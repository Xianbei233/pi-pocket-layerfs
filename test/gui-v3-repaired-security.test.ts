// Exact repaired child contract. No source data or arbitrary SDK may execute.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { directGuiRuntime } from "./fixtures/gui-v3-runtime.ts";
import { hashStage, previewImport } from "../src/pocket-layerfs/v3/import.ts";
import { createGuiImportTree } from "./fixtures/gui-import-tree.ts";

for (const kind of ["changed-stage", "forged-fixed-sdk", "wrong-home", "source-field", "wrong-operation"] as const) {
    test("repaired child rejects " + kind + " before SDK execution", async (t) => {
        const f = await directGuiRuntime(); t.diagnostic("Retained repaired child: " + f.root);
        try {
            const id = randomBytes(12).toString("hex"); const dir = join(f.dataDir, "pocket-layerfs", "imports", id);
            const stage = join(dir, "stage"); const project = "probe";
            for (const p of [stage, join(f.dataDir, "pocket-layerfs", "projects", project), join(f.config.service.sdkPath, "src"), join(f.config.service.sdkPath, "native")]) await mkdir(p, { recursive: true, mode: 0o700 });
            const marker = join(f.root, "SDK_EXECUTED");
            await writeFile(join(f.config.service.sdkPath, "src", "index.js"), 'require("node:fs").writeFileSync(' + JSON.stringify(marker) + ',"marker");exports.LayerFS=class{};');
            await writeFile(join(f.config.service.sdkPath, "native", "layerfs.node"), "fake");
            await writeFile(join(stage, "public.txt"), "original", { mode: 0o600 });
            const request: any = { version: 1, mode: "import", operation: "project.init", importId: id, project, stage,
                store: join(f.dataDir, "pocket-layerfs", "projects", project, "store.sqlite"), home: f.config.service.layerfsHome,
                sdk: f.config.service.sdkPath, stageHash: hashStage(stage) };
            if (kind === "changed-stage") await writeFile(join(stage, "public.txt"), "changed");
            if (kind === "wrong-home") { request.home = join(f.root, "other-home"); await mkdir(request.home, { mode: 0o700 }); }
            if (kind === "source-field") request.sourcePath = "/synthetic-forbidden";
            if (kind === "wrong-operation") request.operation = "project.verify";
            const path = join(dir, "init-request.json"); await writeFile(path, JSON.stringify(request), { mode: 0o600 });
            const result = spawnSync(process.execPath, [new URL("../src/pocket-layerfs/v3/import-child.mjs", import.meta.url).pathname, "--request", path], {
                env: { PATH: "/usr/bin:/bin", TMPDIR: f.root }, timeout: 10_000, maxBuffer: 16_384, encoding: "utf8",
            });
            await writeFile(join(f.root, "child-result.json"), JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }));
            assert.notEqual(result.status, 0); await assert.rejects(readFile(marker), { code: "ENOENT" });
        } finally { f.close(); }
    });
}

test("all 8 protected unknown stages remain and reject a ninth preview", async (t) => {
    const f = await directGuiRuntime(); const tree = await createGuiImportTree();
    t.diagnostic("Retained protected stages: " + f.root);
    try {
        const stages: string[] = [];
        for (let i = 0; i < 8; i++) {
            const p = previewImport(f.runtime, { ownerId: "test-owner-" + i, expectedSha256: f.saved().sha256, projectId: "retained-" + i, label: "Retained", sourcePath: tree.source, branches: ["main"] });
            const dir = join(f.dataDir, "pocket-layerfs", "imports", p.importId); stages.push(dir);
            await writeFile(join(dir, "import-state.json"), JSON.stringify({ version: 1, state: "unknown", owner: "test", at: Date.now() }), { mode: 0o600 });
        }
        assert.throws(() => previewImport(f.runtime, { ownerId: "ninth-owner", expectedSha256: f.saved().sha256, projectId: "ninth", label: "Ninth", sourcePath: tree.source, branches: ["main"] }), (e: any) => e.code === "Busy");
        for (const dir of stages) assert.equal(JSON.parse(await readFile(join(dir, "import-state.json"), "utf8")).state, "unknown");
    } finally { f.close(); }
});
