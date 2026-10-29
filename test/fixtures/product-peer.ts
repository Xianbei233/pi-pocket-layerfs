// Explicit synthetic IPC peer for PRODUCT drop-in/HTTP/model integration.
// Calls the actual Engine + v1.0.0 SDK wrappers, but not service/main or native Store.
import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { Engine } from "../../service/engine.mjs";
import { CODES, LayerfsRefusal } from "../../src/pocket-layerfs/errors.ts";
import { strictSdk } from "./strict-sdk.ts";

export const PEER_TOKEN = "Z".repeat(43);
export async function productPeer(config: any, options: { readText?: string; control?: { status: () => unknown; apply?: (args: any) => Promise<unknown> } } = {}) {
    const sdk = strictSdk(options);
    const upstream = { version: "1.0.0", commit: "2aaf2552ce21154928b9f9c83582e41a637f5910" };
    const engine = new Engine({ config, LayerFS: sdk.LayerFS, upstream, log: () => {} });
    const sockets = new Set<Socket>();
    const operations: { op: string; args: Record<string, unknown> }[] = [];
    await mkdir(config.service.runtimeDir, { recursive: true, mode: 0o700 });
    await writeFile(config.service.tokenFile, PEER_TOKEN, { mode: 0o600 });
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => {});
        socket.setEncoding("utf8");
        let text = "";
        let handled = false;
        socket.on("data", (chunk) => {
            if (handled) return;
            text += chunk;
            if (!text.includes("\n")) return;
            handled = true;
            void (async () => {
                const request = JSON.parse(text.slice(0, text.indexOf("\n")));
                let response;
                try {
                    assert.equal(request.token, PEER_TOKEN);
                    assert.equal(request.v, 1);
                    operations.push({ op: request.op, args: request.args });
                    const args = request.args;
                    let result;
                    switch (request.op) {
                        case "ping": result = engine.ping(upstream); break;
                        case "config.status": if (!options.control) throw new LayerfsRefusal(CODES.Invalid); result = options.control.status(); break;
                        case "config.apply": if (!options.control?.apply) throw new LayerfsRefusal(CODES.Invalid); result = await options.control.apply(args); break;
                        case "branches": result = await engine.listBranches(args); break;
                        case "commits": result = await engine.listCommits(args); break;
                        case "commit": result = await engine.oneCommit(args); break;
                        case "tree": result = await engine.tree(args); break;
                        case "stat": result = await engine.stat(args); break;
                        case "read": result = await engine.read(args); break;
                        case "diff": result = await engine.diff(args); break;
                        case "blame": result = await engine.blame(args); break;
                        case "file-history": result = await engine.fileHistory(args); break;
                        case "fork.plan": result = await engine.forkPlan(args); break;
                        case "fork.commit": result = await engine.forkCommit(args); break;
                        default: throw new LayerfsRefusal(CODES.Invalid);
                    }
                    response = { id: request.id, ok: true, result };
                } catch (error) {
                    response = { id: request.id, ok: false, error: { code: error instanceof LayerfsRefusal ? error.code : CODES.Upstream } };
                }
                if (!socket.destroyed) socket.end(JSON.stringify(response) + "\n");
            })();
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.service.socketPath, () => { server.off("error", reject); resolve(); });
    });
    await chmod(config.service.socketPath, 0o700);
    return {
        engine, sdk, operations,
        async close() {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
            await engine.close();
        },
    };
}
