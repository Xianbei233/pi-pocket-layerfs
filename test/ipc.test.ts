// Real Unix-socket client tests with a deliberately synthetic transport peer.
// This is not a LayerFS SDK/native-engine test.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CODES, LayerfsRefusal } from "../src/pocket-layerfs/errors.ts";
import { readServiceToken, ServiceClient } from "../src/pocket-layerfs/ipc.ts";

const TOKEN = "A".repeat(43);
type Request = { id: string; v: number; token: string; op: string; args: Record<string, unknown> };

function code(wanted: string) {
    return (error: unknown) => error instanceof LayerfsRefusal && error.code === wanted;
}

async function peer(handle: (socket: Socket, request: Request) => void) {
    const root = await mkdtemp(join(tmpdir(), "lfs-ipc-"));
    const socketPath = join(root, "service.sock");
    const sockets = new Set<Socket>();
    const requests: Request[] = [];
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => {});
        socket.setEncoding("utf8");
        let text = "";
        socket.on("data", (chunk) => {
            text += chunk;
            const newline = text.indexOf("\n");
            if (newline < 0) return;
            const request = JSON.parse(text.slice(0, newline)) as Request;
            requests.push(request);
            handle(socket, request);
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => { server.off("error", reject); resolve(); });
    });
    return {
        requests,
        socketPath,
        async close() {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            await rm(root, { recursive: true, force: true });
        },
    };
}

function answer(socket: Socket, request: Request, result: unknown) {
    socket.end(JSON.stringify({ id: request.id, ok: true, result }) + "\n");
}

test("service tokens require private regular files and do not follow leaf symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "lfs-token-"));
    try {
        const path = join(root, "token");
        await writeFile(path, TOKEN, { mode: 0o600 });
        assert.equal(readServiceToken(path), TOKEN);
        await chmod(path, 0o644);
        assert.throws(() => readServiceToken(path), code(CODES.ServiceUnavailable));
        await chmod(path, 0o600);
        await symlink(path, join(root, "link"));
        assert.throws(() => readServiceToken(join(root, "link")), code(CODES.ServiceUnavailable));
        assert.throws(() => readServiceToken(root), code(CODES.ServiceUnavailable));
        await writeFile(path, "invalid token !");
        assert.throws(() => readServiceToken(path), code(CODES.ServiceUnavailable));
        await writeFile(path, "A".repeat(300));
        assert.throws(() => readServiceToken(path), code(CODES.ServiceUnavailable));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("service token read rejects a symlink in an ancestor directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "lfs-token-ancestor-"));
    try {
        const real = join(root, "real");
        await mkdir(real, { mode: 0o700 });
        await writeFile(join(real, "token"), TOKEN, { mode: 0o600 });
        await symlink(real, join(root, "alias"));
        assert.throws(() => readServiceToken(join(root, "alias", "token")), code(CODES.ServiceUnavailable));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("client sends one authenticated request and returns actual framed peer result", async () => {
    const server = await peer((socket, request) => answer(socket, request, { paths: ["/public.txt"] }));
    const client = new ServiceClient({ socketPath: server.socketPath, token: TOKEN });
    try {
        assert.deepEqual(await client.request("list", { project: "alpha", ref: "feature" }), { paths: ["/public.txt"] });
        assert.equal(server.requests.length, 1);
        assert.equal(server.requests[0].v, 1);
        assert.equal(server.requests[0].token, TOKEN);
        assert.equal(server.requests[0].op, "list");
        assert.deepEqual(server.requests[0].args, { project: "alpha", ref: "feature" });
        assert.equal(client.sockets.size, 0);
    } finally {
        client.close();
        await server.close();
    }
});

test("malformed JSON, identity mismatch, disconnect and raw upstream errors fail safely without retry", async () => {
    for (const kind of ["json", "identity", "disconnect", "upstream"] as const) {
        const server = await peer((socket, request) => {
            if (kind === "json") socket.end("{not json}\n");
            if (kind === "identity") socket.end(JSON.stringify({ id: "different", ok: true, result: "secret" }) + "\n");
            if (kind === "disconnect") socket.end();
            if (kind === "upstream") socket.end(JSON.stringify({ id: request.id, ok: false, error: { code: "Upstream", message: `LEAK ${TOKEN} /secret/store.sqlite` } }) + "\n");
        });
        const client = new ServiceClient({ socketPath: server.socketPath, token: TOKEN });
        try {
            await assert.rejects(client.request("read", {}), (error: unknown) => {
                assert.ok(error instanceof LayerfsRefusal);
                assert.ok(!error.message.includes(TOKEN));
                assert.ok(!error.message.includes("/secret"));
                if (kind === "identity" || kind === "json") assert.equal(error.code, CODES.Protocol);
                return true;
            });
            assert.equal(server.requests.length, 1, `${kind}: must not retry`);
            assert.equal(client.sockets.size, 0);
        } finally {
            client.close();
            await server.close();
        }
    }
});

test("timeout and cancellation close their sockets without retrying unknown operations", async () => {
    for (const kind of ["timeout", "cancel"] as const) {
        const server = await peer(() => {});
        const client = new ServiceClient({ socketPath: server.socketPath, token: TOKEN, timeoutMs: 250 });
        const controller = new AbortController();
        const timer = kind === "cancel" ? setTimeout(() => controller.abort(), 80) : undefined;
        try {
            await assert.rejects(client.request("fork.commit", {}, { signal: controller.signal }), code(CODES.Timeout));
            assert.equal(server.requests.length, 1);
            assert.equal(client.sockets.size, 0);
        } finally {
            if (timer) clearTimeout(timer);
            client.close();
            await server.close();
        }
    }
});

test("bounded client admission returns Busy and does not open another request", async () => {
    const server = await peer(() => {});
    const client = new ServiceClient({ socketPath: server.socketPath, token: TOKEN, timeoutMs: 250, maxConcurrent: 1 });
    try {
        const pending = assert.rejects(client.request("read", {}), code(CODES.Timeout));
        await assert.rejects(client.request("read", {}), code(CODES.Busy));
        await pending;
        assert.equal(server.requests.length, 1);
        assert.equal(client.sockets.size, 0);
    } finally {
        client.close();
        await server.close();
    }
});

test("oversized requests are rejected before dispatch and oversized replies release resources", async () => {
    const server = await peer((socket, request) => answer(socket, request, "x".repeat(4000)));
    const client = new ServiceClient({ socketPath: server.socketPath, token: TOKEN, maxResponseBytes: 512 });
    try {
        await assert.rejects(client.request("read", { value: "x".repeat(80_000) }), code(CODES.Invalid));
        assert.equal(server.requests.length, 0);
        await assert.rejects(client.request("read", {}), code(CODES.ResponseTooLarge));
        assert.equal(server.requests.length, 1);
        assert.equal(client.sockets.size, 0);
    } finally {
        client.close();
        await server.close();
    }
});

test("closing a client does not stop a shared service or remove data for another client", async () => {
    const server = await peer((socket, request) => answer(socket, request, { running: true }));
    const first = new ServiceClient({ socketPath: server.socketPath, token: TOKEN });
    const second = new ServiceClient({ socketPath: server.socketPath, token: TOKEN });
    try {
        first.close();
        await assert.rejects(first.request("status", {}), code(CODES.ServiceUnavailable));
        assert.deepEqual(await second.request("status", {}), { running: true });
        assert.equal(server.requests.length, 1);
    } finally {
        first.close();
        second.close();
        await server.close();
    }
});
