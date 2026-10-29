// Additional strict recovery checks. All records and sources are private synthetic data.
import assert from "node:assert/strict";
import { chmod, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { directGuiRuntime } from "./fixtures/gui-v3-runtime.ts";
import { createRuntime } from "../src/pocket-layerfs/v3/runtime.ts";

for (const kind of ["invalid-json", "symlink", "broad-mode", "hash-bytes-mismatch", "stale-target"] as const) {
    test("pending recovery fails closed for " + kind, async (t) => {
        const f = await directGuiRuntime(); let recreated: any;
        t.diagnostic("Retained pending fixture: " + f.root);
        try {
            const path = join(f.dataDir, "pocket-layerfs", ".apply-pending.json");
            const saved = f.saved();
            const record = { previousBytes: saved.bytes.toString("base64"), previousHash: "a".repeat(64), targetHash: saved.sha256, generation: 3, at: Date.now() };
            if (kind === "invalid-json") await writeFile(path, "{bad", { mode: 0o600 });
            else if (kind === "symlink") { const outside = join(f.root, "pending-target"); await writeFile(outside, JSON.stringify(record), { mode: 0o600 }); await symlink(outside, path); }
            else {
                if (kind === "stale-target") record.targetHash = "b".repeat(64);
                await writeFile(path, JSON.stringify(record), { mode: 0o600 });
                if (kind === "broad-mode") await chmod(path, 0o644);
            }
            recreated = createRuntime({ host: f.runtime.host, path: f.path, config: f.config });
            assert.equal(recreated.authorityUnknown, true, "Unusable pending evidence must not authorize saved grants");
            assert.equal(recreated.activeHash, null, "Unverified saved or previous hash must not become active");
        } finally { recreated?.client.close(); f.close(); }
    });
}
