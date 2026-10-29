// Direct business tests. No Pocket app or real Owner data is imported.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createGuiImportTree } from "./fixtures/gui-import-tree.ts";
import { assertImportedFiles } from "./fixtures/gui-contract-driver.ts";
import { directGuiRuntime, testWeb } from "./fixtures/gui-v3-runtime.ts";
import { walkSource, previewImport, confirmImport, LIMITS } from "../src/pocket-layerfs/v3/import.ts";
import { TicketStore } from "../src/pocket-layerfs/v3/tickets.ts";
import { readRegistry } from "../src/pocket-layerfs/v3/registry.ts";
import { createRuntime } from "../src/pocket-layerfs/v3/runtime.ts";
import { applyDraft, checkStatus } from "../src/pocket-layerfs/v3/apply.ts";
import { draftFromConfig, parseDraft } from "../src/pocket-layerfs/v3/gui.ts";
import { LayerfsRefusal, CODES } from "../src/pocket-layerfs/v3/errors.ts";
import { assertExclusiveRuntime } from "../scripts/runtime-lib.mjs";
import { verifySdkProvenance } from "../scripts/verify-lib.mjs";

const SOURCE = new URL("../", import.meta.url).pathname;
const errorCode = (code: string) => (error: any) => error.code === code;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const editableDraft = (config: any) => ({ projects: config.projects.map(({ id, label, branches }: any) => ({ id, label, branches: [...branches] })), toolsEnabled: config.tools.enabled, sessionGrants: config.sessionGrants.map(({ conversationId, project, allowTools, toolBranches }: any) => ({ conversationId, project, allowTools, toolBranches: [...toolBranches] })) });

test("v3 filtered stage exactly matches the independent selected-tree manifest", async (t) => {
    const f = await directGuiRuntime(); const tree = await createGuiImportTree();
    t.diagnostic("Retained runtime: " + f.root + "; source: " + tree.root);
    try {
        const before = await tree.snapshot(); const stage = join(f.root, "stage");
        await mkdir(stage, { mode: 0o700 });
        const result = walkSource({ sourcePath: tree.source, stageRoot: stage, context: { config: f.config, dataDir: f.dataDir } });
        const actual = new Map<string, Buffer>();
        for (const entry of result.entries.filter((entry: any) => entry.type === "file" && entry.sha)) {
            try { actual.set(entry.rel, await readFile(join(stage, entry.rel))); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
        }
        assertImportedFiles(actual, tree.expected, tree.marker);
        assert.deepEqual(await tree.snapshot(), before);
        await assert.rejects(lstat(tree.tripwire), { code: "ENOENT" });
    } finally { f.close(); }
});

test("v3 rejected hardlink and FIFO walks do not leak descriptors", async (t) => {
    const f = await directGuiRuntime(); const tree = await createGuiImportTree();
    t.diagnostic("Retained runtime: " + f.root + "; source: " + tree.root);
    try {
        const bad = await tree.rejectionTree("hardlink"); const fifo = await tree.rejectionTree("fifo");
        const before = (await readdir("/proc/self/fd")).length;
        for (let i = 0; i < 20; i++) {
            assert.throws(() => walkSource({ sourcePath: i % 2 ? bad : fifo, stageRoot: null, context: { config: f.config, dataDir: f.dataDir } }));
        }
        const after = (await readdir("/proc/self/fd")).length;
        assert.ok(after <= before + 1, "Descriptor count grew from " + before + " to " + after);
    } finally { f.close(); }
});

test("v3 .env-star exclusion includes .envrc and .envproduction", async (t) => {
    const f = await directGuiRuntime(); const source = join(f.root, "source");
    t.diagnostic("Retained runtime: " + f.root);
    try {
        await mkdir(source, { mode: 0o700 });
        await writeFile(join(source, ".envrc"), "HARMLESS_EXCLUDED_ENVRC");
        await writeFile(join(source, ".envproduction"), "HARMLESS_EXCLUDED_ENVPROD");
        await writeFile(join(source, "public.txt"), "ordinary");
        const result = walkSource({ sourcePath: source, stageRoot: null, context: { config: f.config, dataDir: f.dataDir } });
        assert.ok(!result.included.some((entry: any) => entry.path.startsWith(".env")), "Sensitive .env* entered included list");
    } finally { f.close(); }
});

test("v3 ignore text enforces the aggregate 256 KiB bound", async (t) => {
    const f = await directGuiRuntime(); const source = join(f.root, "source");
    t.diagnostic("Retained runtime: " + f.root);
    try {
        await mkdir(source, { mode: 0o700 });
        const rules = "#" + "x".repeat(140 * 1024) + "\n";
        await writeFile(join(source, ".gitignore"), rules);
        await mkdir(join(source, "nested")); await writeFile(join(source, "nested", ".gitignore"), rules);
        assert.throws(() => walkSource({ sourcePath: source, stageRoot: null, context: { config: f.config, dataDir: f.dataDir } }),
            (error: any) => error.status === 422, "Aggregate ignore text over 256 KiB must refuse");
    } finally { f.close(); }
});

test("v3 source and stage changes consume the old ticket without native publication", async (t) => {
    const f = await directGuiRuntime(); const tree = await createGuiImportTree();
    t.diagnostic("Retained runtime: " + f.root + "; source: " + tree.root);
    try {
        for (const target of ["source", "stage"]) {
            const p = previewImport(f.runtime, { ownerId: f.owner, expectedSha256: f.saved().sha256, projectId: "import-" + randomBytes(4).toString("hex"), label: "Snapshot", sourcePath: tree.source, branches: ["main"] });
            const path = target === "source" ? join(tree.source, "public.txt") : join(f.dataDir, "pocket-layerfs", "imports", p.importId, "stage", "public.txt");
            await writeFile(path, "Explicit test-owned change " + target);
            await assert.rejects(confirmImport(f.runtime, { ownerId: f.owner, ticket: p.ticket, expectedSha256: f.saved().sha256 }), (e: any) => e.status === 409);
            await assert.rejects(confirmImport(f.runtime, { ownerId: f.owner, ticket: p.ticket, expectedSha256: f.saved().sha256 }), errorCode(CODES.TicketUsed));
            assert.equal(readRegistry(f.runtime.host).stores.length, 0);
        }
    } finally { f.close(); }
});

test("v3 import tickets bind identity, TTL, operation, and one concurrent consumer", async () => {
    let now = 10; const tickets = new TicketStore({ now: () => now });
    const binding = { ownerId: "generated-test-owner", conversationId: "", project: "p", op: "project.import", sourceFingerprint: "a".repeat(64), stageHash: "b".repeat(64), configRevision: "c".repeat(64), importId: "d".repeat(24) };
    const issued = tickets.issue(binding, { ttlMs: 300_000 });
    assert.equal(issued.record.expiresAt, 300_010);
    assert.throws(() => tickets.take(issued.ticket, { ownerId: "other", op: binding.op }), errorCode(CODES.TicketMismatch));
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, async () => tickets.take(issued.ticket, { ownerId: binding.ownerId, op: binding.op })));
    assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
    const expiring = tickets.issue(binding, { ttlMs: 300_000 }); now = 300_010;
    assert.throws(() => tickets.take(expiring.ticket, { ownerId: binding.ownerId, op: binding.op }), errorCode(CODES.TicketExpired));
});

