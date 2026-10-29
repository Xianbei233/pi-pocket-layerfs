// Adversarial CLI tests operate exclusively on synthetic temp directories.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    rename,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fingerprintTree } from "./fixtures/security-tree.ts";

const PROJECT = resolve(import.meta.dirname, "..");
const LOGS = mkdtempSync(join(process.env.LAYERFS_TEST_LOG_DIR ?? tmpdir(), "cli-cases-"));
let commandNumber = 0;
function cli(script: string, args: string[], home: string) {
    const result = spawnSync(
        process.execPath,
        [join(PROJECT, "scripts", `${script}.mjs`), ...args],
        {
            cwd: PROJECT,
            encoding: "utf8",
            timeout: 15_000,
            env: { ...process.env, HOME: home, PI_POCKET_LAYERFS_CONFIG: "" },
        },
    );
    mkdirSync(LOGS, { recursive: true });
    const label = `${String(++commandNumber).padStart(3, "0")}-${script}`;
    writeFileSync(
        join(LOGS, `${label}.log`),
        `${JSON.stringify(args)}\n${result.stdout}\n${result.stderr}\n${result.error?.message ?? ""}`,
    );
    writeFileSync(join(LOGS, `${label}.exit`), `${result.status ?? "signal:" + result.signal}\n`);
    assert.equal(result.error, undefined, `CLI spawn failed: ${result.error?.message}`);
    return result;
}
async function sandbox() {
    const root = await mkdtemp(join(tmpdir(), "lfs-cli-security-"));
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    return {
        root,
        home,
        target: join(root, "extensions"),
        cleanup: () => rm(root, { recursive: true, force: true }),
    };
}
async function install(target: string, home: string) {
    const result = cli("install", ["--target", target], home);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(await readFile(join(target, ".layerfs-install.json"), "utf8"));
}
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

for (const script of ["install", "uninstall"]) {
    for (const attack of [
        "dotdot",
        "nested-dotdot",
        "absolute",
        "unknown-file",
        "duplicate",
        "schema",
    ]) {
        test(`${script} refuses ${attack} manifest without modifying any target or outside file`, async () => {
            const box = await sandbox();
            try {
                const manifest = await install(box.target, box.home);
                const outside = join(box.root, "outside.txt");
                const sentinel = "SYNTHETIC_OUTSIDE_MUST_SURVIVE\n";
                await writeFile(outside, sentinel);
                if (attack === "schema") {
                    manifest.schema = 999;
                    manifest.schemaVersion = 999;
                } else if (attack === "duplicate") {
                    manifest.files.push({ ...manifest.files[0] });
                } else {
                    const path =
                        attack === "dotdot"
                            ? "../outside.txt"
                            : attack === "nested-dotdot"
                              ? "pocket-layerfs/../../outside.txt"
                              : attack === "absolute"
                                ? outside
                                : "unrelated.txt";
                    if (attack === "unknown-file")
                        await writeFile(join(box.target, path), sentinel);
                    manifest.files.unshift({ path, sha256: sha(sentinel) });
                }
                await writeFile(
                    join(box.target, ".layerfs-install.json"),
                    JSON.stringify(manifest),
                );
                const before = await fingerprintTree(box.target);
                const result = cli(script, ["--target", box.target], box.home);
                assert.notEqual(result.status, 0, "invalid manifest must be rejected");
                assert.equal(await readFile(outside, "utf8"), sentinel);
                assert.deepEqual(
                    await fingerprintTree(box.target),
                    before,
                    "full preflight must precede all deletion/replacement",
                );
            } finally {
                await box.cleanup();
            }
        });
    }

    test(`${script} changed late file aborts before deleting earlier files`, async () => {
        const box = await sandbox();
        try {
            const manifest = await install(box.target, box.home);
            assert.ok(manifest.files.length > 2);
            const late = manifest.files.at(-1).path;
            await writeFile(join(box.target, late), "SYNTHETIC_USER_EDIT_MUST_SURVIVE\n");
            const before = await fingerprintTree(box.target);
            const result = cli(script, ["--target", box.target], box.home);
            assert.notEqual(result.status, 0);
            assert.deepEqual(
                await fingerprintTree(box.target),
                before,
                "partial deletion on later mismatch is forbidden",
            );
        } finally {
            await box.cleanup();
        }
    });

    test(`${script} rejects symlink ancestor of target and protects synthetic live HOME`, async () => {
        const box = await sandbox();
        try {
            const live = join(box.home, ".pi-pocket");
            const target = join(live, "extensions");
            await mkdir(target, { recursive: true, mode: 0o700 });
            const alias = join(box.root, "alias");
            await symlink(live, alias);
            const before = await fingerprintTree(live);
            const result = cli(script, ["--target", join(alias, "extensions")], box.home);
            assert.notEqual(result.status, 0);
            assert.deepEqual(await fingerprintTree(live), before);
        } finally {
            await box.cleanup();
        }
    });

    test(`${script} rejects installed helper-directory symlink without deleting its external targets`, async () => {
        const box = await sandbox();
        try {
            await install(box.target, box.home);
            const outside = join(box.root, "outside-helpers");
            await rename(join(box.target, "pocket-layerfs"), outside);
            await symlink(outside, join(box.target, "pocket-layerfs"));
            const before = await fingerprintTree(box.target);
            const outsideBefore = await fingerprintTree(outside);
            const result = cli(script, ["--target", box.target], box.home);
            assert.notEqual(result.status, 0);
            assert.deepEqual(await fingerprintTree(box.target), before);
            assert.deepEqual(await fingerprintTree(outside), outsideBefore);
        } finally {
            await box.cleanup();
        }
    });
}

