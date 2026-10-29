/**
 * Turn a small, browser-supplied draft into the full config candidate.
 *
 * The browser selects known projects, labels, allowed existing branches, the
 * read-only tools switch, and explicit conversation grants. It cannot set the
 * service block, owner ids, Store paths, origins, write policy, or fork policy.
 */
import { validateConfig } from "./config.ts";
import { isBranchName, isProjectName } from "./policy.ts";

const DRAFT_KEYS = new Set(["projects", "toolsEnabled", "sessionGrants"]);
const PROJECT_KEYS = new Set(["id", "label", "branches"]);
const GRANT_KEYS = new Set(["conversationId", "project", "allowTools", "toolBranches"]);
const MAX_PROJECTS = 50;
const MAX_GRANTS = 100;

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {any[]} errors
 * @param {number} max
 */
function nameList(value, field, errors, max = 64) {
    if (!Array.isArray(value) || value.length === 0 || value.length > max) {
        errors.push({ field, code: "list", message: `${field} needs 1 to ${max} entries.` });
        return [];
    }
    const out = [];
    for (const entry of value) {
        if (typeof entry !== "string" || entry.length === 0 || entry.length > 63) {
            errors.push({ field, code: "name", message: `${field} has an invalid name.` });
            continue;
        }
        if (entry !== "main" && !isBranchName(entry)) {
            errors.push({ field, code: "name", message: `${field} has an invalid branch name.` });
            continue;
        }
        if (!out.includes(entry)) out.push(entry);
    }
    return out;
}

/**
 * Check the shape of the browser draft. Unknown or privileged fields are an
 * error, never silently dropped.
 *
 * @param {unknown} raw
 */
export function parseDraft(raw) {
    /** @type {{ field: string, code: string, message: string }[]} */
    const errors = [];
    if (!isObject(raw)) {
        return { errors: [{ field: "draft", code: "shape", message: "draft must be an object." }] };
    }
    for (const key of Object.keys(raw)) {
        if (!DRAFT_KEYS.has(key)) {
            errors.push({ field: key, code: "unknown", message: `draft.${key} is not editable.` });
        }
    }
    if (typeof raw.toolsEnabled !== "boolean")
        errors.push({
            field: "toolsEnabled",
            code: "type",
            message: "toolsEnabled must be true or false.",
        });

    const projects = [];
    if (!Array.isArray(raw.projects) || raw.projects.length > MAX_PROJECTS) {
        errors.push({
            field: "projects",
            code: "list",
            message: `projects must have 0 to ${MAX_PROJECTS} entries.`,
        });
    } else {
        raw.projects.forEach((entry, index) => {
            if (!isObject(entry)) {
                errors.push({
                    field: `projects[${index}]`,
                    code: "shape",
                    message: "Each project must be an object.",
                });
                return;
            }
            for (const key of Object.keys(entry)) {
                if (!PROJECT_KEYS.has(key))
                    errors.push({
                        field: `projects[${index}].${key}`,
                        code: "unknown",
                        message: `projects[${index}].${key} is not editable.`,
                    });
            }
            if (typeof entry.id !== "string" || !isProjectName(entry.id)) {
                errors.push({
                    field: `projects[${index}].id`,
                    code: "id",
                    message: "Project id is not valid.",
                });
                return;
            }
            const label = typeof entry.label === "string" ? entry.label.trim() : "";
            if (label.length === 0 || label.length > 80)
                errors.push({
                    field: `projects[${index}].label`,
                    code: "label",
                    message: "Label needs 1 to 80 characters.",
                });
            const branches = nameList(entry.branches, `projects[${index}].branches`, errors);
            projects.push({ id: entry.id, label, branches });
        });
    }

    const grants = [];
    if (!Array.isArray(raw.sessionGrants) || raw.sessionGrants.length > MAX_GRANTS) {
        errors.push({
            field: "sessionGrants",
            code: "list",
            message: `sessionGrants must have 0 to ${MAX_GRANTS} entries.`,
        });
    } else {
        raw.sessionGrants.forEach((entry, index) => {
            const field = `sessionGrants[${index}]`;
            if (!isObject(entry)) {
                errors.push({ field, code: "shape", message: "Each grant must be an object." });
                return;
            }
            for (const key of Object.keys(entry)) {
                if (!GRANT_KEYS.has(key))
                    errors.push({
                        field: `${field}.${key}`,
                        code: "unknown",
                        message: `${field}.${key} is not editable.`,
                    });
            }
            const conversationId = entry.conversationId;
            if (
                typeof conversationId !== "string" ||
                conversationId.length === 0 ||
                conversationId.length > 200
            )
                errors.push({
                    field: `${field}.conversationId`,
                    code: "session",
                    message: "Choose a conversation.",
                });
            if (typeof entry.project !== "string" || !isProjectName(entry.project))
                errors.push({
                    field: `${field}.project`,
                    code: "project",
                    message: "Choose a project.",
                });
            if (typeof entry.allowTools !== "boolean")
                errors.push({
                    field: `${field}.allowTools`,
                    code: "type",
                    message: "allowTools must be true or false.",
                });
            const toolBranches = nameList(
                entry.toolBranches ?? [],
                `${field}.toolBranches`,
                errors,
                64,
            );
            grants.push({
                conversationId: typeof conversationId === "string" ? conversationId : "",
                project: typeof entry.project === "string" ? entry.project : "",
                allowTools: entry.allowTools === true,
                toolBranches,
            });
        });
    }
    return {
        errors,
        draft: {
            projects,
            toolsEnabled: raw.toolsEnabled === true,
            sessionGrants: grants,
        },
    };
}

/**
 * @param {any} current
 * @param {any} draft
 * @param {Set<string>} sessionIds
 * @param {(projectId: string) => string[] | null} existingBranches
 * @param {{ version: number, stores: any[] }} registry
 */
