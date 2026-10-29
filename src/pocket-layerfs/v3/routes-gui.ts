/**
 * Owner-only Configuration routes for the LayerFS page.
 *
 * They expose a small draft, never a path to a token, socket, SDK, Store, or
 * owner id. Every mutation is explicit and shares the config mutation lock.
 */
import { configSummary, ConfigStoreError, readOwnBytes } from "./config-store.ts";
import { CODES, LayerfsRefusal, safeMessage } from "./errors.ts";
import { isProjectName } from "./policy.ts";
import { checkStatus, draftErrors, applyDraft, sessionIds } from "./apply.ts";
import { confirmImport, LIMITS, listImports, previewImport, projectDetail } from "./import.ts";
import { readRegistry, RegistryError } from "./registry.ts";

/** @param {any} web @param {unknown} error */
function routeError(web, error) {
    if (error instanceof LayerfsRefusal) throw web.error(error.status, safeMessage(error.code));
    if (error instanceof ConfigStoreError) throw web.error(error.status, error.message);
    if (error instanceof RegistryError) throw web.error(409, "The import registry is not usable.");
    throw error;
}

/**
 * @param {any} web
 * @param {unknown} body
 * @param {Set<string>} allowed
 */
function strictBody(web, body, allowed) {
    const value = body === undefined || body === null ? {} : body;
    if (typeof value !== "object" || Array.isArray(value))
        throw web.error(400, "The request body must be an object.");
    for (const key of Object.keys(value)) {
        if (!allowed.has(key) && key !== "__proto__")
            throw web.error(400, `The body field ${key} is not allowed.`);
    }
    return value;
}

/**
 * @param {any} web
 * @param {() => any} run
 */
function guarded(web, run) {
    try {
        return run();
    } catch (error) {
        return routeError(web, error);
    }
}

/**
 * @param {any} web
 * @param {() => Promise<any>} run
 */
async function guardedAsync(web, run) {
    try {
        return await run();
    } catch (error) {
        return routeError(web, error);
    }
}

/**
 * @param {any} runtime
 */
async function serviceStatus(runtime) {
    try {
        const status = await runtime.service.configStatus({ timeoutMs: 2000 });
        return {
            ok: true,
            activeHash: status.activeHash ?? null,
            generation: Number.isSafeInteger(status.generation) ? status.generation : null,
            projectCount: Number.isSafeInteger(status.projectCount) ? status.projectCount : null,
            upstream: status.upstream ?? null,
            startedAt: Number.isSafeInteger(status.startedAt) ? status.startedAt : null,
        };
    } catch (error) {
        return {
            ok: false,
            code: error instanceof LayerfsRefusal ? error.code : CODES.ServiceUnavailable,
        };
    }
}

/**
 * @param {any} runtime
 */
async function overview(runtime, user) {
    const summary = configSummary({ path: runtime.ownPath, activeHash: runtime.activeHash });
    const service = await serviceStatus(runtime);
    let state = "active";
    if (!summary.writable) state = "env-override";
    else if ((summary.hash ?? null) !== (runtime.activeHash ?? null)) state = "saved-pending";
    else if (!service.ok) state = "service-down";
    else if ((service.activeHash ?? null) !== (runtime.activeHash ?? null))
        state = "service-mismatch";
    else if (runtime.lastApply?.outcome === "unknown") state = "unknown";
    return {
        configured: summary.configured,
        writable: summary.writable,
        state,
        savedHash: summary.hash ?? null,
        activeHash: runtime.activeHash ?? null,
        serviceHash: service.ok ? service.activeHash : null,
        reloadRequired: summary.reloadRequired,
        service,
        lastApply: runtime.lastApply,
        owner: {
            personId: user?.id ?? null,
            role: user?.role ?? "owner",
            inOwnerIds:
                runtime.config.ownerPersonIds.length === 0 ||
                runtime.config.ownerPersonIds.includes(user?.id ?? ""),
        },
        toolsEnabled: runtime.config.tools.enabled,
        writeEnabled: runtime.config.write.enabled,
        projects: runtime.config.projects.map((project) => ({
            id: project.id,
            label: project.label,
            origin: project.origin,
            branches: [...project.branches],
        })),
        sessionGrants: runtime.config.sessionGrants.map((grant) => ({
            conversationId: grant.conversationId,
            project: grant.project,
            allowTools: grant.allowTools,
            toolBranches: [...grant.toolBranches],
            fork: {
                enabled: grant.fork.enabled,
                sources: [...grant.fork.sources],
                namePrefix: grant.fork.namePrefix,
            },
        })),
        limits: LIMITS,
    };
}

/** @param {any} host */
function unconfiguredOverview(host) {
    const summary = configSummary({
        path: `${host.dataDir}/pocket-layerfs/config.json`,
        activeHash: null,
    });
    return {
        configured: false,
        writable: summary.writable,
        state: "unconfigured",
        savedHash: summary.hash ?? null,
        activeHash: null,
        serviceHash: null,
        service: { ok: false, code: CODES.NotConfigured },
        lastApply: null,
        toolsEnabled: false,
        writeEnabled: false,
        projects: [],
        sessionGrants: [],
        limits: LIMITS,
    };
}

/**
 * @param {{ web: any, host: any, runtime: any }} options
 */
