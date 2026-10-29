// Official helpers must be imported before this file by the integration test.
import { cp, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createPocketFixture } from "./pocket-harness.ts";
import { validateConfig } from "../../src/pocket-layerfs/v3/config.ts";
import { createRuntime } from "../../src/pocket-layerfs/v3/runtime.ts";
import { previewImport, confirmImport } from "../../src/pocket-layerfs/v3/import.ts";
import { assertExclusiveRuntime } from "../../scripts/runtime-lib.mjs";
import { verifySdkProvenance } from "../../scripts/verify-lib.mjs";
import { ownedGuiService } from "./gui-owned-service.ts";

const SOURCE = new URL("../../", import.meta.url).pathname;
const EVIDENCE = join(SOURCE, ".runtime-gui-retest-32DMIOAL");
const ARTIFACT = join(EVIDENCE, "artifact", "package");

export async function nativeGuiFixture(model: any) {
    const runtime = await mkdtemp(join(EVIDENCE, "gui-native-"));
    const short = await mkdtemp("/tmp/lgn-");
    const sdkRoot = join(runtime, "native"); assertExclusiveRuntime(sdkRoot, { create: true });
    await cp(join(SOURCE, ".runtime", "sdk"), join(sdkRoot, "sdk"), { recursive: true, dereference: false });
    verifySdkProvenance(SOURCE, join(sdkRoot, "sdk"), { requireOfficialSdk: true });
    let owned: any; let config: any; let fixedPath = "";
    const fixture = await createPocketFixture({ model, dataParent: runtime, files: [
        { from: join(ARTIFACT, "src/pocket-layerfs.ts"), name: "pocket-layerfs.ts" },
        { from: join(ARTIFACT, "src/pocket-layerfs"), name: "pocket-layerfs" },
    ], async prepare({ dataDir, actors }) {
        await chmod(dataDir, 0o700);
        for (const path of [join(dataDir, "pocket-layerfs"), join(short, "svc"), join(short, "home")]) await mkdir(path, { recursive: true, mode: 0o700 });
        config = validateConfig({ version: 1, ownerPersonIds: [actors.owner.id], write: { enabled: false }, tools: { enabled: false },
            service: { runtimeDir: join(short, "svc"), socketPath: join(short, "svc", "s"), tokenFile: join(short, "svc", "t"), layerfsHome: join(short, "home"), sdkPath: join(sdkRoot, "sdk") }, projects: [], sessionGrants: [] });
        fixedPath = join(dataDir, "pocket-layerfs", "config.json"); await writeFile(fixedPath, JSON.stringify(config), { mode: 0o600 });
        const demoSource = join(short, "demo-source"); await mkdir(demoSource, { mode: 0o700 });
        await writeFile(join(demoSource, "demo.txt"), "Preserved metadata Demo, not the imported source.\n");
        const active = createRuntime({ host: { dataDir }, path: fixedPath, config });
        const projectId = "demo-" + randomUUID().slice(0, 8);
        try {
            const p = previewImport(active, { ownerId: actors.owner.id, expectedSha256: active.activeHash, projectId, label: "Preserved Demo", sourcePath: demoSource, branches: ["main"] });
            await confirmImport(active, { ownerId: actors.owner.id, ticket: p.ticket, expectedSha256: active.activeHash });
            config = validateConfig({ ...config, projects: [{ id: projectId, label: "Preserved Demo", origin: "demo", branches: ["main"], storePath: join(dataDir, "pocket-layerfs", "projects", projectId, "store.sqlite") }] });
            await writeFile(fixedPath, JSON.stringify(config), { mode: 0o600 });
        } finally { active.client.close(); }
        owned = await ownedGuiService(join(ARTIFACT, "service/main.mjs"), fixedPath, short);
    } });
    return { fixture, runtime, short, config, fixedPath, artifact: ARTIFACT,
        async replaceService() { await owned.stop(); owned = await ownedGuiService(join(ARTIFACT, "service/main.mjs"), fixedPath, short); },
        async close() { await fixture.close(); await owned?.stop(); },
    };
}
