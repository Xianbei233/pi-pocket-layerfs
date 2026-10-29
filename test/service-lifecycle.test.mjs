// Actual service/main.mjs process + Unix sockets. SDK is synthetic, not native.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { ServiceClient } from "../src/pocket-layerfs/ipc.ts";
import { writeTrustReceipt } from "../scripts/verify-lib.mjs";
import { LOGS, PROJECT, runtime } from "./fixtures/resume-runtime.mjs";

const SDK = [
    "import {appendFileSync,existsSync} from 'node:fs';",
    "const root=new URL('../../',import.meta.url);",
    "const event=x=>appendFileSync(new URL('events',root),x+'\\n');",
    "export class LayerFS {",
    "project={list_branches:async()=>{event('begin');while(!existsSync(new URL('release',root)))await new Promise(r=>setTimeout(r,10));event('done');return {items:[{name:'work',head:'01'+'22'.repeat(32)}],hasMore:false}}};",
    "fs={stat:async(ref,path)=>({type:'file',path})};",
    "async close(){event('close');}",
    "}",
].join("\n");

async function until(check, message, ms = 5000) {
    const start = Date.now();
    while (!(await check())) {
        if (Date.now() - start > ms) throw new Error("timeout: " + message);
        await delay(10);
    }
}
async function service(code = SDK, writes = false) {
    const fixture = runtime(code);
    // Explicitly trusted positive fixture only; negative runtime() callers remain unsigned.
    writeTrustReceipt(PROJECT, fixture.root, "owner-authorized");
    if (writes) {
        fixture.config.write = { enabled: true };
        fixture.config.sessionGrants = [
            {
                conversationId: "resume-session",
                project: "synthetic",
                allowTools: true,
                toolBranches: ["work"],
                fork: { enabled: true, sources: ["work"], namePrefix: "recovery-" },
            },
        ];
        writeFileSync(fixture.configPath, JSON.stringify(fixture.config), { mode: 0o600 });
    }
    const child = spawn(
        process.execPath,
        [join(PROJECT, "service/main.mjs"), "--config", fixture.configPath],
        {
            cwd: PROJECT,
            env: { ...process.env, PI_POCKET_LAYERFS_CONFIG: "" },
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
    let log = "";
    child.stdout.on("data", (x) => {
        log += x;
    });
    child.stderr.on("data", (x) => {
        log += x;
    });
    let exit;
    const exited = once(child, "exit").then(([status, signal]) => {
        exit = { status, signal };
        writeFileSync(join(LOGS, "service-" + child.pid + ".log"), log);
        writeFileSync(
            join(LOGS, "service-" + child.pid + ".exit"),
            String(status ?? signal) + "\n",
        );
        return exit;
    });
    await until(() => {
        if (exit) throw new Error("service startup failed: " + log);
        return existsSync(fixture.config.service.socketPath) && log.includes("listening socket=");
    }, "service listen");
    const token = readFileSync(fixture.config.service.tokenFile, "utf8").trim();
    const clients = [];
    function client(timeoutMs = 2000) {
        const result = new ServiceClient({
            socketPath: fixture.config.service.socketPath,
            token,
            timeoutMs,
            maxResponseBytes: 524288,
        });
        clients.push(result);
        return result;
    }
    return {
        ...fixture,
        child,
        token,
        client,
        exited,
        events: () =>
            existsSync(join(fixture.root, "events"))
                ? readFileSync(join(fixture.root, "events"), "utf8").trim().split("\n")
                : [],
        log: () => log,
        release: () => writeFileSync(join(fixture.root, "release"), "yes"),
        async close() {
            for (const c of clients) c.close();
            writeFileSync(join(fixture.root, "release"), "yes");
            if (!exit) child.kill("SIGTERM");
            await Promise.race([exited, delay(9000)]);
            if (!exit) {
                child.kill("SIGKILL");
                await exited;
            }
        },
    };
}

test(
    "D3 real socket: queued disconnect cancels; active timeout is unknown and retains its slot until settlement",
    { timeout: 15000 },
    async () => {
        const s = await service();
        try {
            const active = s.client(120).request("branches", { project: "synthetic" });
            const activeRejected = assert.rejects(active, (error) => error.code === "Timeout");
            await until(() => s.events().includes("begin"), "active SDK began");
            const controller = new AbortController();
            const queued = s
                .client(2000)
                .request("branches", { project: "synthetic" }, { signal: controller.signal });
            const queuedRejected = assert.rejects(queued, (error) => error.code === "Timeout");
            await delay(90);
            controller.abort();
            await queuedRejected;
            await activeRejected;
            const survivor = s.client(3000).request("branches", { project: "synthetic" });
            await delay(100);
            assert.deepEqual(
                s.events(),
                ["begin"],
                "caller timeout must not release active native slot",
            );
            s.release();
            await survivor;
            assert.deepEqual(
                s.events(),
                ["begin", "done", "begin", "done"],
                "disconnected queued call never reaches SDK",
            );
        } finally {
            await s.close();
        }
    },
);

test(
    "D4 real SIGTERM waits beyond grace for active settlement before Store close; sibling service survives",
    { timeout: 23000 },
    async () => {
        const s = await service();
        const sibling = await service();
        try {
            const active = s.client(12000).request("branches", { project: "synthetic" });
            const outcome = active.then(
                (result) => ({ result }),
                (error) => ({ error }),
            );
            await until(() => s.events().includes("begin"), "active SDK began");
            s.child.kill("SIGTERM");
            await until(() => s.log().includes("stop grace expired"), "grace expiry", 6500);
            assert.deepEqual(s.events(), ["begin"], "Store close must not race active work");
            assert.match(s.log(), /outcome unknown/);
            s.release();
            await outcome;
            const exit = await s.exited;
            assert.equal(exit.status, 0);
            assert.deepEqual(s.events(), ["begin", "done", "close"]);
            assert.equal((await sibling.client().request("ping", {})).projects[0], "synthetic");
            assert.ok(existsSync(sibling.config.service.socketPath));
        } finally {
            await s.close();
            await sibling.close();
        }
    },
);

test(
    "D4 unresolved asynchronous Store close must not be reported as clean success",
    { timeout: 13000 },
    async () => {
        const s = await service(
            SDK.replace(
                "async close(){event('close');}",
                "async close(){event('close');await new Promise(()=>{});}",
            ),
        );
        try {
            s.release();
            await s.client().request("branches", { project: "synthetic" });
            s.child.kill("SIGTERM");
            const exit = await s.exited;
            assert.notEqual(exit.status, 0, "close timeout is not a successful shutdown");
            assert.match(s.log(), /close.*(unknown|timeout|expired)|unclean/i);
        } finally {
            await s.close();
        }
    },
);

test(
    "D5 real service preserves a multibyte request path split across writes",
    { timeout: 14000 },
    async () => {
        const s = await service();
        try {
            const socket = connect(s.config.service.socketPath);
            socket.on("error", () => {});
            await once(socket, "connect");
            const path = "/中😀.txt";
            const payload = Buffer.from(
                JSON.stringify({
                    v: 1,
                    id: "utf8",
                    token: s.token,
                    op: "stat",
                    args: { project: "synthetic", ref: "work", path },
                }) + "\n",
            );
            const split = payload.indexOf(Buffer.from("中")) + 1;
            let response = "";
            socket.setEncoding("utf8");
            socket.on("data", (x) => {
                response += x;
            });
            const ended = once(socket, "end");
            socket.write(payload.subarray(0, split));
            await delay(40);
            socket.write(payload.subarray(split));
            await ended;
            socket.destroy();
            assert.equal(JSON.parse(response).result.path, path);
        } finally {
            await s.close();
        }
    },
);

const WRITE_SDK = [
    "import {appendFileSync,existsSync} from 'node:fs';",
    "const root=new URL('../../',import.meta.url);const event=x=>appendFileSync(new URL('events',root),x+'\\n');",
    "export class LayerFS {",
    "project={list_branches:async()=>({items:[{name:'work',head:'01'+'22'.repeat(32)}],hasMore:false})};",
    "branch={fork:async(name,from)=>{event('begin:'+name);while(!existsSync(new URL('release',root)))await new Promise(r=>setTimeout(r,10));event('done:'+name);return {kind:'Forked',branch:name,head:from,base:from}}};",
    "async close(){event('close');}",
    "}",
].join("\n");

test(
    "D3 real socket queued fork never mutates after disconnect; active fork timeout remains unknown until genuine completion",
    { timeout: 15000 },
    async () => {
        const s = await service(WRITE_SDK, true);
        const args = (name) => ({
            project: "synthetic",
            conversationId: "resume-session",
            sourceBranch: "work",
            fromRef: "work",
            expectedHead: "01" + "22".repeat(32),
            newBranch: "recovery-" + name,
        });
        try {
            const active = assert.rejects(
                s.client(250).request("fork.commit", args("active")),
                (error) => error.code === "Timeout",
            );
            await until(() => s.events().includes("begin:recovery-active"), "native fork started");
            const controller = new AbortController();
            const cancelled = assert.rejects(
                s.client().request("fork.commit", args("cancelled"), { signal: controller.signal }),
                (error) => error.code === "Timeout",
            );
            await delay(90);
            controller.abort();
            await cancelled;
            await active;
            const survivor = s.client(3000).request("fork.commit", args("survivor"));
            await delay(90);
            assert.deepEqual(s.events(), ["begin:recovery-active"]);
            s.release();
            assert.equal((await survivor).kind, "Forked");
            assert.deepEqual(s.events(), [
                "begin:recovery-active",
                "done:recovery-active",
                "begin:recovery-survivor",
                "done:recovery-survivor",
            ]);
        } finally {
            await s.close();
        }
    },
);

test(
    "D5 ServiceClient reconstructs UTF-8 response split one byte per write",
    { timeout: 5000 },
    async () => {
        const { root } = runtime();
        const path = join(root, "split.sock");
        const text = "中😀résumé";
        const sockets = new Set();
        const server = createServer((socket) => {
            sockets.add(socket);
            socket.on("close", () => sockets.delete(socket));
            socket.on("error", () => {});
            socket.setEncoding("utf8");
            let request = "";
            let handled = false;
            socket.on("data", async (chunk) => {
                request += chunk;
                if (handled || !request.includes("\n")) {
                    return;
                }
                handled = true;
                const { id } = JSON.parse(request);
                const bytes = Buffer.from(
                    JSON.stringify({ id, ok: true, result: { text } }) + "\n",
                );
                for (const byte of bytes) {
                    if (socket.destroyed) {
                        return;
                    }
                    socket.write(Buffer.from([byte]));
                    await delay(1);
                }
                socket.end();
            });
        });
        await new Promise((resolve) => server.listen(path, resolve));
        const client = new ServiceClient({
            socketPath: path,
            token: "A".repeat(43),
            timeoutMs: 3000,
        });
        try {
            assert.equal((await client.request("ping", {})).text, text);
        } finally {
            client.close();
            for (const socket of sockets) {
                socket.destroy();
            }
            await new Promise((resolve) => server.close(resolve));
        }
    },
);
