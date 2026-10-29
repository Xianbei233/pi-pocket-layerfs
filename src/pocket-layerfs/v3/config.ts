/**
 * Loading and validating the owner's LayerFS plugin configuration.
 *
 * The plugin never reads Pi Pocket's own `config.json`, sessions, tokens, or
 * sign-ins. It reads only this file, named by `PI_POCKET_LAYERFS_CONFIG` or by
 * `host.dataDir/pocket-layerfs/config.json`.
 *
 * Session grants are explicit and fail closed: a conversation gets a project
 * and branches only when `sessionGrants` names that exact conversation. An
 * empty list means no tool and no write in every conversation.
 */
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { isBranchName, isProjectName } from "./policy.ts";

export const CONFIG_VERSION = 1;
export const MAX_CONFIG_BYTES = 256 * 1024;

/**
 * A configuration refusal that is safe to show to the owner. It never holds
 * a token, a store path, or a raw upstream error.
 */
export class ConfigError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = "ConfigError";
    }
}

/**
 * The default config path. An explicit environment path wins, but it must be
 * absolute so a server started in another folder cannot pick a different file.
 *
 * @param {{ dataDir: string }} host
 * @returns {string}
 */
export function defaultConfigPath(host) {
    const configured = process.env.PI_POCKET_LAYERFS_CONFIG;
    if (configured !== undefined && configured !== "") {
        if (!isAbsolute(configured))
            throw new ConfigError("PI_POCKET_LAYERFS_CONFIG must be an absolute path");
        return resolve(configured);
    }
    return join(host.dataDir, "pocket-layerfs", "config.json");
}

/**
 * Read one regular, non-symlink file with a size bound.
 *
 * @param {string} path
 * @returns {string}
 */
function readSmallRegularFile(path) {
    assertNoSymlinkAncestors(path);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink())
        throw new ConfigError("The LayerFS config must be a regular file, not a link");
    if (typeof process.getuid === "function" && info.uid !== process.getuid())
        throw new ConfigError("The LayerFS config must be owned by this user");
    if ((info.mode & 0o022) !== 0)
        throw new ConfigError("The LayerFS config must not be group- or world-writable");
    if (info.size > MAX_CONFIG_BYTES) throw new ConfigError("The LayerFS config is too large");
    return readFileSync(path, "utf8");
}

/**
 * Refuse a link in any component, not only at the final file.
 *
 * @param {string} path
 */
export function assertNoSymlinkAncestors(path) {
    const absolute = resolve(path);
    let current = "/";
    for (const part of absolute.split("/").filter(Boolean)) {
        current = join(current, part);
        let info;
        try {
            info = lstatSync(current);
        } catch {
            throw new ConfigError("The LayerFS config path does not exist");
        }
        if (info.isSymbolicLink())
            throw new ConfigError("The LayerFS config path must not contain a link");
    }
}

/**
 * Read and validate the config at `path`.
 *
 * @param {string} path
 * @returns {{ path: string, config: ReturnType<typeof validateConfig>, warnings: string[] }}
 */
export function loadConfigFile(path) {
    if (typeof path !== "string" || !isAbsolute(path))
        throw new ConfigError("The LayerFS config path must be absolute");
    let raw;
    try {
        raw = JSON.parse(readSmallRegularFile(path));
    } catch (error) {
        if (error instanceof ConfigError) throw error;
        throw new ConfigError("The LayerFS config is not valid JSON");
    }
    const warnings = [];
    const config = validateConfig(raw, warnings);
    return { path, config, warnings };
}

/**
 * Validate one parsed config object. Throws `ConfigError` with a message that
 * names a field but never its value.
 *
 * @param {unknown} raw
 * @param {string[]} [warnings]
 */
