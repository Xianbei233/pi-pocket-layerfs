// Official isolated helpers first. No production Browser or paid provider.
import { cleanUp, lastText, modelTexts, owner, say, scriptedModel } from "/home/xianbei233/Work/pi-pocket-production/test/helpers.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "/home/xianbei233/Work/pi-pocket-production/src/server/browser.ts";
import { nativeGuiFixture } from "./fixtures/gui-native-pocket.ts";
import { createGuiImportTree } from "./fixtures/gui-import-tree.ts";

after(cleanUp);

test("extracted artifact native GUI onboards through normal Chinese/mobile and English/desktop menus", { timeout: 180_000 }, async (t) => {
    const model = scriptedModel((request) => {
        const last = lastText(request as never);
        if (last.role === "toolResult") return fauxAssistantMessage([fauxText(last.text)]);
        if (last.text === "inventory") return fauxAssistantMessage([fauxText("inventory")]);
        const wanted = JSON.parse(last.text.replace(/^\[from:[^\]]+\]\s*/, ""));
        return fauxAssistantMessage([fauxToolCall(wanted.tool, wanted.args)], { stopReason: "toolUse" });
    });
    let f: Awaited<ReturnType<typeof nativeGuiFixture>> | undefined; let browsers: any; let page: any;
    try {
        f = await nativeGuiFixture(model); const fixture = f.fixture;
        t.diagnostic("Retained real GUI: " + f.runtime);
        browsers = new Browsers({ dataDir: join(f.short, "browser"), load: async () => undefined, save: () => {} });
        const baseline = JSON.parse(await readFile(f.fixedPath, "utf8"));
        const demoBytes = await readFile(baseline.projects[0].storePath);
        for (const [width, height, lang] of [[390, 844, "zh-CN"], [1280, 800, "en"]] as const) {
            await fixture.app.setExtensionEnabled(owner(fixture.app), "pocket-layerfs.ts", false);
            page = await browsers.open(width); await page.setViewport({ width, height, scale: 1, mobile: width === 390 });
            const ev = async (body: string) => JSON.parse(await page.evaluate(body));
            async function wait(expression: string, label: string) {
                for (let i = 0; i < 150; i++) {
                    if (await ev("return JSON.stringify(" + expression + ")")) return;
                    await new Promise((r) => setTimeout(r, 100));
                }
                throw new Error("Native GUI wait failed: " + label);
            }
            async function tap(selector: string, text = "") {
                await wait('!document.querySelector(".notice")', "transient notice clears");
                await new Promise((r) => setTimeout(r, 550));
                const at = await ev('const e=[...document.querySelectorAll(' + JSON.stringify(selector) + ')].find(e=>e.textContent.trim()===' + JSON.stringify(text) + '||(!' + JSON.stringify(text) + '&&e.getBoundingClientRect().width>0));if(!e)throw new Error("Missing visible button");e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);return JSON.stringify({x,y,hit:h===e||e.contains(h)})');
                assert.equal(at.hit, true); await page.click({ x: at.x, y: at.y });
            }
            async function fill(label: string, value: string, last = false) {
                await ev('const a=[...document.querySelectorAll(".layerfs label")].filter(e=>e.querySelector("span")?.textContent.trim()===' + JSON.stringify(label) + ');const e=a[' + (last ? 'a.length-1' : '0') + ']?.querySelector("input");if(!e)throw new Error("Missing input");e.dataset.fixtureField="active";return "true"');
                await page.type({ selector: '[data-fixture-field="active"]' }, value);
                await ev('document.querySelector("[data-fixture-field=active]").removeAttribute("data-fixture-field");return "true"');
            }
            async function checkbox(label: string) {
                await ev('const e=[...document.querySelectorAll(".layerfs label")].find(e=>e.querySelector("span")?.textContent.trim()===' + JSON.stringify(label) + ')?.querySelector("input[type=checkbox]");if(!e)throw new Error("Missing checkbox");if(!e.checked){e.click();}return "true"');
            }
            await page.navigate(fixture.base + "/login?token=" + encodeURIComponent(fixture.actors.owner.token));
            await page.navigate(fixture.base + "/s/" + fixture.session);
            await wait('Boolean(document.querySelector(".topbar button[aria-label=Menu]"))', "session");
            await ev('document.documentElement.lang=' + JSON.stringify(lang) + ';return "true"');
            await fixture.app.setExtensionEnabled(owner(fixture.app), "pocket-layerfs.ts", true);
            await new Promise((r) => setTimeout(r, 800));
            await tap('.topbar button[aria-label="Menu"]');
            await wait('Boolean(document.querySelector(".nav-menu"))', "Menu");
            await wait('document.getAnimations().every(a=>a.effect?.getComputedTiming().endTime===Infinity||a.playState!=="running")', "Menu animation");
            // The Menu row includes its ordinary hint. Use its visible hit-tested coordinate.
            await new Promise((r) => setTimeout(r, 500));
            const menu = await ev('const e=[...document.querySelectorAll(".nav-menu button")].find(e=>e.textContent.includes("LayerFS"));e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})');
            await new Promise((r) => setTimeout(r, 400));
            const row = await ev('const e=[...document.querySelectorAll(".nav-menu button")].find(e=>e.textContent.includes("LayerFS"));const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);return JSON.stringify({x,y,hit:h===e||e.contains(h)})');
            assert.equal(row.hit,true,"Ordinary Menu LayerFS row hit"); await page.click({x:row.x,y:row.y});
            const zh = lang.startsWith("zh");
            await wait('[...document.querySelectorAll(".layerfs button")].some(e=>e.textContent.trim()===' + JSON.stringify(zh ? "配置" : "Configuration") + ')', "Configuration");
            await tap(".layerfs button", zh ? "配置" : "Configuration");
            await wait('document.querySelectorAll(".layerfs input").length>=3', "Configuration form");
            const tree = await createGuiImportTree(); const before = await tree.snapshot();
            const project = "gui-" + randomUUID().slice(0, 8);
            await fill(zh ? "项目 ID" : "Project id", project);
            await fill(zh ? "名称" : "Label", "Imported " + width, true);
            await fill(zh ? "源目录（绝对路径）" : "Source folder (absolute path)", tree.source);
            await tap(".layerfs button", zh ? "预览导入" : "Preview import");
            await wait('Boolean(document.querySelector(".layerfs-preview"))', "preview");
            await tap(".layerfs button", zh ? "确认导入" : "Confirm import");
            await wait('document.body.innerText.includes(' + JSON.stringify(zh ? "未发布 Store" : "Unpublished Store") + ')', "confirmed Store");
            await checkbox(zh ? "只读工具" : "Read-only tools");
            await tap(".layerfs button", "+ " + (zh ? "会话授权" : "Conversation grants"));
            await ev('const rows=[...document.querySelectorAll(".layerfs-config-row")].filter(e=>e.querySelector("select"));const row=rows.at(-1);const selects=row.querySelectorAll("select");selects[0].value=' + JSON.stringify(String(fixture.session)) + ';selects[0].dispatchEvent(new Event("change",{bubbles:true}));return "true"');
            await ev('const row=[...document.querySelectorAll(".layerfs-config-row")].filter(e=>e.querySelector("select")).at(-1);const e=row.querySelectorAll("select")[1];e.value=' + JSON.stringify(project) + ';e.dispatchEvent(new Event("change",{bubbles:true}));return "true"');
            await checkbox(zh ? "允许工具" : "Allow tools"); await checkbox("main");
            await tap(".layerfs button", zh ? "保存并应用" : "Save and apply");
            await wait('!document.querySelector(".layerfs button[disabled]") || document.body.innerText.includes(' + JSON.stringify(zh ? "完成" : "Done") + ')', "apply completion");
            const status = await fixture.call("owner", "/api/x/pocket-layerfs/gui/status"); const state = status.data as any;
            await writeFile(join(f.runtime, "gui-" + width + "-status.json"), JSON.stringify(state, null, 2));
            assert.equal(state.state, "active"); assert.equal(state.savedHash, state.activeHash); assert.equal(state.savedHash, state.serviceHash);
            assert.ok(state.projects.some((p: any) => p.id === project));
            assert.ok(state.sessionGrants.some((g: any) => g.conversationId === String(fixture.session) && g.project === project));
            const screenshot = await page.screenshot({ fullPage: true }); await writeFile(join(f.runtime, "gui-" + width + ".jpg"), Buffer.from(screenshot.data, "base64"));
            await say(fixture.app, fixture.session, JSON.stringify({ tool: "layerfs_read", args: { project, ref: "main", path: "/public.txt", startLine: 1, endLine: 20 } }));
            const text = (await modelTexts(fixture.app, fixture.session)).at(-1) ?? "";
            assert.ok(text.includes("Independent GUI fixture, not the demo."));
            await writeFile(join(f.runtime, "gui-" + width + "-tool.txt"), text);
            assert.deepEqual(await tree.snapshot(), before);
            await page.navigate(fixture.base + "/s/" + fixture.session);
            await fixture.app.setExtensionEnabled(owner(fixture.app), "pocket-layerfs.ts", false);
            await fixture.app.setExtensionEnabled(owner(fixture.app), "pocket-layerfs.ts", true);
            const persisted = (await fixture.call("owner", "/api/x/pocket-layerfs/gui/status")).data as any;
            assert.equal(persisted.savedHash, state.savedHash); assert.equal(persisted.serviceHash, state.savedHash);
        }
        await f.replaceService();
        const status = (await f.fixture.call("owner", "/api/x/pocket-layerfs/gui/status")).data as any;
        assert.equal(status.savedHash, status.activeHash); assert.equal(status.savedHash, status.serviceHash);
        assert.deepEqual(await readFile(baseline.projects[0].storePath), demoBytes, "Demo Store changed");
    } catch (error) {
        if (f && page) {
            await writeFile(join(f.runtime, "failure-dom.json"), await page.evaluate('return JSON.stringify({text:document.body.innerText,html:document.querySelector(".ext-page")?.outerHTML})'));
            await writeFile(join(f.runtime, "failure-console.json"), JSON.stringify(page.logs(), null, 2));
            const shot = await page.screenshot({ fullPage: true }); await writeFile(join(f.runtime, "failure.jpg"), Buffer.from(shot.data, "base64"));
        }
        throw error;
    } finally { await browsers?.closeAll({ final: true }); await f?.close(); }
});