export function registerGuiRoutes({ web, host, runtime }) {
    /** @param {any} request */
    const requireOwner = (request) => {
        if (request.user?.role !== "owner") throw web.error(404, "Not found.");
        if (runtime !== null && runtime !== undefined) {
            if (
                !runtime.config.ownerPersonIds.includes(request.user.id) &&
                runtime.config.ownerPersonIds.length > 0
            )
                throw web.error(404, "Not found.");
        }
    };
    /** @param {any} request */
    const requireRuntime = (request) => {
        requireOwner(request);
        if (runtime === null || runtime === undefined)
            throw web.error(
                409,
                "The plugin has no valid configuration. Run the reviewed setup first.",
            );
        return runtime;
    };

    web.route("GET", "gui/overview", async (request) => {
        requireOwner(request);
        if (runtime === null || runtime === undefined) return unconfiguredOverview(host);
        return guardedAsync(web, () => overview(runtime, request.user));
    });

    // Stable alias for the independent contract driver's "status" operation.
    web.route("GET", "gui/status", async (request) => {
        requireOwner(request);
        if (runtime === null || runtime === undefined) return unconfiguredOverview(host);
        return guardedAsync(web, () => overview(runtime, request.user));
    });

    web.route("GET", "gui/projects/:project", (request) => {
        const active = requireRuntime(request);
        return guarded(web, () => {
            const detail = projectDetail(active, request.params.project);
            return detail;
        });
    });

    web.route("GET", "gui/sessions", (request) => {
        requireOwner(request);
        if (typeof request.sessions !== "function")
            throw web.error(501, "This Pi Pocket does not give the session list.");
        const list = request.sessions();
        const sessions = [];
        for (const session of Array.isArray(list) ? list : []) {
            if (sessions.length >= 500) break;
            if (!session || !Number.isSafeInteger(session.id)) continue;
            sessions.push({
                id: session.id,
                conversationId: String(session.id),
                title: typeof session.title === "string" ? session.title.slice(0, 200) : "",
                cwd: typeof session.cwd === "string" ? session.cwd.slice(0, 4096) : "",
                archived: session.archived === true,
                updatedAt: Number.isSafeInteger(session.updatedAt) ? session.updatedAt : 0,
            });
        }
        return { sessions, truncated: Array.isArray(list) && list.length > sessions.length };
    });

    web.route("POST", "gui/validate", async (request) => {
        const active = requireRuntime(request);
        const body = strictBody(web, request.body, new Set(["draft"]));
        return guardedAsync(web, async () => {
            const errors = await draftErrors(active, { draft: body.draft }, request, web);
            return { ok: errors.length === 0, errors };
        });
    });

    web.route("POST", "gui/apply", async (request) => {
        const active = requireRuntime(request);
        const body = strictBody(web, request.body, new Set(["expectedSha256", "draft"]));
        return guardedAsync(web, () =>
            applyDraft(
                active,
                { expectedSha256: body.expectedSha256, draft: body.draft },
                request,
                web,
            ),
        );
    });

    web.route("POST", "gui/check", async (request) => {
        const active = requireRuntime(request);
        strictBody(web, request.body, new Set());
        return guardedAsync(web, () => checkStatus(active, web));
    });

    web.route("POST", "gui/import/preview", (request) => {
        const active = requireRuntime(request);
        return guarded(web, () => {
            const body = request.body ?? {};
            if (
                typeof body.expectedSha256 !== "string" ||
                !/^[0-9a-f]{64}$/.test(body.expectedSha256)
            )
                throw web.error(400, "expectedSha256 must be the current saved hash.");
            const saved = readOwnBytes(active.ownPath);
            if (saved === null || saved.sha256 !== body.expectedSha256)
                throw web.error(409, "The config changed. Read the status and try again.");
            if (typeof body.projectId !== "string" || !isProjectName(body.projectId))
                throw web.error(400, "Project id is not valid.");
            const label = typeof body.label === "string" ? body.label.trim() : "";
            if (label.length === 0 || label.length > 80)
                throw web.error(400, "Label needs 1 to 80 characters.");
            if (typeof body.sourcePath !== "string" || body.sourcePath.length > 4096)
                throw web.error(400, "Enter an absolute source path.");
            const branches = body.branches === undefined ? ["main"] : body.branches;
            if (
                !Array.isArray(branches) ||
                branches.length === 0 ||
                branches.length > 64 ||
                branches.some((name) => name !== "main")
            )
                throw web.error(
                    400,
                    "A new Store has only main. Add other branches with the existing fork routes.",
                );
            return previewImport(active, {
                ownerId: request.user.id,
                expectedSha256: body.expectedSha256,
                projectId: body.projectId,
                label,
                sourcePath: body.sourcePath,
                branches: [...new Set(branches)],
            });
        });
    });

    web.route("POST", "gui/import/confirm", async (request) => {
        const active = requireRuntime(request);
        const body = strictBody(web, request.body, new Set(["ticket", "expectedSha256"]));
        return guardedAsync(web, () =>
            confirmImport(active, {
                ownerId: request.user.id,
                ticket: body.ticket,
                expectedSha256: body.expectedSha256,
            }),
        );
    });

    web.route("GET", "gui/imports", (request) => {
        const active = requireRuntime(request);
        return guarded(web, () => listImports(active));
    });

    web.route("GET", "gui/service", async (request) => {
        const active = requireRuntime(request);
        return guardedAsync(web, async () => serviceStatus(active));
    });
}
