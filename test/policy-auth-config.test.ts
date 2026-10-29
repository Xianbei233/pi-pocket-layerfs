// Actual production pure-boundary tests. Red assertions remain until developer fixes implementation.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
    assertNewBranchName,
    assertOwnerPerson,
    assertReadableBranch,
    isOwnerRequest,
    toolContext,
    sessionGrant,
    writeContext,
    assertToolBranch,
    projectGrant,
} from "../src/pocket-layerfs/auth.ts";
import {
    isInside,
    loadConfigFile,
    publicConfig,
    validateConfig,
} from "../src/pocket-layerfs/config.ts";
import { CODES, fromUpstreamError, LayerfsRefusal } from "../src/pocket-layerfs/errors.ts";
import {
    clampHistoryScan,
    clampLineWindow,
    clampPagePos,
    clampPageSize,
    isBranchName,
    isNodeId,
    normalisePath,
    refKind,
} from "../src/pocket-layerfs/policy.ts";

function rawConfig() {
    const runtime = "/tmp/lfs-policy-synthetic";
    return {
        version: 1,
        ownerPersonIds: ["synthetic-owner"],
        service: {
            runtimeDir: runtime,
            socketPath: `${runtime}/service.sock`,
            tokenFile: `${runtime}/service.token`,
            layerfsHome: `${runtime}/home`,
            sdkPath: `${runtime}/sdk/index.js`,
        },
        tools: { enabled: true, allowedConversationIds: ["session-a"] },
        write: { enabled: true },
        projects: [{
            id: "alpha",
            storePath: `${runtime}/alpha/store.sqlite`,
            branches: ["feature", "private"],
        }, {
            id: "beta",
            storePath: `${runtime}/beta/store.sqlite`,
            branches: ["other"],
        }],
        sessionGrants: [{
            conversationId: "session-a",
            project: "alpha",
            allowTools: true,
            toolBranches: ["feature"],
            fork: { enabled: true, sources: ["feature"], namePrefix: "recovery" },
        }, {
            conversationId: "session-b",
            project: "beta",
            allowTools: true,
            toolBranches: ["other"],
            fork: { enabled: false, sources: [], namePrefix: "recovery" },
        }],
    };
}

function refusal(code?: string) {
    return (error: unknown) => error instanceof LayerfsRefusal && (code === undefined || error.code === code);
}

test("main is not an implicit branch grant in refKind", () => {
    assert.equal(refKind("main", []), "invalid");
    assert.equal(refKind("main", ["feature"]), "invalid");
    assert.equal(refKind("main", ["main"]), "branch");
    assert.equal(refKind("feature", ["feature"]), "branch");
});

test("empty sessionGrants denies every model session rather than all sessions", () => {
    const raw = rawConfig();
    raw.tools.allowedConversationIds = [];
    raw.sessionGrants = [];
    const config = validateConfig(raw);
    assert.throws(() => toolContext({ config, host: { requesterOf: () => "synthetic-owner" }, conversationId: "session-a" }), refusal());
    assert.throws(() => writeContext(config, "session-a", "alpha"), refusal());
});

test("conversation-project-branch grants cannot form a Cartesian product", () => {
    const config = validateConfig(rawConfig());
    const a = toolContext({ config, host: { requesterOf: () => "synthetic-owner" }, conversationId: "session-a" });
    const b = toolContext({ config, host: { requesterOf: () => "synthetic-owner" }, conversationId: "session-b" });
    assert.equal(a.project.id, "alpha");
    assert.deepEqual(a.grant.toolBranches, ["feature"]);
    assert.equal(b.project.id, "beta");
    assert.deepEqual(b.grant.toolBranches, ["other"]);
    assert.throws(() => assertToolBranch(a.grant, "private"), refusal());
    assert.throws(() => assertToolBranch(a.grant, "other"), refusal());
    assert.throws(() => assertToolBranch(b.grant, "feature"), refusal());
    assert.throws(() => writeContext(config, "session-a", "beta"), refusal(CODES.NotFound));
    assert.throws(() => writeContext(config, "session-b", "alpha"), refusal());
    assert.equal(sessionGrant(config, "unknown"), null);
    assert.equal(sessionGrant(config, "session-a/../session-b"), null);
});

