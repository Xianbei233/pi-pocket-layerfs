/**
 * Short-lived, one-time preview tickets for the only internal write in v1:
 * `branch.fork`.
 *
 * A ticket is an opaque random token. Only its SHA-256 hash is kept. The
 * record binds the person, the actual Pocket conversation, the project, the
 * source branch, the source ref, the target branch, the operation, and the
 * expected source head. A browser click sends the token; a model cannot turn
 * `confirm: true` into an approval because it never receives a ticket from a
 * route it can reach, and a ticket for another person or conversation does
 * not match.
 */
import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { CODES, LayerfsRefusal } from "./errors.ts";

export const TICKET_BYTES = 32;
export const MAX_TICKETS = 256;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * @typedef {object} TicketBinding
 * @property {string} ownerId
 * @property {string} conversationId
 * @property {string} project
 * @property {string} sourceBranch
 * @property {string} fromRef
 * @property {string} newBranch
 * @property {string} expectedHead
 * @property {string} op
 */

/**
 * @typedef {TicketBinding & { expiresAt: number }} TicketRecord
 */

/**
 * A one-time ticket store. The clock and random source are injectable so a
 * test can advance time and replay a fixed token without touching the clock.
 */
export class TicketStore {
    /** @type {() => number} */
    now;
    /** @type {(size: number) => Buffer} */
    random;
    /** @type {number} */
    ttlMs;
    /** @type {number} */
    max;
    /** @type {Map<string, TicketRecord>} */
    tickets;

    /**
     * @param {{ now?: () => number, random?: (size: number) => Buffer, ttlMs?: number, max?: number }} [options]
     */
    constructor(
        options: {
            now?: () => number;
            random?: (size: number) => Buffer;
            ttlMs?: number;
            max?: number;
        } = {},
    ) {
        this.now = options.now ?? (() => Date.now());
        this.random = options.random ?? ((size) => nodeRandomBytes(size));
        this.ttlMs = options.ttlMs ?? 120_000;
        this.max = options.max ?? MAX_TICKETS;
        /** @type {Map<string, TicketRecord>} */
        this.tickets = new Map();
    }

    /**
     * Make a preview ticket and return the token exactly once. The caller
     * must give it only to the owner's browser, never to a tool result, an
     * event, a notice, or a log.
     *
     * @param {TicketBinding} binding
     * @returns {{ ticket: string, record: TicketRecord }}
     */
    issue(binding) {
        this.purge();
        if (this.tickets.size >= this.max) throw new LayerfsRefusal(CODES.Busy);
        const token = base64url(this.random(TICKET_BYTES));
        if (!TOKEN_PATTERN.test(token)) throw new LayerfsRefusal(CODES.Upstream);
        const record = Object.freeze({
            ...normaliseBinding(binding),
            expiresAt: this.now() + this.ttlMs,
        });
        this.tickets.set(hashToken(token), record);
        return { ticket: token, record };
    }

    /**
     * Consume a ticket only when every binding field matches. A valid token
     * with a different binding is left in place, so guessing another person's
     * token cannot destroy their preview.
     *
     * @param {string} token
     * @param {TicketBinding} binding
     * @returns {TicketRecord}
     */
    consume(token, binding) {
        if (typeof token !== "string" || !TOKEN_PATTERN.test(token))
            throw new LayerfsRefusal(CODES.TicketInvalid);
        const key = hashToken(token);
        const record = this.tickets.get(key);
        if (record === undefined) throw new LayerfsRefusal(CODES.TicketUsed);
        if (record.expiresAt <= this.now()) {
            this.tickets.delete(key);
            throw new LayerfsRefusal(CODES.TicketExpired);
        }
        const wanted = normaliseBinding(binding);
        for (const field of Object.keys(wanted)) {
            if (record[field] !== wanted[field]) throw new LayerfsRefusal(CODES.TicketMismatch);
        }
        this.tickets.delete(key);
        return record;
    }

    /**
     * Consume a ticket for one owner, conversation, project, and operation.
     * The other binding fields stay server-side and are returned to the
     * caller, so the browser cannot substitute a target branch or source ref.
     *
     * @param {string} token
     * @param {{ ownerId: string, conversationId: string, project: string, op: string }} scope
     * @returns {TicketRecord}
     */
    consumeFor(token, scope) {
        if (typeof token !== "string" || !TOKEN_PATTERN.test(token))
            throw new LayerfsRefusal(CODES.TicketInvalid);
        const key = hashToken(token);
        const record = this.tickets.get(key);
        if (record === undefined) throw new LayerfsRefusal(CODES.TicketUsed);
        if (record.expiresAt <= this.now()) {
            this.tickets.delete(key);
            throw new LayerfsRefusal(CODES.TicketExpired);
        }
        if (
            record.ownerId !== String(scope.ownerId ?? "") ||
            record.conversationId !== String(scope.conversationId ?? "") ||
            record.project !== String(scope.project ?? "") ||
            record.op !== String(scope.op ?? "")
        ) {
            throw new LayerfsRefusal(CODES.TicketMismatch);
        }
        this.tickets.delete(key);
        return record;
    }

    /** Remove every expired ticket. */
    purge() {
        const now = this.now();
        for (const [key, record] of this.tickets) {
            if (record.expiresAt <= now) this.tickets.delete(key);
        }
    }

    /** The number of live tickets, for a test or a bounded status call. */
    get size() {
        this.purge();
        return this.tickets.size;
    }

    /** Drop every ticket. A module reload does this; old previews stop working. */
    clear() {
        this.tickets.clear();
    }
}

/**
 * @param {TicketBinding} binding
 * @returns {TicketBinding}
 */
function normaliseBinding(binding) {
    const text = (value) => (typeof value === "string" ? value : "");
    return {
        ownerId: text(binding.ownerId),
        conversationId: text(binding.conversationId),
        project: text(binding.project),
        sourceBranch: text(binding.sourceBranch),
        fromRef: text(binding.fromRef),
        newBranch: text(binding.newBranch),
        expectedHead: text(binding.expectedHead),
        op: text(binding.op),
    };
}

/**
 * @param {string} token
 * @returns {string}
 */
export function hashToken(token) {
    return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * @param {Buffer} bytes
 * @returns {string}
 */
function base64url(bytes) {
    return bytes.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
