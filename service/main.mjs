/**
 * The private LayerFS service.
 *
 * It is started explicitly by the owner, listens on a private Unix socket and
 * a random token, and calls only the pinned official SDK's in-process Store
 * methods. It does not start Sandboxes, mount Workspaces, run Docker, install
 * anything, or read Pi Pocket's own data. The plugin never starts it.
 */
import { createServer } from "node:net";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadConfigFile, ConfigError } from "../src/pocket-layerfs/config.ts";
import { configFileHash } from "../src/pocket-layerfs/config-store.ts";
import { CODES, LayerfsRefusal, safeMessage } from "../src/pocket-layerfs/errors.ts";
import {
    clampHistoryScan,
    clampLineWindow,
    clampPagePos,
    clampPageSize,
    isNodeId,
    normalisePath,
} from "../src/pocket-layerfs/policy.ts";
import { BoundedQueue } from "./queue.mjs";
import { Engine, clientKey } from "./engine.mjs";
import { createServiceControl } from "./control.mjs";
import { verifySdkProvenance } from "../scripts/verify-lib.mjs";
import {
    assertNoSymlinkPath,
    assertPrivateDir,
    assertRuntimeLayout,
    assertSdkDir,
    assertSocket,
    assertStorePath,
    ensureRuntimeDir,
    ensureToken,
    prepareSocket,
    readToken,
    removeOwnSocket,
    sameToken,
} from "./secure.mjs";

const MAX_REQUEST_BYTES = 64 * 1024;
const OPS = new Set([
    "ping",
    "branches",
    "commits",
    "commit",
    "tree",
    "read",
    "stat",
    "diff",
    "blame",
    "file-history",
    "fork.plan",
    "fork.commit",
    "config.status",
    "config.apply",
]);
const TIMEOUTS = {
    ping: 3000,
    branches: 10_000,
    commits: 10_000,
    commit: 10_000,
    tree: 10_000,
    read: 10_000,
    stat: 10_000,
    diff: 15_000,
    blame: 15_000,
    "file-history": 30_000,
    "fork.plan": 15_000,
    "fork.commit": 15_000,
    "config.status": 3000,
    "config.apply": 30_000,
};

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    const options = {
        config: process.env.PI_POCKET_LAYERFS_CONFIG ?? "",
        check: false,
        help: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--config") {
            options.config = argv[index + 1] ?? "";
            index += 1;
        } else if (arg === "--check") {
            options.check = true;
        } else if (arg === "--help" || arg === "-h") {
            options.help = true;
        } else {
            throw new ConfigError(`Unknown argument: ${arg}`);
        }
    }
    if (!options.help && options.config === "")
        throw new ConfigError("--config <absolute path> is required (or PI_POCKET_LAYERFS_CONFIG)");
    return options;
}

/** @param {string} line */
function log(line) {
    process.stderr.write(`[layerfs-service] ${new Date().toISOString()} ${line}\n`);
}

/**
 * Check the installed SDK against the reviewed pin and a private receipt
 * outside the SDK. The marker alone is never trusted. Read-only: nothing is
 * imported or executed here.
 *
 * @param {string} sdkPath
 * @param {any} config
 */
function verifyUpstream(sdkPath, config) {
    let verified;
    try {
        verified = verifySdkProvenance(join(import.meta.dirname, ".."), sdkPath);
    } catch (error) {
        throw new ConfigError(
            error instanceof Error ? error.message : "The installed SDK is not trusted",
        );
    }
    if (
        config.service.upstreamVersion !== undefined &&
        config.service.upstreamVersion !== verified.version
    ) {
        throw new ConfigError("service.upstreamVersion does not match the pin");
    }
    if (
        config.service.upstreamCommit !== undefined &&
        config.service.upstreamCommit !== verified.commit
    ) {
        throw new ConfigError("service.upstreamCommit does not match the pin");
    }
    return {
        version: verified.version,
        commit: verified.commit,
        tag: verified.tag,
        trust: verified.trust,
    };
}