test("model owner identity is current requester, not former owner or browser-provided claims", () => {
    const config = validateConfig(rawConfig());
    for (const requester of [undefined, "", "synthetic-guest", "synthetic-viewer", "other-owner"]) {
        assert.throws(() => toolContext({ config, host: { requesterOf: () => requester }, conversationId: "session-a" }), refusal(CODES.Forbidden));
    }
    assert.throws(() => toolContext({ config, host: { requesterOf: () => "synthetic-owner" }, conversationId: "other-session" }), refusal(CODES.Forbidden));
    assert.throws(() => toolContext({ config: null, host: { requesterOf: () => "synthetic-owner" }, conversationId: "session-a" }), refusal(CODES.NotConfigured));
    assert.throws(() => toolContext({ config: { ...config, tools: { ...config.tools, enabled: false } }, host: { requesterOf: () => "synthetic-owner" }, conversationId: "session-a" }), refusal(CODES.ToolsDisabled));
});

test("owner page checks role and explicit identity, and project lookup uses exact id", () => {
    const config = validateConfig(rawConfig());
    assert.equal(isOwnerRequest({ user: { id: "synthetic-owner", role: "owner" } }, config), true);
    for (const role of ["guest", "viewer"]) {
        assert.equal(isOwnerRequest({ user: { id: "synthetic-owner", role } }, config), false);
    }
    assert.equal(isOwnerRequest({ user: { id: "other-owner", role: "owner" } }, config), false);
    assert.throws(() => assertOwnerPerson(config, "synthetic-guest"), refusal(CODES.Forbidden));
    for (const id of ["gamma", "../alpha", "ALPHA", null]) assert.throws(() => projectGrant(config, id), refusal(CODES.NotFound));
    assert.equal(projectGrant(config, "alpha").id, "alpha");
});

test("branch and fork target policy retain explicit scope and strict complete-name grammar", () => {
    const config = validateConfig(rawConfig());
    const project = config.projects[0];
    const grant = config.sessionGrants[0];
    assert.equal(assertReadableBranch(project, "feature"), "feature");
    for (const branch of ["main", "ungranted", "../feature", ""]) assert.throws(() => assertReadableBranch(project, branch), refusal());
    for (const branch of ["recovery-", "recovery/escape", "main", "different-1", "Recovery-1"]) assert.throws(() => assertNewBranchName(grant, branch), refusal());
    assert.equal(assertNewBranchName(grant, "recovery-1"), "recovery-1");
    assert.equal(isBranchName("recovery-"), false);
});

test("default fork prefix recovery- is valid although a complete target cannot end in hyphen", () => {
    const raw = rawConfig();
    delete (raw.sessionGrants[0] as { fork?: unknown }).fork;
    const config = validateConfig(raw);
    assert.equal(config.sessionGrants[0].fork.namePrefix, "recovery-");
    assert.equal(assertNewBranchName(config.sessionGrants[0], "recovery-1"), "recovery-1");
    assert.throws(() => assertNewBranchName(config.sessionGrants[0], "recovery-"), refusal());
});

test("runtime containment resolves dot-dot and rejects sibling-prefix paths", () => {
    assert.equal(isInside("/tmp/runtime", "/tmp/runtime/a"), true);
    assert.equal(isInside("/tmp/runtime", "/tmp/runtime-other/a"), false);
    assert.equal(isInside("/tmp/runtime", "/tmp/runtime/../outside/socket"), false);
    const raw = rawConfig();
    raw.service.socketPath = `${raw.service.runtimeDir}/../outside/socket`;
    assert.throws(() => validateConfig(raw), /socketPath|runtimeDir|path/i);
});

