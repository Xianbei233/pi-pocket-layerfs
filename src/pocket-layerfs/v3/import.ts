/* eslint-disable no-restricted-imports -- The frozen contract requires one fixed private child for project.init and Store verification. The child is spawned with fixed arguments, no shell, a bounded request file, and a sanitized environment. */
/**
 * Safe import of an Owner-chosen source tree into a new LayerFS Store.
 *
 * The source is read once, descriptor-anchored, into a filtered private stage.
 * `project.init` receives only the stage. The source path is never a native
 * argument. A ticket binds the Owner, config revision, source fingerprint,
 * stage hash, project, label, branches, and operation.
 */
import {
    closeSync,
    constants,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    unlinkSync,
    writeSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ignore from "ignore";
import { isInside } from "./config.ts";
import { withConfigMutation } from "./config-store.ts";
import { CODES, LayerfsRefusal } from "./errors.ts";
import { isSensitiveName } from "./policy.ts";
import { importRoot, ownDir, projectRoot, readRegistry, updateRegistry } from "./registry.ts";

export const LIMITS = Object.freeze({
    scannedEntries: 10_000,
    includedFiles: 5_000,
    includedBytes: 64 * 1024 * 1024,
    fileBytes: 8 * 1024 * 1024,
    depth: 32,
    ignoreFiles: 64,
    ignorePatterns: 8_192,
    ignoreBytes: 256 * 1024,
    previewMs: 20_000,
    previewOutputBytes: 32 * 1024,
    previewList: 100,
    childMs: 120_000,
    childOutputBytes: 8 * 1024,
});

const CACHE_ROOTS = new Set([
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".cache",
    ".gradle",
    ".next",
    ".nuxt",
    ".turbo",
    "target",
]);

const EXTRA_SENSITIVE = [
    /^\.env/i,
    /^\.netrc$/i,
    /^\.npmrc$/i,
    /^\.pypirc$/i,
    /^\.git-credentials$/i,
    /^auth\.json$/i,
    /^credentials?/i,
    /^secrets?/i,
    /^id_(?:rsa|dsa|ecdsa|ed25519)/i,
    /\.(?:pem|key|p12|pfx|kdbx|jks|keystore|keychain|sqlite|sqlite3|db)$/i,
];

const SENSITIVE_DIRS = new Set([
    ".ssh",
    ".aws",
    ".azure",
    ".docker",
    ".kube",
    ".gnupg",
    "sessions",
    ".sessions",
    "session-history",
]);

/** @param {string} name */
function sensitiveName(name) {
    const lower = name.toLowerCase();
    return (
        isSensitiveName(name) ||
        SENSITIVE_DIRS.has(lower) ||
        EXTRA_SENSITIVE.some((pattern) => pattern.test(name))
    );
}

/** @param {unknown} value */
function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {string} text */
function sha(text) {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

/** @param {string} path */
function shaFile(path) {
    const hash = createHash("sha256");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const buffer = Buffer.alloc(1024 * 1024);
        for (;;) {
            const read = readSync(fd, buffer, 0, buffer.length, null);
            if (read === 0) break;
            hash.update(buffer.subarray(0, read));
        }
    } finally {
        closeSync(fd);
    }
    return hash.digest("hex");
}

/** @param {number} fd */
function dirPath(fd) {
    return `/proc/self/fd/${fd}`;
}

/** @param {string} path */
function assertAbsolute(path, name) {
    if (typeof path !== "string" || path.length === 0 || path.length > 4096 || path.includes("\0"))
        throw new LayerfsRefusal(CODES.Invalid, `${name} is not a valid path.`);
    if (!isAbsolute(path)) throw new LayerfsRefusal(CODES.Invalid, `${name} must be absolute.`);
    return resolve(path);
}

/**
 * A source may not be a root, a private root, or an ancestor of one.
 *
 * @param {string} source
 * @param {{ dataDir: string, config: any }} context
 */
export function validateSource(source, context) {
    const absolute = assertAbsolute(source, "The source path");
    if (absolute === "/")
        throw new LayerfsRefusal(CODES.Invalid, "The filesystem root is not a source.");
    const home = resolve(homedir());
    if (absolute === home)
        throw new LayerfsRefusal(CODES.Invalid, "The home folder itself is not a source.");
    const config = context.config;
    const forbidden = [
        resolve(context.dataDir),
        ownDir({ dataDir: context.dataDir }),
        resolve(config.service.runtimeDir),
        resolve(config.service.layerfsHome),
        resolve(config.service.sdkPath),
        resolve(join(context.dataDir, "pocket-layerfs")),
        home + "/.pi/agent",
        home + "/.pi-pocket",
        home + "/.ssh",
        home + "/.gnupg",
        home + "/.aws",
        home + "/.kube",
        home + "/.azure",
        home + "/.docker",
        home + "/.config/gcloud",
    ];
    for (const root of forbidden) {
        if (isInside(root, absolute))
            throw new LayerfsRefusal(CODES.Invalid, "The source is inside a private folder.");
    }
    let real;
    try {
        real = resolve(absolute);
        const info = lstatSync(real);
        if (!info.isDirectory() || info.isSymbolicLink())
            throw new LayerfsRefusal(CODES.Invalid, "The source must be a real directory.");
        if (typeof process.getuid === "function" && info.uid !== process.getuid())
            throw new LayerfsRefusal(CODES.Invalid, "The source must be owned by this user.");
        if ((info.mode & 0o022) !== 0)
            throw new LayerfsRefusal(
                CODES.Invalid,
                "The source must not be group- or world-writable.",
            );
        let current = "/";
        for (const part of real.split("/").filter(Boolean)) {
            current = join(current, part);
            if (lstatSync(current).isSymbolicLink())
                throw new LayerfsRefusal(CODES.Invalid, "The source path must not contain a link.");
        }
    } catch (error) {
        if (error instanceof LayerfsRefusal) throw error;
        throw new LayerfsRefusal(CODES.Invalid, "The source path is not available.");
    }
    for (const root of forbidden) {
        if (isInside(absolute, root) && absolute !== root)
            throw new LayerfsRefusal(CODES.Invalid, "The source contains a private folder.");
    }
    return real;
}

/**
 * Open the source root one component at a time from `/`, so no ancestor can
 * be swapped for a link between the check and the open.
 *
 * @param {string} path
 */
function openRoot(path) {
    let fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
        const parts = resolve(path).split("/").filter(Boolean);
        for (const part of parts) {
            const next = openSync(
                join(dirPath(fd), part),
                constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            );
            try {
                const info = fstatSync(next);
                if (!info.isDirectory())
                    throw new LayerfsRefusal(
                        CODES.Invalid,
                        "A source component is not a directory.",
                    );
            } catch (error) {
                closeSync(next);
                throw error;
            }
            closeSync(fd);
            fd = next;
        }
        return fd;
    } catch (error) {
        try {
            closeSync(fd);
        } catch {
            // The descriptor is already closed.
        }
        throw error;
    }
}

