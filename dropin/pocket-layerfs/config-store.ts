/**
 * Owner-only status and atomic compare-and-swap writes for this module's own
 * config file.
 *
 * This helper touches only \`host.dataDir/pocket-layerfs/config.json\`. It never
 * reads or writes Pi Pocket's \`config.json\`, sessions, tokens, or sign-ins. It
 * never returns a path, a token, a socket, a store path, or a config value.
 *
 * Each mutation validates the whole candidate with the ordinary loader, applies
 * a mandatory compare-and-swap hash, and writes one temporary 0600 file with
 * O_EXCL and O_NOFOLLOW before a rename and a directory fsync. Every call is
 * synchronous, so two mutations in this server process cannot both pass the
 * same expected hash. A refusal before the rename leaves the file unchanged.
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
import { createHash, randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { MAX_CONFIG_BYTES, validateConfig } from "./config.ts";

/**
 * A safe refusal for the config routes. The message never holds a path, a
 * token, a socket, a store path, or a config value.
 */
export class ConfigStoreError extends Error {
    /** @type {number} */
    status;

    /**
     * @param {number} status
     * @param {string} message
     */
    constructor(status, message) {
        super(message);
        this.name = "ConfigStoreError";
        this.status = status;
    }
}

/**
 * The fixed own-config path. This helper never writes the environment path.
 *
 * @param {{ dataDir: string }} host
 * @returns {string}
 */
export function ownConfigPath(host) {
    return join(host.dataDir, "pocket-layerfs", "config.json");
}

/**
 * Whether management writes are allowed. An environment override makes the
 * live file read-only for this helper.
 *
 * @returns {boolean}
 */
export function writesAllowed() {
    const configured = process.env.PI_POCKET_LAYERFS_CONFIG;
    return configured === undefined || configured === "";
}

/**
 * Best-effort hash of the file the module loaded, for the active hash. It is
 * informational and adds no permission.
 *
 * @param {string} path
 * @returns {string | null}
 */
export function configFileHash(path) {
    const bytes = readActiveFile(path);
    return bytes === null ? null : digest(bytes);
}

/**
 * Read the file the module loaded, for its hash only. It refuses a final link,
 * a foreign or writable file, and an oversized file, and returns null instead
 * of throwing. It does not require mode 0600: the ordinary loader already
 * accepted this file, and this read adds no permission.
 *
 * @param {string} path
 * @returns {Buffer | null}
 */
function readActiveFile(path) {
    let fd = -1;
    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = fstatSync(fd);
        if (!info.isFile()) return null;
        if (typeof process.getuid === "function" && info.uid !== process.getuid()) return null;
        if ((info.mode & 0o022) !== 0) return null;
        if (info.size > MAX_CONFIG_BYTES) return null;
        const buffer = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < buffer.length) {
            const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
            if (read === 0) break;
            offset += read;
        }
        return buffer.subarray(0, offset);
    } catch {
        return null;
    } finally {
        if (fd >= 0) {
            try {
                closeSync(fd);
            } catch {
                // The read already finished or failed; closing once is enough.
            }
        }
    }
}

/**
 * The safe summary of the own config file. It never holds a path, a token, a
 * socket, a store path, an owner id, or a conversation id.
 *
 * @param {{ path: string, activeHash: string | null }} options
 */
export function configSummary({ path, activeHash }) {
    const state = inspectConfig(path);
    const writable = writesAllowed();
    const config = state.config;
    return {
        configured: config !== null,
        writable,
        ...(writable ? {} : { reason: "env-override" }),
        hash: state.sha256,
        activeHash: activeHash ?? null,
        reloadRequired: writable ? (state.sha256 ?? null) !== (activeHash ?? null) : null,
        version: config?.version,
        toolsEnabled: config?.tools.enabled === true,
        writeEnabled: config?.write.enabled === true,
        projectIds: config === null ? [] : config.projects.map((project) => project.id),
        projectCount: config === null ? 0 : config.projects.length,
        grantCount: config === null ? 0 : config.sessionGrants.length,
        ownerIdCount: config === null ? 0 : config.ownerPersonIds.length,
        mode: config === null && state.sha256 === null ? null : "0600",
        size: state.size,
        ...(state.error === null ? {} : { error: state.error }),
    };
}

