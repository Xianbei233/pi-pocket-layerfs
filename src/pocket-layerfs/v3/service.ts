/**
 * The plugin-side facade over the private service. It checks the owner's
 * session grant before a request leaves the server, and the service checks it
 * again against its own copy of the config.
 */
import { CODES, LayerfsRefusal } from "./errors.ts";
import {
    assertAllowedBranch,
    assertForkSource,
    assertNewBranchName,
    projectGrant,
    sessionGrant,
    writeContext,
} from "./auth.ts";
import {
    clampLineWindow,
    clampPagePos,
    clampPageSize,
    isNodeId,
    normaliseDirectory,
    normalisePath,
    refKind,
} from "./policy.ts";

/** A facade for one loaded version of the module. */
export class LayerfsFacade {
    /** @type {{ request: (op: string, args: Record<string, unknown>, options?: any) => Promise<any> }} */
    client;
    /** @type {any} */
    config;

    /**
     * @param {{ client: { request: (op: string, args: Record<string, unknown>, options?: any) => Promise<any> }, config: any }} options
     */
    constructor({ client, config }) {
        this.client = client;
        this.config = config;
    }

    /** @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] */
    ping(options = {}) {
        return this.client.request("ping", {}, options);
    }

    /** The service's actual active hash and generation. */
    configStatus(options = {}) {
        return this.client.request("config.status", {}, options);
    }

    /**
     * @param {{ baseActiveHash: string, targetHash: string, expectedGeneration: number }} args
     * @param {{ timeoutMs?: number }} [options]
     */
    configApply(args, options = {}) {
        return this.client.request("config.apply", args, options);
    }

    /**
     * @param {string} projectId
     * @param {{ tools?: boolean, conversationId?: string, grant?: any }} [options]
     */
    async branches(projectId, options = {}) {
        const project = projectGrant(this.config, projectId);
        const grant = this.#toolGrant(options);
        if (grant !== null && grant.project !== project.id)
            throw new LayerfsRefusal(CODES.NotFound);
        return this.client.request("branches", {
            project: project.id,
            ...this.#scope(options),
        });
    }

    /**
     * @param {string} projectId
     * @param {string} branch
     * @param {number} [pageSize]
     * @param {number} [pagePos]
     * @param {{ tools?: boolean, conversationId?: string, grant?: any }} [options]
     */
    async commits(projectId, branch, pageSize = 50, pagePos = 0, options = {}) {
        const project = projectGrant(this.config, projectId);
        const grant = this.#toolGrant(options);
        assertAllowedBranch(branch, grant === null ? project.branches : grant.toolBranches);
        return this.client.request("commits", {
            project: project.id,
            branch,
            pageSize: clampPageSize(pageSize),
            pagePos: clampPagePos(pagePos),
            ...this.#scope(options),
        });
    }

    /**
     * @param {string} projectId
     * @param {string} commit
     * @param {{ tools?: boolean, conversationId?: string, grant?: any }} [options]
     */
    async commit(projectId, commit, options = {}) {
        const project = projectGrant(this.config, projectId);
        if (!isNodeId(commit)) throw new LayerfsRefusal(CODES.InvalidRef);
        return this.client.request("commit", {
            project: project.id,
            commit,
            ...this.#scope(options),
        });
    }

    /**
     * @param {string} projectId
     * @param {string} ref
     * @param {string} path
     * @param {number} [pageSize]
     * @param {number} [pagePos]
     * @param {{ tools?: boolean, conversationId?: string, grant?: any }} [options]
     */
    async tree(projectId, ref, path = "/", pageSize = 50, pagePos = 0, options = {}) {
        const project = projectGrant(this.config, projectId);
        const checkedRef = this.#ref(project, ref, options);
        const checkedPath = normaliseDirectory(path);
        if (!checkedPath.ok) throw new LayerfsRefusal(checkedPath.code);
        return this.client.request("tree", {
            project: project.id,
            ref: checkedRef,
            path: checkedPath.path,
            pageSize: clampPageSize(pageSize),
            pagePos: clampPagePos(pagePos),
            ...this.#scope(options),
        });
    }