/**
 * Open a directory and prove the descriptor matches the observed entry.
 *
 * @param {string} path
 * @param {number} parentFd
 * @param {string} name
 */
function openDirectory(path, parentFd, name) {
    const observed = name === "" ? lstatSync(path) : lstatSync(join(dirPath(parentFd), name));
    if (!observed.isDirectory() || observed.isSymbolicLink())
        throw new LayerfsRefusal(CODES.Invalid, "A source entry is not a real directory.");
    if (typeof process.getuid === "function" && observed.uid !== process.getuid())
        throw new LayerfsRefusal(CODES.Invalid, "A source entry has a foreign owner.");
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (
        !info.isDirectory() ||
        info.dev !== observed.dev ||
        info.ino !== observed.ino ||
        info.uid !== observed.uid
    ) {
        closeSync(fd);
        throw new LayerfsRefusal(
            CODES.Invalid,
            "A source entry changed during the import preview.",
        );
    }
    return fd;
}

/**
 * Read one `.gitignore` with the same descriptor boundary.
 *
 * @param {number} fd
 * @param {string} name
 */
function readIgnoreFile(fd, name) {
    const path = join(dirPath(fd), name);
    const observed = lstatSync(path);
    if (!observed.isFile() || observed.isSymbolicLink() || observed.nlink > 1)
        throw new LayerfsRefusal(CODES.Invalid, "An ignore file is not a regular file.");
    if (observed.size > LIMITS.ignoreBytes)
        throw new LayerfsRefusal(CODES.Invalid, "The ignore rules are too large.", 422);
    const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const info = fstatSync(file);
        if (info.dev !== observed.dev || info.ino !== observed.ino || info.size !== observed.size)
            throw new LayerfsRefusal(CODES.Invalid, "An ignore file changed while it was read.");
        const buffer = Buffer.alloc(observed.size);
        let offset = 0;
        while (offset < buffer.length) {
            const read = readSync(file, buffer, offset, buffer.length - offset, offset);
            if (read === 0) break;
            offset += read;
        }
        const after = fstatSync(file);
        if (after.size !== observed.size || after.mtimeMs !== observed.mtimeMs)
            throw new LayerfsRefusal(CODES.Invalid, "An ignore file changed while it was read.");
        let text;
        try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
        } catch {
            throw new LayerfsRefusal(CODES.Invalid, "An ignore file is not UTF-8.");
        }
        const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
        return { lines, bytes: offset };
    } finally {
        closeSync(file);
    }
}

/**
 * Last matching rule wins; deeper `.gitignore` files are added later.
 *
 * @param {{ base: string, matcher: any }[]} rules
 * @param {string} rel
 * @param {boolean} isDirectory
 */
function ignoredBy(rules, rel, isDirectory) {
    let decision = false;
    for (const rule of rules) {
        if (rule.base !== "" && rel !== rule.base && !rel.startsWith(`${rule.base}/`)) continue;
        const sub = rule.base === "" ? rel : rel.slice(rule.base.length + 1);
        if (sub === "") continue;
        let result;
        try {
            result = rule.matcher.test(`${sub}${isDirectory ? "/" : ""}`);
        } catch {
            throw new LayerfsRefusal(CODES.Invalid, "The ignore rules could not be evaluated.");
        }
        if (result.ignored) decision = true;
        else if (result.unignored) decision = false;
    }
    return decision;
}

/**
 * Walk the source through held descriptors. With a stage root, copy included
 * files; without one, only collect the fingerprint.
 *
 * Every acquired descriptor is owned by one scope and closed on every exit.
 *
 * @param {{ sourcePath: string, stageRoot: string | null, context: any }} options
 */
