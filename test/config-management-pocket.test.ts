// Official isolation first. Phase B tests use real Pocket loading and loopback HTTP.
// Frozen handoff: version 0.2.0 / API1 on Pocket 0.19.0 / API2.
import { cleanUp, lastText, modelTexts, owner, root, say, scriptedModel } from "/home/xianbei233/Work/pi-pocket-production/test/helpers.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createPocketFixture } from "./fixtures/pocket-harness.ts";
import { productPeer, PEER_TOKEN } from "./fixtures/product-peer.ts";
import { fingerprintTree } from "./fixtures/security-tree.ts";
import { validateConfig } from "../src/pocket-layerfs/config.ts";

const PROJECT = resolve(import.meta.dirname, "..");
const CONFIG = "/api/x/pocket-layerfs/config";
after(cleanUp);

async function fixture() {
    const tools = new Set<string>();
    const replies: string[] = [];
    const model = scriptedModel((request) => {
        for (const message of request.messages) {
            if (message.role === "system") {
                for (const tool of message.toolsAdded ?? []) { tools.add(tool.name); }
                for (const tool of message.toolsRemoved ?? []) { tools.delete(tool.name); }
            }
        }
        const last = lastText(request as never);
        if (last.role === "toolResult") {
            replies.push(last.text);
            return fauxAssistantMessage([fauxText(last.text)]);
        }
        if (last.text.replace(/^\[from:[^\]]+\]\s*/, "") === "read") {
            return fauxAssistantMessage([fauxToolCall("layerfs_read", { project: "alpha", ref: "feature", path: "/public.txt" })], { stopReason: "toolUse" });
        }
        return fauxAssistantMessage([fauxText("inventory recorded")]);
    });
    const f = await createPocketFixture({
        files: [
            { from: join(PROJECT, "src/pocket-layerfs.ts"), name: "pocket-layerfs.ts" },
            { from: join(PROJECT, "src/pocket-layerfs"), name: "pocket-layerfs" },
        ],
        model,
    });
    const directory = join(f.dataDir, "pocket-layerfs");
    const path = join(directory, "config.json");
    const runtime = join(root, "cfg-" + crypto.randomUUID().slice(0, 8));
    function candidate() {
        return {
            version: 1,
            ownerPersonIds: [f.actors.owner.id],
            tools: { enabled: true },
            write: { enabled: false },
            service: {
                runtimeDir: runtime,
                socketPath: join(runtime, "service.sock"),
                tokenFile: join(runtime, "service.token"),
                layerfsHome: join(runtime, "home"),
                sdkPath: join(runtime, "sdk/index.js"),
            },
            projects: [{ id: "alpha", storePath: join(runtime, "alpha/store.sqlite"), branches: ["feature"] }],
            sessionGrants: [{ conversationId: String(f.session), project: "alpha", allowTools: true, toolBranches: ["feature"] }],
        };
    }
    async function hash() {
        return createHash("sha256").update(await readFile(path)).digest("hex");
    }
    async function snapshot() {
        try { return await fingerprintTree(directory); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") { return null; }
            throw error;
        }
    }
    async function put(value: unknown, expectedSha256: string | null) {
        return f.call("owner", CONFIG, { method: "PUT", body: { expectedSha256, candidate: value } });
    }
    // Official HTTP signature: POST config/delete with JSON { expectedSha256 }.
    // Pocket does not parse a DELETE request body. Exact-hash rollback stays mandatory.
    async function remove(expectedSha256: string) {
        return f.call("owner", CONFIG + "/delete", { method: "POST", body: { expectedSha256 } });
    }
    async function reload() {
        await f.app.setExtensionEnabled(owner(f.app), "pocket-layerfs.ts", false);
        await f.app.setExtensionEnabled(owner(f.app), "pocket-layerfs.ts", true);
    }
    return { ...f, tools, replies, directory, path, runtime, candidate, hash, snapshot, put, remove, reload };
}

function successful(response: { status: number }) {
    assert.ok(response.status >= 200 && response.status < 300, "expected a successful configuration response, got " + response.status);
}

function safe(response: { text: string }, candidate: ReturnType<Awaited<ReturnType<typeof fixture>>["candidate"]>) {
    for (const secret of [
        candidate.service.runtimeDir, candidate.service.socketPath, candidate.service.tokenFile,
        candidate.service.layerfsHome, candidate.service.sdkPath, candidate.projects[0].storePath,
        ...candidate.ownerPersonIds, PEER_TOKEN,
    ]) {
        assert.ok(!response.text.includes(secret), "safe config response disclosed a private value");
    }
    assert.ok(!response.text.includes('"candidate"'), "GET must not return the full candidate");
}

