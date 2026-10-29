/**
 * The LayerFS Store adapter used only by the private service.
 *
 * It calls the pinned official SDK's public `project`, `branch`, and `fs`
 * methods. It never calls an internal operator seam, never mounts a
 * Workspace, never starts a Sandbox, and never runs Docker. A Commit id is
 * accepted only when it is reachable from an explicitly granted branch.
 */
import {
    assertAllowedBranch,
    assertForkSource,
    assertNewBranchName,
    projectGrant,
    sessionGrant,
    writeContext,
} from "../src/pocket-layerfs/auth.ts";
import { CODES, LayerfsRefusal } from "../src/pocket-layerfs/errors.ts";
import {
    isNodeId,
    isSensitiveName,
    isSensitivePath,
    normaliseDirectory,
    normalisePath,
    refKind,
} from "../src/pocket-layerfs/policy.ts";

const HISTORY_PAGE = 128;
const HISTORY_SCAN_PAGES = 20;
const MAX_HISTORY_PAGES = 40;

/**
 * A Store client is shared only when the whole identity matches: project,
 * Store path, and LayerFS home. A changed Store path gets a new client.
 *
 * @param {{ id: string, storePath: string }} project
 * @param {string} home
 */
export function clientKey(project, home) {
    return `${project.id}\u0000${project.storePath}\u0000${home}`;
}

export class Engine {
    /**
     * @param {{ config: any, LayerFS: any, upstream: { version: string, commit: string }, log: (line: string) => void, clients?: Map<string, any>, home?: string }} options
     */
    constructor({ config, LayerFS, upstream, log, clients, home }) {
        this.config = config;
        this.LayerFS = LayerFS;
        this.upstream = upstream;
        this.log = log;
        this.clients = clients ?? new Map();
        this.home = home ?? config.service.layerfsHome;
        this.startedAt = Date.now();
    }

