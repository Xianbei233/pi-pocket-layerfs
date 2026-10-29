// Synthetic SDK only: exercises actual service process/socket, never claims native.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
export const PROJECT = resolve(import.meta.dirname, "../..");
export const LOGS =
    process.env.LAYERFS_TEST_LOG_DIR ?? mkdtempSync(join(tmpdir(), "lfs-resume-logs-"));
let serial = 0;
export function command(script, args, env = {}) {
    const result = spawnSync(
        process.execPath,
        [join(PROJECT, "scripts", script + ".mjs"), ...args],
        {
            cwd: PROJECT,
            encoding: "utf8",
            timeout: 20000,
            env: { ...process.env, PI_POCKET_LAYERFS_CONFIG: "", ...env },
        },
    );
    mkdirSync(LOGS, { recursive: true });
    const name =
        "resume-cli-" + process.pid + "-" + ++serial + "-" + script.replace(/[^a-z0-9-]/gi, "_");
    writeFileSync(
        join(LOGS, name + ".log"),
        result.stdout + "\n" + result.stderr + "\n" + (result.error?.message ?? ""),
    );
    writeFileSync(join(LOGS, name + ".exit"), String(result.status ?? result.signal) + "\n");
    return result;
}
export function runtime(sdkCode = "export class LayerFS {}") {
    const root = mkdtempSync(join(tmpdir(), "lfs-resume-"));
    const lock = JSON.parse(readFileSync(join(PROJECT, "upstream.lock.json"), "utf8"));
    mkdirSync(join(root, "sdk/src"), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "sdk/native"), { mode: 0o700 });
    mkdirSync(join(root, "layerfs-home"), { mode: 0o700 });
    mkdirSync(join(root, "store/synthetic"), { recursive: true, mode: 0o700 });
    writeFileSync(
        join(root, ".pi-pocket-layerfs-runtime"),
        JSON.stringify({ name: "pi-pocket-layerfs-runtime", version: 1 }),
        { mode: 0o600 },
    );
    writeFileSync(
        join(root, "sdk/package.json"),
        JSON.stringify({ type: "module", version: lock.version }),
    );
    writeFileSync(
        join(root, "sdk/UPSTREAM.json"),
        JSON.stringify({ ...lock, archiveSha256: lock.archive.sha256 }),
    );
    writeFileSync(join(root, "sdk/src/index.js"), sdkCode);
    writeFileSync(join(root, "sdk/native/layerfs.node"), "SYNTHETIC_NOT_A_NATIVE_ADDON");
    const config = {
        version: 1,
        ownerPersonIds: ["resume-owner"],
        service: {
            runtimeDir: join(root, "service"),
            socketPath: join(root, "service/service.sock"),
            tokenFile: join(root, "service/service.token"),
            layerfsHome: join(root, "layerfs-home"),
            sdkPath: join(root, "sdk"),
            concurrency: 1,
            maxQueue: 2,
        },
        tools: { enabled: false },
        write: { enabled: false },
        projects: [
            {
                id: "synthetic",
                storePath: join(root, "store/synthetic/store.sqlite"),
                branches: ["main", "work"],
            },
        ],
        sessionGrants: [],
    };
    writeFileSync(join(root, "config.json"), JSON.stringify(config), { mode: 0o600 });
    writeFileSync(join(LOGS, "runtime-" + process.pid + "-" + ++serial + ".path"), root + "\n");
    return { root, config, configPath: join(root, "config.json") };
}
