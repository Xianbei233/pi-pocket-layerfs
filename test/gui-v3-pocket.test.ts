// Official helpers first. This file uses only an isolated Pocket fixture and Browser.
import { cleanUp, root, scriptedModel } from "/home/xianbei233/Work/pi-pocket-production/test/helpers.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { Browsers } from "/home/xianbei233/Work/pi-pocket-production/src/server/browser.ts";
import { createPocketFixture } from "./fixtures/pocket-harness.ts";
import { productPeer } from "./fixtures/product-peer.ts";
import { contractConfig } from "./fixtures/strict-sdk.ts";
import { createGuiImportTree } from "./fixtures/gui-import-tree.ts";
import { guiContractDriver, FROZEN_GUI_BINDINGS } from "./fixtures/gui-contract-driver.ts";

after(cleanUp);
const SOURCE = new URL("../", import.meta.url).pathname;

test("frozen GUI routes enforce real host roles, X-Pocket, membership, sessions, and strict DTOs", { timeout: 90_000 }, async (t) => {
    let peer: any; let fixture: any;
    try {
        fixture = await createPocketFixture({
            model: scriptedModel(), files: [
                { from: join(SOURCE, "src/pocket-layerfs.ts"), name: "pocket-layerfs.ts" },
                { from: join(SOURCE, "src/pocket-layerfs"), name: "pocket-layerfs" },
            ],
            async prepare({ dataDir, session, actors }) {
                const base = contractConfig(); const svc = join(root, "v3-http-svc");
                const config = { ...base, ownerPersonIds: [actors.owner.id], write: { enabled: false }, tools: { enabled: false },
                    projects: [{ ...base.projects[0], origin: "demo" }], sessionGrants: [],
                    service: { ...base.service, runtimeDir: svc, socketPath: join(svc, "s"), tokenFile: join(svc, "t"), sdkPath: join(svc, "sdk"), layerfsHome: join(svc, "home") } };
                const dir = join(dataDir, "pocket-layerfs"); await mkdir(dir, { recursive: true, mode: 0o700 });
                await writeFile(join(dir, "config.json"), JSON.stringify(config), { mode: 0o600 });
                peer = await productPeer(config, { control: { status: () => ({ activeHash: createHash("sha256").update(JSON.stringify(config)).digest("hex"), generation: 0 }) } });
            },
        });
        t.diagnostic("Isolated data: " + fixture.dataDir);
        const driver = guiContractDriver(fixture.call, FROZEN_GUI_BINDINGS);
        for (const operation of ["status", "sessions", "preview", "confirm", "apply"] as const) {
            assert.equal((await driver.request(operation, { actor: null, body: operation === "status" || operation === "sessions" ? undefined : {} })).status, 401);
            assert.equal((await driver.request(operation, { pocketHeader: false, body: operation === "status" || operation === "sessions" ? undefined : {} })).status, 403);
            for (const actor of ["guest", "viewer", "singleSessionGuest"] as const) {
                assert.equal((await driver.request(operation, { actor, body: operation === "status" || operation === "sessions" ? undefined : {} })).status, 404);
            }
        }
        const sessions = await driver.request("sessions"); assert.equal(sessions.status, 200);
        const choices = (sessions.data as any).sessions;
        assert.ok(choices.some((s: any) => s.id === Number(fixture.session) && s.conversationId === String(fixture.session)));
        assert.ok(choices.every((s: any) => Number.isSafeInteger(s.id) && s.conversationId === String(s.id)));
        const status = await driver.request("status"); assert.equal(status.status, 200);
        const old = status.data as any;
        const draft = { projects: old.projects.map(({ id, label, branches }: any) => ({ id, label, branches })), toolsEnabled: false, sessionGrants: [] };
        for (const field of ["write", "fork", "ownerPersonIds", "service", "storePath", "sourcePath", "unknown"]) {
            const response = await fixture.call("owner", "/api/x/pocket-layerfs/gui/validate", { body: { draft: { ...draft, [field]: {} } } });
            assert.equal(response.status, 200, field);
            assert.equal((response.data as any).ok, false, field);
            assert.ok((response.data as any).errors.length > 0, field);
            const forbidden = await driver.request("apply", { body: { expectedSha256: old.savedHash, draft: { ...draft, [field]: {} } } });
            assert.equal(forbidden.status, 400, field + " apply");

        }
        const tree = await createGuiImportTree();
        const forbiddenPreview = await driver.request("preview", { body: {
            expectedSha256: old.savedHash, projectId: "dto-" + crypto.randomUUID().slice(0, 8),
            label: "DTO probe", sourcePath: tree.source, branches: ["main"],
            service: { sdkPath: "/forbidden" }, write: { enabled: true }, unknown: true,
        } });
        assert.equal(forbiddenPreview.status, 400, "Preview must reject unknown and privileged body fields");
    } finally { await fixture?.close(); await peer?.close(); }
});

