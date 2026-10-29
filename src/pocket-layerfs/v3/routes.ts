/**
 * Owner-only routes for the LayerFS page and the browser module.
 *
 * Read routes are ordinary owner routes. A bound GET tells the owner's page
 * which one project and branch list the current conversation may use. The two
 * write routes are `conversationRoute`s bound to that actual Pocket session:
 * a preview returns a short-lived one-time ticket, and an owner click
 * executes the exact binding after the service re-checks the source head. A
 * model cannot supply `confirm: true` as an approval because no tool returns a
 * ticket.
 */
import {
    assertNewBranchName,
    assertOwnerPerson,
    isOwnerRequest,
    projectGrant,
    sessionGrant,
    writeContext,
} from "./auth.ts";
import { CODES, LayerfsRefusal, safeMessage } from "./errors.ts";
import { publicConfig, publicSessionGrant } from "./config.ts";
import {
    ConfigStoreError,
    configSummary,
    deleteOwnConfig,
    mutateOwnConfig,
    ownConfigPath,
    withConfigMutation,
} from "./config-store.ts";
import { clampHistoryScan, clampLine, clampPagePos, clampPageSize, isNodeId } from "./policy.ts";

/**
 * @param {object} options
 * @param {any} options.config
 * @param {any} options.web
 * @param {import("./service.ts").LayerfsFacade} options.service
 * @param {import("./tickets.ts").TicketStore} options.tickets
 */
