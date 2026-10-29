/**
 * Shared, pure policy for the Pi Pocket LayerFS plugin and its private service.
 *
 * This file is deliberately dependency-free: it is imported by the drop-in
 * server module, the private Unix-socket service, and therefore must not read
 * files, environment variables, or network state. Keep every check here
 * deterministic so the same input is accepted or refused on both sides of the
 * socket.
 */

/** The longest path accepted, in UTF-8 bytes, after normalisation. */
export const MAX_PATH_BYTES = 4096;
/** The most path segments accepted. */
export const MAX_PATH_SEGMENTS = 128;
/** The longest one path segment accepted. */
export const MAX_SEGMENT_BYTES = 255;
/** The longest allowed project or branch name accepted by the SDK. */
export const MAX_NAME_BYTES = 63;
/** Page sizes are clamped to this upper bound before any SDK call. */
export const MAX_PAGE_SIZE = 200;
/** The largest line window the SDK returns in one call. */
export const SDK_MAX_LINES = 2000;
/** The largest file window the SDK returns in one call. */
export const SDK_MAX_BYTES = 48 * 1024;
/** The default number of bytes a tool result may carry. */
export const DEFAULT_TOOL_BYTES = 32 * 1024;
/** The default service response budget. */
export const DEFAULT_RESPONSE_BYTES = 512 * 1024;
/** The longest commit message shown in a bounded listing, in characters. */
export const MAX_MESSAGE_CHARS = 500;

/**
 * Names and suffixes that are never listed, read, blamed, diffed, or used in
 * a path. Matching is case-insensitive and applies to every path segment.
 * This is intentionally not configurable in v1: an owner who needs a file
 * must place it in a project that does not need a sensitive exemption.
 */
const SENSITIVE_SEGMENTS = new Set([
    ".git",
    ".env",
    ".ssh",
    ".aws",
    ".gnupg",
    ".npmrc",
    ".netrc",
    ".pnpm-store",
    ".cache",
    ".pi-pocket",
    "node_modules",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "credentials",
    "secrets",
]);

const SENSITIVE_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".sqlite", ".sqlite3", ".db", ".kdbx"];

/**
 * Whether one path segment is reserved, secret-bearing, a cache, or a
 * session store. A `.git` file (a worktree pointer) is refused as a name too.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isSensitiveName(name) {
    if (typeof name !== "string" || name.length === 0) return true;
    const lower = name.toLowerCase();
    if (SENSITIVE_SEGMENTS.has(lower)) return true;
    if (lower.startsWith(".env.") || lower.startsWith(".env-")) return true;
    return SENSITIVE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * Whether any segment of an already-normalised absolute path is sensitive.
 *
 * @param {string} path
 * @returns {boolean}
 */
export function isSensitivePath(path) {
    return splitPath(path).some(isSensitiveName);
}

/**
 * Split a normalised absolute path into its non-root segments.
 *
 * @param {string} path
 * @returns {string[]}
 */
export function splitPath(path) {
    return path.split("/").filter((segment) => segment.length > 0);
}

/**
 * Join a directory path and a child name, keeping one leading slash.
 *
 * @param {string} parent
 * @param {string} name
 * @returns {string}
 */
export function joinPath(parent, name) {
    const base = parent === "/" ? "" : parent.replace(/\/+$/, "");
    return `${base}/${name}`;
}

/**
 * A `..` or `.` segment, a backslash, a NUL, or another control character can
 * never make a valid LayerFS path here.
 *
 * @param {string} segment
 * @returns {boolean}
 */
function badSegment(segment) {
    if (segment === "." || segment === "..") return true;
    if (Buffer.byteLength(segment, "utf8") > MAX_SEGMENT_BYTES) return true;
    for (const character of segment) {
        const code = character.codePointAt(0) ?? 0;
        if (code < 0x20 || code === 0x7f) return true;
        if (character === "\\") return true;
    }
    return false;
}

/**
 * Normalise one untrusted absolute path.
 *
 * The result is a canonical absolute path with no trailing slash, no `.` or
 * `..`, no empty middle segment, and no sensitive segment. A refusal carries
 * a stable code but no path in its message, so it can be shown to a person
 * without revealing whether a name exists.
 *
 * @param {unknown} input
 * @returns {{ ok: true, path: string } | { ok: false, code: string }}
 */
