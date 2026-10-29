/**
 * A small bounded queue for Store calls.
 *
 * A call that exceeds its deadline before it starts is removed from the queue
 * and never runs. A running SDK call cannot be cancelled by this service, so
 * a deadline or caller abort rejects the caller, reports an unknown outcome
 * for a write, and keeps the worker slot until the SDK promise really
 * settles. The caller must not retry a timed-out write automatically.
 */
import { CODES, LayerfsRefusal } from "../src/pocket-layerfs/errors.ts";

export class BoundedQueue {
    /**
     * @param {{ concurrency?: number, maxQueue?: number }} [options]
     */
    constructor(options = {}) {
        this.concurrency = options.concurrency ?? 1;
        this.maxQueue = options.maxQueue ?? 16;
        this.active = 0;
        /** @type {any[]} */
        this.queue = [];
        this.closed = false;
        /** @type {Set<(idle: boolean) => void>} */
        this.idleWaiters = new Set();
        this.paused = false;
    }

    /**
     * Stop admitting work and refuse calls that have not started. Running
     * native calls keep their slot. A paused queue has an empty wait list, so
     * waitForIdle counts only those running calls and cannot deadlock.
     */
    pause() {
        this.paused = true;
        for (const entry of this.queue.splice(0)) this.#fail(entry, CODES.Busy, false);
        this.#notifyIdle();
    }

    /** Admit work again. */
    resume() {
        this.paused = false;
        this.#drain();
    }

    /**
     * @template T
     * @param {() => Promise<T>} task
     * @param {{ timeoutMs: number, label?: string, signal?: AbortSignal }} options
     * @returns {Promise<T>}
     */
    run(task, options) {
        if (this.closed) return Promise.reject(new LayerfsRefusal(CODES.ServiceUnavailable));
        if (this.paused) return Promise.reject(new LayerfsRefusal(CODES.Busy));
        const timeoutMs = Math.max(250, Math.min(options.timeoutMs, 60_000));
        return new Promise((resolve, reject) => {
            const entry = {
                task,
                resolve,
                reject,
                label: options.label ?? "call",
                deadline: Date.now() + timeoutMs,
                started: false,
                settled: false,
                released: false,
                timer: null,
                signal: options.signal,
                onAbort: null,
            };

            entry.timer = setTimeout(() => {
                // Before start: remove it, so an expired write never runs.
                // After start: reject this caller, but keep the slot.
                this.#fail(entry, CODES.Timeout, !entry.started);
            }, timeoutMs);
            entry.timer.unref?.();

            if (options.signal !== undefined) {
                if (options.signal.aborted) {
                    this.#fail(entry, CODES.Timeout, true);
                    return;
                }
                entry.onAbort = () => this.#fail(entry, CODES.Timeout, !entry.started);
                options.signal.addEventListener("abort", entry.onAbort, { once: true });
            }

            if (this.active < this.concurrency && this.queue.length === 0) {
                this.#start(entry);
                return;
            }
            if (this.queue.length >= this.maxQueue) {
                this.#fail(entry, CODES.Busy, false);
                return;
            }
            this.queue.push(entry);
        });
    }

    /**
     * @param {any} entry
     * @param {string} code
     * @param {boolean} removeQueued
     */
    #fail(entry, code, removeQueued) {
        if (entry.settled) return;
        entry.settled = true;
        clearTimeout(entry.timer);
        if (entry.onAbort !== null) entry.signal?.removeEventListener("abort", entry.onAbort);
        if (removeQueued && !entry.started) {
            const index = this.queue.indexOf(entry);
            if (index >= 0) this.queue.splice(index, 1);
        }
        entry.reject(new LayerfsRefusal(code));
        this.#notifyIdle();
    }

    /** @param {any} entry */
    #start(entry) {
        if (entry.settled) return;
        const remaining = entry.deadline - Date.now();
        if (remaining <= 0) {
            // Do not take a slot for an entry that is already expired.
            this.#fail(entry, CODES.Timeout, true);
            return;
        }
        entry.started = true;
        this.active += 1;
        Promise.resolve()
            .then(entry.task)
            .then(
                (value) => {
                    this.#release(entry);
                    if (!entry.settled) {
                        entry.settled = true;
                        clearTimeout(entry.timer);
                        if (entry.onAbort !== null)
                            entry.signal?.removeEventListener("abort", entry.onAbort);
                        entry.resolve(value);
                    }
                },
                (error) => {
                    this.#release(entry);
                    if (!entry.settled) {
                        entry.settled = true;
                        clearTimeout(entry.timer);
                        if (entry.onAbort !== null)
                            entry.signal?.removeEventListener("abort", entry.onAbort);
                        entry.reject(error);
                    }
                },
            );
    }

    /** @param {any} entry */
    #release(entry) {
        if (entry.released) return;
        entry.released = true;
        this.active = Math.max(0, this.active - 1);
        this.#drain();
        this.#notifyIdle();
    }

    #drain() {
        while (!this.closed && this.active < this.concurrency && this.queue.length > 0) {
            const next = this.queue.shift();
            if (next.settled) continue;
            this.#start(next);
        }
    }

    #notifyIdle() {
        if (this.active !== 0 || this.queue.length !== 0) return;
        for (const resolve of this.idleWaiters) resolve(true);
        this.idleWaiters.clear();
    }

    /**
     * Wait until no call is running or queued. A timeout returns false; the
     * running native calls are not cancelled by the service.
     *
     * @param {number} timeoutMs
     * @returns {Promise<boolean>}
     */
    waitForIdle(timeoutMs) {
        if (this.active === 0 && this.queue.length === 0) return Promise.resolve(true);
        return new Promise((resolve) => {
            let settled = false;
            const finish = (idle) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.idleWaiters.delete(finish);
                resolve(idle);
            };
            const timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
            this.idleWaiters.add(finish);
        });
    }

    /** Refuse new calls and reject queued calls. Running calls keep their slot. */
    close() {
        this.closed = true;
        for (const entry of this.queue.splice(0)) this.#fail(entry, CODES.ServiceUnavailable, true);
        this.#notifyIdle();
    }
}