    /**
     * @param {string} projectId
     * @param {string} ref
     * @param {string} path
     * @param {{ tools?: boolean, conversationId?: string, grant?: any }} [options]
     */
    async stat(projectId, ref, path, options = {}) {
        const project = projectGrant(this.config, projectId);
        const checkedRef = this.#ref(project, ref, options);
        const checkedPath = normalisePath(path);
        if (!checkedPath.ok) throw new LayerfsRefusal(checkedPath.code);
        return this.client.request("stat", {
            project: project.id,
            ref: checkedRef,
            path: checkedPath.path,
            ...this.#scope(options),
        });
    }

    /**
     * @param {string} projectId
     * @param {string} ref
     * @param {string} path
     * @param {number} [startLine]
     * @param {number} [endLine]
     * @param {{ tools?: boolean, conversationId?: string, grant?: any }} [options]
     */
    async read(projectId, ref, path, startLine = 1, endLine, options = {}) {
        const project = projectGrant(this.config, projectId);
        const checkedRef = this.#ref(project, ref, options);
        const checkedPath = normalisePath(path);
        if (!checkedPath.ok) throw new LayerfsRefusal(checkedPath.code);
        const window = clampLineWindow(startLine, endLine);
        return this.client.request("read", {
            project: project.id,
            ref: checkedRef,
            path: checkedPath.path,
            startLine: window.startLine,
            endLine: window.endLine,
            ...this.#scope(options),
        });
    }

    /**
     * @param {string} projectId
     * @param {string} from
     * @param {string} to
     * @param {{ pageSize?: number, pagePos?: number, cursor?: string, hunks?: boolean, tools?: boolean, conversationId?: string, grant?: any }} [options]
     */
    async diff(
        projectId,
        from,
        to,
        options: {
            pageSize?: number;
            pagePos?: number;
            cursor?: string;
            hunks?: boolean;
            tools?: boolean;
            conversationId?: string;
            grant?: any;
        } = {},
    ) {
        const project = projectGrant(this.config, projectId);
        const fromRef = this.#ref(project, from, options);
        const toRef = this.#ref(project, to, options);
        const cursor =
            options.cursor === undefined || options.cursor === null
                ? undefined
                : normalisePath(options.cursor);
        if (cursor !== undefined && !cursor.ok)
            throw new LayerfsRefusal(
                cursor.code === "NotFound" ? CODES.NotFound : CODES.InvalidPath,
            );
        return this.client.request("diff", {
            project: project.id,
            from: fromRef,
            to: toRef,
            pageSize: clampPageSize(options.pageSize),
            pagePos: clampPagePos(options.pagePos),
            ...(cursor === undefined ? {} : { cursor: cursor.path }),
            hunks: options.hunks !== false,
            ...this.#scope(options),
        });
    }

    /**
     * @param {string} projectId
     * @param {string} ref
     * @param {string} path
     * @param {number} [fromLine]
     * @param {{ tools?: boolean, conversationId?: string, grant?: any }} [options]
     */
    async blame(projectId, ref, path, fromLine = 1, options = {}) {
        const project = projectGrant(this.config, projectId);
        const checkedRef = this.#ref(project, ref, options);
        const checkedPath = normalisePath(path);
        if (!checkedPath.ok) throw new LayerfsRefusal(checkedPath.code);
        return this.client.request("blame", {
            project: project.id,
            ref: checkedRef,
            path: checkedPath.path,
            fromLine,
            ...this.#scope(options),
        });
    }

    /**
     * @param {string} projectId
     * @param {string} branch
     * @param {string} path
     * @param {{ maxCommits?: number, tools?: boolean, conversationId?: string, grant?: any }} [options]
     */
    async fileHistory(
        projectId,
        branch,
        path,
        options: {
            maxCommits?: number;
            tools?: boolean;
            conversationId?: string;
            grant?: any;
        } = {},
    ) {
        const project = projectGrant(this.config, projectId);
        const grant = this.#toolGrant(options);
        assertAllowedBranch(branch, grant === null ? project.branches : grant.toolBranches);
        const checkedPath = normalisePath(path);
        if (!checkedPath.ok) throw new LayerfsRefusal(checkedPath.code);
        return this.client.request("file-history", {
            project: project.id,
            branch,
            path: checkedPath.path,
            maxCommits: options.maxCommits ?? 50,
            ...this.#scope(options),
        });
    }

