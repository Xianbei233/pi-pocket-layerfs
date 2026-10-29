/**
 * Who may read, use a tool, or make an internal recovery branch.
 *
 * A route uses the signed-in person's role (`owner`) and, when configured,
 * their id. A tool uses the current task requester from
 * `host.requesterOf(api.conversationId)`, compared with the owner ids in the
 * plugin's own config, and then the one explicit session grant for that exact
 * conversation. An empty `sessionGrants` list denies every tool and write.
 */
import { CODES, LayerfsRefusal } from "./errors.ts";
import { isBranchName } from "./policy.ts";

/**
 * Resolve the owner and the one session grant for a tool call.
 *
 * @param {object} args
 * @param {any} args.config
 * @param {{ requesterOf: (conversationId: string) => string | undefined }} args.host
 * @param {string} args.conversationId
 * @returns {{ ownerId: string, grant: any, project: any }}
 */
export function toolContext({ config, host, conversationId }) {
    if (config === null || config === undefined) throw new LayerfsRefusal(CODES.NotConfigured);
    if (!config.tools.enabled) throw new LayerfsRefusal(CODES.ToolsDisabled);
    if (config.ownerPersonIds.length === 0) throw new LayerfsRefusal(CODES.NotConfigured);

    const requester = host.requesterOf(conversationId);
    if (typeof requester !== "string" || requester.length === 0)
        throw new LayerfsRefusal(CODES.Forbidden);
    if (!config.ownerPersonIds.includes(requester)) throw new LayerfsRefusal(CODES.Forbidden);

    const grant = sessionGrant(config, conversationId);
    if (grant === null || !grant.allowTools || grant.toolBranches.length === 0)
        throw new LayerfsRefusal(CODES.Forbidden);
    const project = projectGrant(config, grant.project);
    return { ownerId: requester, grant, project };
}

/**
 * The one grant for an exact conversation, or null. There is no fallback to
 * "all conversations" and no Cartesian product with the project list.
 *
 * @param {any} config
 * @param {unknown} conversationId
 * @returns {any | null}
 */
export function sessionGrant(config, conversationId) {
    if (config === null || config === undefined) return null;
    const id = String(conversationId ?? "");
    if (id.length === 0) return null;
    return config.sessionGrants.find((grant) => grant.conversationId === id) ?? null;
}

/**
 * The write grant for an exact conversation, or a refusal. The route's
 * `access: "owner"` and `conversationRoute` binding are checked first.
 *
 * @param {any} config
 * @param {unknown} conversationId
 * @param {unknown} projectId
 * @returns {{ grant: any, project: any }}
 */
export function writeContext(config, conversationId, projectId) {
    if (config === null || config === undefined) throw new LayerfsRefusal(CODES.NotConfigured);
    if (!config.write.enabled) throw new LayerfsRefusal(CODES.WriteDisabled);
    if (config.ownerPersonIds.length === 0) throw new LayerfsRefusal(CODES.NotConfigured);
    const grant = sessionGrant(config, conversationId);
    if (grant === null || !grant.fork.enabled) throw new LayerfsRefusal(CODES.WriteDisabled);
    if (grant.project !== projectId) throw new LayerfsRefusal(CODES.NotFound);
    const project = projectGrant(config, grant.project);
    return { grant, project };
}

/**
 * Whether a browser request is from the configured owner. The route's
 * `access: "owner"` already checks the role; this adds the explicit owner id
 * when the config names one.
 *
 * @param {{ user: { id: string, role: string } }} request
 * @param {any} config
 * @returns {boolean}
 */
export function isOwnerRequest(request, config) {
    if (config === null || config === undefined) return false;
    if (request.user.role !== "owner") return false;
    if (config.ownerPersonIds.length === 0) return true;
    return config.ownerPersonIds.includes(request.user.id);
}

/**
 * The project grant, by exact id.
 *
 * @param {any} config
 * @param {unknown} projectId
 * @returns {any}
 */
export function projectGrant(config, projectId) {
    if (config === null || config === undefined) throw new LayerfsRefusal(CODES.NotConfigured);
    if (typeof projectId !== "string" || projectId.length === 0)
        throw new LayerfsRefusal(CODES.NotFound);
    const project = config.projects.find((entry) => entry.id === projectId);
    if (project === undefined) throw new LayerfsRefusal(CODES.NotFound);
    return project;
}

/**
 * Check that a branch is inside one explicit allowed list. `main` is not a
 * wildcard: it must be listed just like every other branch.
 *
 * @param {unknown} branch
 * @param {readonly string[]} allowed
 * @returns {string}
 */
export function assertAllowedBranch(branch, allowed) {
    if (typeof branch !== "string" || !allowed.includes(branch))
        throw new LayerfsRefusal(CODES.NotFound);
    if (branch !== "main" && !isBranchName(branch)) throw new LayerfsRefusal(CODES.NotFound);
    return branch;
}

/**
 * The readable branches for the owner's UI: the project's explicit list.
 *
 * @param {any} project
 * @param {unknown} branch
 * @returns {string}
 */
export function assertReadableBranch(project, branch) {
    return assertAllowedBranch(branch, project.branches);
}

/**
 * The readable branches for a tool: only the session grant's tool branches.
 *
 * @param {any} grant
 * @param {unknown} branch
 * @returns {string}
 */
export function assertToolBranch(grant, branch) {
    return assertAllowedBranch(branch, grant.toolBranches);
}

/**
 * Check that a source branch is readable and explicitly allowed as a fork
 * source by the same session grant.
 *
 * @param {any} grant
 * @param {any} project
 * @param {unknown} sourceBranch
 * @returns {string}
 */
export function assertForkSource(grant, project, sourceBranch) {
    if (!grant.fork.enabled) throw new LayerfsRefusal(CODES.WriteDisabled);
    const branch = assertReadableBranch(project, sourceBranch);
    if (!grant.fork.sources.includes(branch)) throw new LayerfsRefusal(CODES.Forbidden);
    return branch;
}

/**
 * Check a proposed new branch name against the grant's prefix. The prefix is
 * a prefix, so it may end with `-`; the complete name still has to satisfy the
 * SDK's history-name grammar and start with the prefix.
 *
 * @param {any} grant
 * @param {unknown} newBranch
 * @returns {string}
 */
export function assertNewBranchName(grant, newBranch) {
    if (typeof newBranch !== "string" || !isBranchName(newBranch))
        throw new LayerfsRefusal(CODES.InvalidRef);
    if (!newBranch.startsWith(grant.fork.namePrefix)) throw new LayerfsRefusal(CODES.Forbidden);
    return newBranch;
}

/**
 * Check that a person id is one of the configured owners. Used by the write
 * route after the route's own owner check.
 *
 * @param {any} config
 * @param {unknown} personId
 * @returns {string}
 */
export function assertOwnerPerson(config, personId) {
    if (typeof personId !== "string" || personId.length === 0)
        throw new LayerfsRefusal(CODES.Unauthorized);
    if (config.ownerPersonIds.length === 0) throw new LayerfsRefusal(CODES.NotConfigured);
    if (!config.ownerPersonIds.includes(personId)) throw new LayerfsRefusal(CODES.Forbidden);
    return personId;
}