export function walkSource({ sourcePath, stageRoot, context }) {
    const deadline = Date.now() + LIMITS.previewMs;
    const rootFd = openRoot(sourcePath);
    const rootInfo = fstatSync(rootFd);
    if (typeof process.getuid === "function" && rootInfo.uid !== process.getuid()) {
        closeSync(rootFd);
        throw new LayerfsRefusal(CODES.Invalid, "The source must be owned by this user.");
    }
    const entries = [];
    const excluded = [];
    const reasons = Object.create(null);
    const included = [];
    let scanned = 0;
    let files = 0;
    let bytes = 0;
    let ignoreFiles = 0;
    let ignoreBytes = 0;
    let patterns = 0;
    const stack = [{ fd: rootFd, rel: "", depth: 0, rules: [], info: rootInfo }];
    const checkDeadline = () => {
        if (Date.now() > deadline)
            throw new LayerfsRefusal(
                CODES.Invalid,
                "The import preview deadline was exceeded.",
                422,
            );
    };
    const exclude = (rel, reason) => {
        reasons[reason] = (reasons[reason] ?? 0) + 1;
        if (excluded.length < LIMITS.previewList) excluded.push({ path: rel, reason });
    };
    try {
        while (stack.length > 0) {
            checkDeadline();
            const frame = stack.pop();
            const opened = [];
            let failed = false;
            try {
                const names = readdirSync(dirPath(frame.fd)).sort();
                let rules = frame.rules;
                if (names.includes(".gitignore")) {
                    if (ignoreFiles >= LIMITS.ignoreFiles)
                        throw new LayerfsRefusal(
                            CODES.Invalid,
                            "The source has too many ignore files.",
                            422,
                        );
                    const read = readIgnoreFile(frame.fd, ".gitignore");
                    ignoreFiles += 1;
                    ignoreBytes += read.bytes;
                    if (ignoreBytes > LIMITS.ignoreBytes)
                        throw new LayerfsRefusal(
                            CODES.Invalid,
                            "The aggregate ignore text is too large.",
                            422,
                        );
                    patterns += read.lines.length;
                    if (patterns > LIMITS.ignorePatterns)
                        throw new LayerfsRefusal(
                            CODES.Invalid,
                            "The source has too many ignore rules.",
                            422,
                        );
                    const matcher = ignore();
                    matcher.add(read.lines);
                    rules = [...rules, { base: frame.rel, matcher }];
                }
                for (const name of names) {
                    checkDeadline();
                    if (
                        name === "." ||
                        name === ".." ||
                        name.includes("/") ||
                        name.includes("\\") ||
                        /[\u0000-\u001f\u007f]/.test(name) ||
                        Buffer.byteLength(name, "utf8") > 255
                    )
                        throw new LayerfsRefusal(
                            CODES.Invalid,
                            "A source entry has an unsafe name.",
                        );
                    const rel = frame.rel === "" ? name : `${frame.rel}/${name}`;
                    scanned += 1;
                    if (scanned > LIMITS.scannedEntries)
                        throw new LayerfsRefusal(
                            CODES.Invalid,
                            "The source has too many entries.",
                            422,
                        );
                    const path = join(dirPath(frame.fd), name);
                    let info;
                    try {
                        info = lstatSync(path);
                    } catch {
                        throw new LayerfsRefusal(
                            CODES.Invalid,
                            "A source entry changed during the preview.",
                        );
                    }
                    if (typeof process.getuid === "function" && info.uid !== process.getuid())
                        throw new LayerfsRefusal(
                            CODES.Invalid,
                            "A source entry has a foreign owner.",
                        );
                    if (info.isSymbolicLink()) {
                        entries.push({
                            rel,
                            type: "link",
                            size: 0,
                            mtimeMs: info.mtimeMs,
                            ctimeMs: info.ctimeMs,
                            ino: info.ino,
                            sha: "",
                        });
                        exclude(rel, "symlink");
                        continue;
                    }
                    if (info.isDirectory()) {
                        if (name === ".git") {
                            exclude(rel, "git");
                            continue;
                        }
                        if (CACHE_ROOTS.has(name)) {
                            exclude(rel, "cache");
                            continue;
                        }
                        if (sensitiveName(name)) {
                            exclude(rel, "sensitive");
                            continue;
                        }
                        if (ignoredBy(rules, rel, true)) {
                            exclude(rel, "ignored");
                            continue;
                        }
                        if (frame.depth + 1 > LIMITS.depth)
                            throw new LayerfsRefusal(CODES.Invalid, "The source is too deep.", 422);
                        const childFd = openDirectory(path, frame.fd, name);
                        const childInfo = fstatSync(childFd);
                        if (stageRoot !== null) mkdirSync(join(stageRoot, rel), { mode: 0o700 });
                        entries.push({
                            rel,
                            type: "dir",
                            size: 0,
                            mtimeMs: info.mtimeMs,
                            ctimeMs: info.ctimeMs,
                            ino: info.ino,
                            sha: "",
                        });
                        opened.push({
                            fd: childFd,
                            rel,
                            depth: frame.depth + 1,
                            rules,
                            info: childInfo,
                        });
                        continue;
                    }
                    if (!info.isFile())
                        throw new LayerfsRefusal(CODES.Invalid, "The source has a special file.");
                    if (name === ".git") {
                        exclude(rel, "git");
                        continue;
                    }
                    if (sensitiveName(name)) {
                        exclude(rel, "sensitive");
                        continue;
                    }
                    if (CACHE_ROOTS.has(name) || ignoredBy(rules, rel, false)) {
                        exclude(rel, "ignored");
                        continue;
                    }
                    if (info.nlink > 1)
                        throw new LayerfsRefusal(
                            CODES.Invalid,
                            "The source has a hard-linked file.",
                        );
                    if (info.size > LIMITS.fileBytes)
                        throw new LayerfsRefusal(CODES.Invalid, "A source file is too large.", 422);
                    if (files + 1 > LIMITS.includedFiles)
                        throw new LayerfsRefusal(
                            CODES.Invalid,
                            "The source has too many files.",
                            422,
                        );
                    if (bytes + info.size > LIMITS.includedBytes)
                        throw new LayerfsRefusal(CODES.Invalid, "The source is too large.", 422);
                    const fileFd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
                    let content;
                    try {
                        const before = fstatSync(fileFd);
                        if (
                            !before.isFile() ||
                            before.dev !== info.dev ||
                            before.ino !== info.ino ||
                            before.size !== info.size ||
                            before.uid !== info.uid
                        )
                            throw new LayerfsRefusal(
                                CODES.Invalid,
                                "A source file changed during the preview.",
                            );
                        content = Buffer.alloc(info.size);
                        let offset = 0;
                        while (offset < content.length) {
                            const read = readSync(
                                fileFd,
                                content,
                                offset,
                                content.length - offset,
                                offset,
                            );
                            if (read === 0) break;
                            offset += read;
                        }
                        const after = fstatSync(fileFd);
                        if (
                            offset !== info.size ||
                            after.size !== info.size ||
                            after.mtimeMs !== info.mtimeMs ||
                            after.ctimeMs !== info.ctimeMs
                        )
                            throw new LayerfsRefusal(
                                CODES.Invalid,
                                "A source file changed during the preview.",
                            );
                    } finally {
                        closeSync(fileFd);
                    }
                    const digest = createHash("sha256").update(content).digest("hex");
                    files += 1;
                    bytes += content.length;
                    entries.push({
                        rel,
                        type: "file",
                        size: content.length,
                        mtimeMs: info.mtimeMs,
                        ctimeMs: info.ctimeMs,
                        ino: info.ino,
                        sha: digest,
                    });
                    if (stageRoot !== null) {
                        const target = join(stageRoot, rel);
                        const out = openSync(
                            target,
                            constants.O_WRONLY |
                                constants.O_CREAT |
                                constants.O_EXCL |
                                constants.O_NOFOLLOW,
                            0o600,
                        );
                        try {
                            let written = 0;
                            while (written < content.length)
                                written += writeSync(
                                    out,
                                    content,
                                    written,
                                    content.length - written,
                                );
                        } finally {
                            closeSync(out);
                        }
                    }
                    if (included.length < LIMITS.previewList)
                        included.push({ path: rel, size: content.length });
                }
                const after = fstatSync(frame.fd);
                if (
                    after.dev !== frame.info.dev ||
                    after.ino !== frame.info.ino ||
                    after.mtimeMs !== frame.info.mtimeMs ||
                    after.ctimeMs !== frame.info.ctimeMs
                )
                    throw new LayerfsRefusal(
                        CODES.Invalid,
                        "A source folder changed during the preview.",
                    );
            } catch (error) {
                failed = true;
                throw error;
            } finally {
                try {
                    closeSync(frame.fd);
                } catch {
                    // The frame descriptor is already closed.
                }
                if (failed) {
                    for (const child of opened) {
                        try {
                            closeSync(child.fd);
                        } catch {
                            // The child descriptor is already closed.
                        }
                    }
                }
            }
            for (const child of opened) stack.push(child);
        }
    } finally {
        for (const frame of stack) {
            try {
                closeSync(frame.fd);
            } catch {
                // The descriptor is already closed.
            }
        }
    }
    entries.sort((left, right) => (left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0));
    const fingerprint = createHash("sha256");
    for (const entry of entries) {
        fingerprint.update(
            `${entry.rel}\0${entry.type}\0${entry.size}\0${entry.sha}\0${entry.ino}\0${Math.trunc(entry.mtimeMs)}\0${Math.trunc(entry.ctimeMs)}\n`,
        );
    }
    return {
        entries,
        included,
        excluded,
        reasons,
        scanned,
        files,
        bytes,
        fingerprint: fingerprint.digest("hex"),
        ignoredByGlobalGit: true,
    };
}

