/**
 * The plugin's client for the private Unix-socket service.
 *
 * One request per connection. There are no retries and no fallback: if the
 * service is down, refused, too slow, or gives a malformed answer, the caller
 * gets a typed refusal. The service token is never put in an error, a log
 * line, a tool result, or a route response.
 */
import { createConnection } from "node:net";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { CODES, LayerfsRefusal, safeMessage } from "./errors.ts";
import { assertNoSymlinkAncestors } from "./config.ts";

export const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 256;

/**
 * Read the service token from a private regular file. The service creates it
 * with mode 0600; the plugin refuses a link, a non-regular file, or a file
 * that another user could read.
 *
 * @param {string} path
 * @returns {string}
 */
export function readServiceToken(path) {
    let fd;
    try {
        // A link in an ancestor would make O_NOFOLLOW at the leaf insufficient.
        assertNoSymlinkAncestors(path);
        // O_NOFOLLOW closes the lstat/read race: a link at this exact path is
        // refused by open, not followed and then checked.
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = fstatSync(fd);
        if (!info.isFile() || (info.mode & 0o077) !== 0)
            throw new LayerfsRefusal(CODES.ServiceUnavailable);
        if (info.size > MAX_TOKEN_BYTES) throw new LayerfsRefusal(CODES.ServiceUnavailable);
        const buffer = Buffer.alloc(MAX_TOKEN_BYTES + 1);
        const length = readSync(fd, buffer, 0, buffer.length, 0);
        const token = buffer.subarray(0, length).toString("utf8").trim();
        if (!/^[A-Za-z0-9_-]{43,128}$/.test(token))
            throw new LayerfsRefusal(CODES.ServiceUnavailable);
        return token;
    } catch (error) {
        if (error instanceof LayerfsRefusal) throw error;
        throw new LayerfsRefusal(CODES.ServiceUnavailable);
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

/**
 * @typedef {{ code: string, message?: string }} WireError
 */

/** A typed client for one service process. */
export class ServiceClient {
    /** @type {string} */
    socketPath;
    /** @type {string} */
    token;
    /** @type {number} */
    timeoutMs;
    /** @type {number} */
    maxResponseBytes;
    /** @type {number} */
    maxConcurrent;
    /** @type {Set<import("node:net").Socket>} */
    sockets;
    /** @type {boolean} */
    closed;

    /**
     * @param {{ socketPath: string, token: string, timeoutMs?: number, maxResponseBytes?: number, maxConcurrent?: number }} options
     */
    constructor(options) {
        this.socketPath = options.socketPath;
        this.token = options.token;
        this.timeoutMs = options.timeoutMs ?? 8000;
        this.maxResponseBytes = options.maxResponseBytes ?? 512 * 1024;
        this.maxConcurrent = options.maxConcurrent ?? 16;
        /** @type {Set<import("node:net").Socket>} */
        this.sockets = new Set();
        this.closed = false;
    }

    /**
     * Send one operation and return its result.
     *
     * @param {string} op
     * @param {Record<string, unknown>} args
     * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
     * @returns {Promise<any>}
     */
    request(op, args, options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
        if (this.closed) return Promise.reject(new LayerfsRefusal(CODES.ServiceUnavailable));
        if (typeof op !== "string" || op.length === 0 || op.length > 64) {
            return Promise.reject(new LayerfsRefusal(CODES.Invalid));
        }
        if (this.sockets.size >= this.maxConcurrent)
            return Promise.reject(new LayerfsRefusal(CODES.Busy));
        const id = randomBytes(12).toString("hex");
        const payload = Buffer.from(
            `${JSON.stringify({ v: 1, id, token: this.token, op, args: plainObject(args) })}\n`,
            "utf8",
        );
        if (payload.byteLength > MAX_REQUEST_BYTES)
            return Promise.reject(new LayerfsRefusal(CODES.Invalid));
        const timeoutMs = Math.min(Math.max(options.timeoutMs ?? this.timeoutMs, 250), 60_000);

        return new Promise((resolve, reject) => {
            const socket = createConnection({ path: this.socketPath });
            this.sockets.add(socket);
            let settled = false;
            let buffer = "";
            const timer = setTimeout(() => finish(new LayerfsRefusal(CODES.Timeout)), timeoutMs);

            const finish = (error, value = undefined) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                options.signal?.removeEventListener("abort", onAbort);
                socket.destroy();
                this.sockets.delete(socket);
                if (error) reject(error);
                else resolve(value);
            };

            const onAbort = () => {
                finish(
                    options.signal?.reason instanceof LayerfsRefusal
                        ? options.signal.reason
                        : new LayerfsRefusal(CODES.Timeout),
                );
            };

            if (options.signal !== undefined) {
                if (options.signal.aborted) {
                    finish(new LayerfsRefusal(CODES.Timeout));
                    return;
                }
                options.signal.addEventListener("abort", onAbort, { once: true });
            }

            timer.unref?.();

            socket.setEncoding("utf8");
            socket.on("connect", () => socket.write(payload));
            socket.on("data", (chunk) => {
                buffer += chunk;
                if (Buffer.byteLength(buffer, "utf8") > this.maxResponseBytes + 1024) {
                    finish(new LayerfsRefusal(CODES.ResponseTooLarge));
                    return;
                }
                const newline = buffer.indexOf("\n");
                if (newline < 0) return;
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                let answer;
                try {
                    answer = JSON.parse(line);
                } catch {
                    finish(new LayerfsRefusal(CODES.Protocol));
                    return;
                }
                if (answer === null || typeof answer !== "object" || answer.id !== id) {
                    finish(new LayerfsRefusal(CODES.Protocol));
                    return;
                }
                if (answer.ok !== true) {
                    const code = safeCode(answer.error);
                    finish(new LayerfsRefusal(code));
                    return;
                }
                finish(undefined, answer.result);
            });
            socket.on("error", () => finish(new LayerfsRefusal(CODES.ServiceUnavailable)));
            socket.on("close", () => finish(new LayerfsRefusal(CODES.ServiceUnavailable)));
        });
    }

    /** Close every socket this client owns. It does not stop the service. */
    close() {
        this.closed = true;
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
    }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function safeCode(error) {
    if (error === null || typeof error !== "object") return CODES.Protocol;
    const code = /** @type {any} */ error.code;
    if (typeof code !== "string" || !/^[A-Za-z][A-Za-z0-9]{1,40}$/.test(code))
        return CODES.Protocol;
    return code;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function plainObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
    return /** @type {Record<string, unknown>} */ value;
}

/**
 * A short, safe rendering of a refusal for a notice or a log. It never
 * includes a message from the service or the SDK.
 *
 * @param {unknown} error
 */
export function refusalText(error) {
    if (error instanceof LayerfsRefusal) return safeMessage(error.code);
    return safeMessage(CODES.Upstream);
}
