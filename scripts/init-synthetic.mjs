/**
 * Initialise one synthetic LayerFS project.
 *
 * This is not a general importer. It writes a fixed source tree inside one
 * exclusive runtime and captures only that tree. Real repositories are not
 * imported: LayerFS v1.0.0 `project.init` captures the whole tree, ignored
 * files included, so a general import needs a separate reviewed design.
 *
 * `project.init` in v1.0.0 refuses to install a Store as a non-root user:
 * the native installer requires effective uid 0 (DAEMON_UID). This script
 * does not use sudo. With `--user-namespace`, it re-runs only that step in an
 * unprivileged Linux user namespace (`unshare -Ur`), where the process has
 * effective uid 0 without host root. Without that flag it stops and explains.
 *
 * The hidden `--child` mode accepts only the runtime and project. It derives
 * every path from `<runtime>`; it cannot import an arbitrary host folder.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
    assertExclusiveRuntime,
    assertFixedPath,
    assertReplaceable,
    assertSyntheticSource,
    markSyntheticSource,
} from "./runtime-lib.mjs";

const projectRoot = resolve(import.meta.dirname, "..");

function parseArgs(argv) {
    const options = {
        runtime: join(projectRoot, ".runtime"),
        config: "",
        project: "synthetic",
        userNamespace: false,
        child: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--runtime") options.runtime = resolve(argv[++index] ?? "");
        else if (arg === "--config") options.config = resolve(argv[++index] ?? "");
        else if (arg === "--project") options.project = argv[++index] ?? "";
        else if (arg === "--user-namespace") options.userNamespace = true;
        else if (arg === "--child") options.child = true;
        else if (arg === "--help" || arg === "-h") {
            process.stdout.write(
                "Usage: node scripts/init-synthetic.mjs [--runtime DIR] [--config FILE] [--project NAME] [--user-namespace]\n",
            );
            process.exit(0);
        } else throw new Error(`Unknown argument: ${arg}`);
    }
    return options;
}

function projectId(value) {
    if (
        typeof value !== "string" ||
        !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(value) ||
        value === "main"
    ) {
        throw new Error("The project id is not a valid LayerFS name");
    }
    return value;
}

function paths(runtime, project) {
    return {
        sdk: join(runtime, "sdk"),
        home: join(runtime, "layerfs-home"),
        source: join(runtime, "synthetic-source"),
        store: join(runtime, "store", project, "store.sqlite"),
        storeDir: join(runtime, "store", project),
    };
}

function baseConfig(runtime, project) {
    return {
        version: 1,
        ownerPersonIds: [],
        service: {
            runtimeDir: join(runtime, "service"),
            socketPath: join(runtime, "service/service.sock"),
            tokenFile: join(runtime, "service/service.token"),
            layerfsHome: join(runtime, "layerfs-home"),
            sdkPath: join(runtime, "sdk"),
            requestTimeoutMs: 8000,
            maxResponseBytes: 524288,
            maxQueue: 16,
            concurrency: 1,
        },
        tools: { enabled: false, maxBytes: 32768 },
        write: { enabled: false, ticketTtlMs: 120000 },
        projects: [
            {
                id: project,
                label: "Synthetic",
                storePath: join(runtime, "store", project, "store.sqlite"),
                branches: ["main", "work"],
            },
        ],
        sessionGrants: [],
    };
}

function writeSyntheticSource(runtime, source) {
    assertReplaceable(runtime, source);
    if (existsSync(source)) {
        // Only a tree this script marked may be replaced. A user's directory
        // with the same name is refused, never removed.
        assertSyntheticSource(runtime, source);
        rmSync(source, { recursive: true, force: false });
    }
    mkdirSync(join(source, "docs"), { recursive: true, mode: 0o700 });
    writeFileSync(
        join(source, "README.md"),
        "# Synthetic LayerFS project\n\nA safe fixture created by pi-pocket-layerfs.\n",
        { mode: 0o600 },
    );
    writeFileSync(join(source, "docs/hello.txt"), "hello from the synthetic project\n", {
        mode: 0o600,
    });
    writeFileSync(
        join(source, "notices.md"),
        "This tree is synthetic. It is not imported from a real repository.\n",
        { mode: 0o600 },
    );
    markSyntheticSource(source);
}

async function openLayerfs(sdkPath, home, project, storePath) {
    process.env.LAYERFS_HOME = home;
    process.env.LAYERFS_NATIVE = join(sdkPath, "native/layerfs.node");
    const { LayerFS } = await import(join(sdkPath, "src/index.js"));
    return new LayerFS(project, { storePath });
}

function childPaths(options) {
    const runtime = assertExclusiveRuntime(options.runtime, { create: false });
    const project = projectId(options.project);
    const fixed = paths(runtime, project);
    assertFixedPath(runtime, fixed.source, "synthetic-source");
    assertSyntheticSource(runtime, fixed.source);
    assertFixedPath(runtime, fixed.home, "layerfs-home");
    assertFixedPath(runtime, fixed.sdk, "sdk");
    assertFixedPath(runtime, fixed.store, join("store", project, "store.sqlite"));
    return { runtime, project, ...fixed };
}

async function childInit(options) {
    const fixed = childPaths(options);
    mkdirSync(fixed.home, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(fixed.store), { recursive: true, mode: 0o700 });
    process.env.LAYERFS_HOME = fixed.home;
    process.env.LAYERFS_NATIVE = join(fixed.sdk, "native/layerfs.node");
    const { LayerFS } = await import(join(fixed.sdk, "src/index.js"));
    const layerfs = new LayerFS(fixed.project, { storePath: fixed.store });
    try {
        const result = await layerfs.project.init(fixed.source);
        process.stdout.write(`LAYERFS_INIT ${JSON.stringify(result)}\n`);
    } finally {
        await layerfs.close();
    }
}

function runChildInit(runtime, project) {
    const env = { ...process.env };
    delete env.LAYERFS_DOCKER;
    delete env.LAYERFS_IMAGE;
    delete env.LAYERFS_VOLUME;
    delete env.LAYERFS_DAEMON;
    const args = [
        "-Ur",
        process.execPath,
        join(projectRoot, "scripts/init-synthetic.mjs"),
        "--child",
        "--runtime",
        runtime,
        "--project",
        project,
    ];
    const result = spawnSync("unshare", args, { env, encoding: "utf8" });
    if (result.error) {
        throw new Error(
            "unshare is not available; run project.init as the daemon user, or install a user-namespace-capable kernel",
        );
    }
    if (result.status !== 0) {
        throw new Error(
            `project.init failed in the user namespace: ${(result.stderr || "").trim() || `exit ${result.status}`}`,
        );
    }
    const line = (result.stdout || "")
        .split("\n")
        .find((entry) => entry.startsWith("LAYERFS_INIT "));
    if (line === undefined) throw new Error("project.init gave no result");
    return JSON.parse(line.slice("LAYERFS_INIT ".length));
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.child) {
        await childInit(options);
        return;
    }
    if (typeof process.getuid !== "function") throw new Error("This setup is Linux only");
    const project = projectId(options.project);
    const runtime = assertExclusiveRuntime(options.runtime, { create: true });
    const fixed = paths(runtime, project);
    const configPath =
        options.config === "" ? join(runtime, "config.json") : resolve(options.config);
    if (!configPath.startsWith(`${runtime}/`)) {
        throw new Error("The synthetic config must stay inside the exclusive runtime");
    }

    let config;
    if (existsSync(configPath)) config = JSON.parse(readFileSync(configPath, "utf8"));
    else {
        config = baseConfig(runtime, project);
        writeFileSync(configPath, `${JSON.stringify(config, null, 4)}\n`, { mode: 0o600 });
        process.stdout.write(`[init] wrote ${configPath} (disabled: tools and writes stay off)\n`);
    }
    const configured = config.projects?.find((entry) => entry.id === project);
    if (configured === undefined) throw new Error(`The config has no project named ${project}`);
    if (resolve(configured.storePath) !== resolve(fixed.store)) {
        throw new Error("The project's storePath must be the exclusive runtime's fixed Store path");
    }
    if (resolve(config.service.layerfsHome) !== resolve(fixed.home)) {
        throw new Error("service.layerfsHome must be the exclusive runtime's fixed home");
    }
    if (resolve(config.service.sdkPath) !== resolve(fixed.sdk)) {
        throw new Error("service.sdkPath must be the exclusive runtime's fixed SDK");
    }
    if (!existsSync(join(fixed.sdk, "native/layerfs.node"))) {
        throw new Error("Run `npm run setup` first; the pinned SDK is missing");
    }
    if (existsSync(fixed.store)) {
        throw new Error(
            `The Store already exists at ${fixed.store}; use a new project id. This script never deletes a Store.`,
        );
    }
    if (existsSync(join(fixed.home, project))) {
        throw new Error(
            `The LayerFS home entry ${project} already exists; remove it only if you are sure it is abandoned.`,
        );
    }
    assertReplaceable(runtime, fixed.storeDir);
    mkdirSync(fixed.storeDir, { recursive: true, mode: 0o700 });
    mkdirSync(fixed.home, { recursive: true, mode: 0o700 });
    writeSyntheticSource(runtime, fixed.source);
    process.stdout.write(`[init] synthetic source: ${fixed.source}\n`);
    process.stdout.write(`[init] store: ${fixed.store}\n`);

    if (process.getuid() === 0) {
        await childInit({ runtime, project });
    } else if (options.userNamespace) {
        runChildInit(runtime, project);
        process.stdout.write("[init] project.init ran in an unprivileged user namespace\n");
    } else {
        throw new Error(
            "LayerFS v1.0.0 project.init requires effective uid 0 (DAEMON_UID). This script does not use sudo. Re-run with --user-namespace to use an unprivileged Linux user namespace (unshare -Ur), or run the init as the daemon user.",
        );
    }

    const layerfs = await openLayerfs(fixed.sdk, fixed.home, project, fixed.store);
    try {
        const fork = await layerfs.branch.fork("work", "main");
        if (fork?.kind !== "Forked")
            throw new Error(`work Branch was not created: ${fork?.kind ?? "unknown"}`);
        const seed = await layerfs.fs.write(
            "work",
            "/README.md",
            "# Synthetic LayerFS project\n\nA safe fixture created by pi-pocket-layerfs.\n\nSeeded on the work Branch.\n",
            "Seed the synthetic work Branch",
        );
        if (seed?.kind !== "Committed")
            throw new Error(`the seed write did not commit: ${seed?.kind ?? "unknown"}`);
    } finally {
        await layerfs.close();
    }

    process.stdout.write(`[init] project ${project} is ready\n`);
    process.stdout.write(`[init] config: ${configPath}\n`);
    process.stdout.write(
        "[init] Next: add ownerPersonIds and one sessionGrants entry, then start `node service/main.mjs --config ...`.\n",
    );
    process.stdout.write(
        "[init] Tools and internal writes remain disabled until the owner edits the config.\n",
    );
}

main().catch((error) => {
    process.stderr.write(`[init] ${error instanceof Error ? error.message : "init failed"}\n`);
    process.exitCode = 1;
});