export function registerRoutes({ config, web, service, tickets }) {
    /** @param {any} request */
    const requireOwner = (request) => {
        if (!isOwnerRequest(request, config)) throw web.error(404, "Not found.");
    };

    /** @param {any} request @param {string} projectId */
    const requireProject = (request, projectId) => {
        requireOwner(request);
        try {
            return projectGrant(config, projectId);
        } catch (error) {
            throw routeError(web, error);
        }
    };

    /** @param {any} request @param {string} name @param {string} [fallback] */
    const text = (request, name, fallback = "") => {
        const value = request.query.get(name);
        return value === null || value === "" ? fallback : value;
    };

    /** @param {any} request @param {string} name @param {string} [fallback] */
    const bodyText = (request, name, fallback = "") => {
        const value = request.body?.[name];
        return typeof value === "string" && value.length > 0 ? value : fallback;
    };

    web.route("GET", "status", async (request) => {
        requireOwner(request);
        const safe = publicConfig(config);
        try {
            const ping = await service.ping({ signal: request.signal });
            return { configured: true, service: { ok: true, ...sanitisePing(ping) }, config: safe };
        } catch (error) {
            const code = error instanceof LayerfsRefusal ? error.code : CODES.ServiceUnavailable;
            return {
                configured: true,
                service: { ok: false, code, message: safeMessage(code) },
                config: safe,
            };
        }
    });

    web.route("GET", "projects", (request) => {
        requireOwner(request);
        return publicConfig(config);
    });

    web.route("GET", "projects/:project/branches", async (request) => {
        const project = requireProject(request, request.params.project);
        try {
            return await service.branches(project.id);
        } catch (error) {
            throw routeError(web, error);
        }
    });

    web.route("GET", "projects/:project/commits", async (request) => {
        const project = requireProject(request, request.params.project);
        try {
            return await service.commits(
                project.id,
                text(request, "branch", "main"),
                clampPageSize(text(request, "pageSize", "50")),
                clampPagePos(text(request, "pagePos", "0")),
            );
        } catch (error) {
            throw routeError(web, error);
        }
    });

    web.route("GET", "projects/:project/commit", async (request) => {
        const project = requireProject(request, request.params.project);
        const commit = text(request, "commit");
        if (!isNodeId(commit)) throw web.error(400, safeMessage(CODES.InvalidRef));
        try {
            return await service.commit(project.id, commit);
        } catch (error) {
            throw routeError(web, error);
        }
    });

    web.route("GET", "projects/:project/tree", async (request) => {
        const project = requireProject(request, request.params.project);
        try {
            return await service.tree(
                project.id,
                text(request, "ref", "main"),
                text(request, "path", "/"),
                clampPageSize(text(request, "pageSize", "50")),
                clampPagePos(text(request, "pagePos", "0")),
            );
        } catch (error) {
            throw routeError(web, error);
        }
    });

    web.route("GET", "projects/:project/stat", async (request) => {
        const project = requireProject(request, request.params.project);
        try {
            return await service.stat(
                project.id,
                text(request, "ref", "main"),
                text(request, "path", "/"),
            );
        } catch (error) {
            throw routeError(web, error);
        }
    });

    web.route("GET", "projects/:project/read", async (request) => {
        const project = requireProject(request, request.params.project);
        try {
            return await service.read(
                project.id,
                text(request, "ref", "main"),
                text(request, "path"),
                clampLine(text(request, "startLine", "1"), 1),
                text(request, "endLine") === "" ? undefined : Number(text(request, "endLine")),
            );
        } catch (error) {
            throw routeError(web, error);
        }
    });

    web.route("GET", "projects/:project/diff", async (request) => {
        const project = requireProject(request, request.params.project);
        try {
            return await service.diff(
                project.id,
                text(request, "from", "main"),
                text(request, "to", "main"),
                {
                    pageSize: clampPageSize(text(request, "pageSize", "50")),
                    pagePos: clampPagePos(text(request, "pagePos", "0")),
                    cursor: text(request, "cursor") || undefined,
                    hunks:
                        text(request, "hunks", "1") !== "0" &&
                        text(request, "hunks", "true") !== "false",
                },
            );
        } catch (error) {
            throw routeError(web, error);
        }
    });

    web.route("GET", "projects/:project/blame", async (request) => {
        const project = requireProject(request, request.params.project);
        try {
            return await service.blame(
                project.id,
                text(request, "ref", "main"),
                text(request, "path"),
                clampLine(text(request, "fromLine", "1"), 1),
            );
        } catch (error) {
            throw routeError(web, error);
        }
    });

    web.route("GET", "projects/:project/file-history", async (request) => {
        const project = requireProject(request, request.params.project);
        try {
            return await service.fileHistory(
                project.id,
                text(request, "branch", "main"),
                text(request, "path"),
                {
                    maxCommits: clampHistoryScan(text(request, "maxCommits", "50")),
                },
            );
        } catch (error) {
            throw routeError(web, error);
        }
    });

    if (typeof web.conversationRoute !== "function") {
        // An older server has no bound routes. Reads stay available.
        return;
    }

    web.conversationRoute(
        "GET",
        "session/:source/status",
        (request) => {
            requireOwner(request);
            if (request.user.role !== "owner") throw web.error(404, "Not found.");
            return {
                conversation: {
                    id: String(request.conversation.id),
                    title: request.conversation.title,
                },
                grant: publicSessionGrant(sessionGrant(config, request.conversation.id)),
            };
        },
        { conversation: "source", access: "owner" },
    );

    web.conversationRoute(
        "POST",
        "projects/:project/fork-preview/:source",
        async (request) => {
            const projectId = request.params.project;
            requireOwner(request);
            let context;
            try {
                context = writeContext(config, request.conversation.id, projectId);
            } catch (error) {
                throw routeError(web, error);
            }
            const { grant, project } = context;
            const ownerId = assertOwnerPersonForRoute(web, config, request.user.id);
            const sourceBranch = bodyText(request, "sourceBranch");
            const newBranch = bodyText(request, "newBranch");
            const fromRef = bodyText(request, "fromRef");
            try {
                const source = assertForkSourceForRoute(grant, project, sourceBranch);
                assertNewBranchName(grant, newBranch);
                const plan = await service.prepareFork({
                    projectId: project.id,
                    sourceBranch: source,
                    newBranch,
                    fromRef: fromRef === "" ? undefined : fromRef,
                    conversationId: String(request.conversation.id),
                    signal: request.signal,
                });
                if (plan.targetExists === true) throw new LayerfsRefusal(CODES.NameTaken);
                const record = {
                    ownerId,
                    conversationId: String(request.conversation.id),
                    project: project.id,
                    sourceBranch: source,
                    fromRef: plan.fromRef,
                    newBranch,
                    expectedHead: plan.expectedHead,
                    op: "branch.fork",
                };
                const issued = tickets.issue(record);
                return {
                    ticket: issued.ticket,
                    expiresAt: issued.record.expiresAt,
                    preview: {
                        operation: "branch.fork",
                        project: project.id,
                        projectLabel: project.label,
                        sourceBranch: source,
                        fromRef: plan.fromRef,
                        fromLabel: plan.fromLabel,
                        expectedHead: plan.expectedHead,
                        newBranch,
                        source: {
                            id: String(request.conversation.id),
                            title: request.conversation.title,
                        },
                        currentHead: plan.sourceHead,
                        targetExists: false,
                    },
                };
            } catch (error) {
                throw routeError(web, error);
            }
        },
        { conversation: "source", access: "owner" },
    );

    web.conversationRoute(
        "POST",
        "projects/:project/fork-execute/:source",
        async (request) => {
            requireOwner(request);
            let context;
            try {
                context = writeContext(config, request.conversation.id, request.params.project);
            } catch (error) {
                throw routeError(web, error);
            }
            const { grant, project } = context;
            const ownerId = assertOwnerPersonForRoute(web, config, request.user.id);
            const token = bodyText(request, "ticket");
            if (request.signal.aborted) throw web.error(408, "The request was cancelled.");
            try {
                const record = tickets.consumeFor(token, {
                    ownerId,
                    conversationId: String(request.conversation.id),
                    project: project.id,
                    op: "branch.fork",
                });
                assertForkSourceForRoute(grant, project, record.sourceBranch);
                assertNewBranchName(grant, record.newBranch);
                const result = await service.fork({
                    projectId: record.project,
                    sourceBranch: record.sourceBranch,
                    fromRef: record.fromRef,
                    newBranch: record.newBranch,
                    expectedHead: record.expectedHead,
                    conversationId: String(request.conversation.id),
                    signal: request.signal,
                });
                return {
                    ok: true,
                    operation: "branch.fork",
                    project: record.project,
                    branch: result.branch,
                    head: result.head,
                    base: result.base,
                };
            } catch (error) {
                throw routeError(web, error);
            }
        },
        { conversation: "source", access: "owner" },
    );
}

