// Synthetic fixtures only. No Pocket or business imports.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fingerprintTree } from "./security-tree.ts";

export const GUI_IMPORT_LIMITS = Object.freeze({
    entries: 10_000, files: 5_000, bytes: 64 * 1024 * 1024,
    fileBytes: 8 * 1024 * 1024, depth: 32, ignoreFiles: 64,
    ignorePatterns: 8192, ignoreBytes: 256 * 1024, previewMs: 20_000,
    previewBytes: 32 * 1024, includedPaths: 100, excludedPaths: 100,
    ticketTtlMs: 300_000, globalTickets: 256, nativeMs: 120_000,
    nativeOutputBytes: 8 * 1024,
});

/** Only this newly created source can be a Git target. Retain every fixture. */
export async function createGuiImportTree() {
    const root = await mkdtemp("/tmp/lg-");
    const source = join(root, "s");
    const outside = join(root, "o");
    const temp = join(root, "t");
    await Promise.all([source, outside, temp].map((path) => mkdir(path, { mode: 0o700 })));
    const marker = "HARMLESS_SYNTHETIC_EXCLUDED_" + randomUUID();
    const tripwire = join(root, "EXECUTION_MUST_NOT_OCCUR");
    const env = { PATH: "/usr/bin:/bin", HOME: temp, TMPDIR: temp, LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
    const init = spawnSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "init",
        "--template=", "--initial-branch=fixture-main", "."], {
        cwd: source, env, encoding: "utf8", timeout: 10_000, maxBuffer: 32 * 1024,
    });
    await writeFile(join(root, "git-init.log"), init.stdout + init.stderr, { mode: 0o600 });
    await writeFile(join(root, "git-init.exit"), String(init.status ?? "unknown") + "\n", { mode: 0o600 });
    if (init.error || init.status !== 0) {
        throw new Error("Synthetic Git init failed. Retained evidence: " + root, { cause: init.error });
    }
    // No Git command runs after hostile repository metadata is written.
    await writeFile(join(source, ".git", "config"), ["[core]", "repositoryformatversion = 0",
        "bare = false", 'fsmonitor = "!touch ' + tripwire + '"', '[filter "tripwire"]',
        'clean = "touch ' + tripwire + '"', 'smudge = "touch ' + tripwire + '"',
        "# " + marker, ""].join("\n"));
    const expected = new Map<string, Buffer>([
        ["public.txt", Buffer.from("Independent GUI fixture, not the demo.\n")],
        ["empty.txt", Buffer.alloc(0)], ["binary.dat", Buffer.from([0, 255, 1, 128, 13, 10])],
        ["docs/你好 space.txt", Buffer.from("UTF-8 fixture bytes.\r\n")],
        ["keep.log", Buffer.from("Root negation keeps this.\n")],
        ["docs/nested/keep.tmp", Buffer.from("Nested negation keeps this.\n")],
        ["docs/nested/readme.txt", Buffer.from("Ordinary nested file.\n")],
        [".gitignore", Buffer.from("ignored/\n*.log\n!keep.log\nnode_modules/\n!.env\n!auth.json\n")],
        ["docs/nested/.gitignore", Buffer.from("*.tmp\n!keep.tmp\n/local-only.txt\n")],
    ]);
    const excluded = new Map<string, Buffer>([
        ["ignored/private.txt", Buffer.from(marker)], ["debug.log", Buffer.from(marker)],
        ["docs/nested/discard.tmp", Buffer.from(marker)],
        ["docs/nested/local-only.txt", Buffer.from(marker)],
        ["node_modules/cached.js", Buffer.from(marker)],
        [".env", Buffer.from("SYNTHETIC_ONLY=" + marker)], [".env.local", Buffer.from(marker)],
        ["auth.json", Buffer.from(JSON.stringify({ synthetic: marker }))],
        ["private.key", Buffer.from("-----BEGIN PRIVATE KEY-----\n" + marker + "\n-----END PRIVATE KEY-----\n")],
        [".ssh/id_ed25519", Buffer.from(marker)], ["credentials.json", Buffer.from(marker)],
        ["sessions/history.jsonl", Buffer.from(JSON.stringify({ synthetic: marker }))],
        ["docs/.git", Buffer.from("gitdir: " + join(outside, marker) + "\n")],
    ]);
    for (const [relative, bytes] of [...expected, ...excluded]) {
        await mkdir(dirname(join(source, relative)), { recursive: true, mode: 0o700 });
        await writeFile(join(source, relative), bytes, { mode: 0o600, flag: "wx" });
    }
    await writeFile(join(outside, "private.txt"), marker, { mode: 0o600 });
    for (const [name, target] of [["external-link", join(outside, "private.txt")],
        ["internal-link", "public.txt"], ["broken-link", "absent"], ["cycle", "cycle"],
        ["linked-dir", outside]]) {
        await symlink(target, join(source, name));
    }
    async function rejectionTree(kind: "hardlink" | "fifo" | "worktree") {
        const target = join(root, kind);
        await mkdir(target, { mode: 0o700 });
        await writeFile(join(target, "public.txt"), "Independent rejection fixture.\n", { mode: 0o600 });
        if (kind === "hardlink") {
            await link(join(outside, "private.txt"), join(target, "linked.txt"));
        } else if (kind === "fifo") {
            const result = spawnSync("/usr/bin/mkfifo", ["--mode=600", "--", join(target, "pipe")], {
                env, timeout: 5_000, encoding: "utf8", maxBuffer: 8192,
            });
            await writeFile(join(root, "mkfifo.log"), result.stdout + result.stderr, { mode: 0o600 });
            await writeFile(join(root, "mkfifo.exit"), String(result.status ?? "unknown") + "\n", { mode: 0o600 });
            if (result.error || result.status !== 0) {
                throw new Error("Synthetic FIFO creation failed. Evidence: " + root, { cause: result.error });
            }
        } else {
            await writeFile(join(target, ".git"), "gitdir: " + outside + "\n", { mode: 0o600 });
        }
        return target;
    }
    return { root, source, outside, temp, marker, tripwire, expected, excluded, rejectionTree,
        snapshot: () => fingerprintTree(source),
        async assertPrivateRoot() {
            const stat = await lstat(root);
            if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700) {
                throw new Error("Fixture root is not private: " + root);
            }
        },
        async readExpected() {
            return new Map(await Promise.all([...expected.keys()].map(async (path) =>
                [path, await readFile(join(source, path))] as const)));
        },
    };
}
