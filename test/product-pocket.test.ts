// Official helpers FIRST; real PRODUCT loader + faux tools + authenticated HTTP.
// The IPC peer is explicit synthetic Engine/SDK-contract fixture, NOT native Store.
import {
    cleanUp, context, lastText, modelTexts, owner, root, say, scriptedModel,
} from "/home/xianbei233/Work/pi-pocket-production/test/helpers.ts";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { TurnsDoc } from "/home/xianbei233/Work/pi-pocket-production/src/server/docs.ts";
import { createPocketFixture } from "./fixtures/pocket-harness.ts";
import { contractConfig, HEAD, OLD, PATH, PRIVATE } from "./fixtures/strict-sdk.ts";
import { productPeer, PEER_TOKEN } from "./fixtures/product-peer.ts";
import { HOSTILE_HISTORY } from "./fixtures/security-tree.ts";

const PROJECT = resolve(import.meta.dirname, "..");
const EXPECTED_TOOLS = ["layerfs_status", "layerfs_branches", "layerfs_commits", "layerfs_commit", "layerfs_tree", "layerfs_read", "layerfs_diff", "layerfs_blame", "layerfs_file_history"].sort();
after(cleanUp);

async function product(options: { missingConfig?: boolean; hostile?: boolean } = {}) {
    let peer: Awaited<ReturnType<typeof productPeer>> | undefined;
    const toolReplies: string[] = [];
    const tools = new Map<string, unknown>();
    const model = scriptedModel((request) => {
        for (const message of request.messages) {
            if (message.role === "system") {
                for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
                for (const removed of message.toolsRemoved ?? []) tools.delete(removed.name);
            }
        }
        const last = lastText(request as never);
        if (last.role === "toolResult") {
            toolReplies.push(last.text);
            return fauxAssistantMessage([fauxText(last.text)]);
        }
        const payload = last.text.replace(/^\[from:[^\]]+\]\s*/, "");
        if (payload === "inventory") return fauxAssistantMessage([fauxText("inventory recorded")]);
        const wanted = JSON.parse(payload);
        return fauxAssistantMessage([fauxToolCall(wanted.tool, wanted.args ?? {})], { stopReason: "toolUse" });
    });
    const fixture = await createPocketFixture({
        files: [
            { from: join(PROJECT, "src/pocket-layerfs.ts"), name: "pocket-layerfs.ts" },
            { from: join(PROJECT, "src/pocket-layerfs"), name: "pocket-layerfs" },
        ],
        model,
        async prepare({ dataDir, session, actors }) {
            if (options.missingConfig) return;
            const runtime = join(root, `lfs-${crypto.randomUUID().slice(0, 8)}`);
            const base = contractConfig();
            const config = {
                ...base,
                ownerPersonIds: [actors.owner.id],
                service: { ...base.service, runtimeDir: runtime, socketPath: join(runtime, "service.sock"), tokenFile: join(runtime, "service.token"), layerfsHome: join(runtime, "home"), sdkPath: join(runtime, "sdk") },
                sessionGrants: [{ ...base.sessionGrants[0], conversationId: String(session) }],
            };
            const directory = join(dataDir, "pocket-layerfs");
            await mkdir(directory, { recursive: true, mode: 0o700 });
            await writeFile(join(directory, "config.json"), JSON.stringify(config), { mode: 0o600 });
            peer = await productPeer(config, { readText: options.hostile ? HOSTILE_HISTORY : undefined });
        },
    });
    async function invoke(tool: string, args: Record<string, unknown> = {}, session = fixture.session) {
        await say(fixture.app, session, JSON.stringify({ tool, args }));
        return toolReplies.at(-1) ?? (await modelTexts(fixture.app, session)).at(-1) ?? "";
    }
    return { ...fixture, peer, tools, invoke, async close() { await fixture.close(); await peer?.close(); } };
}

test("actual drop-in with missing config exposes no model tools and starts no service", async () => {
    const fixture = await product({ missingConfig: true });
    try {
        const status = await fixture.call("owner", "/api/x/pocket-layerfs/status");
        assert.equal(status.status, 200);
        assert.equal((status.data as any).configured, false);
        assert.deepEqual((status.data as any).config.projects, []);
        assert.equal(fixture.peer, undefined);
        await say(fixture.app, fixture.session, "inventory");
        assert.match((await modelTexts(fixture.app, fixture.session)).at(-1) ?? "", /inventory recorded/);
        assert.deepEqual([...fixture.tools.keys()].filter((name) => name.startsWith("layerfs_")), []);
        assert.equal((await fixture.call("guest", "/api/x/pocket-layerfs/status")).status, 404);
    } finally { await fixture.close(); }
});