    /**
     * Validate a fork source and read its current head. This does not write.
     *
     * @param {{ projectId: string, sourceBranch: string, newBranch: string, fromRef?: string | null, conversationId: string, signal?: AbortSignal }} request
     */
    async prepareFork({ projectId, sourceBranch, newBranch, fromRef, conversationId, signal }) {
        const { grant, project } = writeContext(this.config, conversationId, projectId);
        const source = assertForkSource(grant, project, sourceBranch);
        const target = assertNewBranchName(grant, newBranch);
        const ref =
            fromRef === undefined || fromRef === null || fromRef === "" ? undefined : fromRef;
        if (ref !== undefined && !isNodeId(ref) && ref !== source)
            throw new LayerfsRefusal(CODES.InvalidRef);
        return this.client.request(
            "fork.plan",
            {
                project: project.id,
                sourceBranch: source,
                newBranch: target,
                conversationId,
                ...(ref === undefined ? {} : { fromRef: ref }),
            },
            signal === undefined ? {} : { signal },
        );
    }

    /**
     * Create one real SDK Branch at a source Head or a reachable Commit.
     * The service re-checks the expected Head immediately before the call.
     *
     * @param {{ projectId: string, sourceBranch: string, fromRef: string, newBranch: string, expectedHead: string, conversationId: string, signal?: AbortSignal }} request
     */
    async fork({
        projectId,
        sourceBranch,
        fromRef,
        newBranch,
        expectedHead,
        conversationId,
        signal,
    }) {
        const { grant, project } = writeContext(this.config, conversationId, projectId);
        const source = assertForkSource(grant, project, sourceBranch);
        const target = assertNewBranchName(grant, newBranch);
        if (!isNodeId(fromRef) && fromRef !== source) throw new LayerfsRefusal(CODES.InvalidRef);
        if (!isNodeId(expectedHead)) throw new LayerfsRefusal(CODES.InvalidRef);
        return this.client.request(
            "fork.commit",
            {
                project: project.id,
                sourceBranch: source,
                fromRef,
                newBranch: target,
                expectedHead,
                conversationId,
            },
            signal === undefined ? {} : { signal, timeoutMs: 15000 },
        );
    }

    /**
     * @param {any} project
     * @param {unknown} ref
     * @param {{ tools?: boolean, conversationId?: string, grant?: any }} options
     * @returns {string}
     */
    #ref(project, ref, options) {
        const grant = this.#toolGrant(options);
        const allowed = grant === null ? project.branches : grant.toolBranches;
        const kind = refKind(ref, allowed);
        if (kind === "invalid") throw new LayerfsRefusal(CODES.NotFound);
        return /** @type {string} */ ref;
    }

    /**
     * @param {{ tools?: boolean, conversationId?: string, grant?: any }} options
     * @returns {any | null}
     */
    #toolGrant(options) {
        if (options.tools !== true) return null;
        const grant = options.grant ?? sessionGrant(this.config, options.conversationId);
        if (grant === null || !grant.allowTools) throw new LayerfsRefusal(CODES.Forbidden);
        return grant;
    }

    /**
     * @param {{ tools?: boolean, conversationId?: string }} options
     * @returns {Record<string, unknown>}
     */
    #scope(options) {
        if (options.tools !== true) return { scope: "ui" };
        if (
            (typeof options.conversationId !== "string" &&
                typeof options.conversationId !== "number") ||
            String(options.conversationId).length === 0
        ) {
            throw new LayerfsRefusal(CODES.Forbidden);
        }
        return { scope: "tool", conversationId: String(options.conversationId) };
    }
}
