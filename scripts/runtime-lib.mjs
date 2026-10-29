/**
 * Exclusive runtime checks. A runtime is a directory this project owns; it
 * carries a marker file. Setup and synthetic init may replace a path inside
 * it only after checking the real path, the owner, the mode, and every
 * ancestor for links. A non-project directory is never removed.
 */
import { createHash } from "node:crypto";
import {
    closeSync,
    constants,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readSync,
    readdirSync,
    readlinkSync,
    realpathSync,
    writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertNotLive } from "./install-lib.mjs";

export const RUNTIME_MARKER = ".pi-pocket-layerfs-runtime";
export const SYNTHETIC_MARKER = ".pi-pocket-layerfs-synthetic";

/**
 * The one synthetic tree this project creates, pinned by content. The marker
 * alone is not provenance: anyone can copy it. `scripts/init-synthetic.mjs`
 * writes exactly these three files, and `assertSyntheticSource` requires the
 * tree below the marker to hash to this value.
 *
 * Files: README.md, notices.md, docs/hello.txt (the marker is excluded).
 */
export const SYNTHETIC_TREE_SHA256 =
    "12ca904c381eb42691d852719d04dd61f5ed41bb5b27fc0dbf1cfdd41bab1642";

function assertNoLinks(path, allowMissingFinal = false) {
    const absolute = resolve(path);
    const parts = absolute.split("/").filter(Boolean);
    let current = "/";
    for (let index = 0; index < parts.length; index += 1) {
        current = join(current, parts[index]);
        let info;
        try {
            info = lstatSync(current);
        } catch {
            if (allowMissingFinal) return;
            throw new Error("A runtime path component is missing");
        }
        if (info.isSymbolicLink()) throw new Error("The runtime path must not contain a link");
    }
}

/**
 * Create or validate an exclusive runtime directory with a marker. A
 * non-empty directory without the marker is refused; it is never adopted.
 *
 * @param {string} runtime
 * @param {{ create?: boolean }} [options]
 * @returns {string} real path
 */
export function assertExclusiveRuntime(runtime, options = {}) {
    if (typeof runtime !== "string" || !isAbsolute(runtime) || resolve(runtime) === "/")
        throw new Error("The runtime must be an absolute non-root path");
    const absolute = resolve(runtime);
    let exists = true;
    try {
        lstatSync(absolute);
    } catch {
        exists = false;
    }
    if (!exists) {
        if (options.create !== true) throw new Error("The runtime does not exist");
        mkdirSync(absolute, { recursive: false, mode: 0o700 });
    }
    assertNoLinks(absolute);
    const info = lstatSync(absolute);
    if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("The runtime must be a real directory");
    if (typeof process.getuid === "function" && info.uid !== process.getuid())
        throw new Error("The runtime must be owned by the current user");
    if ((info.mode & 0o777) !== 0o700) throw new Error("The runtime must have mode 0700");
    const real = realpathSync(absolute);
    if (real !== absolute) throw new Error("The runtime resolves through a link");
    assertNotLive(real);

    const markerPath = join(real, RUNTIME_MARKER);
    let marker = null;
    try {
        marker = lstatSync(markerPath);
    } catch {
        marker = null;
    }
    if (marker === null) {
        if (options.create !== true) return real;
        if (readdirSync(real).length !== 0)
            throw new Error(
                "The runtime is not empty and has no pi-pocket-layerfs marker; refusing to adopt it",
            );
        writeFileSync(
            markerPath,
            `${JSON.stringify({ name: "pi-pocket-layerfs-runtime", version: 1 })}\n`,
            { mode: 0o600 },
        );
    } else {
        if (!marker.isFile() || marker.isSymbolicLink())
            throw new Error("The runtime marker must be a regular file");
        if ((marker.mode & 0o077) !== 0) throw new Error("The runtime marker must be mode 0600");
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(markerPath, "utf8"));
        } catch {
            throw new Error("The runtime marker is not valid JSON");
        }
        if (parsed?.name !== "pi-pocket-layerfs-runtime" || parsed?.version !== 1)
            throw new Error("The runtime marker is not recognized");
    }
    return real;
}

/**
 * Check that a path is inside the exclusive runtime, has no link ancestor,
 * and (if present) is owned by the current user. It does not remove anything.
 *
 * @param {string} runtimeReal
 * @param {string} path
 * @returns {string}
 */
export function assertReplaceable(runtimeReal, path) {
    const absolute = resolve(path);
    if (!absolute.startsWith(`${runtimeReal}${sep}`))
        throw new Error("Refusing a path outside the exclusive runtime");
    assertNoLinks(absolute, true);
    let info = null;
    try {
        info = lstatSync(absolute);
    } catch {
        return absolute;
    }
    if (info.isSymbolicLink()) throw new Error("Refusing a link inside the runtime");
    if (typeof process.getuid === "function" && info.uid !== process.getuid())
        throw new Error("Refusing a runtime path owned by another user");
    return absolute;
}

