// Strict D1/D2/D6 adversarial regressions; all inputs are private synthetic trees.
import assert from "node:assert/strict";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { assertSyntheticSource, treeHash } from "../scripts/runtime-lib.mjs";
import { fingerprintTree } from "./fixtures/security-tree.ts";
import { command, PROJECT, runtime } from "./fixtures/resume-runtime.mjs";

for (const script of ["install", "uninstall"]) {
    for (const leaf of [".layerfs-install.json", "pocket-layerfs.ts"]) {
        test(
            "D1 " + script + " refuses leaf symlink " + leaf + " before changing any data",
            async () => {
                const { root } = runtime();
                const target = join(root, "extensions");
                assert.equal(command("install", ["--target", target]).status, 0);
                const outside = join(root, "outside-copy");
                renameSync(join(target, leaf), outside);
                symlinkSync(outside, join(target, leaf));
                const before = await fingerprintTree(target);
                const outsideBefore = await fingerprintTree(outside);
                const result = command(script, ["--target", target]);
                assert.equal(result.error, undefined);
                assert.notEqual(result.status, 0);
                assert.deepEqual(await fingerprintTree(target), before);
                assert.deepEqual(await fingerprintTree(outside), outsideBefore);
            },
        );
    }
}

test("D1 rejecting a new protected live child must not create that directory", async () => {
    const { root } = runtime();
    const home = join(root, "synthetic-home");
    const live = join(home, ".pi-pocket");
    mkdirSync(live, { recursive: true, mode: 0o700 });
    writeFileSync(join(live, "keep.txt"), "unchanged");
    const before = await fingerprintTree(live);
    const result = command("install", ["--target", join(live, "new-extensions")], {
        HOME: home,
        PI_POCKET_DIR: live,
    });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.deepEqual(
        await fingerprintTree(live),
        before,
        "refusal must precede mkdir in protected live tree",
    );
});

test("D2 service --check refuses forged marker plus arbitrary SDK/native", () => {
    const { root, configPath } = runtime();
    const result = command("../service/main", ["--config", configPath, "--check"]);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, "service must not certify a marker as official provenance");
});

test("D2 setup --check rejects SDK source tampered after an apparently pinned installation", () => {
    const { root } = runtime();
    writeFileSync(
        join(root, "sdk/src/index.js"),
        readFileSync(join(PROJECT, ".runtime/sdk/src/index.js"), "utf8") +
            "\n// SYNTHETIC_UNREVIEWED_TAMPER\n",
    );
    const result = command("setup", ["--runtime", root, "--check"]);
    assert.equal(result.error, undefined);
    assert.notEqual(
        result.status,
        0,
        "changed installed SDK bytes need a trusted integrity receipt",
    );
});

test("D2 treeHash detects non-pinned file content, same-size edits and symlink target changes", () => {
    const { root } = runtime();
    const source = join(root, "tree");
    mkdirSync(source);
    writeFileSync(join(source, "extra.rs"), "AAAA");
    const a = treeHash(source);
    writeFileSync(join(source, "extra.rs"), "BBBB");
    const b = treeHash(source);
    assert.notEqual(a, b);
    symlinkSync("extra.rs", join(source, "link"));
    const c = treeHash(source);
    renameSync(join(source, "link"), join(root, "old-link"));
    symlinkSync("different.rs", join(source, "link"));
    assert.notEqual(treeHash(source), c);
});

test("D2 setup refuses an extracted partial tree before reusing a planted native artifact", () => {
    const { root } = runtime();
    // Remove only the marker file name from consideration by moving the test SDK.
    renameSync(join(root, "sdk"), join(root, "planted-sdk-not-installed"));
    const source = join(root, "src/layerfs-v1.0.0");
    for (const name of ["sdk/js/package.json", "sdk/js/src/index.js", "core/Cargo.lock"]) {
        mkdirSync(dirname(join(source, name)), { recursive: true });
        copyFileSync(join(PROJECT, ".work/layerfs-src", name), join(source, name));
    }
    writeFileSync(join(source, "tampered.rs"), "not official");
    mkdirSync(join(root, "target/release"), { recursive: true });
    writeFileSync(join(root, "target/release/liblayerfs_node.so"), "untrusted artifact");
    const result = command("setup", ["--runtime", root, "--offline"]);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /pinned official tree/);
    assert.equal(existsSync(join(root, "sdk")), false);
});

for (const args of [["--check"], []]) {
    test(
        "D2 setup must not trust forged installed marker/arbitrary artifact " + args.join(" "),
        () => {
            const { root } = runtime("throw new Error('untrusted SDK must never execute')");
            const result = command("setup", ["--runtime", root, ...args]);
            assert.equal(result.error, undefined);
            assert.notEqual(
                result.status,
                0,
                "marker, package version and file existence are not provenance",
            );
        },
    );
}

function synthetic(root) {
    const source = join(root, "synthetic-source");
    mkdirSync(source, { mode: 0o700 });
    writeFileSync(
        join(source, ".pi-pocket-layerfs-synthetic"),
        JSON.stringify({ name: "pi-pocket-layerfs-synthetic", version: 1 }),
        { mode: 0o600 },
    );
    writeFileSync(join(source, "README.md"), "synthetic fixture");
    return source;
}

test("D6 synthetic source refuses nested symlink to arbitrary host tree before SDK import", async () => {
    const { root } = runtime(
        "import {writeFileSync} from 'node:fs';writeFileSync(new URL('../../IMPORTED',import.meta.url),'bad');export class LayerFS {project={init:async()=>({kind:'Initialized'})}; async close(){} }",
    );
    const source = synthetic(root);
    const outside = join(root, "unapproved-host-tree");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "HOST_DATA_MUST_NOT_BE_IMPORTED");
    mkdirSync(join(source, "docs"));
    symlinkSync(outside, join(source, "docs/host"));
    const before = await fingerprintTree(outside);
    const result = command("init-synthetic", [
        "--child",
        "--runtime",
        root,
        "--project",
        "synthetic",
    ]);
    assert.deepEqual(await fingerprintTree(outside), before);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, "hidden child must reject linked host tree");
    assert.equal(existsSync(join(root, "IMPORTED")), false, "refuse before importing SDK");
});

test("D6 exclusive fixed source validator rejects links even with a copied valid marker", () => {
    const { root } = runtime();
    const source = synthetic(root);
    symlinkSync(join(root, "config.json"), join(source, "host-config"));
    assert.throws(() => assertSyntheticSource(root, source), /link|synthetic/i);
});

test("D6 seed errors are propagated, close still runs, and readiness is never printed", () => {
    const { root } = runtime(
        "import {writeFileSync} from 'node:fs';export class LayerFS {branch={fork:async()=>({kind:'Forked'})};fs={write:async()=>{throw new Error('SYNTHETIC_SEED_FAILURE')}};async close(){writeFileSync(new URL('../../CLOSED',import.meta.url),'yes')}}",
    );
    // A synthetic unshare transport isolates the parent seed/error contract.
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(
        join(bin, "unshare"),
        '#!/bin/sh\nprintf \'LAYERFS_INIT {"kind":"Initialized"}\\n\'\n',
        { mode: 0o700 },
    );
    const result = command(
        "init-synthetic",
        ["--runtime", root, "--project", "synthetic", "--user-namespace"],
        { PATH: bin + ":" + process.env.PATH },
    );
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SYNTHETIC_SEED_FAILURE/);
    assert.doesNotMatch(result.stdout, /project synthetic is ready/);
    assert.equal(readFileSync(join(root, "CLOSED"), "utf8"), "yes");
});
