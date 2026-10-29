/**
 * Stable error codes shared by the plugin and its private service. Messages
 * in this module are deliberately generic: a tool result, a route error, and
 * a notice may all reach someone who must not learn whether a path, branch,
 * project, or commit exists.
 */

/** A refusal with a stable code and a safe message. */
export class LayerfsRefusal extends Error {
    /** @type {string} */
    code;
    /** @type {number} */
    status;

    /**
     * @param {string} code
     * @param {string} [message]
     * @param {number} [status]
     */
    constructor(code, message = undefined, status = undefined) {
        super(message ?? safeMessage(code));
        this.name = "LayerfsRefusal";
        this.code = code;
        this.status = status ?? statusFor(code);
    }
}

/** Codes the plugin and service use on the wire. */
export const CODES = Object.freeze({
    Unauthorized: "Unauthorized",
    Forbidden: "Forbidden",
    NotFound: "NotFound",
    Invalid: "Invalid",
    InvalidPath: "InvalidPath",
    InvalidRef: "InvalidRef",
    NotConfigured: "NotConfigured",
    ToolsDisabled: "ToolsDisabled",
    WriteDisabled: "WriteDisabled",
    TicketInvalid: "TicketInvalid",
    TicketExpired: "TicketExpired",
    TicketUsed: "TicketUsed",
    TicketMismatch: "TicketMismatch",
    Busy: "Busy",
    Timeout: "Timeout",
    ResponseTooLarge: "ResponseTooLarge",
    Upstream: "Upstream",
    HeadMoved: "HeadMoved",
    Conflict: "Conflict",
    NameTaken: "NameTaken",
    Unsupported: "Unsupported",
    ServiceUnavailable: "ServiceUnavailable",
    Protocol: "Protocol",
});

/**
 * A generic message for a code. It never names a path, branch, commit,
 * project, socket, token, or upstream error.
 *
 * @param {string} code
 * @returns {string}
 */
export function safeMessage(code) {
    switch (code) {
        case CODES.NotFound:
            return "The requested LayerFS item is not available.";
        case CODES.Forbidden:
        case CODES.Unauthorized:
            return "This LayerFS action is not authorised.";
        case CODES.Invalid:
        case CODES.InvalidPath:
        case CODES.InvalidRef:
            return "The LayerFS request is not valid.";
        case CODES.NotConfigured:
            return "The LayerFS plugin is not configured.";
        case CODES.ToolsDisabled:
            return "LayerFS tools are disabled.";
        case CODES.WriteDisabled:
            return "LayerFS internal writes are disabled.";
        case CODES.TicketInvalid:
        case CODES.TicketExpired:
        case CODES.TicketUsed:
        case CODES.TicketMismatch:
            return "The LayerFS preview is no longer valid. Make a new preview.";
        case CODES.Busy:
            return "The LayerFS service is busy. Try again.";
        case CODES.Timeout:
            return "The LayerFS service did not answer in time.";
        case CODES.ResponseTooLarge:
            return "The LayerFS answer is larger than the allowed limit.";
        case CODES.HeadMoved:
            return "The LayerFS branch head changed. Make a new preview.";
        case CODES.Conflict:
            return "LayerFS refused the change because of a conflict.";
        case CODES.NameTaken:
            return "That LayerFS branch name is already taken.";
        case CODES.Unsupported:
            return "This LayerFS operation is not supported.";
        case CODES.ServiceUnavailable:
            return "The private LayerFS service is not running or not reachable.";
        case CODES.Protocol:
            return "The private LayerFS service gave an unexpected answer.";
        default:
            return "The LayerFS request failed.";
    }
}

/**
 * The HTTP status a browser route should use for a code. Non-owner callers
 * receive 404 before this mapping, so these are for an authorised owner.
 *
 * @param {string} code
 * @returns {number}
 */
export function statusFor(code) {
    switch (code) {
        case CODES.NotFound:
            return 404;
        case CODES.Forbidden:
        case CODES.Unauthorized:
            return 403;
        case CODES.Invalid:
        case CODES.InvalidPath:
        case CODES.InvalidRef:
        case CODES.NotConfigured:
        case CODES.ToolsDisabled:
        case CODES.WriteDisabled:
        case CODES.Unsupported:
            return 400;
        case CODES.TicketInvalid:
        case CODES.TicketExpired:
        case CODES.TicketUsed:
            return 410;
        case CODES.TicketMismatch:
        case CODES.HeadMoved:
        case CODES.Conflict:
        case CODES.NameTaken:
            return 409;
        case CODES.Busy:
            return 429;
        case CODES.Timeout:
            return 504;
        case CODES.ResponseTooLarge:
            return 413;
        case CODES.ServiceUnavailable:
            return 503;
        default:
            return 502;
    }
}

/**
 * Map an SDK refusal code to the plugin's stable code. The SDK's own message
 * is never forwarded; only its code decides.
 *
 * @param {unknown} error
 * @returns {LayerfsRefusal}
 */
export function fromUpstreamError(error) {
    const code =
        typeof error === "object" &&
        error !== null &&
        typeof (/** @type {any} */ error.code) === "string"
            ? /** @type {any} */ error.code
            : "";
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

/**
 * Whether an error is a refusal with one of the given codes.
 *
 * @param {unknown} error
 * @param {...string} codes
 */
export function isRefusal(error, ...codes) {
    return error instanceof LayerfsRefusal && (codes.length === 0 || codes.includes(error.code));
}
