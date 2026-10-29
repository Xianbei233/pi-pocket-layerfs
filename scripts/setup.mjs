/**
 * Prepare the pinned LayerFS SDK without installing anything system-wide.
 *
 * This script downloads only the official v1.0.0 archive, verifies its pinned
 * SHA-256, extracts it under this project's `.runtime`, and builds the native
 * addon with project-local CARGO_HOME/CARGO_TARGET_DIR/TMPDIR. It never runs
 * Docker, never uses sudo, never writes to Pi Pocket's data, and never
 * installs a shared dependency.
 *
 * LayerFS v1.0.0's `project.init` refuses a non-root installer (DAEMON_UID=0).
 * That is a separate step: `scripts/init-synthetic.mjs` explains the two
 * supported paths (the daemon user, or an unprivileged user namespace). This
 * setup script does not elevate and does not hide that limit.
 */
import { createHash } from "node:crypto";
import {
    closeSync,
    copyFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    readSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { assertExclusiveRuntime, assertReplaceable, treeHash } from "./runtime-lib.mjs";
import { hashFile } from "./install-lib.mjs";
import { sdkContentHash, verifySdkProvenance, writeTrustReceipt } from "./verify-lib.mjs";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(import.meta.dirname, "..");
const lock = JSON.parse(readFileSync(join(projectRoot, "upstream.lock.json"), "utf8"));

function parseArgs(argv) {
    const options = {
        runtime: join(projectRoot, ".runtime"),
        archive: "",
        proxy: "",
        check: false,
        force: false,
        offline: false,
        authorizeNative: "",
        help: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--runtime") {
            options.runtime = resolve(argv[++index] ?? "");
        } else if (arg === "--archive") {
            options.archive = resolve(argv[++index] ?? "");
        } else if (arg === "--proxy") {
            options.proxy = argv[++index] ?? "";
        } else if (arg === "--check") {
            options.check = true;
        } else if (arg === "--force") {
            options.force = true;
        } else if (arg === "--offline") {
            options.offline = true;
        } else if (arg === "--authorize-native") {
            options.authorizeNative = argv[++index] ?? "";
        } else if (arg === "--help" || arg === "-h") {
            options.help = true;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return options;
}

function log(message) {
    process.stdout.write(`[setup] ${message}\n`);
}

function run(command, args, options = {}) {
    log(`run: ${command} ${args.join(" ")}`);
    const result = spawnSync(command, args, { stdio: "inherit", ...options });
    if (result.error) throw result.error;
    if (result.status !== 0)
        throw new Error(`${command} exited with ${result.status ?? "no status"}`);
}

function sha256File(path) {
    const hash = createHash("sha256");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const buffer = Buffer.alloc(1024 * 1024);
        while (true) {
            const length = readSync(fd, buffer, 0, buffer.length, null);
            if (length === 0) break;
            hash.update(buffer.subarray(0, length));
        }
    } finally {
        closeSync(fd);
    }
    return hash.digest("hex");
}

function checkPrerequisites() {
    if (process.platform !== "linux") throw new Error("LayerFS v1.0.0 Store calls are Linux only");
    const major = Number(process.versions.node.split(".")[0]);
    const minor = Number(process.versions.node.split(".")[1]);
    if (!Number.isSafeInteger(major) || major < 22 || (major === 22 && minor < 19))
        throw new Error("Node 22.19 or newer is required");
    for (const [command, args] of [
        ["cargo", ["--version"]],
        ["rustc", ["--version"]],
        ["cc", ["--version"]],
        ["make", ["--version"]],
        ["tar", ["--version"]],
    ]) {
        const result = spawnSync(command, args, { stdio: "ignore" });
        if (result.error || result.status !== 0) throw new Error(`${command} is required`);
    }
    const rust = spawnSync("rustc", ["--version"], { encoding: "utf8" });
    const version = /rustc (\d+)\.(\d+)/.exec(rust.stdout ?? "");
    if (
        version === null ||
        Number(version[1]) < 1 ||
        (Number(version[1]) === 1 && Number(version[2]) < 85)
    ) {
        throw new Error("Rust 1.85 or newer is required");
    }
}

function download(archive, proxy) {
    mkdirSync(dirname(archive), { recursive: true, mode: 0o700 });
    const args = [
        "-fL",
        "--proto",
        "=https",
        "--tlsv1.2",
        "--retry",
        "3",
        "--retry-delay",
        "2",
        "--max-time",
        "3600",
    ];
    if (proxy !== "") args.push("--proxy", proxy);
    args.push("-o", archive, lock.archive.url);
    run("curl", args);
}

function verifySource(source) {
    const actualTree = treeHash(source);
    if (actualTree !== lock.treeSha256) {
        throw new Error(
            "The source tree does not match the pinned official tree. Remove the extracted source folder and retry from the verified archive; do not edit the source.",
        );
    }
    for (const [relative, wanted] of Object.entries(lock.files)) {
        const path = join(source, relative);
        if (!existsSync(path)) throw new Error(`The source is missing ${relative}`);
        const actual = sha256File(path);
        if (actual !== wanted)
            throw new Error(`The source file ${relative} does not match the pinned hash`);
    }
    const pkg = JSON.parse(readFileSync(join(source, "sdk/js/package.json"), "utf8"));
    if (pkg.version !== lock.version)
        throw new Error("The source SDK version does not match the pin");
    if (existsSync(join(source, ".git"))) {
        const head = spawnSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" });
        if (head.status !== 0 || head.stdout.trim() !== lock.commit)
            throw new Error("The source checkout is not at the pinned commit");
    }
}

function buildNative(source, runtime, offline) {
    const cargoHome = join(runtime, "cargo");
    const target = join(runtime, "target");
    const tmp = join(runtime, "tmp");
    mkdirSync(cargoHome, { recursive: true, mode: 0o700 });
    mkdirSync(target, { recursive: true, mode: 0o700 });
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    const args = [
        "build",
        "--manifest-path",
        "core/Cargo.toml",
        "--locked",
        "-p",
        "layerfs-node",
        "--release",
    ];
    if (offline) args.push("--offline");
    run("cargo", args, {
        cwd: source,
        env: {
            ...process.env,
            CARGO_HOME: cargoHome,
            CARGO_TARGET_DIR: target,
            TMPDIR: tmp,
            CARGO_NET_GIT_FETCH_WITH_CLI: "true",
        },
    });
    const artifact = join(target, "release", "liblayerfs_node.so");
    if (!existsSync(artifact)) throw new Error("The native build produced no liblayerfs_node.so");
    return artifact;
}

function installSdk(source, runtime, artifact) {
    const sdk = join(runtime, "sdk");
    assertReplaceable(runtime, sdk);
    rmSync(sdk, { recursive: true, force: true });
    cpSync(join(source, "sdk/js"), sdk, {
        recursive: true,
        filter: (path) => basename(path) !== ".git",
    });
    mkdirSync(join(sdk, "native"), { recursive: true, mode: 0o700 });
    copyFileSync(artifact, join(sdk, "native/layerfs.node"));
    writeFileSync(
        join(sdk, "UPSTREAM.json"),
        `${JSON.stringify(
            {
                repo: lock.repo,
                tag: lock.tag,
                commit: lock.commit,
                version: lock.version,
                archiveSha256: lock.archive.sha256,
                verifiedAt: new Date().toISOString(),
            },
            null,
            4,
        )}\n`,
        { mode: 0o600 },
    );
    // The copied JavaScript must be exactly the reviewed official tree; the
    // receipt (outside the SDK) records the native build that was just made.
    const copiedTree = sdkContentHash(sdk);
    if (copiedTree !== lock.sdk?.treeSha256)
        throw new Error("The copied SDK content does not match the pinned official tree");
    writeTrustReceipt(projectRoot, runtime, "official-build");
    mkdirSync(join(runtime, "app"), { recursive: true, mode: 0o700 });
    copyFileSync(join(projectRoot, "upstream.lock.json"), join(runtime, "app/upstream.lock.json"));
    return sdk;
}

function verifyInstalled(runtime) {
    // Content, not the SDK's own marker: setup always requires the pinned
    // official SDK tree; a private receipt may only vouch for a reviewed local
    // native build. This function never imports the SDK.
    const verified = verifySdkProvenance(projectRoot, join(runtime, "sdk"), {
        requireOfficialSdk: true,
    });
    return {
        sdk: join(runtime, "sdk"),
        upstream: { version: verified.version, commit: verified.commit },
        trust: verified.trust,
        sdkTreeSha256: verified.sdkTreeSha256,
        nativeSha256: verified.nativeSha256,
    };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        process.stdout.write(
            `Usage: node scripts/setup.mjs [--runtime DIR] [--archive TARBALL] [--proxy URL] [--offline] [--check] [--force]\n` +
                `       node scripts/setup.mjs [--runtime DIR] --authorize-native <sha256>\n`,
        );
        return;
    }
    if (options.authorizeNative !== "") {
        if (!/^[a-f0-9]{64}$/.test(options.authorizeNative))
            throw new Error("--authorize-native needs a lowercase SHA-256 hex digest");
        const runtime = assertExclusiveRuntime(options.runtime, { create: false });
        const sdk = join(runtime, "sdk");
        const tree = sdkContentHash(sdk);
        if (tree !== lock.sdk?.treeSha256)
            throw new Error(
                "Refusing to authorize a native addon for an SDK that is not the pinned official tree",
            );
        const actual = hashFile(join(sdk, "native", "layerfs.node"));
        if (actual !== options.authorizeNative)
            throw new Error(`The installed native addon is ${actual}, not the authorized hash`);
        writeTrustReceipt(projectRoot, runtime, "owner-authorized");
        log(`recorded an owner-authorized native receipt for ${actual}`);
        return;
    }
    if (options.check) {
        const runtime = assertExclusiveRuntime(options.runtime, { create: false });
        const installed = verifyInstalled(runtime);
        process.stdout.write(`${JSON.stringify({ ok: true, ...installed, pin: lock }, null, 4)}\n`);
        return;
    }
    checkPrerequisites();
    const runtime = assertExclusiveRuntime(options.runtime, { create: true });
    mkdirSync(join(runtime, "downloads"), { recursive: true, mode: 0o700 });

    if (existsSync(join(runtime, "sdk", "UPSTREAM.json")) && !options.force) {
        const installed = verifyInstalled(runtime);
        log(`already installed: ${installed.sdk}`);
        log("Use --force to rebuild. No files were changed.");
        return;
    }

    const sourceRoot = join(runtime, "src", `layerfs-${lock.tag}`);
    if (!existsSync(sourceRoot)) {
        const archive =
            options.archive !== ""
                ? options.archive
                : join(runtime, "downloads", `layerfs-${lock.tag}.tar.gz`);
        if (!existsSync(archive)) download(archive, options.proxy);
        const actual = sha256File(archive);
        if (actual !== lock.archive.sha256)
            throw new Error(`The archive SHA-256 does not match the pin (got ${actual})`);
        mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
        run("tar", ["-xzf", archive, "-C", sourceRoot, "--strip-components=1"]);
    }
    assertReplaceable(runtime, sourceRoot);
    verifySource(sourceRoot);

    const artifact = buildNative(sourceRoot, runtime, options.offline);
    const sdk = installSdk(sourceRoot, runtime, artifact);
    const installed = verifyInstalled(runtime);
    log(`installed ${lock.repo} ${lock.tag} @ ${lock.commit}`);
    log(`SDK: ${sdk}`);
    log(
        "Next: create the plugin config, then run `npm run init:synthetic` with a fresh project id.",
    );
    log(
        "LayerFS v1.0.0 project.init requires effective uid 0. Do not use sudo; see docs/INSTALL.md for the user-namespace option.",
    );
}

main().catch((error) => {
    process.stderr.write(`[setup] ${error instanceof Error ? error.message : "setup failed"}\n`);
    process.exitCode = 1;
});