/**
 * Validate a candidate and write it atomically when the expected hash matches.
 *
 * @param {object} options
 * @param {string} options.path
 * @param {unknown} options.expectedSha256
 * @param {unknown} options.candidate
 * @param {{ id: string, role: string }} options.actor
 * @param {string | null} options.activeHash
 */
export function mutateOwnConfig({ path, expectedSha256, candidate, actor, activeHash }) {
    assertWritable();
    const expected = parseExpected(expectedSha256, true);
    const state = inspectConfig(path);
    assertChangeable(state, expected);
    requireOwnerActor(actor, state);

    let next;
    try {
        next = validateConfig(candidate);
    } catch (error) {
        throw new ConfigStoreError(400, safeValidationMessage(error));
    }
    if (next.ownerPersonIds.length > 0 && !next.ownerPersonIds.includes(String(actor?.id ?? ""))) {
        throw new ConfigStoreError(
            400,
            "candidate.ownerPersonIds must include the requesting owner.",
        );
    }

    let bytes;
    try {
        bytes = Buffer.from(`${JSON.stringify(candidate, null, 4)}\n`, "utf8");
    } catch {
        throw new ConfigStoreError(400, "The LayerFS config could not be encoded.");
    }
    if (bytes.length > MAX_CONFIG_BYTES)
        throw new ConfigStoreError(400, "The LayerFS config is too large.");

    writeAtomic(path, bytes);
    return configSummary({ path, activeHash });
}

/**
 * Delete the own config only when the expected hash matches. The parent folder
 * and every unrelated file stay as they are.
 *
 * @param {object} options
 * @param {string} options.path
 * @param {unknown} options.expectedSha256
 * @param {{ id: string, role: string }} options.actor
 * @param {string | null} options.activeHash
 */
export function deleteOwnConfig({ path, expectedSha256, actor, activeHash }) {
    assertWritable();
    const expected = parseExpected(expectedSha256, false);
    const state = inspectConfig(path);
    if (!state.exists) throw new ConfigStoreError(409, "The LayerFS config does not exist.");
    assertChangeable(state, expected);
    requireOwnerActor(actor, state);
    try {
        unlinkSync(resolve(path));
    } catch {
        throw new ConfigStoreError(409, "The LayerFS config could not be removed.");
    }
    fsyncDir(dirname(resolve(path)));
    return configSummary({ path, activeHash });
}

/** @returns {void} */
function assertWritable() {
    if (!writesAllowed())
        throw new ConfigStoreError(
            403,
            "Config writes are disabled while PI_POCKET_LAYERFS_CONFIG is set.",
        );
}

/**
 * @param {unknown} value
 * @param {boolean} allowNull
 * @returns {string | null}
 */
function parseExpected(value, allowNull) {
    if (value === null && allowNull) return null;
    if (typeof value === "string" && /^[0-9a-f]{64}$/.test(value)) return value;
    throw new ConfigStoreError(
        400,
        allowNull
            ? "expectedSha256 must be null or a 64-character lowercase hex hash."
            : "expectedSha256 must be a 64-character lowercase hex hash.",
    );
}

/**
 * @param {any} state
 * @param {string | null} expected
 */
function assertChangeable(state, expected) {
    if (state.unsafe)
        throw new ConfigStoreError(409, "The current LayerFS config is not safe to change.");
    if ((state.sha256 ?? null) !== expected)
        throw new ConfigStoreError(409, "The LayerFS config changed; read it and try again.");
}

