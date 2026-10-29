/**
 * Shared install/uninstall safety. The manifest is untrusted input: it can be
 * edited, truncated, or replaced by a link. Every path is checked against a
 * fixed prefix, every ancestor is checked for links, and every existing file
 * is hash-checked before anything is removed.
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
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, basename, isAbsolute, join, resolve, sep } from "node:path";

export const MANIFEST = ".layerfs-install.json";
const MANIFEST_MAX = 256 * 1024;
const MODULE_FILE = "pocket-layerfs.ts";
const MODULE_DIR = "pocket-layerfs";

/**
 * @param {string} path
 * @returns {string}
 */
export function hashFile(path) {
    const hash = createHash("sha256");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const info = fstatSync(fd);
        if (!info.isFile()) throw new Error("not a regular file");
        const buffer = Buffer.alloc(1024 * 1024);
        while (true) {
            const length = readSync(fd, buffer, 0, buffer.length, null);
            if (length === 0) break;
            hash.update(buffer.subarray(0, length));
        }
    } finally {
        closeSync(fd);
    }
    return hash.digest("hex");
}

/**
 * Walk existing components and refuse a link. The final path may be missing
 * only when `allowMissingFinal` is true.
 *
 * @param {string} path
 * @param {boolean} [allowMissingFinal]
 */
export function assertNoSymlinkAncestors(path, allowMissingFinal = false) {
    const absolute = resolve(path);
    let current = "/";
    const parts = absolute.split("/").filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
        current = join(current, parts[index]);
        let info;
        try {
            info = lstatSync(current);
        } catch (error) {
            if (allowMissingFinal && index === parts.length - 1) return;
            throw new Error("a target component is missing");
        }
        if (info.isSymbolicLink()) throw new Error("the target path must not contain a link");
    }
}

/**
 * The real path of the live Pi Pocket data folder, if it exists. `PI_POCKET_DIR`
 * may name a copy; the default is ~/.pi-pocket.
 *
 * @returns {string[]}
 */
export function liveRoots() {
    const roots = [join(homedir(), ".pi-pocket")];
    if (process.env.PI_POCKET_DIR) roots.push(resolve(process.env.PI_POCKET_DIR));
    const real = [];
    for (const root of roots) {
        try {
            real.push(realpathSync(root));
        } catch {
            real.push(resolve(root));
        }
    }
    return [...new Set(real)];
}

/**
 * Refuse the live data folder and anything inside it.
 *
 * @param {string} targetReal
 */
export function assertNotLive(targetReal) {
    for (const root of liveRoots()) {
        if (targetReal === root || targetReal.startsWith(`${root}${sep}`)) {
            throw new Error(
                "Refusing to touch the live Pi Pocket data folder. Use an independent target.",
            );
        }
    }
}

/**
 * Prepare and validate an explicit target. A new final component is allowed
 * only when its parent is an existing real directory with no link ancestor.
 *
 * @param {string} target
 * @param {{ create?: boolean }} [options]
 * @returns {string} real path
 */