test("config bootstrap exposes only owner-authenticated routes and rejects missing CSRF header", async () => {
    const f = await fixture();
    try {
        const initial = await f.call("owner", CONFIG);
        assert.equal(initial.status, 200);
        assert.equal((initial.data as any).reloadRequired, false);
        assert.equal(await f.snapshot(), null);
        const body = { expectedSha256: null, candidate: f.candidate() };
        for (const actor of ["guest", "viewer", "singleSessionGuest"] as const) {
            for (const method of ["GET", "PUT", "POST"]) {
                const before = await f.snapshot();
                const path = method === "POST" ? CONFIG + "/delete" : CONFIG;
                assert.equal((await f.call(actor, path, { method, ...(method === "GET" ? {} : { body }) })).status, 404);
                assert.deepEqual(await f.snapshot(), before);
            }
        }
        for (const method of ["GET", "PUT", "POST"]) {
            const path = method === "POST" ? CONFIG + "/delete" : CONFIG;
            assert.equal((await f.call(null, path, { method, ...(method === "GET" ? {} : { body }) })).status, 401);
            assert.equal((await f.call("owner", path, { method, pocketHeader: false, ...(method === "GET" ? {} : { body }) })).status, 403);
        }
        assert.equal(await f.snapshot(), null);
        await say(f.app, f.session, "inventory");
        assert.deepEqual([...f.tools].filter((name) => name.startsWith("layerfs_")), []);
    } finally { await f.close(); }
});

test("config rejects malformed hashes and invalid candidates before filesystem changes", async () => {
    const f = await fixture();
    try {
        const invalid = [
            null, [], {}, { ...f.candidate(), version: 999 },
            { ...f.candidate(), tools: { enabled: "yes" } },
            { ...f.candidate(), ownerPersonIds: ["unrelated-synthetic-owner"] },
            { ...f.candidate(), projects: [{ id: "alpha", storePath: "relative", branches: ["feature"] }] },
            { ...f.candidate(), service: { ...f.candidate().service, socketPath: join(f.runtime, "../outside.sock") } },
        ];
        for (const candidate of invalid) {
            const before = await f.snapshot();
            assert.equal((await f.put(candidate, null)).status, 400);
            assert.deepEqual(await f.snapshot(), before);
        }
        for (const body of [null, {}, { candidate: f.candidate() }, { expectedSha256: 2, candidate: f.candidate() }, { expectedSha256: "bad", candidate: f.candidate() }]) {
            const before = await f.snapshot();
            assert.equal((await f.call("owner", CONFIG, { method: "PUT", body })).status, 400);
            assert.deepEqual(await f.snapshot(), before);
        }
    } finally { await f.close(); }
});