test("actual product loader advertises exactly nine read-only tools and invokes real faux tool path", async () => {
    const fixture = await product({ hostile: true });
    try {
        const status = await fixture.invoke("layerfs_status");
        assert.deepEqual([...fixture.tools.keys()].filter((name) => name.startsWith("layerfs_")).sort(), EXPECTED_TOOLS);
        assert.match(status, /project: alpha/);
        assert.match(status, /branches: feature/);
        for (const forbidden of ["beta", "private", PEER_TOKEN, "/tmp/lfs-contract"]) assert.ok(!status.includes(forbidden));
        const read = await fixture.invoke("layerfs_read", { project: "alpha", ref: "feature", path: PATH, startLine: 1, endLine: 20 });
        assert.match(read, /trust="untrusted"/);
        assert.ok(read.endsWith("</layerfs-data>"));
        assert.equal(read.split("</layerfs-data>").length, 2);
        assert.ok(!read.includes("</system>"));
        const branches = await fixture.invoke("layerfs_branches", { project: "alpha" });
        assert.match(branches, /branch feature/);
        assert.ok(!branches.includes("private"));
        assert.ok(fixture.peer?.operations.some((operation) => operation.op === "read" && operation.args.scope === "tool" && operation.args.conversationId === String(fixture.session)));
        for (const [tool, args] of [
            ["layerfs_read", { project: "beta", ref: "other", path: PATH }],
            ["layerfs_read", { project: "alpha", ref: PRIVATE, path: PATH }],
            ["layerfs_commit", { project: "alpha", commit: PRIVATE }],
            ["layerfs_diff", { project: "alpha", from: OLD, to: PRIVATE }],
        ] as const) {
            const denied = await fixture.invoke(tool, args);
            assert.match(denied, /not available|not authorised/i);
            assert.ok(!denied.includes("PRIVATE_BRANCH_ONLY"));
        }
        const other = await fixture.invoke("layerfs_status", {}, fixture.otherSession);
        assert.match(other, /not authorised/i);
    } finally { await fixture.close(); }
});

test("guest requester cannot reuse a granted session's tools even after owner success", async () => {
    const fixture = await product();
    try {
        assert.match(await fixture.invoke("layerfs_read", { project: "alpha", ref: "feature", path: PATH }), /BBBB/);
        const before = fixture.peer!.operations.length;
        const guest = fixture.app.config.users.find((person) => person.id === fixture.actors.guest.id)!;
        const { submissionId } = await fixture.app.commands.submit(fixture.session, guest, { text: JSON.stringify({ tool: "layerfs_read", args: { project: "alpha", ref: "feature", path: PATH } }), requestId: crypto.randomUUID() });
        await (await fixture.app.harness.submission(submissionId, context))!.wait(context);
        const answer = (await modelTexts(fixture.app, fixture.session)).at(-1) ?? "";
        assert.match(answer, /not authorised/i);
        assert.equal(fixture.peer!.operations.length, before, "guest must be rejected before service dispatch");
    } finally { await fixture.close(); }
});

test("product HTTP reads and bound owner preview/execute reject unauthorized callers, spoofing and replay", async () => {
    const fixture = await product();
    const prefix = "/api/x/pocket-layerfs";
    const previewPath = `${prefix}/projects/alpha/fork-preview/${fixture.session}`;
    const executePath = `${prefix}/projects/alpha/fork-execute/${fixture.session}`;
    const body = { sourceBranch: "feature", newBranch: "recovery-1" };
    try {
        assert.equal((await fixture.call(null, `${prefix}/status`)).status, 401);
        assert.equal((await fixture.call("owner", `${prefix}/status`, { pocketHeader: false })).status, 403);
        for (const actor of ["guest", "viewer", "singleSessionGuest"] as const) {
            assert.equal((await fixture.call(actor, `${prefix}/projects`)).status, 404);
            assert.equal((await fixture.call(actor, previewPath, { body })).status, 404);
            assert.equal((await fixture.call(actor, executePath, { body: { confirm: true } })).status, 404);
        }
        const read = await fixture.call("owner", `${prefix}/projects/alpha/read?ref=feature&path=${encodeURIComponent(PATH)}&endLine=20`);
        assert.equal(read.status, 200);
        assert.equal((read.data as any).text, "BBBB\n");
        assert.equal((await fixture.call("owner", executePath, { body: { confirm: true } })).status, 410);
        assert.equal((await fixture.call("owner", `${prefix}/projects/alpha/fork-preview/${fixture.otherSession}`, { body: { ...body, conversationId: fixture.session } })).status, 400);
        assert.equal((await fixture.call("owner", `${prefix}/projects/beta/fork-preview/${fixture.session}`, { body })).status, 404);
        assert.equal((await fixture.call("owner", `${prefix}/projects/alpha/fork-preview/999999999`, { body })).status, 404);
        const preview = await fixture.call("owner", previewPath, { body });
        assert.equal(preview.status, 200);
        assert.equal((preview.data as any).preview.expectedHead, HEAD);
        const ticket = (preview.data as any).ticket;
        assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
        assert.equal(fixture.peer!.operations.filter((operation) => operation.op === "fork.commit").length, 0);
        const executed = await fixture.call("owner", executePath, { body: { ticket } });
        assert.equal(executed.status, 200);
        assert.equal((executed.data as any).ok, true);
        assert.equal((await fixture.call("owner", executePath, { body: { ticket } })).status, 410);
        assert.equal(fixture.peer!.operations.filter((operation) => operation.op === "fork.commit").length, 1);
        const fresh = await fixture.call("owner", previewPath, { body });
        const oldTicket = (fresh.data as any).ticket;
        await fixture.app.setExtensionEnabled(owner(fixture.app), "pocket-layerfs.ts", false);
        assert.equal((await fixture.call("owner", `${prefix}/status`)).status, 404);
        await fixture.app.setExtensionEnabled(owner(fixture.app), "pocket-layerfs.ts", true);
        assert.equal((await fixture.call("owner", executePath, { body: { ticket: oldTicket } })).status, 410);
        assert.equal((await fixture.call("owner", `${prefix}/status`)).status, 200, "disable must not stop shared peer");
        await fixture.app.harness.commit(async (tx) => {
            Object.assign(await tx.doc(TurnsDoc, fixture.session), { on: true, driver: fixture.actors.guest.id, asks: [] });
        }, context);
        assert.equal((await fixture.call("owner", previewPath, { body })).status, 409, "actual source turn check must precede mutation");
    } finally { await fixture.close(); }
});
