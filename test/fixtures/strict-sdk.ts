// Contract fixture, NOT a native engine. These are the REAL pinned v1.0.0
// grouped wrappers; only their bottom-level call dispatcher is synthetic.
// Thus an extra project argument is rejected by the actual SDK pagination
// validation or by exact branch/path assertions below, rather than accepted.
import assert from "node:assert/strict";
import { LayerFS } from "../../.work/layerfs-src/sdk/js/src/index.js";
import { validateConfig } from "../../src/pocket-layerfs/config.ts";

export const OLD = "01" + "11".repeat(32);
export const HEAD = "01" + "22".repeat(32);
export const PRIVATE = "01" + "33".repeat(32);
export const ABSENT = "01" + "99".repeat(32);
export const PATH = "/public.txt";

export function contractConfig() {
    return validateConfig({
        version: 1,
        ownerPersonIds: ["owner"],
        tools: { enabled: true },
        write: { enabled: true },
        service: {
            runtimeDir: "/tmp/lfs-contract",
            socketPath: "/tmp/lfs-contract/service.sock",
            tokenFile: "/tmp/lfs-contract/service.token",
            layerfsHome: "/tmp/lfs-contract/home",
            sdkPath: "/tmp/lfs-contract/sdk/index.js",
        },
        projects: [
            { id: "alpha", storePath: "/tmp/lfs-contract/alpha/store.sqlite", branches: ["feature", "private"] },
            { id: "beta", storePath: "/tmp/lfs-contract/beta/store.sqlite", branches: ["other"] },
        ],
        sessionGrants: [
            { conversationId: "session-a", project: "alpha", allowTools: true, toolBranches: ["feature"], fork: { enabled: true, sources: ["feature"], namePrefix: "recovery-" } },
            { conversationId: "session-b", project: "beta", allowTools: true, toolBranches: ["other"] },
        ],
    });
}

type SdkCall = { project: string; method: string; args: Record<string, unknown> };
export function strictSdk(options: { diffError?: boolean; historyHasMore?: boolean; head?: string; readText?: string } = {}) {
    const observed: SdkCall[] = [];
    const closed: string[] = [];
    const branches = [
        { name: "feature", head: options.head ?? HEAD, base: OLD },
        { name: "private", head: PRIVATE, base: OLD },
    ];
    const history: Record<string, { id: string; parent: string | null; message: string; time: number; via: string }[]> = {
        feature: [
            { id: HEAD, parent: OLD, message: "same inode and same size edit", time: 2, via: "write" },
            { id: OLD, parent: null, message: "initial", time: 1, via: "write" },
        ],
        private: [
            { id: PRIVATE, parent: OLD, message: "PRIVATE_BRANCH_ONLY", time: 3, via: "write" },
            { id: OLD, parent: null, message: "initial", time: 1, via: "write" },
        ],
    };
    const validRefs = ["feature", "private", OLD, HEAD, PRIVATE];
    function ref(value: unknown) { assert.ok(typeof value === "string" && validRefs.includes(value), `invalid positional ref ${String(value)}`); }
    function path(value: unknown) { assert.ok(value === PATH || value === "/" || value === "/link", `invalid positional path ${String(value)}`); }
    class ContractSDK extends LayerFS {
        async call(method: string, args: Record<string, unknown>) {
            const record = { project: this.projectName, method, args };
            observed.push(record);
            if (method === "project.list_branches") {
                assert.equal(typeof args.pageSize, "number");
                assert.equal(typeof args.pagePos, "number");
                return { items: branches.slice(Number(args.pagePos), Number(args.pagePos) + Number(args.pageSize)), hasMore: false };
            }
            if (method === "branch.list_commits") {
                assert.ok(args.branch === "feature" || args.branch === "private");
                assert.equal(typeof args.pageSize, "number");
                assert.equal(typeof args.pagePos, "number");
                const items = history[String(args.branch)];
                return { items: items.slice(Number(args.pagePos), Number(args.pagePos) + Number(args.pageSize)), hasMore: options.historyHasMore === true };
            }
            if (method === "fs.stat") {
                ref(args.branch); path(args.path);
                return { type: args.path === "/" ? "dir" : args.path === "/link" ? "symlink" : "file", inode: 7, size: 5 };
            }
            if (method === "fs.read") {
                ref(args.branch); path(args.path);
                assert.ok(Number.isSafeInteger(args.startLine));
                assert.ok(Number.isSafeInteger(args.endLine));
                assert.ok(Number(args.startLine) >= 1);
                assert.ok(Number(args.endLine) >= Number(args.startLine));
                assert.ok(Number(args.endLine) - Number(args.startLine) < 2000);
                return { text: options.readText ?? (args.branch === OLD ? "AAAA\n" : "BBBB\n"), startLine: 1, endLine: 1, truncated: false, lineTruncated: false, nextLine: null };
            }
            if (method === "fs.list") {
                ref(args.branch); path(args.path);
                assert.equal(typeof args.pageSize, "number");
                return { items: [{ name: "public.txt", type: "file" }, { name: ".env", type: "file" }, { name: "link", type: "symlink" }], hasMore: false };
            }
            if (method === "fs.blame") {
                ref(args.branch); path(args.path);
                assert.equal(args.fromLine, 1);
                return { lines: [{ line: 1, text: "BBBB", commit: HEAD }], truncated: false };
            }
            if (method === "fs.diff_files") {
                const left = args.left as { commit: string; path: string };
                const right = args.right as { commit: string; path: string };
                ref(args.branch); ref(left.commit); ref(right.commit); path(left.path); path(right.path);
                assert.equal(left.path, PATH);
                assert.equal(right.path, PATH);
                if (options.diffError) throw Object.assign(new Error("SYNTHETIC upstream error"), { code: "Failed" });
                return { kind: "Text", contentEqual: left.commit === right.commit, sameInode: true, hunksOmitted: false, hunks: [{ op: "-", text: "AAAA" }, { op: "+", text: "BBBB" }] };
            }
            if (method === "branch.diff_commits" || method === "branch.diff_branches") {
                ref(args.from); ref(args.to);
                assert.equal(typeof args.pageSize, "number");
                assert.equal(typeof args.pagePos, "number");
                assert.equal(typeof args.hunks, "boolean");
                return { items: [{ path: PATH, kind: "Modified", content: true, before: { type: "file" }, after: { type: "file" }, hunks: [{ op: "-", text: "AAAA" }, { op: "+", text: "BBBB" }] }], hasMore: false, nextCursor: null };
            }
            if (method === "branch.fork") {
                assert.equal(args.name, "recovery-1");
                assert.ok(args.from === HEAD || args.from === OLD);
                return { name: args.name, head: args.from, base: OLD };
            }
            throw new Error(`Unexpected SDK operation ${method}`);
        }
        async close() { closed.push(this.projectName); }
    }
    return { LayerFS: ContractSDK, observed, closed };
}
