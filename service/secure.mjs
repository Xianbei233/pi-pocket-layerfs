/**
 * Private-file checks for the standalone service.
 *
 * The service is not a shared daemon and does not trust a same-UID socket as
 * authentication. It checks the runtime directory, the token file, the
 * LayerFS home, the Store, and the SDK path before it opens them, and it
 * opens the token with O_NOFOLLOW so an lstat/read race cannot swap a link
 * in. A trusted config is still checked: a typo such as
 * `/runtime/../outside` must not escape the runtime directory.
 */
import {
    chmodSync,
    closeSync,
    constants,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readSync,
    realpathSync,
    unlinkSync,
    writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createConnection } from "node:net";
import { CODES, LayerfsRefusal } from "../src/pocket-layerfs/errors.ts";

const TOKEN_BYTES = 32;
const MAX_TOKEN_BYTES = 256;

/**
 * Walk every component from `/` and refuse any symbolic link. This catches a
 * link in an ancestor, not only at the final component.
 *
 * @param {string} path
 */
export function assertNoSymlinkPath(path) {
    const absolute = resolve(path);
    let current = "/";
    for (const part of absolute.split("/").filter(Boolean)) {
        current = join(current, part);
        let info;
        try {
            info = lstatSync(current);
        } catch {
            throw new LayerfsRefusal(CODES.NotConfigured);
        }
        if (info.isSymbolicLink()) throw new LayerfsRefusal(CODES.NotConfigured);
    }
}

/**
 * Require a path to be its own real path, so no ancestor was a link when it
 * was checked.
 *
 * @param {string} path
 */
export function assertRealPath(path) {
    if (realpathSync(path) !== resolve(path)) throw new LayerfsRefusal(CODES.NotConfigured);
}

/**
 * Create the runtime directory if absent, then require mode 0700, the current
 * uid, and no link in any component.
 *
 * @param {string} path
 * @returns {string}
 */
export function ensureRuntimeDir(path) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    assertNoSymlinkPath(path);
    assertRealPath(path);
    const info = lstatSync(path);
    if (!info.isDirectory()) throw new LayerfsRefusal(CODES.NotConfigured);
    if (typeof process.getuid === "function" && info.uid !== process.getuid())
        throw new LayerfsRefusal(CODES.NotConfigured);
    if ((info.mode & 0o777) !== 0o700) throw new LayerfsRefusal(CODES.NotConfigured);
    return resolve(path);
}

/**
 * Require an existing private directory (LayerFS home). The service does not
 * create it: `project.init` and the owner's setup do.
 *
 * @param {string} path
 * @returns {string}
 */
export function assertPrivateDir(path) {
    assertNoSymlinkPath(path);
    assertRealPath(path);
    const info = lstatSync(path);
    if (!info.isDirectory()) throw new LayerfsRefusal(CODES.NotConfigured);
    if (typeof process.getuid === "function" && info.uid !== process.getuid())
        throw new LayerfsRefusal(CODES.NotConfigured);
    if ((info.mode & 0o777) !== 0o700) throw new LayerfsRefusal(CODES.NotConfigured);
    return resolve(path);
}

/**
 * Require the SDK folder to be a real directory owned by this user, with no
 * group/other write, and its three install markers.
 *
 * @param {string} path
 * @returns {string}
 */
export function assertSdkDir(path) {
    assertNoSymlinkPath(path);
    assertRealPath(path);
    const info = lstatSync(path);
    if (!info.isDirectory()) throw new LayerfsRefusal(CODES.NotConfigured);
    if (typeof process.getuid === "function" && info.uid !== process.getuid())
        throw new LayerfsRefusal(CODES.NotConfigured);
    if ((info.mode & 0o022) !== 0) throw new LayerfsRefusal(CODES.NotConfigured);
    for (const marker of ["package.json", "UPSTREAM.json", "src/index.js", "native/layerfs.node"]) {
        assertNoSymlinkPath(join(path, marker));
    }
    return resolve(path);
}

/**
 * Check an existing Store file. A missing Store is allowed: the owner may not
 * have initialised the project yet, and every call then reports NotFound.
 *
 * @param {string} path
 */
export function assertStorePath(path) {
    assertNoSymlinkPath(dirname(path));
    let info;
    try {
        info = lstatSync(path);
    } catch (error) {
        if (error && typeof error === "object" && /** @type {any} */ (error).code === "ENOENT")
            return;
        throw new LayerfsRefusal(CODES.NotConfigured);
    }
    if (info.isSymbolicLink() || !info.isFile()) throw new LayerfsRefusal(CODES.NotConfigured);
    if (typeof process.getuid === "function" && info.uid !== process.getuid())
        throw new LayerfsRefusal(CODES.NotConfigured);
    if ((info.mode & 0o022) !== 0) throw new LayerfsRefusal(CODES.NotConfigured);
    assertRealPath(path);
}

/**
 * Read the service token, creating it with mode 0600 if absent. Every read
 * uses O_NOFOLLOW and fstat on the open descriptor.
 *
 * @param {string} path
 * @returns {string}
 */
