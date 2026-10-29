// No Pocket imports. Child attacks use only private synthetic files.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { directGuiRuntime } from "./fixtures/gui-v3-runtime.ts";
import { previewImport, confirmImport } from "../src/pocket-layerfs/v3/import.ts";
import { createGuiImportTree } from "./fixtures/gui-import-tree.ts";
import { readRegistry } from "../src/pocket-layerfs/v3/registry.ts";

const CHILD = new URL("../src/pocket-layerfs/v3/import-child.mjs", import.meta.url).pathname;

test("import child refuses a forged arbitrary SDK and home before executing SDK JavaScript", async (t) => {
    const f = await directGuiRuntime(); t.diagnostic("Retained child attack: " + f.root);
    try {
        const importId = randomBytes(12).toString("hex");
        const dir = join(f.dataDir, "pocket-layerfs", "imports", importId);
        const stage = join(dir, "stage"); const sdk = join(f.root, "untrusted-sdk");
        const marker = join(f.root, "UNTRUSTED_CODE_EXECUTED");
        const store = join(f.dataDir, "pocket-layerfs", "projects", "attack", "store.sqlite");
        for (const path of [stage, join(sdk, "src"), join(sdk, "native"), join(f.root, "chosen-home"), join(f.dataDir, "pocket-layerfs", "projects", "attack")]) {
            await mkdir(path, { recursive: true, mode: 0o700 });
        }
        await writeFile(join(sdk, "native", "layerfs.node"), "not a native addon");
        await writeFile(join(sdk, "src", "index.js"), 'require("node:fs").writeFileSync(' + JSON.stringify(marker) + ', "SYNTHETIC_TRIPWIRE"); exports.LayerFS = class { constructor() { this.project = { init: async () => ({kind:"Initialized"}) }; } async close() {} };');
        const request = { version: 1, mode: "import", importId, project: "attack", stage, store, home: join(f.root, "chosen-home"), sdk };
        const path = join(dir, "init-request.json"); await writeFile(path, JSON.stringify(request), { mode: 0o600 });
        const result = spawnSync(process.execPath, [CHILD, "--request", path], {
            env: { PATH: "/usr/bin:/bin", TMPDIR: f.root }, timeout: 10_000, encoding: "utf8", maxBuffer: 16_384,
        });
        await writeFile(join(f.root, "child.log"), result.stdout + result.stderr);
        await writeFile(join(f.root, "child.exit"), String(result.status));
        await assert.rejects(lstat(marker), { code: "ENOENT" }, "Untrusted SDK executed before pin validation");
        assert.notEqual(result.status, 0);
    } finally { f.close(); }
});

test("a concurrent preview cannot delete the stage of an import already running", async (t) => {
    const f = await directGuiRuntime(); const tree = await createGuiImportTree();
    t.diagnostic("Retained lifecycle runtime: " + f.root + "; source: " + tree.root);
    const oldPath = process.env.PATH;
    let pending: Promise<any> | undefined;
    try {
        const bin = join(f.root, "bin"); await mkdir(bin, { mode: 0o700 });
        const child = join(bin, "unshare");
        // Test-owned child barrier. It executes no source file and no native call.
        await writeFile(child, "#!/bin/sh\n/usr/bin/sleep 0.5\nexit 2\n", { mode: 0o700 });
        process.env.PATH = bin + ":/usr/bin:/bin";
        const input = { ownerId: f.owner, expectedSha256: f.saved().sha256, projectId: "first", label: "First", sourcePath: tree.source, branches: ["main"] };
        const first = previewImport(f.runtime, input);
        const stage = join(f.dataDir, "pocket-layerfs", "imports", first.importId, "stage");
        pending = confirmImport(f.runtime, { ownerId: f.owner, ticket: first.ticket, expectedSha256: input.expectedSha256 }).catch((e) => e);
        let refused = false;
        try { previewImport(f.runtime, { ...input, projectId: "second" }); } catch { refused = true; }
        let stageExists = true; try { await lstat(stage); } catch { stageExists = false; }
        assert.ok(refused || stageExists, "Preview deleted the stage while the child was active");
    } finally { await pending; process.env.PATH = oldPath; f.close(); }
});
