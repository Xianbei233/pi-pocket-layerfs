// Production trust boundary tests: no imports of arbitrary SDK/native content.
import assert from "node:assert/strict";
import {
    chmodSync,
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    renameSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { sdkContentHash, verifySdkProvenance, writeTrustReceipt } from "../scripts/verify-lib.mjs";
import { fingerprintTree } from "./fixtures/security-tree.ts";
import { command, PROJECT, runtime } from "./fixtures/resume-runtime.mjs";

function authorized() {
    const fixture = runtime(
        "throw new Error('verification must never execute this authorized fixture')",
    );
    // Explicit test-owner authorization, before any subsequent adversarial change.
    writeTrustReceipt(PROJECT, fixture.root, "owner-authorized");
    return fixture;
}

test("D2 external receipt binds an explicitly authorized synthetic SDK; service check is read-only and setup never labels it official", async () => {
    const { root, configPath } = authorized();
    const receipt = join(root, "trust/sdk-receipt.json");
    assert.equal(lstatSync(dirname(receipt)).mode & 0o777, 0o700);
    assert.equal(lstatSync(receipt).mode & 0o777, 0o600);
    assert.ok(!receipt.startsWith(join(root, "sdk") + "/"));
    assert.equal(verifySdkProvenance(PROJECT, join(root, "sdk")).trust, "receipt:owner-authorized");
    const before = await fingerprintTree(root);
    const result = command("../service/main", ["--config", configPath, "--check"]);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /receipt:owner-authorized/);
    assert.deepEqual(await fingerprintTree(root), before);
    assert.equal(existsSync(join(root, "service")), false);
    const setup = command("setup", ["--runtime", root, "--check"]);
    assert.notEqual(setup.status, 0, "owner receipt is not an official SDK tree pin");
});

for (const mode of [0o644, 0o666]) {
    test("D2 rejects receipt permission " + mode.toString(8), () => {
        const { root } = authorized();
        chmodSync(join(root, "trust/sdk-receipt.json"), mode);
        assert.throws(() => verifySdkProvenance(PROJECT, join(root, "sdk")), /receipt|0600/i);
    });
}
for (const mode of [0o755, 0o777]) {
    test("D2 rejects trust directory permission " + mode.toString(8), () => {
        const { root } = authorized();
        chmodSync(join(root, "trust"), mode);
        assert.throws(() => verifySdkProvenance(PROJECT, join(root, "sdk")), /trust|0700|private/i);
    });
}

for (const attack of ["inside-sdk", "receipt-symlink", "trust-symlink"]) {
    test("D2 receipt cannot move into SDK or resolve through a symlink: " + attack, () => {
        const { root } = authorized();
        const receipt = join(root, "trust/sdk-receipt.json");
        if (attack === "inside-sdk") {
            renameSync(receipt, join(root, "sdk/sdk-receipt.json"));
        } else if (attack === "receipt-symlink") {
            const outside = join(root, "detached-receipt.json");
            renameSync(receipt, outside);
            symlinkSync(outside, receipt);
        } else {
            const detached = join(root, "detached-trust");
            renameSync(join(root, "trust"), detached);
            symlinkSync(detached, join(root, "trust"));
        }
        assert.throws(
            () => verifySdkProvenance(PROJECT, join(root, "sdk")),
            /receipt|link|content|trusted/i,
        );
    });
}

for (const file of ["src/index.js", "native/layerfs.node"]) {
    test("D2 signed content tamper fails closed without re-signing: " + file, () => {
        const { root, configPath } = authorized();
        writeFileSync(join(root, "sdk", file), "SYNTHETIC_POST_RECEIPT_TAMPER");
        assert.throws(
            () => verifySdkProvenance(PROJECT, join(root, "sdk")),
            /content|addon|receipt/i,
        );
        const result = command("../service/main", ["--config", configPath, "--check"]);
        assert.equal(result.error, undefined);
        assert.notEqual(result.status, 0);
    });
}

test("D2 official SDK/native positive passes actual byte pins without a receipt; checks do not mutate it", async () => {
    const { root, configPath } = runtime();
    cpSync(join(PROJECT, ".runtime/sdk"), join(root, "sdk"), { recursive: true, force: true });
    const pin = JSON.parse(readFileSync(join(PROJECT, "upstream.lock.json"), "utf8"));
    assert.equal(sdkContentHash(join(root, "sdk")), pin.sdk.treeSha256);
    const verified = verifySdkProvenance(PROJECT, join(root, "sdk"));
    assert.equal(verified.trust, "official-pin");
    assert.ok(pin.nativeBuilds.some((build) => build.sha256 === verified.nativeSha256));
    assert.equal(existsSync(join(root, "trust")), false);
    const before = await fingerprintTree(root);
    for (const [script, args] of [
        ["setup", ["--runtime", root, "--check"]],
        ["../service/main", ["--config", configPath, "--check"]],
    ]) {
        const result = command(script, args);
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /official-pin/);
    }
    assert.deepEqual(await fingerprintTree(root), before);
});