/**
 * Remove deployment settings from the environment. The service must never
 * start a Sandbox or dial Docker, even if the owner's shell has these set.
 */
function clearSandboxEnvironment() {
    for (const name of [
        "LAYERFS_DOCKER",
        "LAYERFS_IMAGE",
        "LAYERFS_VOLUME",
        "LAYERFS_DAEMON",
        "LAYERFS_CONTAINER_PREFIX",
        "LAYERFS_DAEMON_HOST",
        "LAYERFS_TRACE",
        "LAYERFS_TRACE_STEP",
        "LAYERFS_TRACE_START",
        "LAYERFS_STORE_PATH",
    ]) {
        delete process.env[name];
        delete process.env[`DSH_${name}`];
    }
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} [max]
 */
function text(value, name, max = 200) {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > max ||
        value.includes("\0")
    ) {
        throw new LayerfsRefusal(CODES.Invalid, undefined);
    }
    return value;
}

/**
 * @param {unknown} scope
 * @param {unknown} conversationId
 */
function scopeOf(scope, conversationId) {
    if (scope === undefined || scope === "ui") return { scope: "ui" };
    if (scope !== "tool") throw new LayerfsRefusal(CODES.Invalid);
    return { scope: "tool", conversationId: text(conversationId, "conversationId", 200) };
}

/**
 * @param {any} args
 * @returns {{ scope: "ui" } | { scope: "tool", conversationId: string }}
 */
function readScope(args) {
    return scopeOf(args.scope, args.conversationId);
}

/**
 * @param {Engine} engine
 * @param {string} op
 * @param {Record<string, any>} args
 * @param {{ version: string, commit: string }} upstream
 */
async function dispatch(engine, op, args, upstream) {
    switch (op) {
        case "ping":
            return engine.ping(upstream);
        case "branches": {
            const project = text(args.project, "project", 63);
            return engine.listBranches({ project, ...readScope(args) });
        }
        case "commits": {
            const project = text(args.project, "project", 63);
            return engine.listCommits({
                project,
                branch: text(args.branch, "branch", 63),
                pageSize: clampPageSize(args.pageSize),
                pagePos: clampPagePos(args.pagePos),
                ...readScope(args),
            });
        }
        case "commit": {
            const project = text(args.project, "project", 63);
            if (!isNodeId(args.commit)) throw new LayerfsRefusal(CODES.InvalidRef);
            return engine.oneCommit({ project, commit: args.commit, ...readScope(args) });
        }
        case "tree": {
            const project = text(args.project, "project", 63);
            return engine.tree({
                project,
                ref: text(args.ref, "ref", 80),
                path: typeof args.path === "string" ? args.path : "/",
                pageSize: clampPageSize(args.pageSize),
                pagePos: clampPagePos(args.pagePos),
                ...readScope(args),
            });
        }
        case "read": {
            const project = text(args.project, "project", 63);
            const window = clampLineWindow(args.startLine, args.endLine);
            return engine.read({
                project,
                ref: text(args.ref, "ref", 80),
                path: text(args.path, "path", 4096),
                startLine: window.startLine,
                endLine: window.endLine,
                ...readScope(args),
            });
        }
        case "stat": {
            const project = text(args.project, "project", 63);
            return engine.stat({
                project,
                ref: text(args.ref, "ref", 80),
                path: text(args.path, "path", 4096),
                ...readScope(args),
            });
        }
        case "diff": {
            const project = text(args.project, "project", 63);
            const cursor =
                args.cursor === undefined || args.cursor === null
                    ? undefined
                    : normalisePath(args.cursor);
            if (cursor !== undefined && !cursor.ok) throw new LayerfsRefusal(cursor.code);
            return engine.diff({
                project,
                from: text(args.from, "from", 80),
                to: text(args.to, "to", 80),
                pageSize: clampPageSize(args.pageSize),
                pagePos: clampPagePos(args.pagePos),
                ...(cursor === undefined ? {} : { cursor: cursor.path }),
                hunks: args.hunks !== false,
                ...readScope(args),
            });
        }
        case "blame": {
            const project = text(args.project, "project", 63);
            return engine.blame({
                project,
                ref: text(args.ref, "ref", 80),
                path: text(args.path, "path", 4096),
                fromLine:
                    Number.isSafeInteger(args.fromLine) && args.fromLine > 0 ? args.fromLine : 1,
                ...readScope(args),
            });
        }
        case "file-history": {
            const project = text(args.project, "project", 63);
            return engine.fileHistory({
                project,
                branch: text(args.branch, "branch", 63),
                path: text(args.path, "path", 4096),
                maxCommits: clampHistoryScan(args.maxCommits),
                ...readScope(args),
            });
        }
        case "fork.plan": {
            const project = text(args.project, "project", 63);
            return engine.forkPlan({
                project,
                sourceBranch: text(args.sourceBranch, "sourceBranch", 63),
                newBranch: text(args.newBranch, "newBranch", 63),
                conversationId: text(args.conversationId, "conversationId", 200),
                ...(args.fromRef === undefined
                    ? {}
                    : { fromRef: text(args.fromRef, "fromRef", 80) }),
            });
        }
        case "fork.commit": {
            const project = text(args.project, "project", 63);
            if (!isNodeId(args.expectedHead)) throw new LayerfsRefusal(CODES.InvalidRef);
            return engine.forkCommit({
                project,
                sourceBranch: text(args.sourceBranch, "sourceBranch", 63),
                fromRef: text(args.fromRef, "fromRef", 80),
                newBranch: text(args.newBranch, "newBranch", 63),
                expectedHead: args.expectedHead,
                conversationId: text(args.conversationId, "conversationId", 200),
            });
        }
        default:
            throw new LayerfsRefusal(CODES.Invalid);
    }
}