/**
 * @param {any} grant
 * @param {any} project
 * @param {unknown} sourceBranch
 */
function assertForkSourceForRoute(grant, project, sourceBranch) {
    if (!grant.fork.enabled) throw new LayerfsRefusal(CODES.WriteDisabled);
    if (typeof sourceBranch !== "string" || !project.branches.includes(sourceBranch))
        throw new LayerfsRefusal(CODES.NotFound);
    if (!grant.fork.sources.includes(sourceBranch)) throw new LayerfsRefusal(CODES.Forbidden);
    return sourceBranch;
}

/**
 * The owner id is required for a write route. A route with an empty
 * `ownerPersonIds` list refuses writes rather than accepting any owner tab.
 *
 * @param {any} web
 * @param {any} config
 * @param {unknown} personId
 * @returns {string}
 */
function assertOwnerPersonForRoute(web, config, personId) {
    try {
        return assertOwnerPerson(config, personId);
    } catch (error) {
        throw routeError(web, error);
    }
}

/**
 * Owner-only management of this module's own config file. These routes are
 * registered even when the config is absent or invalid, so the owner can see
 * the safe status and create or repair the file. They never add a tool, and a
 * missing config keeps every tool and write denied.
 *
 * @param {object} options
 * @param {any} options.web
 * @param {{ dataDir: string }} options.host
 * @param {string | null | (() => string | null)} options.activeHash
 */
export function registerConfigRoutes({ web, host, activeHash: activeHashSource }) {
    const activeHash = () =>
        typeof activeHashSource === "function" ? activeHashSource() : activeHashSource;
    const path = ownConfigPath(host);
    const summary = () => configSummary({ path, activeHash: activeHash() });
    /** @param {any} request */
    const requireOwner = (request) => {
        if (request.user?.role !== "owner") throw web.error(404, "Not found.");
    };

    web.route("GET", "config", (request) => {
        requireOwner(request);
        return summary();
    });

    web.route("PUT", "config", async (request) => {
        requireOwner(request);
        return withConfigMutation(() =>
            change(request, () =>
                mutateOwnConfig({
                    path,
                    expectedSha256: request.body?.expectedSha256,
                    candidate: request.body?.candidate,
                    actor: request.user,
                    activeHash: activeHash(),
                }),
            ),
        );
    });

    web.route("POST", "config/delete", async (request) => {
        requireOwner(request);
        return withConfigMutation(() =>
            change(request, () =>
                deleteOwnConfig({
                    path,
                    expectedSha256: request.body?.expectedSha256,
                    actor: request.user,
                    activeHash: activeHash(),
                }),
            ),
        );
    });

    if (typeof web.conversationRoute === "function") {
        web.conversationRoute(
            "GET",
            "config/whoami/:source",
            (request) => {
                requireOwner(request);
                const current = summary();
                return {
                    personId: request.user.id,
                    role: request.user.role,
                    conversationId: String(request.conversation.id),
                    activeHash: activeHash(),
                    currentHash: current.hash ?? null,
                };
            },
            { conversation: "source", access: "owner" },
        );
    }

    /**
     * @param {any} request
     * @param {() => unknown} run
     */
    function change(request, run) {
        try {
            run();
        } catch (error) {
            if (error instanceof ConfigStoreError) throw web.error(error.status, error.message);
            throw web.error(409, "The LayerFS config could not be changed.");
        }
        return summary();
    }
}

/**
 * @param {any} ping
 */
function sanitisePing(ping) {
    return {
        version: typeof ping.version === "string" ? ping.version.slice(0, 32) : "0.1.0",
        upstreamVersion:
            typeof ping.upstreamVersion === "string"
                ? ping.upstreamVersion.slice(0, 32)
                : undefined,
        upstreamCommit:
            typeof ping.upstreamCommit === "string" ? ping.upstreamCommit.slice(0, 80) : undefined,
        projects: Array.isArray(ping.projects)
            ? ping.projects.filter((id) => typeof id === "string").slice(0, 50)
            : [],
        startedAt: typeof ping.startedAt === "number" ? ping.startedAt : undefined,
    };
}

/**
 * @param {any} web
 * @param {unknown} error
 * @returns {Error}
 */
function routeError(web, error) {
    if (error instanceof LayerfsRefusal) return web.error(error.status, safeMessage(error.code));
    return web.error(502, safeMessage(CODES.Upstream));
}