test("config PUT creates private files, exposes no paths, and keeps tools denied until official reload", async () => {
    const f = await fixture();
    let peer: Awaited<ReturnType<typeof productPeer>> | undefined;
    try {
        const candidate = f.candidate();
        const changed = await f.put(candidate, null);
        successful(changed);
        assert.equal((changed.data as any).reloadRequired, true);
        const dir = await lstat(f.directory);
        const file = await lstat(f.path);
        assert.equal(dir.mode & 0o777, 0o700);
        assert.equal(file.mode & 0o777, 0o600);
        assert.equal(dir.uid, process.getuid!());
        assert.equal(file.uid, process.getuid!());
        assert.ok(file.isFile() && !file.isSymbolicLink());
        assert.equal(file.nlink, 1);
        const stored = JSON.parse(await readFile(f.path, "utf8"));
        assert.deepEqual(stored.ownerPersonIds, candidate.ownerPersonIds);
        assert.deepEqual(stored.projects, candidate.projects);
        assert.deepEqual((await readdir(f.directory)).sort(), ["config.json"]);
        const digest = await f.hash();
        const summary = await f.call("owner", CONFIG);
        assert.equal(summary.status, 200);
        assert.equal((summary.data as any).hash, digest);
        assert.equal((summary.data as any).activeHash, null);
        assert.equal((summary.data as any).configured, true);
        assert.equal((summary.data as any).writable, true);
        assert.deepEqual((summary.data as any).projectIds, ["alpha"]);
        assert.equal((summary.data as any).projectCount, 1);
        assert.equal((summary.data as any).grantCount, 1);
        assert.equal((summary.data as any).ownerIdCount, 1);
        assert.equal((summary.data as any).reloadRequired, true);
        safe(summary, candidate);
        await say(f.app, f.session, "inventory");
        assert.deepEqual([...f.tools].filter((name) => name.startsWith("layerfs_")), []);
        peer = await productPeer(validateConfig(stored));
        await f.reload();
        const loaded = await f.call("owner", CONFIG);
        assert.equal(loaded.status, 200);
        assert.equal((loaded.data as any).reloadRequired, false);
        assert.equal((loaded.data as any).activeHash, digest);
        safe(loaded, candidate);
        await say(f.app, f.session, "read");
        assert.equal([...f.tools].filter((name) => name.startsWith("layerfs_")).length, 9);
        assert.match(f.replies.at(-1) ?? "", /BBBB/);
        assert.ok(peer.operations.some((operation) => operation.op === "read" && operation.args.scope === "tool"));
        const deleted = await f.remove(await f.hash());
        successful(deleted);
        assert.equal((deleted.data as any).reloadRequired, true);
        assert.equal((deleted.data as any).activeHash, digest);
        assert.equal((deleted.data as any).hash, null);
        await f.reload();
        await say(f.app, f.session, "inventory");
        assert.deepEqual([...f.tools].filter((name) => name.startsWith("layerfs_")), []);
        assert.match((await modelTexts(f.app, f.session)).at(-1) ?? "", /inventory recorded/);
    } finally { await f.close(); await peer?.close(); }
});

test("config compare-and-swap rejects stale/null hashes and all failed writes preserve exact fingerprints", async () => {
    const f = await fixture();
    try {
        successful(await f.put(f.candidate(), null));
        const digest = await f.hash();
        for (const expected of [null, "0".repeat(64)]) {
            const before = await f.snapshot();
            assert.equal((await f.put(f.candidate(), expected)).status, 409);
            assert.deepEqual(await f.snapshot(), before);
        }
        const before = await f.snapshot();
        assert.equal((await f.put({ ...f.candidate(), version: 99 }, digest)).status, 400);
        assert.deepEqual(await f.snapshot(), before);
        for (const body of [{}, { expectedSha256: null }, { expectedSha256: "bad" }]) {
            assert.equal((await f.call("owner", CONFIG + "/delete", { method: "POST", body })).status, 400);
            assert.deepEqual(await f.snapshot(), before);
        }
        assert.equal((await f.remove("0".repeat(64))).status, 409);
        assert.deepEqual(await f.snapshot(), before);
    } finally { await f.close(); }
});

test("concurrent config writes with one expected hash admit exactly one atomic replacement", async () => {
    const f = await fixture();
    try {
        successful(await f.put(f.candidate(), null));
        const digest = await f.hash();
        const a = { ...f.candidate(), tools: { enabled: false } };
        const b = { ...f.candidate(), write: { enabled: true } };
        const results = await Promise.all([f.put(a, digest), f.put(b, digest)]);
        const winner = results.findIndex((result) => result.status >= 200 && result.status < 300);
        assert.ok(winner >= 0);
        assert.equal(results[1 - winner].status, 409);
        const stored = JSON.parse(await readFile(f.path, "utf8"));
        const wanted = [a, b][winner];
        assert.equal(stored.tools.enabled, wanted.tools.enabled);
        assert.equal(stored.write.enabled, wanted.write.enabled);
        assert.equal((await lstat(f.path)).mode & 0o777, 0o600);
        assert.deepEqual((await readdir(f.directory)).sort(), ["config.json"]);
    } finally { await f.close(); }
});

test("bound config identity comes from authenticated person and path conversation, never query claims", async () => {
    const f = await fixture();
    try {
        for (const conversation of [f.session, f.otherSession]) {
            const path = CONFIG + "/whoami/" + conversation;
            const response = await f.call("owner", path + "?personId=forged&role=guest&conversationId=forged");
            assert.equal(response.status, 200);
            assert.equal((response.data as any).personId, f.actors.owner.id);
            assert.equal((response.data as any).role, "owner");
            assert.equal(String((response.data as any).conversationId), String(conversation));
            assert.equal((response.data as any).activeHash, null);
            assert.equal((response.data as any).currentHash, null);
            // The official router rejects unsupported methods before plugin dispatch.
            assert.equal((await f.call("owner", path, { method: "POST", body: { personId: "forged", role: "owner", conversationId: f.otherSession } })).status, 405);
            for (const actor of ["guest", "viewer", "singleSessionGuest"] as const) {
                assert.equal((await f.call(actor, path)).status, 404);
            }
            assert.equal((await f.call("owner", path, { pocketHeader: false })).status, 403);
        }
        assert.equal((await f.call("owner", CONFIG + "/whoami/999999999")).status, 404);
    } finally { await f.close(); }
});