/**
 * A full tree hash over sorted relative paths, type, size, file bytes and
 * symlink targets. `.git` at the root is always excluded; `exclude` names
 * further top-level entries (for example a marker file or an SDK's native
 * folder). This is a content hash, not a marker written by the tree itself.
 *
 * @param {string} root
 * @param {string[]} [exclude]
 * @returns {string}
 */
export function treeHash(root, exclude = []) {
    const base = resolve(root);
    const skip = new Set([".git", ...exclude]);
    const hash = createHash("sha256");
    const walk = (dir) => {
        const names = readdirSync(dir, { withFileTypes: true })
            .filter((entry) => !(dir === base && skip.has(entry.name)))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const name of names) {
            const path = join(dir, name.name);
            const rel = relative(base, path).split("/").join("/");
            const info = lstatSync(path);
            if (info.isSymbolicLink()) {
                hash.update(`l\0${rel}\0${readlinkSync(path)}\0`);
            } else if (info.isDirectory()) {
                hash.update(`d\0${rel}\0`);
                walk(path);
            } else if (info.isFile()) {
                hash.update(`f\0${rel}\0${info.size}\0`);
                const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
                try {
                    const buffer = Buffer.alloc(1024 * 1024);
                    while (true) {
                        const length = readSync(fd, buffer, 0, buffer.length, null);
                        if (length === 0) break;
                        hash.update(buffer.subarray(0, length));
                    }
                } finally {
                    closeSync(fd);
                }
            } else {
                throw new Error(`The source contains a non-regular entry: ${rel}`);
            }
        }
    };
    walk(base);
    return hash.digest("hex");
}

/**
 * Write a synthetic-source marker only after the fixed tree is created.
 *
 * @param {string} source
 */
export function markSyntheticSource(source) {
    writeFileSync(
        join(source, SYNTHETIC_MARKER),
        `${JSON.stringify({ name: "pi-pocket-layerfs-synthetic", version: 1 })}\n`,
        { mode: 0o600 },
    );
}

/**
 * Walk every entry without following a link. Only real directories and
 * regular files owned by the current user are allowed; the tree this project
 * creates is flat in shape and never contains a link.
 *
 * @param {string} root
 * @param {string} label
 */
function assertFixedTree(root, label) {
    const base = resolve(root);
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            const info = lstatSync(path);
            const rel = relative(base, path).split("/").join("/");
            if (info.isSymbolicLink()) throw new Error(`${label} must not contain a link: ${rel}`);
            if (typeof process.getuid === "function" && info.uid !== process.getuid())
                throw new Error(`${label} contains a path owned by another user: ${rel}`);
            if (info.isDirectory()) {
                walk(path);
            } else if (!info.isFile()) {
                throw new Error(`${label} contains an unexpected non-regular entry: ${rel}`);
            }
        }
    };
    walk(base);
}

/**
 * Validate a source directory as the fixed synthetic tree. It must be exactly
 * `<runtime>/synthetic-source`, have the marker, be owned by the current user,
 * and contain no link.
 *
 * @param {string} runtimeReal
 * @param {string} source
 */
export function assertSyntheticSource(runtimeReal, source) {
    const expected = join(runtimeReal, "synthetic-source");
    if (resolve(source) !== expected)
        throw new Error("The synthetic child may only use <runtime>/synthetic-source");
    assertReplaceable(runtimeReal, expected);
    const info = lstatSync(expected);
    if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("The synthetic source must be a real directory");
    if (typeof process.getuid === "function" && info.uid !== process.getuid())
        throw new Error("The synthetic source must be owned by the current user");
    assertFixedTree(expected, "The synthetic source");
    const markerPath = join(expected, SYNTHETIC_MARKER);
    const marker = lstatSync(markerPath);
    if (!marker.isFile() || marker.isSymbolicLink())
        throw new Error("The synthetic source marker is missing or not regular");
    if ((marker.mode & 0o077) !== 0)
        throw new Error("The synthetic source marker must be mode 0600");
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(markerPath, "utf8"));
    } catch {
        throw new Error("The synthetic source marker is not valid JSON");
    }
    if (parsed?.name !== "pi-pocket-layerfs-synthetic" || parsed?.version !== 1)
        throw new Error("The synthetic source marker is not recognized");
    // The marker can be copied; the tree beneath it cannot be forged without
    // changing this fixed content hash. Anything else is not this runtime's
    // synthetic source and must never reach project.init or the SDK import.
    const actual = treeHash(expected, [SYNTHETIC_MARKER]);
    if (actual !== SYNTHETIC_TREE_SHA256)
        throw new Error(
            "The synthetic source is not the fixed synthetic tree this project creates; refusing to import it",
        );
}

/**
 * A path must be exactly one of the fixed child paths under the runtime.
 *
 * @param {string} runtimeReal
 * @param {string} path
 * @param {string} relativePath
 */
export function assertFixedPath(runtimeReal, path, relativePath) {
    const expected = join(runtimeReal, relativePath);
    if (resolve(path) !== expected) throw new Error(`The child may only use ${relativePath}`);
    return assertReplaceable(runtimeReal, expected);
}

/**
 * The parent of a path, for a simple diagnostic.
 *
 * @param {string} path
 */
export function parentOf(path) {
    return dirname(path);
}