test("ordinary Menu opens Configuration and its unchanged form must pass strict validation", { timeout: 90_000 }, async (t) => {
    let peer: any; let fixture: any; let browsers: any; let page: any;
    try {
        fixture = await createPocketFixture({ model: scriptedModel(), files: [
            { from: join(SOURCE, "src/pocket-layerfs.ts"), name: "pocket-layerfs.ts" },
            { from: join(SOURCE, "src/pocket-layerfs"), name: "pocket-layerfs" },
        ], async prepare({ dataDir, actors }) {
            const base = contractConfig(); const svc = join(root, "v3-ui-svc");
            const config = { ...base, ownerPersonIds: [actors.owner.id], write: { enabled: false }, tools: { enabled: false },
                projects: [{ ...base.projects[0], origin: "demo" }], sessionGrants: [],
                service: { ...base.service, runtimeDir: svc, socketPath: join(svc, "s"), tokenFile: join(svc, "t"), sdkPath: join(svc, "sdk"), layerfsHome: join(svc, "home") } };
            const dir = join(dataDir, "pocket-layerfs"); await mkdir(dir, { recursive: true, mode: 0o700 });
            await writeFile(join(dir, "config.json"), JSON.stringify(config), { mode: 0o600 }); peer = await productPeer(config, { control: { status: () => ({ activeHash: createHash("sha256").update(JSON.stringify(config)).digest("hex"), generation: 0 }) } });
        } });
        browsers = new Browsers({ dataDir: join(root, "v3-own-browser"), load: async () => undefined, save: () => {} });
        page = await browsers.open(1); await page.setViewport({ width: 390, height: 844, scale: 1, mobile: true });
        const evaluate = async (script: string) => JSON.parse(await page.evaluate(script));
        async function waitFor(script: string, label: string) {
            for (let i = 0; i < 60; i++) { if (await evaluate("return JSON.stringify(" + script + ")")) return; await new Promise((r) => setTimeout(r, 100)); }
            throw new Error("UI wait failed: " + label);
        }
        async function tap(selector: string, text = "") {
            await new Promise((r) => setTimeout(r, 700));
            const at = await evaluate('const e=[...document.querySelectorAll(' + JSON.stringify(selector) + ')].find(e=>e.textContent.includes(' + JSON.stringify(text) + ')&&e.getBoundingClientRect().width>0); if(!e)throw new Error("No visible control");e.scrollIntoView({block:"center"}); const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);return JSON.stringify({x,y,hit:h===e||e.contains(h)})');
            assert.equal(at.hit, true, "A visible control must receive the tap"); await page.click({ x: at.x, y: at.y });
        }
        const failures: string[] = [];
        for (const [width, height] of [[390, 844], [1280, 800]]) {
            await page.setViewport({ width, height, scale: 1, mobile: width === 390 });
            await page.navigate(fixture.base + "/login?token=" + encodeURIComponent(fixture.actors.owner.token));
            await page.navigate(fixture.base + "/s/" + fixture.session);
            await waitFor('Boolean(document.querySelector(".topbar button[aria-label=Menu]"))', "ordinary session Menu");
            await tap('.topbar button[aria-label="Menu"]');
            await waitFor('Boolean(document.querySelector(".nav-menu"))', "ordinary Menu");
            await tap(".nav-menu button", "LayerFS");
            await waitFor('[...document.querySelectorAll(".layerfs button")].some(e=>/Configuration|配置/.test(e.textContent))', "Configuration entry");
            await tap(".layerfs button", "Configuration");
            await waitFor('[...document.querySelectorAll(".layerfs button")].some(e=>/Validate|验证/.test(e.textContent))', "Validate form");
            await tap(".layerfs button", "Validate");
            await new Promise((r) => setTimeout(r, 200));
            const text = await evaluate('return JSON.stringify(document.body.innerText)');
            const path = join(SOURCE, ".runtime-gui-test-exec-vgskYGIp", "configuration-" + width);
            await writeFile(path + ".txt", text);
            const screenshot = await page.screenshot({ fullPage: true });
            await writeFile(path + ".jpg", Buffer.from(screenshot.data, "base64"));
            await writeFile(path + "-console.json", JSON.stringify(page.logs(), null, 2));
            if (text.includes("origin is not editable")) failures.push(width + ": GUI submits forbidden origin metadata");
            assert.ok(text.includes("Demo"), "Demo metadata must remain visible");
        }
        assert.deepEqual(failures, [], "Both normal-menu forms must validate");
    } finally { await browsers?.closeAll({ final: true }); await fixture?.close(); await peer?.close(); }
});


test("unconfigured GUI reports setup limits and registers no model tools", { timeout: 30_000 }, async () => {
    const f = await createPocketFixture({ model: scriptedModel(), files: [
        { from: join(SOURCE, "src/pocket-layerfs.ts"), name: "pocket-layerfs.ts" },
        { from: join(SOURCE, "src/pocket-layerfs"), name: "pocket-layerfs" },
    ] });
    try {
        const response = await f.call("owner", "/api/x/pocket-layerfs/gui/status");
        assert.equal(response.status, 200); const status = response.data as any;
        assert.equal(status.configured, false); assert.equal(status.state, "unconfigured");
        assert.deepEqual(status.projects, []); assert.equal(status.service?.ok === true, false);
    } finally { await f.close(); }
});
