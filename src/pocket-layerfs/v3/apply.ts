/**
 * The one explicit Save and apply transaction.
 *
 * The config file is written first with compare-and-swap, then the service is
 * asked to apply the exact target hash from the exact base hash and generation.
 * The plugin holder is swapped only after the service acknowledges. A definite
 * refusal restores the previous bytes once; an unknown outcome is reported as
 * unknown and never retried.
 */
import { closeSync, constants, openSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { readOwnBytes, withConfigMutation, writeOwnBytes } from "./config-store.ts";
import { validateConfig } from "./config.ts";
import { CODES, LayerfsRefusal, safeMessage } from "./errors.ts";
import { buildCandidate, parseDraft } from "./gui.ts";
import { readRegistry, updateRegistry } from "./registry.ts";
import { swapRuntime } from "./runtime.ts";

const DEFINITE = new Set([
    CODES.NotApplied,
    CODES.Invalid,
    CODES.Forbidden,
    CODES.NotConfigured,
    CODES.Conflict,
    CODES.StaleGeneration,
    CODES.NotFound,
    CODES.Unsupported,
    CODES.HeadMoved,
    CODES.NameTaken,
    CODES.ResponseTooLarge,
    CODES.Busy,
]);

/**
 * @param {any} web
 */
function requireWritable(web) {
    if (
        process.env.PI_POCKET_LAYERFS_CONFIG !== undefined &&
        process.env.PI_POCKET_LAYERFS_CONFIG !== ""
    )
        throw web.error(403, "Config writes are disabled while PI_POCKET_LAYERFS_CONFIG is set.");
}

/**
 * The official session list, never a database or a log.
 *
 * @param {any} request
 */
export function sessionIds(request) {
    if (typeof request.sessions !== "function")
        throw new LayerfsRefusal(
            CODES.Unsupported,
            "This Pi Pocket does not give the session list.",
            501,
        );
    const list = request.sessions();
    const ids = new Set();
    for (const session of Array.isArray(list) ? list : []) {
        if (session && Number.isSafeInteger(session.id)) ids.add(String(session.id));
    }
    return ids;
}

/**
 * @param {any} runtime
 * @param {any} web
 */
async function branchLists(runtime, web, { allowFallback = false } = {}) {
    const map = new Map();
    for (const project of runtime.config.projects) {
        try {
            const result = await runtime.service.branches(project.id, { timeoutMs: 6000 });
            map.set(
                project.id,
                (Array.isArray(result.items) ? result.items : [])
                    .map((item) => item.name)
                    .filter((name) => typeof name === "string"),
            );
        } catch {
            throw web.error(
                503,
                "The service did not give the branch list. Apply needs the live service.",
            );
        }
    }
    return map;
}

/**
 * @param {any} runtime
 * @param {{ draft: any }} input
 * @param {any} request
 * @param {any} web
 */
export async function draftErrors(runtime, input, request, web) {
    const parsed = parseDraft(input.draft);
    if (parsed.errors.length > 0) return parsed.errors;
    let ids;
    try {
        ids = sessionIds(request);
    } catch (error) {
        if (error instanceof LayerfsRefusal) throw web.error(error.status, safeMessage(error.code));
        throw error;
    }
    const registry = readRegistry(runtime.host);
    const branches = await branchLists(runtime, web);
    const imported = new Map<string, any>(registry.stores.map((store) => [store.projectId, store]));
    const { errors } = buildCandidate({
        current: runtime.config,
        draft: parsed.draft,
        sessionIds: ids,
        existingBranches: (projectId) => {
            if (branches.has(projectId)) return branches.get(projectId);
            const store = imported.get(projectId) as any;
            return store === undefined ? null : [...store.branches];
        },
        registry,
    });
    return errors;
}

/**
 * @param {any} runtime
 * @param {{ expectedSha256: any, draft: any }} input
 * @param {any} request
 * @param {any} web
 */
export async function applyDraft(runtime, input, request, web) {
    return withConfigMutation(async () => {
        requireWritable(web);
        if (
            typeof input.expectedSha256 !== "string" ||
            !/^[0-9a-f]{64}$/.test(input.expectedSha256)
        )
            throw web.error(400, "expectedSha256 must be the current saved hash.");
        let status;
        try {
            status = await runtime.service.configStatus({ timeoutMs: 3000 });
        } catch {
            throw web.error(503, "The private service is not reachable. Nothing was written.");
        }
        if (
            typeof status.activeHash !== "string" ||
            !Number.isSafeInteger(status.generation) ||
            status.generation < 0
        )
            throw web.error(502, "The service did not give a usable status.");
        const saved = readOwnBytes(runtime.ownPath);
        if (saved === null) throw web.error(409, "The saved config is not readable.");
        if (saved.sha256 !== input.expectedSha256)
            throw web.error(409, "The config changed. Read the status and try again.");
        if (runtime.authorityUnknown || runtime.activeHash !== status.activeHash)
            throw web.error(
                409,
                "The plugin and the service do not share an established active config. Use Check status first.",
            );
        const H1 = status.activeHash;
        const parsed = parseDraft(input.draft);
        if (parsed.errors.length > 0)
            throw web.error(
                400,
                parsed.errors
                    .map((entry) => entry.message)
                    .join(" ")
                    .slice(0, 400),
            );
        let ids;
        try {
            ids = sessionIds(request);
        } catch (error) {
            if (error instanceof LayerfsRefusal)
                throw web.error(error.status, safeMessage(error.code));
            throw error;
        }
        const registry = readRegistry(runtime.host);
        const branches = await branchLists(runtime, web, { allowFallback: true });
        /** @type {Map<string, any>} */
        const imported = new Map(registry.stores.map((store) => [store.projectId, store]));
        const built = buildCandidate({
            current: runtime.config,
            draft: parsed.draft,
            sessionIds: ids,
            existingBranches: (projectId) => {
                if (branches.has(projectId)) return branches.get(projectId);
                const store = imported.get(projectId) as any;
                return store === undefined ? null : [...store.branches];
            },
            registry,
        });
        if (built.errors.length > 0)
            throw web.error(
                400,
                built.errors
                    .map((entry) => entry.message)
                    .join(" ")
                    .slice(0, 400),
            );
        const candidate = built.candidate;
        const bytes = Buffer.from(`${JSON.stringify(candidate, null, 4)}\n`, "utf8");
        const H2 = createHash("sha256").update(bytes).digest("hex");
        let summary;
        try {
            summary = writeOwnBytes({
                path: runtime.ownPath,
                expectedSha256: saved.sha256,
                bytes,
                actor: { id: request.user.id, role: request.user.role },
                activeHash: H1,
            });
        } catch (error) {
            if (error && typeof error.status === "number")
                throw web.error(error.status, error.message);
            throw web.error(409, "The config could not be written.");
        }
        const generation = status.generation;
        let result;
        try {
            result = await runtime.service.configApply(
                { baseActiveHash: H1, targetHash: H2, expectedGeneration: generation },
                { timeoutMs: 30_000 },
            );
        } catch (error) {
            const code = error instanceof LayerfsRefusal ? error.code : CODES.ServiceUnavailable;
            if (DEFINITE.has(code)) {
                let compensated = false;
                try {
                    writeOwnBytes({
                        path: runtime.ownPath,
                        expectedSha256: H2,
                        bytes: saved.bytes,
                        actor: { id: request.user.id, role: request.user.role },
                        activeHash: H1,
                    });
                    compensated = true;
                } catch {
                    compensated = false;
                }
                runtime.lastApply = {
                    at: Date.now(),
                    outcome: compensated ? "refused" : "pending",
                    code,
                    savedHash: compensated ? saved.sha256 : H2,
                    targetHash: H2,
                    generation,
                };
                if (!compensated)
                    throw web.error(
                        409,
                        `The service refused the change (${code}) and the previous bytes could not be restored. Saved is pending; the active service config did not change.`,
                    );
                throw web.error(
                    error.status ?? 502,
                    `The service refused the change (${code}). The previous configuration is kept.`,
                );
            }
            writePending(runtime, {
                previousHash: saved.sha256,
                previousBytes: saved.bytes.toString("base64"),
                targetHash: H2,
                generation: generation + 1,
            });
            runtime.lastApply = {
                at: Date.now(),
                outcome: "unknown",
                code,
                savedHash: H2,
                targetHash: H2,
                generation: generation + 1,
            };
            throw web.error(
                504,
                "The service gave no answer. The outcome is unknown. Use Check status; do not retry automatically.",
            );
        }
        if (
            result?.applied !== true ||
            result.activeHash !== H2 ||
            result.generation !== generation + 1
        ) {
            writePending(runtime, {
                previousHash: saved.sha256,
                previousBytes: saved.bytes.toString("base64"),
                targetHash: H2,
                generation: generation + 1,
            });
            runtime.lastApply = {
                at: Date.now(),
                outcome: "unknown",
                code: CODES.Protocol,
                savedHash: H2,
                targetHash: H2,
                generation: generation + 1,
            };
            throw web.error(
                504,
                "The service answer is not the expected one. Check status; do not retry.",
            );
        }
        swapRuntime(runtime, { config: candidate, hash: H2 });
        runtime.generation = result.generation;
        runtime.lastApply = {
            at: Date.now(),
            outcome: "ok",
            savedHash: H2,
            targetHash: H2,
            generation: result.generation,
        };
        let warning = null;
        try {
            updateRegistry(runtime.host, (current) => ({
                registry: {
                    version: current.version,
                    stores: current.stores.map((store) =>
                        store.state === "unpublished-ready" &&
                        candidate.projects.some((project) => project.id === store.projectId)
                            ? { ...store, state: "published" }
                            : store,
                    ),
                },
                answer: null,
            }));
        } catch {
            warning = "The Store metadata could not be marked published.";
        }
        return {
            ok: true,
            state: "active",
            savedHash: H2,
            activeHash: runtime.activeHash,
            serviceHash: result.activeHash,
            generation: result.generation,
            written: summary?.size ?? bytes.length,
            ...(warning === null ? {} : { warning }),
        };
    });
}

/**
 * Explicit reconciliation. It reads the service status and may adopt a
 * confirmed same-hash generation. It never replays a mutation.
 *
 * @param {any} runtime
 * @param {any} web
 */
export async function checkStatus(runtime, web) {
    return withConfigMutation(async () => {
        let status;
        try {
            status = await runtime.service.configStatus({ timeoutMs: 3000 });
        } catch {
            throw web.error(503, "The private service is not reachable.");
        }
        const saved = readOwnBytes(runtime.ownPath);
        const savedHash = saved === null ? null : saved.sha256;
        let adopted = false;
        if (
            saved !== null &&
            runtime.lastApply?.outcome === "unknown" &&
            status.activeHash === savedHash &&
            (runtime.lastApply.generation === null ||
                status.generation === runtime.lastApply.generation)
        ) {
            let config = null;
            try {
                config = validateConfig(JSON.parse(saved.bytes.toString("utf8")));
            } catch {
                config = null;
            }
            if (config !== null) {
                swapRuntime(runtime, { config, hash: savedHash });
                runtime.authorityUnknown = false;
                runtime.generation = status.generation;
                runtime.lastApply = {
                    at: Date.now(),
                    outcome: "ok",
                    savedHash,
                    targetHash: savedHash,
                    generation: status.generation,
                };
                adopted = true;
            }
        }
        return {
            ok: true,
            adopted,
            savedHash,
            activeHash: runtime.activeHash,
            serviceHash: status.activeHash ?? null,
            generation: status.generation ?? null,
            state:
                savedHash !== null &&
                savedHash === runtime.activeHash &&
                savedHash === status.activeHash
                    ? "active"
                    : "mismatch",
        };
    });
}

/**
 * Keep the previous valid bytes privately for an unknown outcome.
 *
 * @param {any} runtime
 * @param {{ previousHash: string, previousBytes: string, targetHash: string, generation: number }} value
 */
function writePending(runtime, value) {
    try {
        const path = `${runtime.serviceDir}/.apply-pending.json`;
        const bytes = Buffer.from(`${JSON.stringify({ ...value, at: Date.now() })}\n`, "utf8");
        const fd = openSync(
            path,
            constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
            0o600,
        );
        try {
            let offset = 0;
            while (offset < bytes.length)
                offset += writeSync(fd, bytes, offset, bytes.length - offset);
        } finally {
            closeSync(fd);
        }
    } catch {
        // The pending file is best effort; the state in memory still says unknown.
    }
}