/**
 * @param {import("node:net").Socket} socket
 * @param {{ id: string | null, ok: boolean, result?: unknown, error?: { code: string } }} answer
 * @param {number} maxResponseBytes
 */
function send(socket, answer, maxResponseBytes) {
    if (!socket.writable) return;
    let payload = JSON.stringify(answer);
    if (Buffer.byteLength(payload, "utf8") > maxResponseBytes) {
        payload = JSON.stringify({
            id: answer.id,
            ok: false,
            error: { code: CODES.ResponseTooLarge },
        });
    }
    socket.end(`${payload}\n`);
}

/**
 * @param {import("node:net").Socket} socket
 * @param {string} line
 * @param {object} runtime
 */
async function processLine(socket, line, runtime, signal) {
    const { serviceToken, queue, upstream, maxResponseBytes } = runtime;
    let request;
    try {
        request = JSON.parse(line);
    } catch {
        send(socket, { id: null, ok: false, error: { code: CODES.Protocol } }, maxResponseBytes);
        return;
    }
    if (
        request === null ||
        typeof request !== "object" ||
        request.v !== 1 ||
        typeof request.id !== "string" ||
        request.id.length === 0 ||
        request.id.length > 64 ||
        typeof request.token !== "string" ||
        typeof request.op !== "string" ||
        !OPS.has(request.op) ||
        request.args === null ||
        typeof request.args !== "object" ||
        Array.isArray(request.args)
    ) {
        send(
            socket,
            {
                id: typeof request?.id === "string" ? request.id.slice(0, 64) : null,
                ok: false,
                error: { code: CODES.Protocol },
            },
            maxResponseBytes,
        );
        return;
    }
    if (!sameToken(request.token, serviceToken)) {
        send(
            socket,
            { id: request.id, ok: false, error: { code: CODES.Unauthorized } },
            maxResponseBytes,
        );
        log(`op=${request.op} auth=refused`);
        return;
    }
    const started = Date.now();
    try {
        const result =
            request.op === "config.status"
                ? runtime.control.status()
                : request.op === "config.apply"
                  ? await runtime.control.apply(request.args)
                  : await queue.run(
                        () => dispatch(runtime.engine, request.op, request.args, upstream),
                        {
                            timeoutMs: TIMEOUTS[request.op] ?? 10_000,
                            label: request.op,
                            signal,
                        },
                    );
        send(socket, { id: request.id, ok: true, result }, maxResponseBytes);
        log(
            `op=${request.op} project=${safeProject(request.args.project)} ok durationMs=${Date.now() - started}`,
        );
    } catch (error) {
        const code = error instanceof LayerfsRefusal ? error.code : CODES.Upstream;
        send(socket, { id: request.id, ok: false, error: { code } }, maxResponseBytes);
        log(
            `op=${request.op} project=${safeProject(request.args.project)} code=${code} durationMs=${Date.now() - started}`,
        );
    }
}