export function validateConfig(raw, warnings = []) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
        throw new ConfigError("The LayerFS config must be an object");
    const value = /** @type {Record<string, unknown>} */ raw;
    if (value.version !== CONFIG_VERSION)
        throw new ConfigError(`The LayerFS config version must be ${CONFIG_VERSION}`);

    const owners = stringList(value.ownerPersonIds, "ownerPersonIds", 20, 200);
    if (owners.length === 0)
        warnings.push("ownerPersonIds is empty: tools and internal writes stay denied");

    const serviceRaw = requiredObject(value.service, "service");
    const service = {
        runtimeDir: absolutePath(serviceRaw.runtimeDir, "service.runtimeDir"),
        socketPath: absolutePath(serviceRaw.socketPath, "service.socketPath"),
        tokenFile: absolutePath(serviceRaw.tokenFile, "service.tokenFile"),
        layerfsHome: absolutePath(serviceRaw.layerfsHome, "service.layerfsHome"),
        sdkPath: absolutePath(serviceRaw.sdkPath, "service.sdkPath"),
        requestTimeoutMs: boundedInteger(
            serviceRaw.requestTimeoutMs,
            "service.requestTimeoutMs",
            1000,
            60000,
            8000,
        ),
        maxResponseBytes: boundedInteger(
            serviceRaw.maxResponseBytes,
            "service.maxResponseBytes",
            64 * 1024,
            4 * 1024 * 1024,
            512 * 1024,
        ),
        maxQueue: boundedInteger(serviceRaw.maxQueue, "service.maxQueue", 1, 128, 16),
        concurrency: boundedInteger(serviceRaw.concurrency, "service.concurrency", 1, 4, 1),
        serviceVersion:
            typeof serviceRaw.serviceVersion === "string"
                ? serviceRaw.serviceVersion.slice(0, 64)
                : undefined,
        upstreamVersion:
            typeof serviceRaw.upstreamVersion === "string"
                ? serviceRaw.upstreamVersion.slice(0, 64)
                : undefined,
        upstreamCommit:
            typeof serviceRaw.upstreamCommit === "string"
                ? serviceRaw.upstreamCommit.slice(0, 80)
                : undefined,
    };
    if (!isInside(service.runtimeDir, service.socketPath))
        throw new ConfigError("service.socketPath must be inside service.runtimeDir");
    if (!isInside(service.runtimeDir, service.tokenFile))
        throw new ConfigError("service.tokenFile must be inside service.runtimeDir");
    if (service.socketPath.length > 100)
        throw new ConfigError("service.socketPath is too long for a Unix socket");

    const toolsRaw = value.tools === undefined ? {} : requiredObject(value.tools, "tools");
    const tools = {
        enabled: booleanOr(toolsRaw.enabled, false, "tools.enabled"),
        maxBytes: boundedInteger(
            toolsRaw.maxBytes,
            "tools.maxBytes",
            4 * 1024,
            256 * 1024,
            32 * 1024,
        ),
    };

    const writeRaw = value.write === undefined ? {} : requiredObject(value.write, "write");
    const write = {
        enabled: booleanOr(writeRaw.enabled, false, "write.enabled"),
        ticketTtlMs: boundedInteger(
            writeRaw.ticketTtlMs,
            "write.ticketTtlMs",
            30_000,
            300_000,
            120_000,
        ),
    };
    if (write.enabled && owners.length === 0)
        throw new ConfigError("write.enabled needs at least one ownerPersonIds entry");

    const projectValues = Array.isArray(value.projects) ? value.projects : [];
    if (!Array.isArray(value.projects)) throw new ConfigError("projects must be an array");
    if (projectValues.length > 50) throw new ConfigError("projects has too many entries");
    const projects = projectValues.map((entry, index) => validateProject(entry, index));
    const ids = new Set();
    for (const project of projects) {
        if (ids.has(project.id)) throw new ConfigError("projects has a duplicate id");
        ids.add(project.id);
    }

    const grantValues = value.sessionGrants === undefined ? [] : value.sessionGrants;
    if (!Array.isArray(grantValues)) throw new ConfigError("sessionGrants must be an array");
    if (grantValues.length > 100) throw new ConfigError("sessionGrants has too many entries");
    const grants = grantValues.map((entry, index) => validateGrant(entry, index, projects));
    const conversations = new Set();
    for (const grant of grants) {
        if (conversations.has(grant.conversationId))
            throw new ConfigError("sessionGrants has a duplicate conversationId");
        conversations.add(grant.conversationId);
        if ((grant.allowTools || grant.fork.enabled) && owners.length === 0) {
            throw new ConfigError(
                "A session grant needs at least one ownerPersonIds entry for tools or writes",
            );
        }
    }
    if (tools.enabled && grants.every((grant) => !grant.allowTools))
        warnings.push("tools.enabled is true but no session grant allows tools");

    return Object.freeze({
        version: CONFIG_VERSION,
        ownerPersonIds: Object.freeze(owners),
        service: Object.freeze(service),
        tools: Object.freeze(tools),
        write: Object.freeze(write),
        projects: Object.freeze(projects),
        sessionGrants: Object.freeze(grants),
    });
}