test("configured owner membership cannot be bypassed by another genuine Pocket owner", async () => {
    const f = await fixture();
    try {
        successful(await f.put(f.candidate(), null));
        await f.reload();
        const another = f.app.config.addUser("Other synthetic Owner", "owner");
        const before = await f.snapshot();
        // GET is Owner-role-only. Current configured membership gates mutations.
        const overview = await fetch(f.base + CONFIG, {
            signal: AbortSignal.timeout(10_000),
            headers: { authorization: "Bearer " + another.token, "x-pocket": "1" },
        });
        assert.equal(overview.status, 200);
        safe({ text: await overview.text() }, f.candidate());
        const statuses: number[] = [];
        for (const method of ["PUT", "POST"]) {
            const path = method === "POST" ? CONFIG + "/delete" : CONFIG;
            const response = await fetch(f.base + path, {
                method,
                redirect: "error",
                signal: AbortSignal.timeout(10_000),
                headers: { authorization: "Bearer " + another.token, "x-pocket": "1", "content-type": "application/json" },
                ...(method === "GET" ? {} : { body: JSON.stringify({ expectedSha256: await f.hash(), candidate: { ...f.candidate(), ownerPersonIds: [another.user.id] } }) }),
            });
            await response.text();
            statuses.push(response.status);
            assert.deepEqual(await f.snapshot(), before);
        }
        assert.deepEqual(statuses, [404, 404], "excluded configured Owner must receive 404 for PUT and POST delete");
    } finally { await f.close(); }
});

test("exact-hash delete and restore preserve unrelated plugin files and never accept a stale rollback", async () => {
    const f = await fixture();
    try {
        successful(await f.put(f.candidate(), null));
        const saved = JSON.parse(await readFile(f.path, "utf8"));
        const oldHash = await f.hash();
        const directory = join(f.directory, "unrelated-directory");
        await mkdir(directory, { mode: 0o700 });
        const unrelated = await fingerprintTree(directory);
        const deleted = await f.remove(oldHash);
        successful(deleted);
        // No config was loaded in this fixture: deletion restores the active absent state.
        assert.equal((deleted.data as any).reloadRequired, false);
        await assert.rejects(readFile(f.path), { code: "ENOENT" });
        assert.deepEqual(await fingerprintTree(directory), unrelated);
        const before = await f.snapshot();
        assert.equal((await f.remove(oldHash)).status, 409);
        assert.deepEqual(await f.snapshot(), before);
        successful(await f.put(saved, null));
        assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), saved);
        assert.deepEqual(await fingerprintTree(directory), unrelated);
    } finally { await f.close(); }
});

for (const mode of [0o755, 0o777]) {
    test("config rejects insecure parent mode " + mode.toString(8) + " without repairs or data loss", async () => {
        const f = await fixture();
        try {
            successful(await f.put(f.candidate(), null));
            const digest = await f.hash();
            await chmod(f.directory, mode);
            const before = await f.snapshot();
            for (const result of [await f.put(f.candidate(), digest), await f.remove(digest)]) {
                assert.ok(result.status >= 400 && result.status < 500);
                assert.deepEqual(await f.snapshot(), before);
            }
        } finally { await f.close(); }
    });
}

for (const mode of [0o644, 0o666]) {
    test("config rejects insecure file mode " + mode.toString(8) + " without repairs or data loss", async () => {
        const f = await fixture();
        try {
            successful(await f.put(f.candidate(), null));
            const digest = await f.hash();
            await chmod(f.path, mode);
            const before = await f.snapshot();
            for (const result of [await f.put(f.candidate(), digest), await f.remove(digest)]) {
                assert.ok(result.status >= 400 && result.status < 500);
                assert.deepEqual(await f.snapshot(), before);
            }
        } finally { await f.close(); }
    });
}