export function prepareTarget(target, options = {}) {
    if (typeof target !== "string" || target.length === 0 || !isAbsolute(target))
        throw new Error("The target must be an absolute path");
    if (resolve(target) === "/") throw new Error("The target must not be the filesystem root");
    const absolute = resolve(target);
    let exists = true;
    try {
        lstatSync(absolute);
    } catch {
        exists = false;
    }
    if (exists) {
        assertNoSymlinkAncestors(absolute);
        const info = lstatSync(absolute);
        if (!info.isDirectory() || info.isSymbolicLink())
            throw new Error("The target must be a real directory");
    } else {
        const parent = dirname(absolute);
        assertNoSymlinkAncestors(parent);
        const parentInfo = lstatSync(parent);
        if (!parentInfo.isDirectory()) throw new Error("The target parent must be a directory");
        const parentReal = realpathSync(parent);
        if (parentReal !== parent) throw new Error("The target resolves through a link");
        // Refuse a protected location before creating anything. The live
        // fingerprint must be unchanged even for a rejected install.
        assertNotLive(join(parentReal, basename(absolute)));
        if (options.create) {
            mkdirSync(absolute, { recursive: false, mode: 0o700 });
            assertNoSymlinkAncestors(absolute);
        } else {
            throw new Error("The target does not exist");
        }
    }
    const real = realpathSync(absolute);
    assertNotLive(real);
    if (real !== absolute) throw new Error("The target resolves through a link");
    return real;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function safeRelative(value) {
    if (typeof value !== "string" || value.length === 0 || value.length > 240)
        throw new Error("The manifest has an invalid file path");
    if (
        value.includes("\0") ||
        value.includes("\\") ||
        value.startsWith("/") ||
        value.includes("//")
    )
        throw new Error("The manifest has an invalid file path");
    if (value === MODULE_FILE) return value;
    if (!value.startsWith(`${MODULE_DIR}/`))
        throw new Error("The manifest path is outside the module prefix");
    const relative = value.slice(MODULE_DIR.length + 1);
    const parts = relative.split("/");
    if (parts.length === 0 || parts.length > 10) throw new Error("The manifest path is too deep");
    for (const part of parts) {
        if (
            part === "" ||
            part === "." ||
            part === ".." ||
            part === "_pocket.d.ts" ||
            part.startsWith(".") ||
            !/^[A-Za-z0-9._-]+$/.test(part)
        ) {
            throw new Error("The manifest has an invalid file path component");
        }
    }
    return value;
}

/**
 * @param {unknown} raw
 * @returns {{ name: string, version: string, files: { path: string, sha256: string }[] }}
 */
export function validateManifest(raw) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("The manifest is not an object");
    const manifest = /** @type {any} */ (raw);
    const allowed = new Set(["name", "version", "installedAt", "files", "configPath", "enabled"]);
    for (const key of Object.keys(manifest)) {
        if (!allowed.has(key)) throw new Error("The manifest has an unknown field");
    }
    if (manifest.name !== "pi-pocket-layerfs") throw new Error("The manifest has an unknown name");
    if (typeof manifest.version !== "string" || manifest.version.length > 40)
        throw new Error("The manifest has an invalid version");
    if (!Array.isArray(manifest.files) || manifest.files.length > 200)
        throw new Error("The manifest has an invalid file list");
    const seen = new Set();
    const files = [];
    for (const entry of manifest.files) {
        if (entry === null || typeof entry !== "object")
            throw new Error("The manifest has an invalid file entry");
        const path = safeRelative(entry.path);
        if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256))
            throw new Error("The manifest has an invalid file hash");
        if (seen.has(path)) throw new Error("The manifest has a duplicate file path");
        seen.add(path);
        files.push({ path, sha256: entry.sha256 });
    }
    return { name: manifest.name, version: manifest.version, files };
}

/**
 * Read and validate a manifest without following a leaf link.
 *
 * @param {string} target
 * @returns {{ name: string, version: string, files: { path: string, sha256: string }[] } | null}
 */
export function readManifest(target) {
    const path = join(target, MANIFEST);
    let info;
    try {
        info = lstatSync(path);
    } catch {
        return null;
    }
    if (!info.isFile() || info.isSymbolicLink())
        throw new Error("The install manifest must be a regular file");
    if (info.size > MANIFEST_MAX) throw new Error("The install manifest is too large");
    let raw;
    try {
        raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        throw new Error("The install manifest is not valid JSON");
    }
    return validateManifest(raw);
}

/**
 * Resolve a manifest path under the real target. Every existing parent is
 * checked for links. With `createParents`, missing parents are made 0700 and
 * checked again; without it, a missing parent means the file is already gone.
 *
 * @param {string} targetReal
 * @param {string} relative
 * @param {{ createParents?: boolean }} [options]
 * @returns {string | null}
 */
export function destinationFor(targetReal, relative, options = {}) {
    const safe = safeRelative(relative);
    const parts = safe.split("/");
    let current = targetReal;
    for (let index = 0; index < parts.length - 1; index += 1) {
        current = join(current, parts[index]);
        let info;
        try {
            info = lstatSync(current);
        } catch {
            if (options.createParents !== true) return null;
            mkdirSync(current, { recursive: false, mode: 0o700 });
            info = lstatSync(current);
        }
        if (info.isSymbolicLink() || !info.isDirectory())
            throw new Error("A destination parent is not a real directory");
    }
    const destination = join(targetReal, safe);
    if (!destination.startsWith(`${targetReal}${sep}`))
        throw new Error("The manifest path escapes the target");
    return destination;
}

/**
 * Write a manifest through a same-directory temporary file and rename.
 *
 * @param {string} target
 * @param {any} value
 */
export function writeManifest(target, value) {
    const path = join(target, MANIFEST);
    const temporary = join(target, `${MANIFEST}.${process.pid}.${Date.now()}.new`);
    writeFileSync(temporary, `${JSON.stringify(value, null, 4)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
}