/**
 * Hash the stage as it is now, including its file content.
 *
 * @param {string} stageRoot
 */
export function hashStage(stageRoot) {
    const result = walkStage(stageRoot);
    return result.hash;
}

/** @param {string} stageRoot */
function walkStage(stageRoot) {
    const hash = createHash("sha256");
    const stack = [{ path: stageRoot, rel: "" }];
    const entries = [];
    let files = 0;
    let bytes = 0;
    while (stack.length > 0) {
        const frame = stack.pop();
        for (const name of readdirSync(frame.path).sort()) {
            const path = join(frame.path, name);
            const rel = frame.rel === "" ? name : `${frame.rel}/${name}`;
            const info = lstatSync(path);
            if (info.isSymbolicLink() || info.uid !== process.getuid())
                throw new LayerfsRefusal(CODES.Invalid, "The import stage is not safe.");
            if (info.isDirectory()) {
                stack.push({ path, rel });
            } else if (info.isFile()) {
                files += 1;
                bytes += info.size;
                entries.push(`${rel}\0file\0${info.size}\0${shaFile(path)}\n`);
            } else {
                throw new LayerfsRefusal(CODES.Invalid, "The import stage has a special file.");
            }
        }
    }
    entries.sort();
    for (const entry of entries) hash.update(entry);
    hash.update(`count\0${files}\0${bytes}\n`);
    return { hash: hash.digest("hex"), files, bytes };
}