/** @param {unknown} value */
function safeProject(value) {
    return typeof value === "string" && /^[a-z0-9._-]{1,63}$/.test(value) ? value : "-";
}

/**
 * @param {import("node:net").Socket} socket
 * @param {object} runtime
 */
function handleConnection(socket, runtime) {
    // Decode once with the socket's UTF-8 decoder. Converting each Buffer
    // chunk separately can split a multibyte path across two chunks.
    socket.setEncoding("utf8");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    socket.on("close", cancel);
    socket.on("error", () => {
        cancel();
    });
    socket.setTimeout(15_000, () => {
        cancel();
        socket.destroy();
    });
    let buffer = "";
    let handled = false;
    socket.on("data", (chunk) => {
        if (handled) return;
        buffer += chunk;
        if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
            handled = true;
            send(
                socket,
                { id: null, ok: false, error: { code: CODES.Invalid } },
                runtime.maxResponseBytes,
            );
            return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        handled = true;
        void processLine(socket, buffer.slice(0, newline), runtime, controller.signal);
    });
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        process.stdout.write(
            "Usage: node service/main.mjs --config <absolute-config.json> [--check]\n",
        );
        return;
    }
    const { config } = loadConfigFile(options.config);
    // --check is read-only: validate the layout without creating the runtime
    // directory, the socket, or the token.
    if (options.check) {
        assertRuntimeLayout(
            config.service.runtimeDir,
            config.service.tokenFile,
            config.service.socketPath,
        );
        assertPrivateDir(config.service.layerfsHome);
        const checkSdk = assertSdkDir(config.service.sdkPath);
        for (const project of config.projects) assertStorePath(project.storePath);
        const checkedUpstream = verifyUpstream(checkSdk, config);
        let token = "missing";
        try {
            token = readToken(config.service.tokenFile) === "" ? "missing" : "present";
        } catch {
            token = "missing";
        }
        process.stdout.write(
            `${JSON.stringify({ ok: true, upstream: checkedUpstream, projects: config.projects.map((project) => project.id), token, socket: config.service.socketPath }, null, 2)}\n`,
        );
        return;
    }
    const runtimeDir = ensureRuntimeDir(config.service.runtimeDir);
    assertRuntimeLayout(runtimeDir, config.service.tokenFile, config.service.socketPath);
    assertPrivateDir(config.service.layerfsHome);
    const sdkPath = assertSdkDir(config.service.sdkPath);
    for (const project of config.projects) assertStorePath(project.storePath);
    const upstream = verifyUpstream(sdkPath, config);

    clearSandboxEnvironment();
    process.env.LAYERFS_HOME = config.service.layerfsHome;
    process.env.LAYERFS_NATIVE = join(sdkPath, "native", "layerfs.node");
    assertNoSymlinkPath(process.env.LAYERFS_NATIVE);
    const { LayerFS } = await import(pathToFileURL(join(sdkPath, "src", "index.js")).href);
    const serviceToken = ensureToken(config.service.tokenFile);
    const clients = new Map();
    const engine = new Engine({
        config,
        LayerFS,
        upstream,
        log,
        clients,
        home: config.service.layerfsHome,
    });
    const queue = new BoundedQueue({
        concurrency: config.service.concurrency,
        maxQueue: config.service.maxQueue,
    });
    const serviceRuntime = {
        serviceToken,
        queue,
        engine,
        clients,
        LayerFS,
        config,
        upstream,
        configPath: resolve(options.config),
        activeHash: configFileHash(options.config),
        generation: 0,
        appliedAt: Date.now(),
        startedAt: Date.now(),
        maxResponseBytes: config.service.maxResponseBytes,
        applyBusy: false,
    };
    serviceRuntime.control = createServiceControl(serviceRuntime, { verifyUpstream });
    await prepareSocket(config.service.socketPath);

    const server = createServer((socket) => handleConnection(socket, serviceRuntime));
    server.maxConnections = 64;
    const address = await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.service.socketPath, () => resolve(server.address()));
    }).catch((error) => {
        throw error;
    });
    assertSocket(config.service.socketPath);
    const info = (await import("node:fs")).lstatSync(config.service.socketPath);
    const startedAt = Date.now();
    log(
        `listening socket=${config.service.socketPath} upstream=${upstream.version}@${upstream.commit.slice(0, 12)} projects=${config.projects.length} address=${typeof address === "string" ? address : "unix"}`,
    );

    let stopping = false;
    const stop = async (signal) => {
        if (stopping) return;
        stopping = true;
        serviceRuntime.queue.pause();
        log(`stopping signal=${signal} uptimeMs=${Date.now() - startedAt}`);
        server.close();
        server.closeIdleConnections?.();
        queue.close();
        // Reject queued calls, then wait for a running native call to settle
        // before closing the Store. Closing the SDK while a call is in flight
        // can revoke its overlay resources.
        const settled = await queue.waitForIdle(5000);
        if (!settled) {
            log(
                "stop grace expired: a native Store call is still running; Store close skipped, outcome unknown",
            );
            const later = await queue.waitForIdle(25_000);
            if (!later) {
                log(
                    "stop hard deadline: native Store call still running; exiting without claiming a clean stop",
                );
                removeOwnSocket(config.service.socketPath, info.dev, info.ino);
                process.exitCode = 2;
                return;
            }
        }
        // The official SDK close is asynchronous. A resolved close is a clean
        // stop; a rejection or a timeout is reported as an unknown outcome and
        // the process exits non-zero instead of claiming the Store closed.
        let closeFailure = "";
        let closeTimer;
        try {
            const winner = await Promise.race([
                serviceRuntime.engine.close().then(() => "closed"),
                new Promise((resolveTimeout) => {
                    closeTimer = setTimeout(() => resolveTimeout("timeout"), 3000);
                }),
            ]);
            if (winner === "timeout") {
                closeFailure = "Store close timed out after 3000 ms";
                log(`Store close timed out after 3000 ms: outcome unknown, not a clean stop`);
            }
        } catch (error) {
            const code = error instanceof Error ? (error.code ?? error.name) : "unknown";
            closeFailure = `Store close failed (${code})`;
            log(`Store close failed: ${code}; outcome unknown, not a clean stop`);
        } finally {
            clearTimeout(closeTimer);
        }
        server.closeAllConnections?.();
        removeOwnSocket(config.service.socketPath, info.dev, info.ino);
        if (closeFailure !== "") {
            process.exitCode = 4;
            return;
        }
        process.exitCode = 0;
    };
    process.on("SIGINT", () => void stop("SIGINT"));
    process.on("SIGTERM", () => void stop("SIGTERM"));
}

main().catch((error) => {
    const message =
        error instanceof ConfigError || error instanceof LayerfsRefusal
            ? error.message
            : "The LayerFS service could not start";
    log(`startup failed: ${message}`);
    process.exitCode = 1;
});
