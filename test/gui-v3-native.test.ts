// Real pinned SDK. No Pocket or Owner source data.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { directGuiRuntime } from "./fixtures/gui-v3-runtime.ts";
import { createGuiImportTree } from "./fixtures/gui-import-tree.ts";
import { assertBinarySnapshotBytes } from "./fixtures/gui-binary-oracle.ts";
import { assertImportedFiles } from "./fixtures/gui-contract-driver.ts";
import { assertExclusiveRuntime } from "../scripts/runtime-lib.mjs";
import { verifySdkProvenance } from "../scripts/verify-lib.mjs";
import { previewImport, confirmImport } from "../src/pocket-layerfs/v3/import.ts";
import { readRegistry } from "../src/pocket-layerfs/v3/registry.ts";

const SOURCE = new URL("../", import.meta.url).pathname;

test("real pinned native import returns verified unpublished-ready and exact selected bytes", { timeout: 150_000 }, async (t) => {
    const evidence = await mkdtemp(join(SOURCE, ".runtime-gui-native-"));
    const f = await directGuiRuntime(evidence);
    const tree = await createGuiImportTree();
    t.diagnostic("Retained native runtime: " + f.root + "; source: " + tree.root);
    try {
        const nativeRuntime = join(f.root, "native"); assertExclusiveRuntime(nativeRuntime, { create: true });
        await cp(join(SOURCE, ".runtime", "sdk"), join(nativeRuntime, "sdk"), { recursive: true, dereference: false });
        const provenance = verifySdkProvenance(SOURCE, join(nativeRuntime, "sdk"), { requireOfficialSdk: true });
        assert.equal(provenance.trust, "official-pin");
        const config = { ...f.config, service: { ...f.config.service, sdkPath: join(nativeRuntime, "sdk") } };
        f.runtime.config = config;
        await writeFile(f.path, JSON.stringify(config, null, 4) + "\n", { mode: 0o600 });
        f.runtime.activeHash = f.saved().sha256;
        const before = await tree.snapshot(); const saved = f.saved();
        const projectId = "native-" + Date.now().toString(36);
        const p = previewImport(f.runtime, { ownerId: f.owner, expectedSha256: saved.sha256, projectId, label: "Real native fixture", sourcePath: tree.source, branches: ["main"] });
        let answer: any; let failure: any;
        try { answer = await confirmImport(f.runtime, { ownerId: f.owner, ticket: p.ticket, expectedSha256: saved.sha256 }); }
        catch (e) { failure = e; }
        await writeFile(join(f.root, "confirm-result.json"), JSON.stringify({ answer, failure: failure ? { message: failure.message, code: failure.code, status: failure.status } : null, registry: readRegistry(f.runtime.host) }, null, 2));
        assert.deepEqual(await tree.snapshot(), before, "Native import changed the source");
        assert.deepEqual(f.saved().bytes, saved.bytes, "Import published config before apply");
        assert.equal(await readFile(f.config.projects[0].storePath, "utf8"), "OLD_STORE_MUST_REMAIN");
        // Read the actual Store even if final verification failed. This is evidence, not a success substitute.
        const { LayerFS } = await import(new URL("file://" + join(nativeRuntime, "sdk", "src", "index.js")).href);
        process.env.LAYERFS_HOME = config.service.layerfsHome;
        process.env.LAYERFS_NATIVE = join(nativeRuntime, "sdk", "native", "layerfs.node");
        const client = new LayerFS(projectId, { storePath: join(f.dataDir, "pocket-layerfs", "projects", projectId, "store.sqlite") });
        const actual = new Map<string, Uint8Array>();
        let nativeReadError: any;
        const byteErrors: string[] = [];
        const binaryProofs: unknown[] = [];
        try {
            const dirs = ["/"];
            while (dirs.length) {
                const path = dirs.pop()!; let pos = 0;
                for (;;) {
                    const listing = await client.fs.list("main", path, 100, pos);
                    for (const item of listing.items) {
                        const next = path === "/" ? "/" + item.name : path + "/" + item.name;
                        if (item.type === "dir") dirs.push(next);
                        else {
                            try {
                                const read = await client.fs.read("main", next, 1);
                                actual.set(next.slice(1), Buffer.from(read.text, "utf8"));
                            } catch (error: any) {
                                if (error.code !== "Binary") { byteErrors.push(next + ":" + error.code); }
                                else {
                                    const expected = tree.expected.get(next.slice(1));
                                    assert.ok(expected, "Unexpected binary path: " + next);
                                    binaryProofs.push(await assertBinarySnapshotBytes({ client, importRef: "main", path: next, expected }));
                                    actual.set(next.slice(1), expected);
                                }
                            }
                        }
                    }
                    if (!listing.hasMore) break;
                    pos = listing.nextPagePos ?? pos + listing.items.length;
                }
            }
        } catch (e: any) { nativeReadError = { message: e.message, code: e.code }; }
        finally { await client.close(); }
        await writeFile(join(f.root, "native-logical-read.json"), JSON.stringify({ files: [...actual].map(([path, bytes]) => ({ path, base64: Buffer.from(bytes).toString("base64") })), nativeReadError, byteErrors, binaryProofs }, null, 2));
        assert.equal(failure, undefined, "Confirmed import must finish verified unpublished-ready: " + failure?.message);
        assert.equal(answer.state, "unpublished-ready");
        assert.equal(nativeReadError, undefined);
        assert.deepEqual(byteErrors, [], "Pinned SDK cannot prove complete file-byte equality for Binary refusals");
        assertImportedFiles(actual, tree.expected, tree.marker);
        assert.equal(binaryProofs.length, 1);
        assert.deepEqual(await tree.snapshot(), before, "Binary oracle changed the source");
    } finally { f.close(); }
});
