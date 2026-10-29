import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BoundedQueue } from "../service/queue.mjs";
import { CODES, LayerfsRefusal } from "../src/pocket-layerfs/errors.ts";

function deferred<T = string>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}
function code(wanted: string) {
    return (error: unknown) => error instanceof LayerfsRefusal && error.code === wanted;
}

test("queued deadline expires immediately without executing work or occupying a slot", async () => {
    const queue = new BoundedQueue({ concurrency: 1, maxQueue: 1 });
    const gate = deferred();
    const first = queue.run(() => gate.promise, { timeoutMs: 2000 });
    let writes = 0;
    const expired = assert.rejects(queue.run(async () => { writes += 1; return "bad"; }, { timeoutMs: 250, label: "fork.commit" }), code(CODES.Timeout));
    await delay(320);
    await expired;
    assert.equal(queue.queue.length, 0);
    assert.equal(queue.active, 1);
    assert.equal(writes, 0);
    const next = queue.run(async () => "next", { timeoutMs: 1000 });
    gate.resolve("done");
    assert.equal(await first, "done");
    assert.equal(await next, "next");
    assert.equal(queue.active, 0);
    queue.close();
});

test("queued signal cancellation immediately removes entry and never executes its write", async () => {
    const queue = new BoundedQueue({ concurrency: 1, maxQueue: 1 });
    const gate = deferred();
    const first = queue.run(() => gate.promise, { timeoutMs: 2000 });
    const controller = new AbortController();
    let writes = 0;
    const cancelled = assert.rejects(queue.run(async () => { writes += 1; return "bad"; }, { timeoutMs: 1000, signal: controller.signal, label: "fork.commit" }), code(CODES.Timeout));
    controller.abort();
    await cancelled;
    assert.equal(queue.queue.length, 0);
    assert.equal(queue.active, 1);
    gate.resolve("done");
    await first;
    assert.equal(writes, 0);
    assert.equal(await queue.run(async () => "slot-reused", { timeoutMs: 1000 }), "slot-reused");
    assert.equal(queue.active, 0);
    queue.close();
});

test("deadline discovered during drain does not leak the active slot", async (t) => {
    let now = 0;
    t.mock.method(Date, "now", () => now);
    const queue = new BoundedQueue({ concurrency: 1, maxQueue: 2 });
    const gate = deferred();
    const first = queue.run(() => gate.promise, { timeoutMs: 2000 });
    let writes = 0;
    const expired = assert.rejects(queue.run(async () => { writes += 1; return "bad"; }, { timeoutMs: 250 }), code(CODES.Timeout));
    now = 500;
    gate.resolve("done");
    await first;
    await expired;
    assert.equal(writes, 0);
    assert.equal(queue.active, 0);
    assert.equal(queue.queue.length, 0);
    assert.equal(await queue.run(async () => "reused", { timeoutMs: 1000 }), "reused");
    assert.equal(queue.active, 0);
    queue.close();
});

test("running native timeout rejects caller but holds concurrency until genuine settlement; never retries", async () => {
    const queue = new BoundedQueue({ concurrency: 1, maxQueue: 1 });
    const gate = deferred();
    let starts = 0;
    const timedOut = assert.rejects(queue.run(() => { starts += 1; return gate.promise; }, { timeoutMs: 250, label: "fork.commit" }), code(CODES.Timeout));
    await delay(320);
    await timedOut;
    assert.equal(starts, 1);
    assert.equal(queue.active, 1);
    let nextStarted = false;
    const next = queue.run(async () => { nextStarted = true; return "next"; }, { timeoutMs: 1000 });
    await assert.rejects(queue.run(async () => "excess", { timeoutMs: 1000 }), code(CODES.Busy));
    assert.equal(nextStarted, false);
    gate.resolve("late-success-outcome-unknown-to-caller");
    assert.equal(await next, "next");
    assert.equal(starts, 1);
    assert.equal(queue.active, 0);
    queue.close();
});

test("running cancellation retains native slot and closes only queued work on service stop", async () => {
    const queue = new BoundedQueue({ concurrency: 1, maxQueue: 2 });
    const gate = deferred();
    const controller = new AbortController();
    let starts = 0;
    const running = assert.rejects(queue.run(() => { starts += 1; return gate.promise; }, { timeoutMs: 1000, signal: controller.signal }), code(CODES.Timeout));
    await Promise.resolve();
    controller.abort();
    await running;
    assert.equal(queue.active, 1);
    let queuedStarts = 0;
    const queued = assert.rejects(queue.run(async () => { queuedStarts += 1; return "bad"; }, { timeoutMs: 1000 }), code(CODES.ServiceUnavailable));
    queue.close();
    await queued;
    await assert.rejects(queue.run(async () => "bad", { timeoutMs: 1000 }), code(CODES.ServiceUnavailable));
    assert.equal(queuedStarts, 0);
    assert.equal(starts, 1);
    assert.equal(queue.active, 1);
    gate.resolve("native-finished");
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(queue.active, 0);
});