/**
 * @param {unknown} raw
 * @param {number} index
 */
function validateProject(raw, index) {
    const value = requiredObject(raw, `projects[${index}]`);
    const id = value.id;
    if (!isProjectName(id))
        throw new ConfigError(`projects[${index}].id is not a valid LayerFS project id`);
    const label =
        typeof value.label === "string" && value.label.trim() !== ""
            ? value.label.trim().slice(0, 80)
            : id;
    const storePath = absolutePath(value.storePath, `projects[${index}].storePath`);
    const origin = value.origin === undefined ? "owner" : value.origin;
    if (origin !== "demo" && origin !== "import" && origin !== "owner")
        throw new ConfigError(`projects[${index}].origin is not valid`);
    const branches = stringList(value.branches, `projects[${index}].branches`, 64, 63);
    if (branches.length === 0)
        throw new ConfigError(
            `projects[${index}].branches must name at least one authorised branch`,
        );
    for (const branch of branches) {
        if (branch !== "main" && !isBranchName(branch))
            throw new ConfigError(`projects[${index}].branches has an invalid branch name`);
    }
    return Object.freeze({ id, label, origin, storePath, branches: Object.freeze(branches) });
}

/**
 * One conversation is bound to one project, an explicit branch list for
 * tools, and an explicit fork grant. It is not combined with every project in
 * a global list.
 *
 * @param {unknown} raw
 * @param {number} index
 * @param {any[]} projects
 */
function validateGrant(raw, index, projects) {
    const value = requiredObject(raw, `sessionGrants[${index}]`);
    const conversationId = value.conversationId;
    if (
        typeof conversationId !== "string" ||
        conversationId.length === 0 ||
        conversationId.length > 200 ||
        conversationId.includes("\0")
    ) {
        throw new ConfigError(`sessionGrants[${index}].conversationId must be a non-empty string`);
    }
    const projectId = value.project;
    if (typeof projectId !== "string")
        throw new ConfigError(`sessionGrants[${index}].project must be a project id`);
    const project = projects.find((entry) => entry.id === projectId);
    if (project === undefined)
        throw new ConfigError(`sessionGrants[${index}].project is not a configured project`);

    const allowTools = booleanOr(value.allowTools, false, `sessionGrants[${index}].allowTools`);
    const toolBranches =
        value.toolBranches === undefined
            ? []
            : stringList(value.toolBranches, `sessionGrants[${index}].toolBranches`, 64, 63);
    for (const branch of toolBranches) {
        if (branch !== "main" && !isBranchName(branch))
            throw new ConfigError(
                `sessionGrants[${index}].toolBranches has an invalid branch name`,
            );
        if (!project.branches.includes(branch))
            throw new ConfigError(
                `sessionGrants[${index}].toolBranches must be a subset of the project branches`,
            );
    }
    if (allowTools && toolBranches.length === 0)
        throw new ConfigError(`sessionGrants[${index}].allowTools needs at least one tool branch`);

    const forkRaw =
        value.fork === undefined ? {} : requiredObject(value.fork, `sessionGrants[${index}].fork`);
    const forkEnabled = booleanOr(forkRaw.enabled, false, `sessionGrants[${index}].fork.enabled`);
    const sources =
        forkRaw.sources === undefined
            ? []
            : stringList(forkRaw.sources, `sessionGrants[${index}].fork.sources`, 64, 63);
    for (const branch of sources) {
        if (branch !== "main" && !isBranchName(branch))
            throw new ConfigError(
                `sessionGrants[${index}].fork.sources has an invalid branch name`,
            );
        if (!project.branches.includes(branch))
            throw new ConfigError(
                `sessionGrants[${index}].fork.sources must be a subset of the project branches`,
            );
    }
    if (forkEnabled && sources.length === 0)
        throw new ConfigError(
            `sessionGrants[${index}].fork.enabled needs at least one source branch`,
        );
    const namePrefix = forkRaw.namePrefix === undefined ? "recovery-" : String(forkRaw.namePrefix);
    if (namePrefix.length > 30 || !/^[a-z0-9._-]*$/.test(namePrefix)) {
        throw new ConfigError(`sessionGrants[${index}].fork.namePrefix is not valid`);
    }

    return Object.freeze({
        conversationId,
        project: project.id,
        allowTools,
        toolBranches: Object.freeze(toolBranches),
        fork: Object.freeze({ enabled: forkEnabled, sources: Object.freeze(sources), namePrefix }),
    });
}