test("config path and existing configured file reject ancestor symlinks, not only leaf symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "lfs-config-boundary-"));
    try {
        const real = join(root, "real");
        const alias = join(root, "alias");
        await mkdir(real, { mode: 0o700 });
        const file = join(real, "config.json");
        await writeFile(file, JSON.stringify(rawConfig()), { mode: 0o600 });
        await symlink(real, alias);
        assert.throws(() => loadConfigFile(join(alias, "config.json")));
        assert.equal(JSON.parse(await readFile(file, "utf8")).version, 1);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("config rejects world-writable regular files", async () => {
    const root = await mkdtemp(join(tmpdir(), "lfs-config-mode-"));
    try {
        const path = join(root, "config.json");
        await writeFile(path, JSON.stringify(rawConfig()));
        await chmod(path, 0o666);
        assert.throws(() => loadConfigFile(path));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("public config does not leak service paths, tokens, owner ids or Store locations", () => {
    const raw = rawConfig();
    const config = validateConfig(raw);
    const shown = JSON.stringify(publicConfig(config));
    for (const secret of [raw.ownerPersonIds[0], raw.service.runtimeDir, raw.service.tokenFile, raw.service.sdkPath, raw.projects[0].storePath]) assert.ok(!shown.includes(secret));
    assert.ok(shown.includes("alpha"));
});

test("path policy rejects traversal, control bytes, sensitive names and oversized segments", () => {
    for (const path of ["../outside", "/a/../outside", "/./public", "/a\\b", "/a\0b", "/a\nb", `/${"a".repeat(256)}`, "/.git/config", "/.GIT", "/docs/.env.local", "/key.pem", "/node_modules/a", "/.pi-pocket/pocket.sqlite"]) {
        assert.equal(normalisePath(path).ok, false, JSON.stringify(path));
    }
    assert.deepEqual(normalisePath("/docs/你好 space.txt"), { ok: true, path: "/docs/你好 space.txt" });
    assert.deepEqual(normalisePath("/"), { ok: true, path: "/" });
});

test("node IDs are not classified as authorized branches and require later reachability checks", () => {
    const id = "01" + "ab".repeat(32);
    assert.equal(isNodeId(id), true);
    assert.equal(refKind(id, ["feature"]), "commit");
    assert.equal(refKind("ab".repeat(32), ["feature"]), "invalid");
    assert.equal(refKind("private", ["feature"]), "invalid");
});

test("bounded paging and line windows never issue unsafe integer values or over-2000 line ranges", () => {
    for (const value of [NaN, Infinity, -1, 0, Number.MAX_SAFE_INTEGER + 1]) {
        assert.ok(Number.isSafeInteger(clampPageSize(value)));
        assert.ok(clampPageSize(value) >= 1 && clampPageSize(value) <= 200);
        assert.ok(Number.isSafeInteger(clampPagePos(value)));
        assert.ok(clampPagePos(value) >= 0);
        assert.ok(clampHistoryScan(value) >= 1 && clampHistoryScan(value) <= 200);
    }
    for (const start of [1, 2, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]) {
        const window = clampLineWindow(start);
        assert.ok(Number.isSafeInteger(window.startLine));
        assert.ok(Number.isSafeInteger(window.endLine));
        assert.ok(window.endLine >= window.startLine);
        assert.ok(window.endLine - window.startLine + 1 <= 2000);
    }
});

test("upstream secrets never survive safe error mapping", () => {
    for (const code of ["NoSuchPath", "NoSuchBranch", "NoSuchCommit", "InvalidInput", "Unsupported", "arbitrary"]) {
        const mapped = fromUpstreamError({ code, message: "SYNTHETIC_TOKEN /secret/store.sqlite" });
        assert.ok(!mapped.message.includes("SYNTHETIC_TOKEN"));
        assert.ok(!mapped.message.includes("/secret"));
        assert.ok(mapped.status >= 400 && mapped.status <= 599);
    }
});