function fakeService(f: any, mode: "ok" | "refuse" | "unknown" | "mismatch") {
    const state = { hash: mode === "mismatch" ? "f".repeat(64) : f.runtime.activeHash, generation: 0, calls: 0 };
    f.runtime.service = {
        configStatus: async () => ({ activeHash: state.hash, generation: state.generation }),
        branches: async () => ({ items: [{ name: "main" }], hasMore: false }),
        configApply: async (args: any) => {
            state.calls++;
            if (mode === "refuse") throw new LayerfsRefusal(CODES.NotApplied);
            state.hash = args.targetHash; state.generation++;
            if (mode === "unknown") throw new LayerfsRefusal(CODES.Timeout);
            return { applied: true, activeHash: state.hash, generation: state.generation };
        },
    };
    return state;
}

test("v3 apply compensates definite refusal and serializes competing CAS writes", async (t) => {
    const f = await directGuiRuntime(); t.diagnostic("Retained runtime: " + f.root);
    try {
        const web = testWeb(); const request = { user: { id: f.owner, role: "owner" }, sessions: () => [] };
        const old = f.saved(); const draft = editableDraft(f.config); draft.projects[0].label = "Changed";
        const state = fakeService(f, "refuse");
        await assert.rejects(applyDraft(f.runtime, { expectedSha256: old.sha256, draft }, request, web));
        assert.deepEqual(f.saved().bytes, old.bytes); assert.equal(f.runtime.activeHash, old.sha256); assert.equal(state.calls, 1);
        fakeService(f, "ok");
        const outcomes = await Promise.allSettled(["One", "Two"].map((label) => applyDraft(f.runtime, { expectedSha256: old.sha256, draft: { ...draft, projects: [{ ...draft.projects[0], label }] } }, request, web)));
        assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
        assert.equal(outcomes.filter((o) => o.status === "rejected").length, 1);
        assert.equal(f.runtime.activeHash, f.saved().sha256);
    } finally { f.close(); }
});