/**
 * @param {string} root
 * @param {string} path
 */
function assertStagePath(root, path) {
    const relative = path.startsWith(`${root}${sep}`) ? path.slice(root.length + 1) : null;
    if (relative === null || relative.split(sep).some((part) => !/^[A-Za-z0-9._-]+$/.test(part)))
        throw new LayerfsRefusal(CODES.Invalid, "The import stage path is not valid.");
    return relative;
}

const IMPORT_STATE_FILE = "import-state.json";

/**
 * Lifecycle states: `active` and `unknown` and `retained` are protected from
 * cleanup. `preview` and `failed` may be replaced.
 */
export function readImportState(dir) {
    try {
        const path = join(dir, IMPORT_STATE_FILE);
        const info = lstatSync(path);
        if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) return "idle";
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (parsed?.version !== 1) return "idle";
        return typeof parsed.state === "string" ? parsed.state : "idle";
    } catch {
        return "idle";
    }
}

/**
 * @param {string} dir
 * @param {"preview"|"active"|"unknown"|"retained"|"failed"} state
 * @param {string} ownerId
 */
function writeImportState(dir, state, ownerId) {
    const path = join(dir, IMPORT_STATE_FILE);
    const temporary = join(dir, `.state-${randomBytes(8).toString("hex")}.tmp`);
    const bytes = Buffer.from(
        `${JSON.stringify(
            {
                version: 1,
                state,
                owner: createHash("sha256").update(ownerId, "utf8").digest("hex"),
                at: Date.now(),
            },
            null,
            4,
        )}\n`,
        "utf8",
    );
    const fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
    );
    try {
        let offset = 0;
        while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    } finally {
        closeSync(fd);
    }
    renameSync(temporary, path);
}

/**
 * @param {any} runtime
 * @param {string} ownerId
 * @param {string} dir
 * @param {"preview"|"active"|"unknown"|"retained"|"failed"} state
 */
function markImportState(runtime, ownerId, dir, state) {
    try {
        writeImportState(dir, state, ownerId);
    } catch {
        // A marker write failure keeps the in-memory state and never grants.
    }
    runtime.importStates?.set(ownerId, { state, dir });
}

/**
 * Keep the fixed folder bound. Active, unknown, and retained stages are never
 * removed. If the protected count leaves no room, refuse before creating.
 *
 * @param {any} runtime
 * @param {string | null} keepDir
 */
function pruneImports(runtime, keepDir = null) {
    const root = importRoot(runtime.host);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const dirs = [];
    for (const name of readdirSync(root)) {
        if (!/^[0-9a-f]{24}$/.test(name)) continue;
        const path = join(root, name);
        const info = lstatSync(path);
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        if (typeof process.getuid === "function" && info.uid !== process.getuid()) continue;
        dirs.push({ path, at: info.mtimeMs, state: readImportState(path) });
    }
    const protectedState = new Set(["active", "unknown", "retained"]);
    const removable = dirs
        .filter((entry) => !protectedState.has(entry.state) && entry.path !== keepDir)
        .sort((left, right) => left.at - right.at);
    let count = dirs.length;
    while (count + 1 > 8 && removable.length > 0) {
        const entry = removable.shift();
        try {
            rmSync(entry.path, { recursive: true, force: true });
            count -= 1;
        } catch {
            break;
        }
    }
    if (count + 1 > 8)
        throw new LayerfsRefusal(
            CODES.Busy,
            "Retained import stages fill the fixed limit. Finish or inspect them first.",
        );
}

/**
 * Make one private import folder. A previous preview of this Owner is removed
 * only when it is not active, unknown, or retained, and only inside the bound.
 *
 * @param {any} runtime
 * @param {string} ownerId
 */
function newImportDir(runtime, ownerId) {
    const current = runtime.importStates?.get(ownerId);
    if (current?.state === "active")
        throw new LayerfsRefusal(CODES.Busy, "An import for this owner is still running.");
    const root = importRoot(runtime.host);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    pruneImports(runtime);
    runtime.previews.delete(ownerId);
    const importId = randomBytes(12).toString("hex");
    const dir = join(root, importId);
    mkdirSync(dir, { recursive: false, mode: 0o700 });
    mkdirSync(join(dir, "stage"), { mode: 0o700 });
    markImportState(runtime, ownerId, dir, "preview");
    return { importId, dir, stage: join(dir, "stage") };
}

/**
 * @param {unknown} value
 */
function text(value, max) {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= max &&
        !value.includes("\0")
    );
}