export function normalisePath(input) {
    if (typeof input !== "string") return { ok: false, code: "InvalidPath" };
    if (input.length === 0) return { ok: true, path: "/" };
    if (!input.startsWith("/")) return { ok: false, code: "InvalidPath" };
    if (input.includes("\0") || input.includes("\\")) return { ok: false, code: "InvalidPath" };
    if (Buffer.byteLength(input, "utf8") > MAX_PATH_BYTES)
        return { ok: false, code: "InvalidPath" };

    const segments = input.split("/").filter((segment) => segment.length > 0);
    if (segments.length > MAX_PATH_SEGMENTS) return { ok: false, code: "InvalidPath" };
    for (const segment of segments) {
        if (badSegment(segment)) return { ok: false, code: "InvalidPath" };
        if (isSensitiveName(segment)) return { ok: false, code: "NotFound" };
    }

    return { ok: true, path: segments.length === 0 ? "/" : `/${segments.join("/")}` };
}

/**
 * A parent directory for a listing request. `/` remains `/`.
 *
 * @param {unknown} input
 * @returns {{ ok: true, path: string } | { ok: false, code: string }}
 */
export function normaliseDirectory(input) {
    return normalisePath(input === undefined || input === null ? "/" : input);
}

/**
 * The SDK's history-name grammar: 1..63 ASCII bytes, lowercase letters,
 * digits, dot, underscore, hyphen, beginning and ending alphanumeric.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isHistoryName(name) {
    if (typeof name !== "string") return false;
    const bytes = Buffer.byteLength(name, "utf8");
    if (bytes < 1 || bytes > MAX_NAME_BYTES) return false;
    if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(name)) return false;
    return true;
}

/**
 * A project id is an SDK project name and must be an allowed history name.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isProjectName(name) {
    return isHistoryName(name);
}

/**
 * A branch name is an SDK history name other than the reserved `main` line.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isBranchName(name) {
    return isHistoryName(name) && name !== "main";
}

/**
 * A Commit or Layer identity is exactly 66 hex characters: a one-byte tag
 * followed by 32 bytes of authority-local identity.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isNodeId(value) {
    return typeof value === "string" && /^[0-9a-f]{66}$/.test(value);
}

/**
 * Whether a ref names a branch (`main` or an allowed branch) or a node id.
 *
 * @param {unknown} ref
 * @param {readonly string[]} allowedBranches
 * @returns {"branch" | "commit" | "invalid"}
 */
export function refKind(ref, allowedBranches) {
    if (typeof ref !== "string") return "invalid";
    // `main` is not a wildcard: a project that has not granted `main` must
    // refuse it exactly like any other unlisted branch.
    if (allowedBranches.includes(ref)) return "branch";
    if (isNodeId(ref)) return "commit";
    return "invalid";
}

/**
 * Clamp an untrusted page size to the policy bound.
 *
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
export function clampPageSize(value, fallback = 50) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1) return fallback;
    return Math.min(number, MAX_PAGE_SIZE);
}

/**
 * Clamp an untrusted page position to a non-negative safe integer.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function clampPagePos(value) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) return 0;
    return Math.min(number, Number.MAX_SAFE_INTEGER);
}

/**
 * Clamp an untrusted line number to the SDK's positive safe-integer range.
 *
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
export function clampLine(value, fallback = 1) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1) return fallback;
    return Math.min(number, Number.MAX_SAFE_INTEGER);
}

/**
 * Clamp a commit-history scan bound.
 *
 * @param {unknown} value
 * @param {number} [fallback]
 * @returns {number}
 */
export function clampHistoryScan(value, fallback = 50) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1) return fallback;
    return Math.min(number, 200);
}

/**
 * Clamp a line window so one SDK read cannot ask for more than it returns.
 *
 * @param {number} startLine
 * @param {number} [endLine]
 * @returns {{ startLine: number, endLine: number }}
 */
export function clampLineWindow(startLine, endLine) {
    const start = clampLine(startLine, 1);
    const requested =
        endLine === undefined || endLine === null
            ? Number.MAX_SAFE_INTEGER
            : clampLine(endLine, start);
    const bounded = Math.min(requested, start + SDK_MAX_LINES - 1, Number.MAX_SAFE_INTEGER);
    return { startLine: start, endLine: Math.max(start, bounded) };
}

/**
 * Whether text should be refused as a tool result before it reaches a model.
 *
 * @param {unknown} text
 * @param {number} maxBytes
 * @returns {boolean}
 */
export function exceedsBytes(text, maxBytes) {
    return Buffer.byteLength(String(text), "utf8") > maxBytes;
}

/**
 * A short, non-secret identifier for logs. It never returns a full node id.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function shortId(value) {
    const text = typeof value === "string" ? value : "";
    if (text.length <= 12) return text;
    return `${text.slice(0, 12)}…`;
}