test("v3 unverified service mismatch refuses apply even when plugin equals saved", async (t) => {
    const f = await directGuiRuntime(); t.diagnostic("Retained runtime: " + f.root);
    try {
        const state = fakeService(f, "mismatch"); const before = f.saved();
        const draft = editableDraft(f.config); draft.toolsEnabled = true;
        await assert.rejects(applyDraft(f.runtime, { expectedSha256: before.sha256, draft }, { user: { id: f.owner, role: "owner" }, sessions: () => [] }, testWeb()), (e: any) => e.status === 409);
        assert.equal(state.calls, 0); assert.deepEqual(f.saved().bytes, before.bytes);
    } finally { f.close(); }
});

test("v3 unknown apply survives module runtime recreation and reconciles without replay", async (t) => {
    const f = await directGuiRuntime(); t.diagnostic("Retained runtime: " + f.root);
    let recreated: any;
    try {
        const state = fakeService(f, "unknown"); const draft = editableDraft(f.config); draft.toolsEnabled = true;
        await assert.rejects(applyDraft(f.runtime, { expectedSha256: f.saved().sha256, draft }, { user: { id: f.owner, role: "owner" }, sessions: () => [] }, testWeb()), (e: any) => e.status === 504);
        assert.equal(state.calls, 1); assert.equal(f.runtime.lastApply.outcome, "unknown");
        const saved = JSON.parse(f.saved().bytes.toString("utf8"));
        recreated = createRuntime({ host: f.runtime.host, path: f.path, config: saved });
        assert.equal(recreated.lastApply?.outcome, "unknown", "Pending apply must be recovered, not silently adopted");
        recreated.service = { configStatus: async () => ({ activeHash: state.hash, generation: state.generation }) };
        const checked = await checkStatus(recreated, testWeb());
        assert.equal(checked.adopted, true); assert.equal(state.calls, 1);
    } finally { recreated?.client.close(); f.close(); }
});

test("v3 draft parser rejects privileged fields at every editable level", async () => {
    const f = await directGuiRuntime();
    try {
        const draft = editableDraft(f.config);
        for (const key of ["write", "fork", "ownerPersonIds", "service", "storePath", "sourcePath", "unknown"]) {
            assert.ok(parseDraft({ ...draft, [key]: {} }).errors.length > 0, key);
            assert.ok(parseDraft({ ...draft, projects: [{ ...draft.projects[0], [key]: {} }] }).errors.length > 0, key);
        }
    } finally { f.close(); }
});


test("v3 exported GUI draft is accepted unchanged by the strict parser", async () => {
    const f = await directGuiRuntime();
    try { assert.deepEqual(parseDraft(draftFromConfig(f.config)).errors, []); }
    finally { f.close(); }
});


test("v3 unsafe source forms, private roots, and limits refuse without tickets", async (t) => {
    const f = await directGuiRuntime(); t.diagnostic("Retained bounds runtime: " + f.root);
    try {
        const { validateSource } = await import("../src/pocket-layerfs/v3/import.ts");
        const context = { dataDir: f.dataDir, config: f.config };
        for (const path of ["", ".", "relative", "/", f.dataDir, f.root, f.config.service.runtimeDir]) {
            assert.throws(() => validateSource(path, context), path);
        }
        const source = join(f.root, "limits"); await mkdir(source);
        await writeFile(join(source, "too-large.txt"), Buffer.alloc(LIMITS.fileBytes + 1));
        assert.throws(() => previewImport(f.runtime, { ownerId: f.owner, expectedSha256: f.saved().sha256, projectId: "oversize", label: "Oversize", sourcePath: source, branches: ["main"] }), (e: any) => e.status === 422);
        assert.equal(f.runtime.tickets.size, 0); assert.equal(readRegistry(f.runtime.host).stores.length, 0);
    } finally { f.close(); }
});

test("v3 retained preview storage never exceeds the 8-folder bound", async (t) => {
    const f = await directGuiRuntime(); const tree = await createGuiImportTree();
    t.diagnostic("Retained storage runtime: " + f.root);
    try {
        for (let i = 0; i < 10; i++) {
            previewImport(f.runtime, { ownerId: "isolated-owner-" + i, expectedSha256: f.saved().sha256, projectId: "candidate-" + i, label: "Candidate", sourcePath: tree.source, branches: ["main"] });
        }
        const dirs = await readdir(join(f.dataDir, "pocket-layerfs", "imports"));
        assert.ok(dirs.length <= 8, "Retained preview folders: " + dirs.length);
    } finally { f.close(); }
});