/**
 * The role owner is always required. The old file's owner ids also gate the
 * change when they are set. A current file that is not valid JSON cannot give
 * those ids; the owner may repair it, and that file grants no tool or write.
 *
 * A refusal is a 404, as the route's own owner check is. An unauthorized actor
 * cannot tell whether a config route exists for another owner.
 *
 * @param {{ id: string, role: string }} actor
 * @param {any} state
 */
function requireOwnerActor(actor, state) {
    if (actor === null || typeof actor !== "object" || actor.role !== "owner")
        throw new ConfigStoreError(404, "Not found.");
    if (typeof actor.id !== "string" || actor.id.length === 0)
        throw new ConfigStoreError(404, "Not found.");
    if (state.config === null) return;
    const owners = state.config.ownerPersonIds;
    if (owners.length > 0 && !owners.includes(actor.id))
        throw new ConfigStoreError(404, "Not found.");
}

/**
 * Read and check the current file. A bad mode, a link, or a wrong owner is
 * unsafe: mutations refuse it and the summary reports an error.
 *
 * @param {string} path
 */
function inspectConfig(path) {
    const absolute = resolve(path);
    let info;
    try {
        info = lstatSync(absolute);
    } catch (error) {
        if (error?.code === "ENOENT")
            return {
                exists: false,
                sha256: null,
                size: null,
                config: null,
                unsafe: false,
                error: null,
            };
        return {
            exists: true,
            sha256: null,
            size: null,
            config: null,
            unsafe: true,
            error: "The LayerFS config is not available.",
        };
    }
    try {
        assertExistingAncestorsNoLinks(dirname(absolute));
        const parent = lstatSync(dirname(absolute));
        if (parent.isSymbolicLink() || !parent.isDirectory())
            throw new ConfigStoreError(409, "The LayerFS config folder must be a directory.");
        if (typeof process.getuid === "function" && parent.uid !== process.getuid())
            throw new ConfigStoreError(
                409,
                "The LayerFS config folder must be owned by this user.",
            );
        if ((parent.mode & 0o777) !== 0o700)
            throw new ConfigStoreError(409, "The LayerFS config folder must be mode 0700.");
        const bytes = readNoFollow(absolute);
        const sha256 = digest(bytes);
        let config = null;
        let error = null;
        let parsed;
        try {
            parsed = JSON.parse(bytes.toString("utf8"));
        } catch {
            error = "The LayerFS config is not valid JSON.";
        }
        if (error === null) {
            try {
                config = validateConfig(parsed);
            } catch (failure) {
                error = safeValidationMessage(failure);
            }
        }
        return { exists: true, sha256, size: bytes.length, config, unsafe: false, error };
    } catch (failure) {
        return {
            exists: true,
            sha256: null,
            size: null,
            config: null,
            unsafe: true,
            error: safeValidationMessage(failure),
        };
    }
}

/**
 * Read one regular 0600 file owned by this user, with a size bound. O_NOFOLLOW
 * refuses a final link, and the parent checks above refuse a link above it.
 *
 * @param {string} path
 * @returns {Buffer}
 */
function readNoFollow(path) {
    let fd = -1;
    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = fstatSync(fd);
        if (!info.isFile())
            throw new ConfigStoreError(409, "The LayerFS config must be a regular file.");
        if (typeof process.getuid === "function" && info.uid !== process.getuid())
            throw new ConfigStoreError(409, "The LayerFS config must be owned by this user.");
        if ((info.mode & 0o777) !== 0o600)
            throw new ConfigStoreError(409, "The LayerFS config must be mode 0600.");
        if (info.size > MAX_CONFIG_BYTES)
            throw new ConfigStoreError(409, "The LayerFS config is too large.");
        const buffer = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < buffer.length) {
            const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
            if (read === 0) break;
            offset += read;
        }
        return buffer.subarray(0, offset);
    } catch (error) {
        if (error instanceof ConfigStoreError) throw error;
        throw new ConfigStoreError(409, "The LayerFS config must be a regular file.");
    } finally {
        if (fd >= 0) {
            try {
                closeSync(fd);
            } catch {
                // The read already finished or failed; closing once is enough.
            }
        }
    }
}

