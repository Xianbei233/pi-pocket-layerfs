/**
 * Private metadata for imported Stores.
 *
 * This registry never grants access and never replaces the config. It records
 * which private Store a project id was imported into, so the config can name a
 * server-derived path that a browser never supplies. It holds no token.
 */
import {
    closeSync,
    constants,
    fstatSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readSync,
    renameSync,
    unlinkSync,
    writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export const REGISTRY_VERSION = 1;
export const REGISTRY_MAX_BYTES = 256 * 1024;
export const REGISTRY_MAX_STORES = 200;

export class RegistryError extends Error {
    constructor(message) {
        super(message);
        this.name = "RegistryError";
    }
}

/** @param {{ dataDir: string }} host */
export function ownDir(host) {
    return join(host.dataDir, "pocket-layerfs");
}

/** @param {{ dataDir: string }} host */
export function registryPath(host) {
    return join(ownDir(host), "registry.json");
}

/** @param {{ dataDir: string }} host */
export function importRoot(host) {
    return join(ownDir(host), "imports");
}

/** @param {{ dataDir: string }} host */
export function projectRoot(host) {
    return join(ownDir(host), "projects");
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} max
 */
function safeText(value, name, max) {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > max ||
        value.includes("\0")
    )
        throw new RegistryError(`registry.${name} is not valid`);
    return value;
}

/**
 * Read and validate the registry. A missing file is an empty registry. A
 * malformed file fails closed and is never rewritten.
 *
 * @param {{ dataDir: string }} host
 */
export function readRegistry(host) {
    const path = registryPath(host);
    let info;
    try {
        info = lstatSync(path);
    } catch (error) {
        if (error?.code === "ENOENT") return { version: REGISTRY_VERSION, stores: [] };
        throw new RegistryError("registry.unavailable");
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new RegistryError("registry.unsafe");
    if (typeof process.getuid === "function" && info.uid !== process.getuid())
        throw new RegistryError("registry.foreign");
    if ((info.mode & 0o077) !== 0) throw new RegistryError("registry.mode");
    if (info.size > REGISTRY_MAX_BYTES) throw new RegistryError("registry.large");
    let raw;
    try {
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const buffer = Buffer.alloc(info.size);
            let offset = 0;
            while (offset < buffer.length) {
                const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
                if (read === 0) break;
                offset += read;
            }
            raw = JSON.parse(buffer.subarray(0, offset).toString("utf8"));
        } finally {
            closeSync(fd);
        }
    } catch (error) {
        throw new RegistryError(error instanceof RegistryError ? error.message : "registry.parse");
    }
    if (!isObject(raw) || raw.version !== REGISTRY_VERSION || !Array.isArray(raw.stores))
        throw new RegistryError("registry.version");
    if (raw.stores.length > REGISTRY_MAX_STORES) throw new RegistryError("registry.count");
    const root = projectRoot(host);
    const stores = raw.stores.map((entry) => {
        if (!isObject(entry)) throw new RegistryError("registry.entry");
        const projectId = safeText(entry.projectId, "projectId", 63);
        if (!/^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/.test(projectId))
            throw new RegistryError("registry.projectId");
        const storePath = safeText(entry.storePath, "storePath", 1024);
        if (!isAbsolute(storePath) || storePath.includes("\0"))
            throw new RegistryError("registry.storePath");
        const expected = join(root, projectId, "store.sqlite");
        if (resolve(storePath) !== resolve(expected)) throw new RegistryError("registry.storePath");
        const sourcePath =
            entry.sourcePath === null || entry.sourcePath === undefined
                ? null
                : safeText(entry.sourcePath, "sourcePath", 4096);
        const state = entry.state;
        if (!["unpublished-ready", "published", "retained", "failed", "unknown"].includes(state))
            throw new RegistryError("registry.state");
        const branches = entry.branches;
        if (
            !Array.isArray(branches) ||
            branches.length === 0 ||
            branches.length > 64 ||
            branches.some(
                (name) => typeof name !== "string" || !/^[A-Za-z0-9._-]{1,63}$/.test(name),
            )
        )
            throw new RegistryError("registry.branches");
        return Object.freeze({
            importId: safeText(entry.importId, "importId", 64),
            projectId,
            label: safeText(entry.label, "label", 80),
            branches: Object.freeze([...new Set(branches)]),
            origin: "import",
            storePath: resolve(storePath),
            sourcePath,
            state,
            createdAt: Number.isSafeInteger(entry.createdAt) ? entry.createdAt : 0,
            files: Number.isSafeInteger(entry.files) ? entry.files : 0,
            bytes: Number.isSafeInteger(entry.bytes) ? entry.bytes : 0,
            fingerprint:
                typeof entry.fingerprint === "string" && /^[0-9a-f]{64}$/.test(entry.fingerprint)
                    ? entry.fingerprint
                    : null,
        });
    });
    return { version: REGISTRY_VERSION, stores };
}

/**
 * Write the registry with one 0600 temporary file and a rename inside the
 * private own folder.
 *
 * @param {{ dataDir: string }} host
 * @param {{ version: number, stores: any[] }} registry
 */
export function writeRegistry(host, registry) {
    const path = registryPath(host);
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const dirInfo = lstatSync(directory);
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) throw new RegistryError("registry.dir");
    if (typeof process.getuid === "function" && dirInfo.uid !== process.getuid())
        throw new RegistryError("registry.dir");
    if ((dirInfo.mode & 0o777) !== 0o700) throw new RegistryError("registry.dir");
    const bytes = Buffer.from(`${JSON.stringify(registry, null, 4)}\n`, "utf8");
    if (bytes.length > REGISTRY_MAX_BYTES) throw new RegistryError("registry.large");
    const temporary = join(
        directory,
        `.registry-${createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 16)}.tmp`,
    );
    let fd = -1;
    let renamed = false;
    try {
        fd = openSync(
            temporary,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
        );
        let offset = 0;
        while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
        fsyncSync(fd);
        closeSync(fd);
        fd = -1;
        renameSync(temporary, path);
        renamed = true;
        const dirFd = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
        try {
            fsyncSync(dirFd);
        } finally {
            closeSync(dirFd);
        }
    } catch {
        if (fd >= 0) {
            try {
                closeSync(fd);
            } catch {
                // The failed handle is already unusable.
            }
        }
        if (!renamed) {
            try {
                unlinkSync(temporary);
            } catch {
                // No temporary file exists.
            }
        }
        throw new RegistryError("registry.write");
    }
}

/**
 * @param {{ dataDir: string }} host
 * @param {(registry: any) => { registry: any, answer: any }} change
 */
export function updateRegistry(host, change) {
    const current = readRegistry(host);
    const { registry, answer } = change(current);
    writeRegistry(host, registry);
    return answer;
}