test("install/uninstall happy path never copies config, starts a service or removes unrelated user data", async () => {
    const box = await sandbox();
    try {
        const manifest = await install(box.target, box.home);
        assert.equal(manifest.enabled, false);
        assert.ok(
            manifest.files.every(
                (entry: { path: string }) =>
                    entry.path === "pocket-layerfs.ts" || entry.path.startsWith("pocket-layerfs/"),
            ),
        );
        assert.ok(
            !manifest.files.some(
                (entry: { path: string }) =>
                    entry.path.endsWith("config.json") || entry.path.endsWith(".token"),
            ),
        );
        const sentinel = join(box.target, "my-unrelated-data.txt");
        await writeFile(sentinel, "keep me");
        const result = cli("uninstall", ["--target", box.target], box.home);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(await readFile(sentinel, "utf8"), "keep me");
        assert.equal(existsSync(join(box.target, "pocket-layerfs.ts")), false);
        assert.equal(existsSync(join(box.target, ".layerfs-install.json")), false);
    } finally {
        await box.cleanup();
    }
});

test("setup rejects partial source pins and unauthenticated prebuilt artifacts without running them", async () => {
    const box = await sandbox();
    try {
        const source = join(box.root, "untrusted-source");
        const runtime = join(box.root, "runtime");
        for (const name of ["sdk/js/package.json", "sdk/js/src/index.js", "core/Cargo.lock"]) {
            const destination = join(source, name);
            await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
            await copyFile(join(PROJECT, ".work/layerfs-src", name), destination);
        }
        await writeFile(
            join(source, "core", "UNREVIEWED.rs"),
            "// Synthetic tampered tree: the three pinned files are not a full-tree receipt.\n",
        );
        const artifact = join(runtime, "target/release/liblayerfs_node.so");
        await mkdir(dirname(artifact), { recursive: true, mode: 0o700 });
        await writeFile(artifact, "SYNTHETIC_NOT_AN_ADDON_DO_NOT_LOAD");
        const before = await fingerprintTree(runtime);
        const result = cli(
            "setup",
            ["--runtime", runtime, "--source", source, "--skip-build"],
            box.home,
        );
        assert.notEqual(
            result.status,
            0,
            "three hashes plus arbitrary artifact must not become a trusted official SDK",
        );
        assert.equal(existsSync(join(runtime, "sdk/UPSTREAM.json")), false);
        assert.deepEqual(await fingerprintTree(runtime), before);
    } finally {
        await box.cleanup();
    }
});

test("synthetic init rejects hidden child external-source bypass before importing any SDK", async () => {
    const box = await sandbox();
    try {
        const sdk = join(box.root, "fake-sdk");
        const source = join(box.root, "arbitrary-host-directory");
        const marker = join(box.root, "SDK_WAS_IMPORTED");
        await mkdir(join(sdk, "src"), { recursive: true });
        await mkdir(source);
        await writeFile(join(source, "user.txt"), "synthetic user directory, not approved import");
        await writeFile(join(sdk, "package.json"), '{"type":"module"}');
        await writeFile(
            join(sdk, "src/index.js"),
            `import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)},'IMPORTED');\nexport class LayerFS { project={init:async()=>({kind:'Initialized'})};async close(){} }\n`,
        );
        const result = cli(
            "init-synthetic",
            [
                "--runtime",
                join(box.root, "runtime"),
                "--child",
                "--project",
                "synthetic",
                "--source",
                source,
                "--store",
                join(box.root, "store/store.sqlite"),
                "--home",
                join(box.root, "layerfs-home"),
                "--sdk",
                sdk,
            ],
            box.home,
        );
        assert.notEqual(result.status, 0);
        assert.equal(
            existsSync(marker),
            false,
            "untrusted local SDK must not be imported through hidden child flags",
        );
        assert.equal(
            await readFile(join(source, "user.txt"), "utf8"),
            "synthetic user directory, not approved import",
        );
    } finally {
        await box.cleanup();
    }
});

test("synthetic init must not remove pre-existing unowned synthetic-source directory", async () => {
    const box = await sandbox();
    try {
        const runtime = join(box.root, "runtime");
        const source = join(runtime, "synthetic-source");
        await mkdir(source, { recursive: true, mode: 0o700 });
        await writeFile(join(source, "KEEP_USER_DATA"), "synthetic unrelated data");
        await mkdir(join(runtime, "sdk/native"), { recursive: true, mode: 0o700 });
        await writeFile(
            join(runtime, "sdk/native/layerfs.node"),
            "synthetic non-addon; must not be loaded",
        );
        const before = await fingerprintTree(runtime);
        const result = cli(
            "init-synthetic",
            ["--runtime", runtime, "--project", "synthetic"],
            box.home,
        );
        assert.notEqual(result.status, 0);
        assert.deepEqual(
            await fingerprintTree(runtime),
            before,
            "unmarked runtime must remain entirely untouched",
        );
    } finally {
        await box.cleanup();
    }
});
