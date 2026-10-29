/**
 * The one mutable runtime for this loaded module version.
 *
 * Routes and tools read this holder on every call. A successful apply swaps
 * the config, the facade, and the tickets in one assignment. No handler closes
 * over a config value, so no stale grant survives a change.
 */
import { closeSync, constants, lstatSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { configFileHash, ownConfigPath } from "./config-store.ts";
import { validateConfig } from "./config.ts";
import { LazyServiceClient } from "./lazy.ts";
import { LayerfsFacade } from "./service.ts";
import { TicketStore } from "./tickets.ts";

/**
 * @param {{ host: any, path: string, config: any }} options
 */
const PENDING_MAX = 512 * 1024;

/**
 * Read the private pending-apply evidence with no links and a size bound.
 *
 * @param {string} path
 */
function readPending(path) {
    let info;
    try {
        info = lstatSync(path);
    } catch {
        return null;
    }
    if (!info.isFile() || info.isSymbolicLink()) return null;
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) return null;
    if ((info.mode & 0o077) !== 0) return null;
    if (info.size > PENDING_MAX) return null;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const buffer = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < buffer.length) {
            const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
            if (read === 0) break;
            offset += read;
        }
        const value = JSON.parse(buffer.subarray(0, offset).toString("utf8"));
        if (value === null || typeof value !== "object") return null;
        if (typeof value.previousBytes !== "string") return null;
        if (typeof value.previousHash !== "string" || !/^[0-9a-f]{64}$/.test(value.previousHash))
            return null;
        if (typeof value.targetHash !== "string" || !/^[0-9a-f]{64}$/.test(value.targetHash))
            return null;
        if (!Number.isSafeInteger(value.generation) || value.generation < 1) return null;
        const previous = Buffer.from(value.previousBytes, "base64");
        if (previous.length === 0 || previous.length > 256 * 1024) return null;
        const previousConfig = validateConfig(JSON.parse(previous.toString("utf8")));
        return {
            previousConfig,
            previousHash: value.previousHash,
            targetHash: value.targetHash,
            generation: value.generation,
            at: Number.isSafeInteger(value.at) ? value.at : Date.now(),
        };
    } catch {
        return null;
    } finally {
        closeSync(fd);
    }
}

export function createRuntime({ host, path, config }) {
    const client = new LazyServiceClient({
        socketPath: config.service.socketPath,
        tokenFile: config.service.tokenFile,
        timeoutMs: config.service.requestTimeoutMs,
        maxResponseBytes: config.service.maxResponseBytes,
    });
    const ownPath = ownConfigPath(host);
    const savedHash = configFileHash(path);
    let activeConfig = config;
    let activeHash = savedHash;
    let lastApply = null;
    let authorityUnknown = false;
    const pendingPath = join(dirname(ownPath), ".apply-pending.json");
    const pending = readPending(pendingPath);
    if (pending !== null && pending.targetHash === savedHash) {
        activeConfig = pending.previousConfig;
        activeHash = pending.previousHash;
        lastApply = {
            at: pending.at,
            outcome: "unknown",
            savedHash: pending.targetHash,
            targetHash: pending.targetHash,
            generation: pending.generation,
        };
    } else if (pending !== null && pending.previousHash === savedHash) {
        // The file already equals the previous valid bytes; the evidence is
        // stale and grants nothing new.
        authorityUnknown = false;
        activeHash = savedHash;
        lastApply = null;
    } else if (pending !== null) {
        // Stale or unusable evidence: never adopt the saved bytes at load.
        authorityUnknown = true;
        activeHash = null;
        lastApply = {
            at: Date.now(),
            outcome: "unknown",
            savedHash,
            targetHash: savedHash,
            generation: null,
        };
    }
    /** @type {any} */
    const runtime = {
        host,
        configPath: path,
        ownPath,
        serviceDir: dirname(ownPath),
        config: activeConfig,
        client,
        service: new LayerfsFacade({ client, config: activeConfig }),
        tickets: new TicketStore({ ttlMs: activeConfig.write.ticketTtlMs }),
        generation: 0,
        activeHash,
        lastApply,
        authorityUnknown,
        previews: new Map(),
        importStates: new Map(),
        disposed: false,
    };
    return runtime;
}

/**
 * Use a new validated config after the service has confirmed it.
 *
 * @param {any} runtime
 * @param {{ config: any, hash: string }} next
 */
export function swapRuntime(runtime, { config, hash }) {
    runtime.config = config;
    runtime.service = new LayerfsFacade({ client: runtime.client, config });
    runtime.tickets.clear();
    runtime.activeHash = hash;
    runtime.generation += 1;
}

/**
 * A proxy so a registered route keeps reading the current holder. The reader
 * is called on each property access.
 *
 * @param {() => any} read
 */
export function dynamicObject(read) {
    return new Proxy(
        {},
        {
            get: (_target, key) => read()[key],
            has: (_target, key) => key in read(),
            ownKeys: () => Reflect.ownKeys(read()),
            getOwnPropertyDescriptor: (_target, key) => ({
                configurable: true,
                enumerable: true,
                value: read()[key],
            }),
        },
    );
}

/**
 * A proxy for the facade, with methods bound to the current facade.
 *
 * @param {() => any} read
 */
export function dynamicService(read) {
    return new Proxy(
        {},
        {
            get: (_target, key) => {
                const value = read()[key];
                return typeof value === "function" ? value.bind(read()) : value;
            },
        },
    );
}