/**
 * @param {string} directory
 */
function assertExistingAncestorsNoLinks(directory) {
    let current = "/";
    for (const part of resolve(directory).split("/").filter(Boolean)) {
        current = join(current, part);
        let info;
        try {
            info = lstatSync(current);
        } catch {
            return;
        }
        if (info.isSymbolicLink())
            throw new ConfigStoreError(409, "The LayerFS config path must not contain a link.");
    }
}

/**
 * Create only the missing own folder with mode 0700. An existing folder keeps
 * its mode; a broader or foreign folder is refused, never adopted.
 *
 * @param {string} path
 */
function ensurePrivateDir(path) {
    const directory = dirname(resolve(path));
    let missing = false;
    let current = "/";
    for (const part of directory.split("/").filter(Boolean)) {
        current = join(current, part);
        let info;
        try {
            info = lstatSync(current);
        } catch (error) {
            if (error?.code === "ENOENT") {
                missing = true;
                break;
            }
            throw new ConfigStoreError(409, "The LayerFS config folder is not available.");
        }
        if (info.isSymbolicLink())
            throw new ConfigStoreError(409, "The LayerFS config path must not contain a link.");
        if (!info.isDirectory())
            throw new ConfigStoreError(409, "The LayerFS config folder must be a directory.");
    }
    if (missing) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory())
        throw new ConfigStoreError(409, "The LayerFS config folder must be a directory.");
    if (typeof process.getuid === "function" && info.uid !== process.getuid())
        throw new ConfigStoreError(409, "The LayerFS config folder must be owned by this user.");
    if ((info.mode & 0o777) !== 0o700)
        throw new ConfigStoreError(409, "The LayerFS config folder must be mode 0700.");
}

/**
 * Write one temporary 0600 file, fsync it, rename it, and fsync the folder.
 * Only this call's own temporary file is removed after a failure.
 *
 * @param {string} path
 * @param {Buffer} bytes
 */
function writeAtomic(path, bytes) {
    const absolute = resolve(path);
    ensurePrivateDir(absolute);
    const directory = dirname(absolute);
    const temporary = join(directory, `.config-${randomBytes(8).toString("hex")}.tmp`);
    let fd = -1;
    let renamed = false;
    try {
        fd = openSync(
            temporary,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
        );
        let offset = 0;
        while (offset < bytes.length) {
            offset += writeSync(fd, bytes, offset, bytes.length - offset);
        }
        fsyncSync(fd);
        closeSync(fd);
        fd = -1;
        renameSync(temporary, absolute);
        renamed = true;
        fsyncDir(directory);
    } catch {
        if (fd >= 0) {
            try {
                closeSync(fd);
            } catch {
                // The failed write is already closed or unusable.
            }
        }
        if (!renamed) {
            try {
                unlinkSync(temporary);
            } catch {
                // No temporary file exists, or it is already gone.
            }
            throw new ConfigStoreError(409, "The LayerFS config could not be written.");
        }
    }
}

/**
 * Best-effort directory sync. A failure here does not undo a completed rename.
 *
 * @param {string} directory
 */
function fsyncDir(directory) {
    let fd = -1;
    try {
        fd = openSync(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
        fsyncSync(fd);
    } catch {
        // The rename already happened; report success rather than a false failure.
    } finally {
        if (fd >= 0) {
            try {
                closeSync(fd);
            } catch {
                // The directory handle is already unusable.
            }
        }
    }
}

/**
 * @param {Buffer} bytes
 * @returns {string}
 */
function digest(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

/**
 * A validation message names a field, never its value. Any other failure gets
 * one generic sentence.
 *
 * @param {unknown} error
 * @returns {string}
 */
function safeValidationMessage(error) {
    const message =
        error instanceof Error && error.name === "ConfigError"
            ? error.message
            : "The LayerFS config is invalid.";
    return String(message)
        .replace(/[\r\n\t]+/g, " ")
        .slice(0, 200);
}