for (const leaf of [false, true]) {
    test("config rejects " + (leaf ? "leaf" : "ancestor") + " symlinks and preserves the target", async () => {
        const f = await fixture();
        try {
            successful(await f.put(f.candidate(), null));
            const digest = await f.hash();
            const original = leaf ? f.path : f.directory;
            const target = join(f.dataDir, "private-target-" + crypto.randomUUID());
            await rename(original, target);
            await symlink(target, original);
            const targetBefore = leaf ? await readFile(target) : await fingerprintTree(target);
            const linkBefore = await lstat(original);
            const directoryBefore = await f.snapshot();
            for (const result of [await f.put(f.candidate(), digest), await f.remove(digest)]) {
                assert.ok(result.status >= 400 && result.status < 500);
                assert.deepEqual(leaf ? await readFile(target) : await fingerprintTree(target), targetBefore);
                assert.deepEqual(await f.snapshot(), directoryBefore);
                assert.equal((await lstat(original)).ino, linkBefore.ino);
            }
        } finally { await f.close(); }
    });
}


test("environment override denies both official mutation routes and preserves both paths", async () => {
    const f = await fixture();
    const old = process.env.PI_POCKET_LAYERFS_CONFIG;
    try {
        successful(await f.put(f.candidate(), null));
        const digest = await f.hash();
        const overrideDir = join(root, "override-" + crypto.randomUUID());
        await mkdir(overrideDir, { mode: 0o700 });
        const override = join(overrideDir, "config.json");
        await writeFile(override, JSON.stringify(f.candidate()), { mode: 0o600 });
        const outside = await fingerprintTree(overrideDir);
        const before = await f.snapshot();
        process.env.PI_POCKET_LAYERFS_CONFIG = override;
        const summary = await f.call("owner", CONFIG);
        assert.equal(summary.status, 200);
        assert.equal((summary.data as any).writable, false);
        assert.equal((summary.data as any).reloadRequired, null);
        assert.ok(!summary.text.includes(override));
        for (const result of [await f.put(f.candidate(), digest), await f.remove(digest)]) {
            assert.equal(result.status, 403);
            assert.deepEqual(await f.snapshot(), before);
            assert.deepEqual(await fingerprintTree(overrideDir), outside);
        }
    } finally {
        if (old === undefined) { delete process.env.PI_POCKET_LAYERFS_CONFIG; }
        else { process.env.PI_POCKET_LAYERFS_CONFIG = old; }
        await f.close();
    }
});

for (const mode of [0o755, 0o777]) {
    test("first config write rejects an existing unsafe empty parent " + mode.toString(8), async () => {
        const f = await fixture();
        try {
            await mkdir(f.directory, { mode });
            await chmod(f.directory, mode);
            const before = await f.snapshot();
            assert.equal((await f.put(f.candidate(), null)).status, 409);
            assert.deepEqual(await f.snapshot(), before);
        } finally { await f.close(); }
    });
}

test("first config write rejects an ancestor symlink before creating any file", async () => {
    const f = await fixture();
    try {
        const target = join(f.dataDir, "empty-target");
        await mkdir(target, { mode: 0o700 });
        await symlink(target, f.directory);
        const before = await fingerprintTree(target);
        const link = await lstat(f.directory);
        assert.equal((await f.put(f.candidate(), null)).status, 409);
        assert.deepEqual(await fingerprintTree(target), before);
        assert.equal((await lstat(f.directory)).ino, link.ino);
    } finally { await f.close(); }
});

test("invalid JSON bootstrap keeps management available and tools absent until repaired and reloaded", async () => {
    const f = await fixture();
    try {
        successful(await f.put(f.candidate(), null));
        // Deliberate corruption of this isolated fixture only, never a deployment write.
        await writeFile(f.path, "{invalid synthetic JSON", { mode: 0o600 });
        await f.reload();
        const digest = await f.hash();
        const summary = await f.call("owner", CONFIG);
        assert.equal(summary.status, 200);
        assert.equal((summary.data as any).configured, false);
        assert.equal((summary.data as any).hash, digest);
        assert.equal((summary.data as any).activeHash, null);
        await say(f.app, f.session, "inventory");
        assert.deepEqual([...f.tools].filter((name) => name.startsWith("layerfs_")), []);
        successful(await f.put(f.candidate(), digest));
        await say(f.app, f.session, "inventory");
        assert.deepEqual([...f.tools].filter((name) => name.startsWith("layerfs_")), []);
        await f.reload();
        const loaded = await f.call("owner", CONFIG);
        assert.equal((loaded.data as any).configured, true);
        assert.equal((loaded.data as any).reloadRequired, false);
    } finally { await f.close(); }
});
