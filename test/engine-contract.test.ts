// Uses actual v1.0.0 grouped SDK wrappers with a synthetic dispatcher.
// Validates adapter contract/security only, NOT actual Store content/diff execution.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine } from "../service/engine.mjs";
import { CODES, LayerfsRefusal } from "../src/pocket-layerfs/errors.ts";
import { ABSENT, contractConfig, HEAD, OLD, PATH, PRIVATE, strictSdk } from "./fixtures/strict-sdk.ts";

function setup(options: Parameters<typeof strictSdk>[0] = {}) {
    const sdk = strictSdk(options);
    const engine = new Engine({ config: contractConfig(), LayerFS: sdk.LayerFS, upstream: { version: "1.0.0", commit: "2aaf2552ce21154928b9f9c83582e41a637f5910" }, log: () => {} });
    return { engine, ...sdk };
}
const tool = { project: "alpha", scope: "tool", conversationId: "session-a" };
function refusal(error: unknown) { return error instanceof LayerfsRefusal && [CODES.NotFound, CODES.Forbidden].includes(error.code); }

test("Engine invokes real bound SDK wrappers without an extra project argument for reads/listing/blame", async () => {
    const { engine, observed, closed } = setup();
    try {
        const branches = await engine.listBranches(tool);
        assert.deepEqual(branches.items.map((item: { name: string }) => item.name), ["feature"]);
        const commits = await engine.listCommits({ ...tool, branch: "feature", pageSize: 10, pagePos: 0 });
        assert.equal(commits.items[0].id, HEAD);
        assert.equal((await engine.stat({ ...tool, ref: "feature", path: PATH })).inode, 7);
        const tree = await engine.tree({ ...tool, ref: "feature", path: "/", pageSize: 10, pagePos: 0 });
        assert.deepEqual(tree.items.map((item: { name: string }) => item.name), ["public.txt"]);
        assert.equal(tree.omitted, 2);
        assert.equal((await engine.read({ ...tool, ref: OLD, path: PATH, startLine: 1, endLine: 20 })).text, "AAAA\n");
        assert.equal((await engine.blame({ ...tool, ref: "feature", path: PATH, fromLine: 1 })).lines[0].commit, HEAD);
        assert.equal((await engine.oneCommit({ ...tool, commit: OLD })).commit.id, OLD);
        for (const method of ["project.list_branches", "branch.list_commits", "fs.stat", "fs.list", "fs.read", "fs.blame"]) assert.ok(observed.some((call) => call.method === method), method);
    } finally {
        await engine.close();
    }
    assert.deepEqual(closed, ["alpha"]);
});

test("Engine invokes branch/commit/mixed diff wrappers with true positional refs and paging", async () => {
    const { engine, observed } = setup();
    try {
        for (const [from, to] of [[OLD, HEAD], ["feature", "feature"], [OLD, "feature"], ["feature", OLD]]) {
            const result = await engine.diff({ ...tool, from, to, pageSize: 10, pagePos: 0, hunks: true });
            assert.equal(result.items[0].path, PATH);
        }
        assert.ok(observed.some((call) => call.method === "branch.diff_branches"));
        assert.ok(observed.some((call) => call.method === "branch.diff_commits" && call.args.from === OLD && call.args.to === HEAD));
    } finally {
        await engine.close();
    }
});

test("service independently enforces project/session/branch and historical commit reachability", async () => {
    const { engine, observed } = setup();
    try {
        const denied = [
            () => engine.read({ ...tool, project: "beta", ref: "other", path: PATH, startLine: 1, endLine: 20 }),
            () => engine.read({ ...tool, conversationId: "session-b", ref: "feature", path: PATH, startLine: 1, endLine: 20 }),
            () => engine.read({ ...tool, conversationId: "unknown", ref: "feature", path: PATH, startLine: 1, endLine: 20 }),
            () => engine.read({ ...tool, ref: "main", path: PATH, startLine: 1, endLine: 20 }),
            () => engine.read({ ...tool, ref: "private", path: PATH, startLine: 1, endLine: 20 }),
            () => engine.read({ ...tool, ref: PRIVATE, path: PATH, startLine: 1, endLine: 20 }),
            () => engine.oneCommit({ ...tool, commit: PRIVATE }),
            () => engine.oneCommit({ ...tool, commit: ABSENT }),
            () => engine.diff({ ...tool, from: OLD, to: PRIVATE, pageSize: 10, pagePos: 0 }),
        ];
        for (const operation of denied) await assert.rejects(operation(), refusal);
        assert.ok(!observed.some((call) => call.method === "fs.read" || call.method.startsWith("branch.diff_")));
        assert.equal((await engine.read({ ...tool, ref: OLD, path: PATH, startLine: 1, endLine: 20 })).text, "AAAA\n", "reachable common ancestor remains a positive control");
    } finally {
        await engine.close();
    }
});

test("same-inode same-size edits remain present in file history using actual SDK diff_files wrapper", async () => {
    const { engine, observed } = setup();
    try {
        const result = await engine.fileHistory({ ...tool, branch: "feature", path: PATH, maxCommits: 10 });
        assert.ok(result.items.some((item: { commit: string; change: string }) => item.commit === HEAD && item.change === "modified"));
        const compared = observed.find((call) => call.method === "fs.diff_files");
        assert.ok(compared, "equal stat metadata is not evidence of equal content");
        assert.deepEqual(compared.args.left, { commit: HEAD, path: PATH });
        assert.deepEqual(compared.args.right, { commit: OLD, path: PATH });
        assert.equal(result.errors, 0);
        assert.equal(result.truncated, false);
    } finally {
        await engine.close();
    }
});

test("history bounds and upstream comparison failures are explicitly reported rather than clean history", async () => {
    for (const options of [{}, { diffError: true }]) {
        const { engine } = setup(options);
        try {
            const result = await engine.fileHistory({ ...tool, branch: "feature", path: PATH, maxCommits: 1 });
            assert.equal(result.truncated, true);
            assert.equal(result.scanned, 1);
            if (options.diffError) assert.ok(result.errors > 0);
        } finally {
            await engine.close();
        }
    }
});

test("fork uses exact approved immutable head, blocks stale head, cross-session and unrelated commit", async () => {
    const { engine, observed } = setup();
    const request = { project: "alpha", conversationId: "session-a", sourceBranch: "feature", newBranch: "recovery-1" };
    try {
        const preview = await engine.forkPlan(request);
        assert.equal(preview.expectedHead, HEAD);
        await assert.rejects(engine.forkCommit({ ...request, fromRef: "feature", expectedHead: OLD }), (error: unknown) => error instanceof LayerfsRefusal && error.code === CODES.HeadMoved);
        await assert.rejects(engine.forkCommit({ ...request, conversationId: "session-b", fromRef: "feature", expectedHead: HEAD }), (error: unknown) => error instanceof LayerfsRefusal && error.code === CODES.WriteDisabled);
        await assert.rejects(engine.forkCommit({ ...request, fromRef: PRIVATE, expectedHead: HEAD }), refusal);
        assert.equal(observed.filter((call) => call.method === "branch.fork").length, 0);
        await engine.forkCommit({ ...request, fromRef: "feature", expectedHead: HEAD });
        const fork = observed.find((call) => call.method === "branch.fork");
        assert.deepEqual(fork?.args, { name: "recovery-1", from: HEAD });
    } finally {
        await engine.close();
    }
});