export function buildCandidate({ current, draft, sessionIds, existingBranches, registry }) {
    /** @type {{ field: string, code: string, message: string }[]} */
    const errors = [];
    const byId = new Map(current.projects.map((project) => [project.id, project]));
    const imported = new Map<string, any>(registry.stores.map((store) => [store.projectId, store]));
    const projects = [];
    const seen = new Set();

    for (const entry of draft.projects) {
        if (seen.has(entry.id)) {
            errors.push({
                field: `projects.${entry.id}`,
                code: "duplicate",
                message: "Each project may appear once.",
            });
            continue;
        }
        seen.add(entry.id);
        const known = byId.get(entry.id) as any;
        if (known !== undefined) {
            const available = existingBranches(entry.id);
            if (available === null) {
                errors.push({
                    field: `projects.${entry.id}.branches`,
                    code: "service",
                    message: "The service is not reachable; branches cannot be checked.",
                });
            } else {
                for (const branch of entry.branches) {
                    if (!available.includes(branch))
                        errors.push({
                            field: `projects.${entry.id}.branches`,
                            code: "branch",
                            message: `Branch ${branch} does not exist in this Store.`,
                        });
                }
            }
            const forkSources = current.sessionGrants
                .filter((grant) => grant.project === entry.id)
                .flatMap((grant) => grant.fork.sources);
            for (const source of forkSources) {
                if (!entry.branches.includes(source))
                    errors.push({
                        field: `projects.${entry.id}.branches`,
                        code: "fork",
                        message: `Branch ${source} is used by an existing fork grant. Keep it.`,
                    });
            }
            projects.push({
                id: known.id,
                label: entry.label,
                origin: known.origin ?? "owner",
                storePath: known.storePath,
                branches: entry.branches,
            });
            continue;
        }
        const store = imported.get(entry.id) as any;
        if (store === undefined || store.state !== "unpublished-ready") {
            errors.push({
                field: `projects.${entry.id}`,
                code: "unknown",
                message: "Import this project first.",
            });
            continue;
        }
        for (const branch of entry.branches) {
            if (!store.branches.includes(branch))
                errors.push({
                    field: `projects.${entry.id}.branches`,
                    code: "branch",
                    message: `Branch ${branch} is not in the imported Store.`,
                });
        }
        projects.push({
            id: store.projectId,
            label: entry.label,
            origin: store.origin,
            storePath: store.storePath,
            branches: entry.branches,
        });
    }
    for (const project of current.projects) {
        if (!seen.has(project.id))
            errors.push({
                field: `projects.${project.id}`,
                code: "missing",
                message: "Every configured project must stay in the list.",
            });
    }

    const projectIds = new Set(projects.map((project) => project.id));
    const branchesOf = new Map(projects.map((project) => [project.id, project.branches]));
    const grants = [];
    const conversations = new Set();
    for (const [index, grant] of draft.sessionGrants.entries()) {
        const field = `sessionGrants[${index}]`;
        if (!sessionIds.has(grant.conversationId))
            errors.push({
                field: `${field}.conversationId`,
                code: "session",
                message: "The conversation is not in your current session list.",
            });
        if (conversations.has(grant.conversationId))
            errors.push({
                field: `${field}.conversationId`,
                code: "duplicate",
                message: "One grant per conversation.",
            });
        conversations.add(grant.conversationId);
        if (!projectIds.has(grant.project))
            errors.push({
                field: `${field}.project`,
                code: "project",
                message: "Choose a configured project.",
            });
        const allowed = branchesOf.get(grant.project) ?? [];
        for (const branch of grant.toolBranches) {
            if (!allowed.includes(branch))
                errors.push({
                    field: `${field}.toolBranches`,
                    code: "branch",
                    message: "Tool branches must be project branches.",
                });
        }
        if (grant.allowTools && grant.toolBranches.length === 0)
            errors.push({
                field: `${field}.toolBranches`,
                code: "empty",
                message: "Tools need at least one branch.",
            });
        const previous = current.sessionGrants.find(
            (entry) => entry.conversationId === grant.conversationId,
        );
        grants.push({
            conversationId: grant.conversationId,
            project: grant.project,
            allowTools: grant.allowTools,
            toolBranches: grant.toolBranches,
            fork:
                previous === undefined
                    ? { enabled: false, sources: [], namePrefix: "recovery-" }
                    : {
                          enabled: previous.fork.enabled,
                          sources: previous.fork.sources,
                          namePrefix: previous.fork.namePrefix,
                      },
        });
    }

    const candidate = {
        version: current.version,
        ownerPersonIds: current.ownerPersonIds,
        service: current.service,
        tools: { enabled: draft.toolsEnabled, maxBytes: current.tools.maxBytes },
        write: { enabled: current.write.enabled, ticketTtlMs: current.write.ticketTtlMs },
        projects,
        sessionGrants: grants,
    };

    if (errors.length === 0) {
        try {
            validateConfig(candidate);
        } catch (error) {
            errors.push({
                field: "config",
                code: "invalid",
                message: error instanceof Error ? error.message : "The configuration is not valid.",
            });
        }
    }
    return { candidate, errors };
}

/**
 * The safe draft shown in the GUI.
 *
 * @param {any} config
 */
export function draftFromConfig(config) {
    return {
        projects: config.projects.map((project) => ({
            id: project.id,
            label: project.label,
            branches: [...project.branches],
        })),
        toolsEnabled: config.tools.enabled,
        sessionGrants: config.sessionGrants.map((grant) => ({
            conversationId: grant.conversationId,
            project: grant.project,
            allowTools: grant.allowTools,
            toolBranches: [...grant.toolBranches],
        })),
    };
}