/** @param {string} path */
function writePrivateJson(path, value) {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 4)}\n`, "utf8");
    const fd = openSync(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
    );
    try {
        let offset = 0;
        while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    } finally {
        closeSync(fd);
    }
}

/**
 * @param {{ dataDir: string, config: any, host: any }} runtime
 * @param {{ projectId: string, label: string, sourcePath: string, branches: string[] }} input
 */
export function previewImport(runtime, input) {
    const registry = readRegistry(runtime.host);
    const config = runtime.config;
    if (config.projects.some((project) => project.id === input.projectId))
        throw new LayerfsRefusal(CODES.Conflict, "That project id is already configured.");
    if (registry.stores.some((store) => store.projectId === input.projectId))
        throw new LayerfsRefusal(
            CODES.Conflict,
            "That project id was already imported. Choose a new id.",
        );
    const source = validateSource(input.sourcePath, { dataDir: runtime.host.dataDir, config });
    const homeEntry = join(config.service.layerfsHome, input.projectId);
    try {
        lstatSync(homeEntry);
        throw new LayerfsRefusal(
            CODES.Conflict,
            "That project id is already initialized. Choose a new id.",
        );
    } catch (error) {
        if (error instanceof LayerfsRefusal) throw error;
        if (error?.code !== "ENOENT")
            throw new LayerfsRefusal(CODES.Invalid, "The LayerFS home is not available.");
    }
    const target = join(projectRoot(runtime.host), input.projectId, "store.sqlite");
    try {
        lstatSync(target);
        throw new LayerfsRefusal(CODES.Conflict, "A Store already exists for that project id.");
    } catch (error) {
        if (error instanceof LayerfsRefusal) throw error;
        if (/** @type {any} */ error?.code !== "ENOENT")
            throw new LayerfsRefusal(CODES.Invalid, "The Store folder is not available.");
    }
    const { importId, dir, stage } = newImportDir(runtime, input.ownerId);
    let walked;
    try {
        walked = walkSource({
            sourcePath: source,
            stageRoot: stage,
            context: { config, dataDir: runtime.host.dataDir },
        });
        const manifest = {
            version: 1,
            importId,
            projectId: input.projectId,
            label: input.label,
            branches: input.branches,
            files: walked.files,
            bytes: walked.bytes,
            scanned: walked.scanned,
            entries: walked.entries.map((entry) => ({
                path: entry.rel,
                type: entry.type,
                size: entry.size,
                sha256: entry.sha,
            })),
        };
        const stageHash = hashStage(stage);
        writePrivateJson(join(dir, "manifest.json"), { ...manifest, stageHash });
        const preview = {
            importId,
            projectId: input.projectId,
            label: input.label,
            branches: input.branches,
            files: walked.files,
            bytes: walked.bytes,
            scanned: walked.scanned,
            excluded: walked.excluded,
            excludedCounts: walked.reasons,
            included: walked.included,
            truncated:
                walked.included.length < walked.files || walked.excluded.length < walked.scanned,
            fingerprint: walked.fingerprint,
            stageHash,
            expiresAt: 0,
            ticket: "",
            notes: [
                "Only main exists in a new Store. Add other branches with the existing fork routes.",
                "Global Git excludes and .git/info/exclude are not read.",
                "A later source change needs a new preview and import.",
            ],
        };
        if (Buffer.byteLength(JSON.stringify(preview), "utf8") > LIMITS.previewOutputBytes)
            throw new LayerfsRefusal(CODES.Invalid, "The preview output is too large.", 422);
        const issued = runtime.tickets.issue(
            {
                ownerId: input.ownerId,
                conversationId: "",
                project: input.projectId,
                sourceBranch: "",
                fromRef: "",
                newBranch: "",
                expectedHead: "",
                op: "project.import",
                configRevision: input.expectedSha256,
                importId,
                stageHash,
                sourceFingerprint: walked.fingerprint,
                label: input.label,
                branches: input.branches.join(","),
            },
            { ttlMs: 300_000 },
        );
        preview.ticket = issued.ticket;
        preview.expiresAt = issued.record.expiresAt;
        runtime.previews.set(input.ownerId, {
            dir,
            importId,
            projectId: input.projectId,
            label: input.label,
            branches: input.branches,
            sourcePath: source,
            fingerprint: walked.fingerprint,
            stageHash,
            files: walked.files,
            bytes: walked.bytes,
            scanned: walked.scanned,
            configRevision: input.expectedSha256,
            expiresAt: issued.record.expiresAt,
        });
        return preview;
    } catch (error) {
        if (readImportState(dir) === "preview") {
            try {
                rmSync(dir, { recursive: true, force: true });
            } catch {
                // The failed staging folder is already gone.
            }
            runtime.importStates?.delete(input.ownerId);
        }
        throw error;
    }
}

/**
 * @param {{ config: any }} runtime
 * @param {string} source
 */
function sourceFingerprint(runtime, source) {
    const walked = walkSource({
        sourcePath: source,
        stageRoot: null,
        context: { config: runtime.config, dataDir: runtime.host.dataDir },
    });
    return walked.fingerprint;
}

/**
 * @param {{ stdout: string }} result
 */
function parseChildLine(result) {
    const line = result.stdout.split("\n").find((entry) => entry.startsWith("LAYERFS_IMPORT "));
    if (line === undefined)
        throw new LayerfsRefusal(CODES.Upstream, "The import child gave no result.");
    try {
        return JSON.parse(line.slice("LAYERFS_IMPORT ".length));
    } catch {
        throw new LayerfsRefusal(CODES.Upstream, "The import child gave an invalid result.");
    }
}

/**
 * @param {string[]} args
 * @param {{ timeoutMs: number }} options
 * @returns {Promise<{ error?: string, code?: number | null, signal?: string | null, stdout: string, stderr: string, timedOut: boolean, tooLarge: boolean }>}
 */
function runChild(args, options) {
    return new Promise((resolveRun) => {
        const child = spawn(args[0], args.slice(1), {
            env: {
                PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
                LANG: "C",
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let tooLarge = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, options.timeoutMs);
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > LIMITS.childOutputBytes) {
                tooLarge = true;
                child.kill("SIGKILL");
                return;
            }
            stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
            if (stderr.length < 4096) stderr += chunk;
        });
        child.on("error", (error) => {
            clearTimeout(timer);
            resolveRun({
                error: (error as any).code ?? "spawn",
                stdout,
                stderr,
                timedOut,
                tooLarge,
            });
        });
        child.on("close", (code, signal) => {
            clearTimeout(timer);
            resolveRun({ code, signal, stdout, stderr, timedOut, tooLarge });
        });
    });
}

/**
 * @param {{ host: any, config: any }} runtime
 * @param {string} importId
 */
function importDirOf(runtime, importId) {
    if (!/^[0-9a-f]{24}$/.test(importId))
        throw new LayerfsRefusal(CODES.Invalid, "The import id is not valid.");
    return join(importRoot(runtime.host), importId);
}

/**
 * Confirm one preview. The native child receives only the stage and target.
 *
 * @param {any} runtime
 * @param {{ ownerId: string, ticket: string, expectedSha256: string }} input
 */
export async function confirmImport(runtime, input) {
    const record = runtime.tickets.take(input.ticket, {
        ownerId: input.ownerId,
        op: "project.import",
    });
    if (record.configRevision !== input.expectedSha256)
        throw new LayerfsRefusal(CODES.TicketMismatch, "The configuration changed; preview again.");
    const preview = runtime.previews.get(input.ownerId);
    if (
        preview === undefined ||
        preview.importId !== record.importId ||
        preview.stageHash !== record.stageHash ||
        preview.fingerprint !== record.sourceFingerprint ||
        preview.configRevision !== record.configRevision
    )
        throw new LayerfsRefusal(CODES.TicketMismatch, "The preview does not match this import.");
    const dir = importDirOf(runtime, record.importId);
    if (runtime.importStates?.get(input.ownerId)?.state === "active")
        throw new LayerfsRefusal(CODES.Busy, "An import for this owner is already running.");
    markImportState(runtime, input.ownerId, dir, "active");
    let finalState = "failed";
    let failure = null;
    let nativeStarted = false;
    try {
        const configNow = runtime.config;
        const own = runtime.ownPath;
        const saved = readOwnHash(own);
        if (saved !== input.expectedSha256)
            throw new LayerfsRefusal(CODES.Conflict, "The configuration changed; preview again.");
        const source = validateSource(preview.sourcePath, {
            dataDir: runtime.host.dataDir,
            config: configNow,
        });
        const stage = join(dir, "stage");
        if (hashStage(stage) !== record.stageHash)
            throw new LayerfsRefusal(CODES.Conflict, "The import stage changed; preview again.");
        const fingerprint = sourceFingerprint(runtime, source);
        if (fingerprint !== record.sourceFingerprint)
            throw new LayerfsRefusal(CODES.Conflict, "The source changed; preview again.");
        const targetDir = join(projectRoot(runtime.host), preview.projectId);
        mkdirSync(targetDir, { recursive: true, mode: 0o700 });
        const store = join(targetDir, "store.sqlite");
        if (exists(store))
            throw new LayerfsRefusal(CODES.Conflict, "The Store target already exists.");
        const home = configNow.service.layerfsHome;
        if (exists(join(home, preview.projectId)))
            throw new LayerfsRefusal(CODES.Conflict, "The LayerFS home entry already exists.");
        const requestPath = join(dir, "init-request.json");
        writePrivateJson(requestPath, {
            version: 1,
            mode: "import",
            operation: "project.init",
            importId: record.importId,
            project: preview.projectId,
            stage,
            store,
            home,
            sdk: configNow.service.sdkPath,
            stageHash: record.stageHash,
        });
        const childPath = fileURLToPath(new URL("./import-child.mjs", import.meta.url));
        nativeStarted = true;
        const result = (await runChild(
            ["unshare", "-Ur", process.execPath, childPath, "--request", requestPath],
            { timeoutMs: LIMITS.childMs },
        )) as any;
        if (result.error !== undefined) {
            finalState = "failed";
            throw new LayerfsRefusal(CODES.Upstream, "The rootless import child is not available.");
        }
        if (result.timedOut || result.tooLarge) {
            finalState = "unknown";
            throw new LayerfsRefusal(
                CODES.Timeout,
                "The import outcome is unknown. A partial Store is kept private; do not retry automatically.",
                504,
            );
        }
        if (result.code !== 0) {
            finalState = "unknown";
            throw new LayerfsRefusal(
                CODES.Upstream,
                "The import did not finish. A partial Store is kept private; choose a new import id.",
            );
        }
        const parsed = parseChildLine(result);
        if (parsed.kind !== "Initialized" || parsed.operation !== "project.init")
            throw new LayerfsRefusal(CODES.Upstream, "The Store was not initialized.");
        const verifyPath = join(dir, "verify-request.json");
        writePrivateJson(verifyPath, {
            version: 1,
            mode: "verify",
            operation: "project.verify",
            importId: record.importId,
            project: preview.projectId,
            stage,
            store,
            home,
            sdk: configNow.service.sdkPath,
            stageHash: record.stageHash,
        });
        const verify = (await runChild([process.execPath, childPath, "--request", verifyPath], {
            timeoutMs: 60_000,
        })) as any;
        if (verify.error !== undefined || verify.timedOut || verify.tooLarge || verify.code !== 0) {
            finalState = "unknown";
            throw new LayerfsRefusal(
                CODES.Timeout,
                "The Store verification did not finish. The Store is kept private; do not retry automatically.",
                504,
            );
        }
        const check = parseChildLine(verify);
        if (check.ok !== true || check.operation !== "project.verify")
            throw new LayerfsRefusal(CODES.Upstream, "The Store verification is not valid.");
        const branches = Array.isArray(check.branches)
            ? check.branches.filter(
                  (name) => typeof name === "string" && /^[A-Za-z0-9._-]{1,63}$/.test(name),
              )
            : [];
        if (!branches.includes("main"))
            throw new LayerfsRefusal(CODES.Upstream, "The Store has no main branch.");
        const info = lstatSync(store);
        if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022) !== 0)
            throw new LayerfsRefusal(CODES.Upstream, "The Store file is not safe.");
        await withConfigMutation(() =>
            updateRegistry(runtime.host, (registry) => ({
                registry: {
                    version: registry.version,
                    stores: [
                        ...registry.stores,
                        {
                            importId: record.importId,
                            projectId: preview.projectId,
                            label: preview.label,
                            branches,
                            origin: "import",
                            storePath: store,
                            sourcePath: preview.sourcePath,
                            state: "unpublished-ready",
                            createdAt: Date.now(),
                            files: preview.files,
                            bytes: preview.bytes,
                            fingerprint: record.sourceFingerprint,
                        },
                    ],
                },
                answer: { branches },
            })),
        );
        finalState = "retained";
        return {
            ok: true,
            importId: record.importId,
            projectId: preview.projectId,
            branches,
            files: preview.files,
            bytes: preview.bytes,
            state: "unpublished-ready",
            note: "The Store is unpublished. Save and apply to publish the project.",
        };
    } catch (error) {
        failure = error;
        throw error;
    } finally {
        runtime.previews.delete(input.ownerId);
        markImportState(runtime, input.ownerId, dir, finalState);
        if (failure !== null && nativeStarted) {
            try {
                await withConfigMutation(() =>
                    updateRegistry(runtime.host, (registry) => ({
                        registry: {
                            version: registry.version,
                            stores: [
                                ...registry.stores,
                                {
                                    importId: record.importId,
                                    projectId: preview.projectId,
                                    label: preview.label,
                                    branches: ["main"],
                                    origin: "import",
                                    storePath: join(
                                        projectRoot(runtime.host),
                                        preview.projectId,
                                        "store.sqlite",
                                    ),
                                    sourcePath: preview.sourcePath,
                                    state: finalState === "unknown" ? "unknown" : "failed",
                                    createdAt: Date.now(),
                                    files: preview.files ?? 0,
                                    bytes: preview.bytes ?? 0,
                                    fingerprint: record.sourceFingerprint,
                                },
                            ],
                        },
                        answer: null,
                    })),
                );
            } catch {
                // The Store bytes and the lifecycle marker stay; the registry
                // write failure is reported by the thrown error path.
            }
        }
    }
}

/** @param {string} path */
function exists(path) {
    try {
        lstatSync(path);
        return true;
    } catch {
        return false;
    }
}

/** @param {string} path */
function readOwnHash(path) {
    try {
        return shaFile(path);
    } catch {
        return null;
    }
}

/**
 * The unpublished and retained Stores, without private paths or source text.
 *
 * @param {any} runtime
 */
export function listImports(runtime) {
    const registry = readRegistry(runtime.host);
    return {
        stores: registry.stores.map((store) => ({
            importId: store.importId,
            projectId: store.projectId,
            label: store.label,
            branches: store.branches,
            state: store.state,
            createdAt: store.createdAt,
            files: store.files,
            bytes: store.bytes,
            configured: runtime.config.projects.some((project) => project.id === store.projectId),
        })),
        limits: LIMITS,
    };
}

/**
 * @param {any} runtime
 * @param {string} projectId
 */
export function projectDetail(runtime, projectId) {
    const project = runtime.config.projects.find((entry) => entry.id === projectId);
    if (project === undefined) throw new LayerfsRefusal(CODES.NotFound);
    const registry = readRegistry(runtime.host);
    const store = registry.stores.find((entry) => entry.projectId === projectId);
    return {
        id: project.id,
        label: project.label,
        origin: project.origin,
        branches: project.branches,
        sourcePath: store?.sourcePath ?? null,
        storeState: store?.state ?? "configured",
        files: store?.files ?? null,
        bytes: store?.bytes ?? null,
    };
}