    /**
     * @param {string} projectId
     * @returns {any}
     */
    #project(projectId) {
        return projectGrant(this.config, projectId);
    }

    /**
     * @param {any} project
     * @returns {any}
     */
    #client(project) {
        const key = clientKey(project, this.home);
        let client = this.clients.get(key);
        if (client === undefined) {
            client = new this.LayerFS(project.id, { storePath: project.storePath });
            this.clients.set(key, client);
        }
        return client;
    }

    /**
     * @param {unknown} scope
     * @param {unknown} conversationId
     * @param {any} project
     * @returns {readonly string[]}
     */
    #allowedBranches(scope, conversationId, project) {
        if (scope === "tool") {
            const grant = sessionGrant(this.config, conversationId);
            if (grant === null || !grant.allowTools) throw new LayerfsRefusal(CODES.Forbidden);
            if (grant.project !== project.id) throw new LayerfsRefusal(CODES.NotFound);
            return grant.toolBranches;
        }
        if (scope === "ui") return project.branches;
        throw new LayerfsRefusal(CODES.Invalid);
    }

    /**
     * @param {unknown} branch
     * @param {readonly string[]} allowed
     */
    #branch(branch, allowed) {
        return assertAllowedBranch(branch, allowed);
    }

    /**
     * @param {any} project
     * @returns {Promise<any[]>}
     */
    async #branches(project) {
        const client = this.#client(project);
        const items = [];
        let pos = 0;
        for (let page = 0; page < 40; page += 1) {
            const result = await client.project.list_branches(HISTORY_PAGE, pos);
            const pageItems = Array.isArray(result.items) ? result.items : [];
            items.push(...pageItems);
            if (result.hasMore !== true) break;
            pos = Number.isSafeInteger(result.nextPagePos)
                ? result.nextPagePos
                : pos + pageItems.length;
            if (pageItems.length === 0) break;
        }
        return items;
    }

    /**
     * @param {any} project
     * @param {string} name
     */
    async #branchItem(project, name) {
        const items = await this.#branches(project);
        return items.find((item) => item.name === name) ?? null;
    }

    /**
     * One page of a Branch's Commits. `main` is a line of Layers, not Commits;
     * the public SDK has no layer listing, so it answers with an empty page
     * and a note instead of inventing history.
     *
     * @param {any} project
     * @param {string} branch
     * @param {number} pageSize
     * @param {number} pagePos
     */
    async commits(project, branch, allowed, pageSize, pagePos) {
        this.#branch(branch, allowed);
        if (branch === "main") {
            return {
                items: [],
                hasMore: false,
                nextPagePos: null,
                note: "main is a line of Layers; commit history is per Branch",
            };
        }
        const client = this.#client(project);
        const result = await client.branch.list_commits(branch, pageSize, pagePos);
        return { ...result, items: Array.isArray(result.items) ? result.items : [] };
    }

    /**
     * Find a Commit in one explicit set of branches. The scan is bounded; a
     * Commit older than the bound is refused rather than guessed.
     *
     * @param {any} project
     * @param {string} commit
     * @param {readonly string[]} branches
     * @returns {Promise<{ branch: string, record: any } | null>}
     */
    async #findCommit(project, commit, branches) {
        for (const branch of branches) {
            if (branch === "main") continue;
            let pos = 0;
            for (let page = 0; page < HISTORY_SCAN_PAGES; page += 1) {
                const result = await this.commits(project, branch, branches, HISTORY_PAGE, pos);
                const items = Array.isArray(result.items) ? result.items : [];
                const found = items.find((item) => item.id === commit);
                if (found !== undefined) return { branch, record: found };
                if (result.hasMore !== true) break;
                pos = Number.isSafeInteger(result.nextPagePos)
                    ? result.nextPagePos
                    : pos + items.length;
                if (items.length === 0) break;
            }
        }
        return null;
    }

    /**
     * @param {any} project
     * @param {unknown} ref
     * @param {readonly string[]} allowed
     * @returns {Promise<{ ref: string, kind: "branch" | "commit", branch?: string }>}
     */
    async #ref(project, ref, allowed) {
        const kind = refKind(ref, allowed);
        if (kind === "invalid") throw new LayerfsRefusal(CODES.NotFound);
        if (kind === "branch") {
            this.#branch(ref, allowed);
            return { ref: /** @type {string} */ (ref), kind };
        }
        const found = await this.#findCommit(project, /** @type {string} */ (ref), allowed);
        if (found === null) throw new LayerfsRefusal(CODES.NotFound);
        return { ref: /** @type {string} */ (ref), kind, branch: found.branch };
    }

    /**
     * @param {any} project
     * @param {unknown} ref
     */
    async #stat(project, ref, path) {
        const client = this.#client(project);
        try {
            return await client.fs.stat(ref, path);
        } catch (error) {
            throw mapUpstream(error);
        }
    }

    /**
     * @param {any} project
     * @param {string} ref
     * @param {string} path
     */
    async #regularFile(project, ref, path) {
        const info = await this.#stat(project, ref, path);
        if (info.type !== "file") throw new LayerfsRefusal(CODES.NotFound);
        return info;
    }

    /**
     * @param {any} project
     * @param {string} ref
     * @param {string} path
     */
    async #directory(project, ref, path) {
        const info = await this.#stat(project, ref, path);
        if (info.type !== "dir") throw new LayerfsRefusal(CODES.NotFound);
        return info;
    }

    /** @param {any} project */
    async branches(project) {
        return { items: await this.#branches(project), hasMore: false, nextPagePos: null };
    }

    /**
     * @param {{ project: string, scope?: string, conversationId?: string }} args
     */
    async listBranches(args) {
        const project = this.#project(args.project);
        const allowed = this.#allowedBranches(args.scope ?? "ui", args.conversationId, project);
        const items = (await this.#branches(project)).filter((item) => allowed.includes(item.name));
        return { items, hasMore: false, nextPagePos: null };
    }

    /**
     * @param {{ project: string, branch: string, pageSize: number, pagePos: number, scope?: string, conversationId?: string }} args
     */
    async listCommits(args) {
        const project = this.#project(args.project);
        const allowed = this.#allowedBranches(args.scope ?? "ui", args.conversationId, project);
        return this.commits(project, args.branch, allowed, args.pageSize, args.pagePos);
    }

    /**
     * @param {{ project: string, commit: string, scope?: string, conversationId?: string }} args
     */
    async oneCommit(args) {
        const project = this.#project(args.project);
        const allowed = this.#allowedBranches(args.scope ?? "ui", args.conversationId, project);
        if (!isNodeId(args.commit)) throw new LayerfsRefusal(CODES.InvalidRef);
        const found = await this.#findCommit(project, args.commit, allowed);
        if (found === null) throw new LayerfsRefusal(CODES.NotFound);
        return { commit: found.record, branch: found.branch };
    }

    /**
     * @param {{ project: string, ref: string, path: string, pageSize: number, pagePos: number, scope?: string, conversationId?: string }} args
     */
    async tree(args) {
        const project = this.#project(args.project);
        const allowed = this.#allowedBranches(args.scope ?? "ui", args.conversationId, project);
        const ref = await this.#ref(project, args.ref, allowed);
        const path = normaliseDirectory(args.path);
        if (!path.ok) throw new LayerfsRefusal(path.code);
        await this.#directory(project, ref.ref, path.path);
        const client = this.#client(project);
        let result;
        try {
            result = await client.fs.list(ref.ref, path.path, args.pageSize, args.pagePos);
        } catch (error) {
            throw mapUpstream(error);
        }
        const items = [];
        let omitted = 0;
        for (const item of Array.isArray(result.items) ? result.items : []) {
            if (isSensitiveName(item.name) || item.type === "symlink") {
                omitted += 1;
                continue;
            }
            items.push(item);
        }
        return { ...result, items, omitted };
    }

    /**
     * @param {{ project: string, ref: string, path: string, startLine: number, endLine: number, scope?: string, conversationId?: string }} args
     */
    async read(args) {
        const project = this.#project(args.project);
        const allowed = this.#allowedBranches(args.scope ?? "ui", args.conversationId, project);
        const ref = await this.#ref(project, args.ref, allowed);
        const path = normalisePath(args.path);
        if (!path.ok) throw new LayerfsRefusal(path.code);
        await this.#regularFile(project, ref.ref, path.path);
        const client = this.#client(project);
        try {
            return await client.fs.read(ref.ref, path.path, args.startLine, args.endLine);
        } catch (error) {
            throw mapUpstream(error);
        }
    }

    /**
     * @param {{ project: string, ref: string, path: string, scope?: string, conversationId?: string }} args
     */
    async stat(args) {
        const project = this.#project(args.project);
        const allowed = this.#allowedBranches(args.scope ?? "ui", args.conversationId, project);
        const ref = await this.#ref(project, args.ref, allowed);
        const path = normalisePath(args.path);
        if (!path.ok) throw new LayerfsRefusal(path.code);
        const info = await this.#stat(project, ref.ref, path.path);
        if (info.type === "symlink") throw new LayerfsRefusal(CODES.NotFound);
        return info;
    }

    /**
     * @param {{ project: string, from: string, to: string, pageSize: number, pagePos: number, cursor?: string, hunks?: boolean, scope?: string, conversationId?: string }} args
     */
    async diff(args) {
        const project = this.#project(args.project);
        const allowed = this.#allowedBranches(args.scope ?? "ui", args.conversationId, project);
        const from = await this.#ref(project, args.from, allowed);
        const to = await this.#ref(project, args.to, allowed);
        const client = this.#client(project);
        const options = {
            ...(args.cursor ? { cursor: args.cursor } : {}),
            hunks: args.hunks !== false,
        };
        let result;
        try {
            if (from.kind === "branch" && to.kind === "branch") {
                result = await client.branch.diff_branches(
                    from.ref,
                    to.ref,
                    args.pageSize,
                    args.pagePos,
                    options,
                );
            } else if (from.kind === "commit" && to.kind === "commit") {
                result = await client.branch.diff_commits(
                    from.ref,
                    to.ref,
                    args.pageSize,
                    args.pagePos,
                    options,
                );
            } else {
                const branch = from.kind === "branch" ? from : to;
                const commit = from.kind === "commit" ? from : to;
                const item = await this.#branchItem(project, branch.ref);
                const head = item?.head ?? null;
                if (typeof head !== "string") throw new LayerfsRefusal(CODES.InvalidRef);
                result =
                    from.kind === "branch"
                        ? await client.branch.diff_commits(
                              head,
                              commit.ref,
                              args.pageSize,
                              args.pagePos,
                              options,
                          )
                        : await client.branch.diff_commits(
                              commit.ref,
                              head,
                              args.pageSize,
                              args.pagePos,
                              options,
                          );
            }
        } catch (error) {
            throw mapUpstream(error);
        }
        const items = [];
        let omitted = 0;
        for (const item of Array.isArray(result.items) ? result.items : []) {
            const path = normalisePath(item.path);
            if (
                !path.ok ||
                isSensitivePath(path.path) ||
                item.type === "symlink" ||
                item.before?.type === "symlink" ||
                item.after?.type === "symlink"
            ) {
                omitted += 1;
                continue;
            }
            items.push(item);
        }
        return { ...result, items, omitted };
    }

    /**
     * @param {{ project: string, ref: string, path: string, fromLine: number, scope?: string, conversationId?: string }} args
     */
    async blame(args) {
        const project = this.#project(args.project);
        const allowed = this.#allowedBranches(args.scope ?? "ui", args.conversationId, project);
        const ref = await this.#ref(project, args.ref, allowed);
        const path = normalisePath(args.path);
        if (!path.ok) throw new LayerfsRefusal(path.code);
        await this.#regularFile(project, ref.ref, path.path);
        const client = this.#client(project);
        try {
            return await client.fs.blame(ref.ref, path.path, args.fromLine);
        } catch (error) {
            throw mapUpstream(error);
        }
    }

    /**
     * A bounded per-file history: walk newest Commits, stat the path at each
     * Commit and its parent, and list the transitions. This is O(commits), not
     * a server-side index; the bound is explicit in the answer.
     *
     * @param {{ project: string, branch: string, path: string, maxCommits: number, scope?: string, conversationId?: string }} args
     */
    async fileHistory(args) {
        const project = this.#project(args.project);
        const allowed = this.#allowedBranches(args.scope ?? "ui", args.conversationId, project);
        const branch = this.#branch(args.branch, allowed);
        const path = normalisePath(args.path);
        if (!path.ok) throw new LayerfsRefusal(path.code);
        if (branch === "main") {
            return {
                items: [],
                scanned: 0,
                truncated: false,
                path: path.path,
                branch,
                note: "main is a line of Layers; commit history is per Branch",
            };
        }
        const commits = [];
        let more = false;
        let pos = 0;
        for (
            let page = 0;
            page < MAX_HISTORY_PAGES && commits.length < args.maxCommits + 1;
            page += 1
        ) {
            const result = await this.commits(project, branch, allowed, HISTORY_PAGE, pos);
            const items = Array.isArray(result.items) ? result.items : [];
            commits.push(...items);
            more = result.hasMore === true;
            if (!more) break;
            pos = Number.isSafeInteger(result.nextPagePos)
                ? result.nextPagePos
                : pos + items.length;
            if (items.length === 0) break;
        }
        const truncated = more || commits.length > args.maxCommits;
        const selected = commits.slice(0, args.maxCommits);
        const stats = new Map();
        const statAt = async (commit) => {
            if (stats.has(commit)) return stats.get(commit);
            let value = { info: null, symlink: false, missing: false };
            try {
                const info = await this.#stat(project, commit, path.path);
                value =
                    info.type === "symlink"
                        ? { info: null, symlink: true, missing: false }
                        : { info, symlink: false, missing: false };
            } catch (error) {
                if (!(error instanceof LayerfsRefusal) || error.code !== CODES.NotFound)
                    throw error;
                value = { info: null, symlink: false, missing: true };
            }
            stats.set(commit, value);
            return value;
        };
        const client = this.#client(project);
        const items = [];
        let omittedSymlink = false;
        let errors = 0;
        for (const commit of selected) {
            const current = await statAt(commit.id);
            const parentId = commit.parent ?? null;
            const parent =
                parentId === null
                    ? { info: null, symlink: false, missing: true }
                    : await statAt(parentId);
            if (current.symlink || parent.symlink) {
                omittedSymlink = true;
                continue;
            }
            let change;
            if (current.info !== null && parent.info === null) {
                change = "added";
            } else if (current.info === null && parent.info !== null) {
                change = "removed";
            } else if (current.info !== null && parent.info !== null) {
                // inode and size are a cheap fast path, never proof: a file can
                // be edited in place with the same length, or rewritten under
                // the same inode. Ask the SDK for a real content comparison.
                let contentEqual;
                try {
                    const diff = await client.fs.diff_files(
                        commit.id,
                        path.path,
                        parentId,
                        path.path,
                    );
                    contentEqual = diff.contentEqual === true;
                } catch (error) {
                    if (
                        error &&
                        typeof error === "object" &&
                        /** @type {any} */ (error).code === "NoSuchPath"
                    ) {
                        errors += 1;
                        continue;
                    }
                    errors += 1;
                    continue;
                }
                if (!contentEqual) change = "modified";
                else if (
                    current.info.inode !== parent.info.inode ||
                    current.info.size !== parent.info.size
                )
                    change = "metadata";
                else continue;
            } else {
                continue;
            }
            items.push({
                commit: commit.id,
                parent: parentId,
                message: commit.message ?? null,
                time: commit.time,
                via: commit.via,
                change,
                size: current.info?.size ?? parent.info?.size ?? null,
                inode: current.info?.inode ?? null,
                ...(change === "metadata"
                    ? { note: "same content; identity or size metadata changed" }
                    : {}),
            });
        }
        return {
            items,
            scanned: selected.length,
            truncated,
            errors,
            path: path.path,
            branch,
            ...(omittedSymlink ? { note: "a symlink version was omitted" } : {}),
        };
    }

    /**
     * Validate a fork source and read its exact current head. No write.
     *
     * @param {{ project: string, sourceBranch: string, fromRef?: string, conversationId: string }} args
     */
    async forkPlan(args) {
        if (typeof args.newBranch !== "string" || args.newBranch.length === 0)
            throw new LayerfsRefusal(CODES.InvalidRef);
        const { grant, project } = writeContext(this.config, args.conversationId, args.project);
        const source = assertForkSource(grant, project, args.sourceBranch);
        const item = await this.#branchItem(project, source);
        if (item === null) throw new LayerfsRefusal(CODES.NotFound);
        const sourceHead = item.head ?? item.base ?? "";
        if (!isNodeId(sourceHead)) throw new LayerfsRefusal(CODES.Upstream);
        let fromRef = source;
        let fromLabel = source;
        if (args.fromRef !== undefined && args.fromRef !== null) {
            if (args.fromRef === source) {
                fromRef = source;
                fromLabel = source;
            } else if (isNodeId(args.fromRef)) {
                const found = await this.#findCommit(project, args.fromRef, [source]);
                if (found === null) throw new LayerfsRefusal(CODES.NotFound);
                fromRef = args.fromRef;
                fromLabel = `${source}@${args.fromRef.slice(0, 12)}…`;
            } else {
                throw new LayerfsRefusal(CODES.InvalidRef);
            }
        }
        const items = await this.#branches(project);
        const targetExists = items.some((branch) => branch.name === args.newBranch);
        return {
            project: project.id,
            sourceBranch: source,
            sourceHead,
            expectedHead: sourceHead,
            fromRef,
            fromLabel,
            targetBranch: args.newBranch,
            targetExists,
        };
    }

    /**
     * Create one real Branch with `branch.fork`, at the exact node the owner
     * previewed. There is no forced Commit and no simulated recovery point.
     *
     * @param {{ project: string, sourceBranch: string, fromRef: string, newBranch: string, expectedHead: string, conversationId: string }} args
     */
    async forkCommit(args) {
        const { grant, project } = writeContext(this.config, args.conversationId, args.project);
        const source = assertForkSource(grant, project, args.sourceBranch);
        const target = assertNewBranchName(grant, args.newBranch);
        const plan = await this.forkPlan({
            project: project.id,
            sourceBranch: source,
            fromRef: args.fromRef,
            newBranch: target,
            conversationId: args.conversationId,
        });
        if (plan.expectedHead !== args.expectedHead) throw new LayerfsRefusal(CODES.HeadMoved);
        if (plan.targetExists) throw new LayerfsRefusal(CODES.NameTaken);
        // Fork the exact approved node, not a branch name that another writer
        // could move between the check and the call. A branch preview is bound
        // to its head; a commit preview is bound to that commit.
        const forkFrom = isNodeId(args.fromRef) ? args.fromRef : plan.expectedHead;
        const client = this.#client(project);
        try {
            const result = await client.branch.fork(target, forkFrom);
            return { ...result, project: project.id, fromRef: forkFrom };
        } catch (error) {
            throw mapUpstream(error);
        }
    }

    /**
     * @param {{ version: string, commit: string }} upstream
     */
    ping(upstream) {
        return {
            version: "0.1.0",
            upstreamVersion: upstream.version,
            upstreamCommit: upstream.commit,
            startedAt: this.startedAt,
            projects: this.config.projects.map((project) => project.id),
        };
    }

    /** Close every Store client this service opened. */
    async close() {
        for (const client of this.clients.values()) {
            try {
                await client.close();
            } catch {
                // A close failure does not change the service's shutdown.
            }
        }
        this.clients.clear();
    }
}

/**
 * @param {unknown} error
 * @returns {LayerfsRefusal}
 */
function mapUpstream(error) {
    if (error instanceof LayerfsRefusal) return error;
    const code = error && typeof error === "object" ? /** @type {any} */ (error).code : undefined;
    switch (code) {
        case "NoSuchPath":
        case "NoSuchBranch":
        case "NoSuchCommit":
        case "NoSuchProject":
        case "NoCommit":
        case "NoStore":
            return new LayerfsRefusal(CODES.NotFound);
        case "HeadMoved":
            return new LayerfsRefusal(CODES.HeadMoved);
        case "Conflict":
            return new LayerfsRefusal(CODES.Conflict);
        case "NameTaken":
            return new LayerfsRefusal(CODES.NameTaken);
        case "Busy":
            return new LayerfsRefusal(CODES.Busy);
        case "InvalidInput":
            return new LayerfsRefusal(CODES.Invalid);
        case "Unsupported":
            return new LayerfsRefusal(CODES.Unsupported);
        case "TooLarge":
        case "Capacity":
            return new LayerfsRefusal(CODES.ResponseTooLarge);
        default:
            return new LayerfsRefusal(CODES.Upstream);
    }
}
