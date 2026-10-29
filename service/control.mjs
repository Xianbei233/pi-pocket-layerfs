/**
 * Testable service control: status and one explicit config apply.
 *
 * The service reads only its fixed startup path. A caller cannot send a path,
 * a candidate config, or a token. The apply checks the exact target hash, the
 * base active hash, and the current generation before it pauses the queue.
 */
import { loadConfigFile } from "../src/pocket-layerfs/config.ts";
import { readOwnBytes } from "../src/pocket-layerfs/config-store.ts";
import { CODES, LayerfsRefusal } from "../src/pocket-layerfs/errors.ts";
import { Engine, clientKey } from "./engine.mjs";
import { assertPrivateDir, assertSdkDir, assertStorePath } from "./secure.mjs";

/**
 * @param {any} runtime
 */
export function configStatus(runtime) {
    return {
        activeHash: runtime.activeHash,
        generation: runtime.generation,
        appliedAt: runtime.appliedAt,
        projectCount: runtime.config.projects.length,
        upstream: { version: runtime.upstream.version, commit: runtime.upstream.commit },
        startedAt: runtime.startedAt,
        pid: process.pid,
    };
}

/**
 * @param {unknown} value
 * @param {string} name
 */
function hashArg(value, name) {
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
        throw new LayerfsRefusal(CODES.Invalid, `${name} must be a SHA-256 hash`);
    return value;
}

/**
 * @param {any} runtime
 * @param {any} args
 * @param {(sdkPath: string, config: any) => any} verifyUpstream
 */
export async function applyConfig(runtime, args, verifyUpstream) {
    if (runtime.applyBusy) throw new LayerfsRefusal(CODES.Busy);
    runtime.applyBusy = true;
    try {
        const base = hashArg(args.baseActiveHash, "baseActiveHash");
        const target = hashArg(args.targetHash, "targetHash");
        const expectedGeneration = args.expectedGeneration;
        if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0)
            throw new LayerfsRefusal(CODES.Invalid, "expectedGeneration is not valid");
        let loaded;
        try {
            loaded = loadConfigFile(runtime.configPath);
        } catch {
            throw new LayerfsRefusal(CODES.NotApplied, "The saved config is not valid");
        }
        const next = loaded.config;
        const saved = readOwnBytes(runtime.configPath);
        if (saved === null || saved.sha256 !== target)
            throw new LayerfsRefusal(CODES.NotApplied, "The saved config is not the target");
        if (base !== runtime.activeHash)
            throw new LayerfsRefusal(CODES.NotApplied, "The base is not the active config");
        if (expectedGeneration !== runtime.generation)
            throw new LayerfsRefusal(CODES.StaleGeneration);
        for (const key of ["runtimeDir", "socketPath", "tokenFile", "layerfsHome", "sdkPath"]) {
            if (next.service[key] !== runtime.config.service[key])
                throw new LayerfsRefusal(
                    CODES.NotApplied,
                    "A service path change needs an explicit service restart",
                );
        }
        assertPrivateDir(next.service.layerfsHome);
        const sdkPath = assertSdkDir(next.service.sdkPath);
        const checkedUpstream = verifyUpstream(sdkPath, next);
        if (
            checkedUpstream.version !== runtime.upstream.version ||
            checkedUpstream.commit !== runtime.upstream.commit
        )
            throw new LayerfsRefusal(CODES.NotApplied, "The installed SDK changed");
        for (const project of next.projects) assertStorePath(project.storePath);
        runtime.queue.pause();
        try {
            const idle = await runtime.queue.waitForIdle(5000);
            if (!idle) throw new LayerfsRefusal(CODES.Busy);
            const candidate = new Engine({
                config: next,
                LayerFS: runtime.LayerFS,
                upstream: runtime.upstream,
                log: runtime.log ?? (() => {}),
                clients: runtime.clients,
                home: next.service.layerfsHome,
            });
            for (const project of next.projects) {
                const list = await candidate.listBranches({ project: project.id, scope: "ui" });
                for (const branch of project.branches) {
                    if (branch === "main") continue;
                    if (!list.items.some((item) => item.name === branch))
                        throw new LayerfsRefusal(
                            CODES.NotApplied,
                            "A configured branch is missing",
                        );
                }
            }
            runtime.engine = candidate;
            runtime.config = next;
            runtime.activeHash = target;
            runtime.generation = expectedGeneration + 1;
            runtime.appliedAt = Date.now();
            const keep = new Set(
                next.projects.map((project) => clientKey(project, next.service.layerfsHome)),
            );
            for (const [key, client] of [...runtime.clients]) {
                if (keep.has(key)) continue;
                try {
                    await client.close();
                    runtime.clients.delete(key);
                } catch {
                    runtime.log?.("orphan Store close outcome unknown; client kept");
                }
            }
            return {
                applied: true,
                activeHash: target,
                generation: runtime.generation,
                appliedAt: runtime.appliedAt,
                projectCount: next.projects.length,
                upstream: {
                    version: runtime.upstream.version,
                    commit: runtime.upstream.commit,
                },
            };
        } finally {
            runtime.queue.resume();
        }
    } finally {
        runtime.applyBusy = false;
    }
}

/**
 * A small control object for a test or for the service loop.
 *
 * @param {any} runtime
 * @param {{ verifyUpstream: (sdkPath: string, config: any) => any }} options
 */
export function createServiceControl(runtime, options) {
    return {
        status: () => configStatus(runtime),
        apply: (args) => applyConfig(runtime, args, options.verifyUpstream),
    };
}
