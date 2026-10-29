// Fixture self-tests, NOT LayerFS implementation or engine acceptance.
import assert from "node:assert/strict";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
    createSecurityTree,
    fingerprintTree,
    HOSTILE_HISTORY,
    OMIT_FROM_CAPTURE,
    PATH_ATTACKS,
    PUBLIC_TEXT,
    SECRET_MARKER,
} from "./fixtures/security-tree.ts";

test("security fixture is synthetic and contains every capture-exclusion probe", async () => {
    const tree = await createSecurityTree();
    try {
        assert.equal(await readFile(join(tree.source, "public.txt"), "utf8"), PUBLIC_TEXT);
        assert.equal(await readFile(join(tree.outside, "secret.txt"), "utf8"), SECRET_MARKER);
        assert.equal(await readFile(join(tree.source, "docs/hostile.txt"), "utf8"), HOSTILE_HISTORY);
        for (const path of OMIT_FROM_CAPTURE) {
            await assert.doesNotReject(lstat(join(tree.source, path)), path);
        }
        const seen = await fingerprintTree(tree.source);
        assert.deepEqual(await fingerprintTree(tree.source), seen);
        assert.ok(!seen.some((entry) => entry.path.startsWith("linked-directory/")));
        assert.equal(seen.find((entry) => entry.path === "dangling-link")?.kind, "symlink");
    } finally {
        await tree.cleanup();
    }
});

test("security fixture has real external symlinks and real shared-inode hardlinks", async () => {
    const tree = await createSecurityTree();
    try {
        assert.equal(await readlink(join(tree.source, "link-outside.txt")), join(tree.outside, "secret.txt"));
        const original = await lstat(join(tree.outside, "secret.txt"));
        const linked = await lstat(join(tree.source, "hardlink-outside.txt"));
        assert.equal(linked.ino, original.ino);
        assert.equal(linked.dev, original.dev);
        assert.equal(linked.nlink, 2);
        assert.equal((await lstat(join(tree.source, "docs/hardlink-original.txt"))).nlink, 2);
    } finally {
        await tree.cleanup();
    }
});

test("worktree fixture uses a real .git file and preserves intentionally dirty tracked content", async () => {
    const tree = await createSecurityTree({ gitWorktree: true });
    try {
        assert.equal((await lstat(join(tree.source, ".git"))).isFile(), true);
        assert.match(await readFile(join(tree.source, ".git"), "utf8"), /^gitdir: /);
        assert.equal(await readFile(join(tree.source, "tracked.txt"), "utf8"), "intentionally dirty, do not restore\n");
        const status = tree.status();
        assert.match(status, /^ M tracked\.txt$/m);
        assert.ok(!status.includes("ignored-dir/"));
        assert.ok(!status.includes("node_modules/"));
        assert.deepEqual(await fingerprintTree(tree.source), await fingerprintTree(tree.source));
        assert.equal(tree.status(), status);
    } finally {
        await tree.cleanup();
    }
});

test("path probes preserve raw JSON and percent-encoded boundary distinctions", () => {
    assert.ok(PATH_ATTACKS.some((value) => value.includes("\0")));
    assert.ok(PATH_ATTACKS.some((value) => value.startsWith("/")));
    assert.ok(PATH_ATTACKS.some((value) => value.startsWith("../")));
    assert.ok(PATH_ATTACKS.some((value) => value.includes("%252e")));
    assert.ok(PATH_ATTACKS.some((value) => value.includes("\\")));
    assert.equal(new Set(PATH_ATTACKS).size, PATH_ATTACKS.length);
});
