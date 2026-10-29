// Direct plugin/service fixtures only. Pocket integration must import official helpers first.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateConfig } from "../../src/pocket-layerfs/v3/config.ts";
import { createRuntime } from "../../src/pocket-layerfs/v3/runtime.ts";
import { readOwnBytes } from "../../src/pocket-layerfs/v3/config-store.ts";

export async function directGuiRuntime(parent = "/tmp") {
    const root = await mkdtemp(join(parent, "lvg-"));
    const dataDir = join(root, "data");
    const service = join(root, "svc");
    const home = join(root, "home");
    const sdk = join(root, "sdk");
    const store = join(root, "old", "store.sqlite");
    for (const path of [dataDir, service, home, sdk, join(root, "old"), join(dataDir, "pocket-layerfs")]) {
        await mkdir(path, { recursive: true, mode: 0o700 });
    }
    await writeFile(join(sdk, "index.js"), "// Test stub, never a trusted native SDK.\n", { mode: 0o600 });
    await writeFile(store, "OLD_STORE_MUST_REMAIN", { mode: 0o600 });
    const project = "p-" + randomUUID().slice(0, 8);
    const owner = randomUUID();
    const config = validateConfig({
        version: 1, ownerPersonIds: [owner], write: { enabled: false }, tools: { enabled: false },
        service: { runtimeDir: service, socketPath: join(service, "s"), tokenFile: join(service, "t"),
            layerfsHome: home, sdkPath: sdk },
        projects: [{ id: project, label: "Preserved Demo", origin: "demo", storePath: store, branches: ["main"] }],
        sessionGrants: [],
    });
    const path = join(dataDir, "pocket-layerfs", "config.json");
    await writeFile(path, JSON.stringify(config, null, 4) + "\n", { mode: 0o600 });
    const runtime = createRuntime({ host: { dataDir }, path, config });
    return { root, dataDir, owner, project, config, path, runtime,
        saved: () => readOwnBytes(path)!,
        close: () => runtime.client.close() };
}

export function testWeb() {
    return { error(status: number, message: string) { return Object.assign(new Error(message), { status }); } };
}
