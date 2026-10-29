// Fixture quality only. No Pocket, business, or native SDK imports.
import assert from "node:assert/strict";
import { lstat, readFile, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createGuiImportTree, GUI_IMPORT_LIMITS } from "./fixtures/gui-import-tree.ts";
import { assertImportedFiles, guiContractDriver, type GuiBinding, type GuiOperation } from "./fixtures/gui-contract-driver.ts";

test("GUI fixture is private, synthetic, independently enumerated, and retained", async (t) => {
    const tree = await createGuiImportTree();
    t.diagnostic("Retained fixture: " + tree.root);
    await tree.assertPrivateRoot();
    assert.ok(tree.root.startsWith("/tmp/lg-"));
    assert.ok(tree.root.length < 32);
    assert.equal((await lstat(join(tree.source, ".git"))).isDirectory(), true);
    assert.equal(await readFile(join(tree.root, "git-init.exit"), "utf8"), "0\n");
    assert.deepEqual(await tree.readExpected(), tree.expected);
    for (const [path, bytes] of tree.excluded) {
        assert.deepEqual(await readFile(join(tree.source, path)), bytes);
        assert.ok(bytes.includes(Buffer.from(tree.marker)), path);
        assert.ok(!tree.expected.has(path));
    }
    for (const bytes of tree.expected.values()) {
        assert.ok(!bytes.includes(Buffer.from(tree.marker)));
    }
    assert.equal((await lstat(join(tree.source, "external-link"))).isSymbolicLink(), true);
    assert.equal(await readlink(join(tree.source, "internal-link")), "public.txt");
    assert.equal(await readlink(join(tree.source, "cycle")), "cycle");
    await assert.rejects(lstat(tree.tripwire), { code: "ENOENT" });
    const before = await tree.snapshot();
    assert.deepEqual(await tree.snapshot(), before);
    await writeFile(join(tree.source, "public.txt"), "Explicit test-owned change.\n");
    assert.notDeepEqual(await tree.snapshot(), before);
});

test("rejection fixtures contain real hardlinks, a FIFO, and a synthetic worktree pointer", async (t) => {
    const tree = await createGuiImportTree();
    t.diagnostic("Retained rejection fixtures: " + tree.root);
    const hard = await tree.rejectionTree("hardlink");
    const [a, b] = await Promise.all([lstat(join(hard, "linked.txt")), lstat(join(tree.outside, "private.txt"))]);
    assert.equal(a.ino, b.ino);
    assert.equal(a.dev, b.dev);
    assert.ok(a.nlink > 1);
    const fifo = await tree.rejectionTree("fifo");
    assert.equal((await lstat(join(fifo, "pipe"))).isFIFO(), true);
    const worktree = await tree.rejectionTree("worktree");
    assert.equal((await lstat(join(worktree, ".git"))).isFile(), true);
    assert.equal(await readFile(join(worktree, ".git"), "utf8"), "gitdir: " + tree.outside + "\n");
    await assert.rejects(lstat(tree.tripwire), { code: "ENOENT" });
});

test("native byte oracle rejects missing, extra, changed, and excluded file content", () => {
    const expected = new Map([["public.txt", Buffer.from("ordinary bytes")]]);
    assertImportedFiles(new Map(expected), expected, "EXCLUDED");
    assert.throws(() => assertImportedFiles(new Map(), expected, "EXCLUDED"));
    assert.throws(() => assertImportedFiles(new Map([...expected, [".env", Buffer.from("EXCLUDED")]]), expected, "EXCLUDED"));
    assert.throws(() => assertImportedFiles(new Map([["public.txt", Buffer.from("changed")]]), expected, "EXCLUDED"));
    const tainted = new Map([["public.txt", Buffer.from("EXCLUDED")]]);
    assert.throws(() => assertImportedFiles(tainted, tainted, "EXCLUDED"));
});

test("API adapter requires fixed bindings and preserves actor and CSRF-negative requests", async () => {
    const bindings = Object.fromEntries(["status", "sessions", "preview", "confirm", "apply"].map((name) => [
        name, { method: "POST", path: "/api/x/fixture-only/" + name },
    ])) as Record<GuiOperation, GuiBinding>;
    const seen: unknown[] = [];
    const driver = guiContractDriver(async (...args) => {
        seen.push(args);
        return { status: 403, data: {}, text: "denied" };
    }, bindings);
    assert.equal((await driver.request("preview", { actor: null, body: { source: "/test-only" }, pocketHeader: false })).status, 403);
    assert.deepEqual(seen, [[null, "/api/x/fixture-only/preview", { method: "POST", body: { source: "/test-only" }, pocketHeader: false }]]);
    for (const path of ["https://outside.invalid", "//outside.invalid", "/api/x/../outside", "/api/x/%2e%2e", "/api/x/test?bad", "/api/x/test\\other"]) {
        assert.throws(() => guiContractDriver(async () => ({ status: 200, data: {}, text: "" }), {
            ...bindings, preview: { method: "POST", path },
        }));
    }
});

test("fixture bounds match the frozen contract", () => {
    assert.deepEqual(GUI_IMPORT_LIMITS, {
        entries: 10_000, files: 5_000, bytes: 67_108_864, fileBytes: 8_388_608,
        depth: 32, ignoreFiles: 64, ignorePatterns: 8192, ignoreBytes: 262_144,
        previewMs: 20_000, previewBytes: 32_768, includedPaths: 100,
        excludedPaths: 100, ticketTtlMs: 300_000, globalTickets: 256,
        nativeMs: 120_000, nativeOutputBytes: 8192,
    });
    assert.equal(Object.isFrozen(GUI_IMPORT_LIMITS), true);
});
