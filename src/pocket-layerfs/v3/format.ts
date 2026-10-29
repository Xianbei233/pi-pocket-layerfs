/**
 * Rendering LayerFS data for a model and for the browser.
 *
 * Everything a model receives is fenced in a tag of our own, after
 * `host.text.defang`, and labelled as untrusted data. The browser uses text
 * nodes; it never sets HTML from a file, commit message, path, or diff.
 */
import { DEFAULT_TOOL_BYTES, MAX_MESSAGE_CHARS, shortId } from "./policy.ts";

export const DATA_TAG = "layerfs-data";

/**
 * A safe attribute value: an allowlist, not escaping. It cannot close the tag.
 *
 * @param {unknown} value
 * @param {number} [max]
 */
export function attr(value, max = 160) {
    const text = String(value ?? "")
        .replace(/[^A-Za-z0-9._:@/+-]/g, "?")
        .slice(0, max);
    return text.length === 0 ? "?" : text;
}

/**
 * A fallback only for a test host that does not provide `host.text`. It keeps
 * lines and removes a closing tag and control characters. Production always
 * uses `host.text.defang`.
 *
 * @param {string} text
 */
function fallbackDefang(text) {
    return text
        .replaceAll(`</${DATA_TAG}`, "")
        .replaceAll(`<${DATA_TAG}`, "")
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

/**
 * @param {{ text?: { defang?: (text: string) => string } }} host
 * @param {unknown} text
 */
export function defang(host, text) {
    const value = String(text ?? "");
    if (typeof host?.text?.defang === "function") return host.text.defang(value);
    return fallbackDefang(value);
}

/**
 * Cut a string to a UTF-8 byte budget without splitting a character.
 *
 * @param {unknown} text
 * @param {number} maxBytes
 * @returns {{ text: string, truncated: boolean }}
 */
export function clipBytes(text, maxBytes) {
    const value = String(text ?? "");
    if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
    if (maxBytes < 3) return { text: "", truncated: true };
    let kept = "";
    let bytes = 0;
    for (const character of value) {
        const size = Buffer.byteLength(character, "utf8");
        if (bytes + size + 3 > maxBytes) break;
        kept += character;
        bytes += size;
    }
    return { text: `${kept}…`, truncated: true };
}

/**
 * Fence data for the model. The metadata is safe ASCII; the body is defanged
 * and cut to `maxBytes`.
 *
 * @param {{ text?: { defang?: (text: string) => string } }} host
 * @param {unknown} body
 * @param {Record<string, unknown>} [meta]
 * @param {number} [maxBytes]
 */
export function fence(host, body, meta = {}, maxBytes = DEFAULT_TOOL_BYTES) {
    const clipped = clipBytes(body, maxBytes);
    const attributes = Object.entries(meta)
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .map(([name, value]) => `${attr(name, 32)}="${attr(value)}"`)
        .join(" ");
    const head =
        attributes.length === 0
            ? `<${DATA_TAG} trust="untrusted">`
            : `<${DATA_TAG} trust="untrusted" ${attributes}>`;
    const note = clipped.truncated ? "\n[layerfs: output cut at the tool byte limit]" : "";
    return `${head}\n${defang(host, clipped.text)}${note}\n</${DATA_TAG}>`;
}

/**
 * A Pi Durable tool result whose only content is fenced data.
 *
 * @param {{ text?: { defang?: (text: string) => string } }} host
 * @param {unknown} body
 * @param {Record<string, unknown>} [meta]
 * @param {number} [maxBytes]
 */
export function toolResult(host, body, meta = {}, maxBytes = DEFAULT_TOOL_BYTES) {
    return { content: [{ type: "text" as const, text: fence(host, body, meta, maxBytes) }] };
}

/**
 * One line, no controls, cut for a listing.
 *
 * @param {unknown} message
 * @param {number} [max]
 */
export function oneLine(message, max = 200) {
    const value = String(message ?? "")
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * @param {unknown} time
 * @returns {string}
 */
export function isoTime(time) {
    const number = Number(time);
    if (!Number.isFinite(number) || number <= 0) return "unknown-time";
    try {
        return new Date(number).toISOString();
    } catch {
        return "unknown-time";
    }
}

/**
 * @param {unknown} value
 * @param {number} [chars]
 */
export function short(value, chars = 12) {
    const text = typeof value === "string" ? value : "";
    return text.length <= chars ? text : `${text.slice(0, chars)}…`;
}

/**
 * A branch's head is its newest Commit, else its base Layer. The service
 * returns both; this makes the preview binding explicit.
 *
 * @param {{ head?: string | null, base?: string | null }} branch
 */
export function branchHead(branch) {
    return branch.head ?? branch.base ?? "";
}

/**
 * A compact commit line for a tool. The message is defanged later by `fence`.
 *
 * @param {any} commit
 */
export function commitLine(commit) {
    const message = oneLine(commit.message ?? "(no message)", MAX_MESSAGE_CHARS);
    return `commit ${shortId(commit.id)} ${isoTime(commit.time)} via=${attr(commit.via ?? "?")} parent=${shortId(commit.parent ?? "-")} ${message}`;
}

/**
 * @param {any} item
 */
export function changeLine(item) {
    const before = item.before?.type ?? "-";
    const after = item.after?.type ?? "-";
    const flags = [
        item.content ? "content" : "",
        item.metadata ? "metadata" : "",
        item.identity ? "identity" : "",
    ]
        .filter(Boolean)
        .join(",");
    return `${attr(item.kind)} ${attr(item.path)} ${before}->${after}${flags ? ` (${flags})` : ""}`;
}

/**
 * Render diff hunks as plain lines. No markup, no HTML.
 *
 * @param {any[] | null | undefined} hunks
 * @param {number} [maxLines]
 */
export function hunkLines(hunks, maxLines = 160) {
    if (!Array.isArray(hunks) || hunks.length === 0) return [];
    const lines = [];
    for (const hunk of hunks.slice(0, maxLines)) {
        const op = hunk?.op === "+" || hunk?.op === "-" ? hunk.op : " ";
        lines.push(`${op}${String(hunk?.text ?? "").replace(/\r?\n$/, "")}`);
    }
    if (hunks.length > maxLines) lines.push(`… ${hunks.length - maxLines} hunk lines omitted`);
    return lines;
}