export function ensureToken(path) {
    assertNoSymlinkPath(dirname(path));
    try {
        return readToken(path);
    } catch (error) {
        // Only a missing file is created here. A link, a broader mode, or a
        // wrong owner is a refusal, not a request to replace the file.
        if (!(error instanceof LayerfsRefusal) || error.code !== "NoTokenFile") throw error;
    }
    const token = base64url(randomBytes(TOKEN_BYTES));
    let fd;
    try {
        fd = openSync(
            path,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
        );
        writeSync(fd, token, 0, "utf8");
        closeSync(fd);
        fd = undefined;
        return token;
    } catch (error) {
        if (fd !== undefined) closeSync(fd);
        if (error && typeof error === "object" && /** @type {any} */ (error).code === "EEXIST")
            return readToken(path);
        throw new LayerfsRefusal(CODES.NotConfigured);
    }
}

/**
 * @param {string} path
 * @returns {string}
 */
export function readToken(path) {
    let fd;
    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
        if (error && typeof error === "object" && /** @type {any} */ (error).code === "ENOENT") {
            throw new LayerfsRefusal("NoTokenFile");
        }
        throw new LayerfsRefusal(CODES.NotConfigured);
    }
    try {
        const info = fstatSync(fd);
        if (!info.isFile()) throw new LayerfsRefusal(CODES.NotConfigured);
        if (typeof process.getuid === "function" && info.uid !== process.getuid())
            throw new LayerfsRefusal(CODES.NotConfigured);
        if ((info.mode & 0o077) !== 0) throw new LayerfsRefusal(CODES.NotConfigured);
        if (info.size > MAX_TOKEN_BYTES) throw new LayerfsRefusal(CODES.NotConfigured);
        const buffer = Buffer.alloc(MAX_TOKEN_BYTES + 1);
        const length = readSync(fd, buffer, 0, buffer.length, 0);
        const token = buffer.subarray(0, length).toString("utf8").trim();
        if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new LayerfsRefusal(CODES.NotConfigured);
        return token;
    } finally {
        closeSync(fd);
    }
}

/**
 * Prepare a Unix socket path. If a stale socket exists, remove it only when a
 * connection attempt is refused; a live service is not disturbed.
 *
 * @param {string} path
 * @returns {Promise<void>}
 */
export async function prepareSocket(path) {
    let info;
    try {
        info = lstatSync(path);
    } catch (error) {
        if (error && typeof error === "object" && /** @type {any} */ (error).code === "ENOENT")
            return;
        throw new LayerfsRefusal(CODES.NotConfigured);
    }
    if (!info.isSocket()) throw new LayerfsRefusal(CODES.NotConfigured);
    if (typeof process.getuid === "function" && info.uid !== process.getuid())
        throw new LayerfsRefusal(CODES.NotConfigured);
    const live = await new Promise((resolveLive) => {
        const socket = createConnection({ path });
        const done = (value) => {
            socket.destroy();
            resolveLive(value);
        };
        socket.setTimeout(300, () => done(true));
        socket.on("connect", () => done(true));
        socket.on("error", () => done(false));
    });
    if (live) throw new LayerfsRefusal(CODES.Busy);
    try {
        unlinkSync(path);
    } catch {
        throw new LayerfsRefusal(CODES.NotConfigured);
    }
}

/**
 * After `listen`, require mode 0600 and the current uid.
 *
 * @param {string} path
 */
export function assertSocket(path) {
    const info = lstatSync(path);
    if (!info.isSocket()) throw new LayerfsRefusal(CODES.NotConfigured);
    if (typeof process.getuid === "function" && info.uid !== process.getuid())
        throw new LayerfsRefusal(CODES.NotConfigured);
    if ((info.mode & 0o077) !== 0) {
        chmodSync(path, 0o600);
        const after = lstatSync(path);
        if ((after.mode & 0o077) !== 0) throw new LayerfsRefusal(CODES.NotConfigured);
    }
}

/**
 * Remove this service's socket only if it is still the same socket inode.
 *
 * @param {string} path
 * @param {number} dev
 * @param {number} ino
 */
export function removeOwnSocket(path, dev, ino) {
    try {
        const info = lstatSync(path);
        if (info.isSocket() && info.dev === dev && info.ino === ino) unlinkSync(path);
    } catch {
        // The socket already went; nothing to remove.
    }
}

/**
 * @param {string} a
 * @param {string} b
 */
export function sameToken(a, b) {
    const left = Buffer.from(String(a), "utf8");
    const right = Buffer.from(String(b), "utf8");
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
}

/**
 * @param {Buffer} bytes
 */
function base64url(bytes) {
    return bytes.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * The token file's parent must be the already-checked runtime directory.
 *
 * @param {string} runtimeDir
 * @param {string} tokenFile
 * @param {string} socketPath
 */
export function assertRuntimeLayout(runtimeDir, tokenFile, socketPath) {
    const root = resolve(runtimeDir);
    for (const path of [tokenFile, socketPath]) {
        if (!isAbsolute(path) || !path.startsWith(`${root}/`))
            throw new LayerfsRefusal(CODES.NotConfigured);
        if (dirname(path) !== root) throw new LayerfsRefusal(CODES.NotConfigured);
        if (basename(path).startsWith(".")) throw new LayerfsRefusal(CODES.NotConfigured);
    }
}
