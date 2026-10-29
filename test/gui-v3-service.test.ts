import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { directGuiRuntime } from "./fixtures/gui-v3-runtime.ts";
import { BoundedQueue } from "../service/queue.mjs";
import { Engine, clientKey } from "../service/engine.mjs";
import { createServiceControl } from "../service/control.mjs";

function deferred() { let resolve!: (value?: any) => void; const promise = new Promise<any>((r) => { resolve = r; }); return { promise, resolve }; }

test("service pause rejects queued calls and drains true active work without closing it", async () => {
    const queue = new BoundedQueue({ concurrency: 1 }); const barrier = deferred(); let queuedRan = false;
    const active = queue.run(() => barrier.promise, { timeoutMs: 1000 });
    const queued = queue.run(async () => { queuedRan = true; }, { timeoutMs: 1000 });
    const rejected = assert.rejects(queued, (e: any) => e.code === "Busy");
    queue.pause(); await rejected;
    assert.equal(await queue.waitForIdle(20), false); assert.equal(queuedRan, false);
    barrier.resolve("settled"); assert.equal(await active, "settled");
    assert.equal(await queue.waitForIdle(100), true);
    queue.resume(); assert.equal(await queue.run(async () => 7, { timeoutMs: 1000 }), 7); await queue.close();
});

test("service generation apply reads the fixed config, shares full identity, and closes only settled orphans", async (t) => {
    const f = await directGuiRuntime(); t.diagnostic("Retained service control: " + f.root);
    const closes: string[] = []; const calls: string[] = [];
    class FakeLayerFS {
        project: any;
        constructor(id: string) { calls.push(id); this.project = { list_branches: async () => ({ items: [{ name: "main" }], hasMore: false }) }; }
        async close() { closes.push("candidate"); }
    }
    try {
        const sdk = f.config.service.sdkPath;
        for (const path of [join(sdk, "src"), join(sdk, "native")]) await mkdir(path, { mode: 0o700 });
        for (const path of ["package.json", "UPSTREAM.json", "src/index.js", "native/layerfs.node"]) await writeFile(join(sdk, path), "test-only");
        const queue = new BoundedQueue(); const clients = new Map<string, any>();
        const oldKey = clientKey(f.config.projects[0], f.config.service.layerfsHome);
        clients.set(oldKey, { project: { list_branches: async () => ({ items: [{ name: "main" }], hasMore: false }) }, close: async () => closes.push("old") });
        const upstream = { version: "1.0.0", commit: "test-control-only" };
        const runtime: any = { config: f.config, configPath: f.path, activeHash: f.saved().sha256, generation: 0, appliedAt: 0, startedAt: 1,
            queue, clients, LayerFS: FakeLayerFS, upstream, engine: {}, log: () => {}, applyBusy: false };
        const control = createServiceControl(runtime, { verifyUpstream: () => upstream });
        const base = runtime.activeHash; const changed = { ...f.config, projects: [{ ...f.config.projects[0], label: "Changed" }] };
        await writeFile(f.path, JSON.stringify(changed)); const target = f.saved().sha256;
        const result = await control.apply({ baseActiveHash: base, targetHash: target, expectedGeneration: 0 });
        assert.equal(result.generation, 1); assert.equal(control.status().activeHash, target); assert.equal(calls.length, 0); assert.deepEqual(closes, []);
        await assert.rejects(control.apply({ baseActiveHash: target, targetHash: target, expectedGeneration: 0 }), (e: any) => e.code === "StaleGeneration");
        assert.notEqual(clientKey(f.config.projects[0], "other-home"), oldKey);
        assert.notEqual(clientKey({ ...f.config.projects[0], storePath: "/other/store.sqlite" }, f.config.service.layerfsHome), oldKey);
        const barrier = deferred(); const active = queue.run(() => barrier.promise, { timeoutMs: 1000 });
        await writeFile(f.path, JSON.stringify({ ...changed, projects: [] })); const next = f.saved().sha256;
        const applying = control.apply({ baseActiveHash: target, targetHash: next, expectedGeneration: 1 });
        await new Promise((resolve) => setImmediate(resolve)); assert.deepEqual(closes, []);
        barrier.resolve(); await active; await applying; assert.deepEqual(closes, ["old"]); assert.equal(control.status().generation, 2);
        await queue.close();
    } finally { f.close(); }
});