/**
 * The safe subset a browser or a tool may see. No socket, token, store path,
 * home, sdk path, owner person id, or other conversation id leaves the server.
 *
 * @param {ReturnType<typeof validateConfig>} config
 */
export function publicConfig(config) {
    return {
        version: config.version,
        toolsEnabled: config.tools.enabled,
        writeEnabled: config.write.enabled,
        projects: config.projects.map((project) => ({
            id: project.id,
            label: project.label,
            origin: project.origin,
            branches: project.branches,
        })),
    };
}

/**
 * The public form of one conversation's grant, for the bound session route.
 * It names only that conversation's project and branches.
 *
 * @param {any} grant
 */
export function publicSessionGrant(grant) {
    if (grant === null || grant === undefined) return null;
    return {
        project: grant.project,
        allowTools: grant.allowTools,
        toolBranches: grant.toolBranches,
        fork: {
            enabled: grant.fork.enabled,
            sources: grant.fork.sources,
            namePrefix: grant.fork.namePrefix,
        },
    };
}

/**
 * Whether `child` is inside `parent`, or is `parent` itself. Both paths are
 * resolved first, so a `..` cannot escape the parent lexically. The service
 * additionally checks every real ancestor for links and ownership.
 *
 * @param {string} parent
 * @param {string} child
 */
export function isInside(parent, child) {
    const root = resolve(parent);
    const target = resolve(child);
    return target === root || target.startsWith(`${root}${sep}`);
}

/**
 * @param {unknown} value
 * @param {string} name
 */
function requiredObject(value, name) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new ConfigError(`${name} must be an object`);
    return /** @type {Record<string, unknown>} */ value;
}

/**
 * Resolve a configured absolute path, refusing a NUL. The service checks the
 * real path and every ancestor before it uses one.
 *
 * @param {unknown} value
 * @param {string} name
 */
function absolutePath(value, name) {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        !isAbsolute(value) ||
        value.includes("\0")
    ) {
        throw new ConfigError(`${name} must be an absolute path`);
    }
    return resolve(value);
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} maxItems
 * @param {number} maxLength
 */
function stringList(value, name, maxItems, maxLength) {
    if (!Array.isArray(value)) throw new ConfigError(`${name} must be an array`);
    if (value.length > maxItems) throw new ConfigError(`${name} has too many entries`);
    const out = [];
    for (const entry of value) {
        if (
            typeof entry !== "string" ||
            entry.length === 0 ||
            entry.length > maxLength ||
            entry.includes("\0")
        ) {
            throw new ConfigError(`${name} has an invalid entry`);
        }
        if (!out.includes(entry)) out.push(entry);
    }
    return out;
}

/**
 * @param {unknown} value
 * @param {boolean} fallback
 * @param {string} name
 */
function booleanOr(value, fallback, name) {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") throw new ConfigError(`${name} must be true or false`);
    return value;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 */
function boundedInteger(value, name, min, max, fallback) {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max)
        throw new ConfigError(`${name} must be an integer from ${min} to ${max}`);
    return value;
}
