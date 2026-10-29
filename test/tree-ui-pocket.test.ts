// Official isolation first. The SDK dispatcher is synthetic; Chromium and Pocket are real.
import {
    cleanUp,
    root,
    scriptedModel,
    until,
} from "/home/xianbei233/Work/pi-pocket-production/test/helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import { Browsers } from "/home/xianbei233/Work/pi-pocket-production/src/server/browser.ts";
import { createPocketFixture } from "./fixtures/pocket-harness.ts";
import { contractConfig, PATH } from "./fixtures/strict-sdk.ts";
import { productPeer } from "./fixtures/product-peer.ts";

const PROJECT = resolve(import.meta.dirname, "..");
// A read-only old release copy permits red reproduction while the developer edits current source.
const SOURCE = process.env.LAYERFS_UI_SOURCE_ROOT ?? PROJECT;
const LOGS = mkdtempSync(join(process.env.LAYERFS_TEST_LOG_DIR ?? tmpdir(), "tree-ui-"));
after(cleanUp);

test(
    "visible Tree returns to the containing directory after root/nested File, Blame, File history, History and Diff",
    { timeout: 115000 },
    async () => {
        let peer: Awaited<ReturnType<typeof productPeer>> | undefined;
        let fixture: Awaited<ReturnType<typeof createPocketFixture>> | undefined;
        let browsers: Browsers | undefined;
        let page: Awaited<ReturnType<Browsers["open"]>> | undefined;
        const accepted: unknown[] = [];
        try {
            fixture = await createPocketFixture({
                model: scriptedModel(),
                files: [
                    { from: join(SOURCE, "src/pocket-layerfs.ts"), name: "pocket-layerfs.ts" },
                    { from: join(SOURCE, "src/pocket-layerfs"), name: "pocket-layerfs" },
                ],
                async prepare({ dataDir, session, actors }) {
                    const service = join(root, "tree-ui-ipc");
                    const base = contractConfig();
                    const config = {
                        ...base,
                        ownerPersonIds: [actors.owner.id],
                        write: { enabled: false },
                        projects: [base.projects[0]],
                        service: {
                            ...base.service,
                            runtimeDir: service,
                            socketPath: join(service, "s"),
                            tokenFile: join(service, "t"),
                            sdkPath: join(service, "sdk"),
                            layerfsHome: join(service, "home"),
                        },
                        sessionGrants: [
                            {
                                ...base.sessionGrants[0],
                                conversationId: String(session),
                                fork: { enabled: false },
                            },
                        ],
                    };
                    const directory = join(dataDir, "pocket-layerfs");
                    await mkdir(directory, { recursive: true, mode: 0o700 });
                    await writeFile(join(directory, "config.json"), JSON.stringify(config), {
                        mode: 0o600,
                    });
                    peer = await productPeer(config);
                    const dispatch = peer.sdk.LayerFS.prototype.call;
                    peer.sdk.LayerFS.prototype.call = async function (method, args) {
                        // Official v1.0.0 reads::list includes path and inode. The old strict fixture does not.
                        if (method === "fs.list") {
                            assert.ok(
                                args.path === "/" || args.path === "/docs",
                                "never list a file as a directory",
                            );
                            return {
                                snapshot: args.branch,
                                path: args.path,
                                items:
                                    args.path === "/"
                                        ? [
                                              {
                                                  name: "public.txt",
                                                  path: PATH,
                                                  type: "file",
                                                  inode: 7,
                                              },
                                              {
                                                  name: "docs",
                                                  path: "/docs",
                                                  type: "dir",
                                                  inode: 8,
                                              },
                                          ]
                                        : [
                                              {
                                                  name: "nested.txt",
                                                  path: "/docs/nested.txt",
                                                  type: "file",
                                                  inode: 9,
                                              },
                                          ],
                                hasMore: false,
                                nextPagePos: null,
                            };
                        }
                        if (method === "fs.stat" && args.path === "/docs") {
                            return { type: "dir", inode: 8, size: 0 };
                        }
                        const mapped = { ...args };
                        if (mapped.path === "/docs/nested.txt") {
                            mapped.path = PATH;
                        }
                        for (const side of ["left", "right"]) {
                            const value = mapped[side] as { path?: string } | undefined;
                            if (value?.path === "/docs/nested.txt") {
                                mapped[side] = { ...value, path: PATH };
                            }
                        }
                        return await dispatch.call(this, method, mapped);
                    };
                },
            });
            browsers = new Browsers({
                dataDir: join(root, "tree-ui-browser"),
                load: async () => undefined,
                save: () => {},
            });
            page = await browsers.open(1);
            await page.setViewport({ width: 1280, height: 800, scale: 1, mobile: false });
            const evaluate = async <T>(body: string): Promise<T> =>
                JSON.parse(await page!.evaluate(body));
            const wait = async (expression: string, label: string) =>
                until(
                    async () =>
                        evaluate<boolean>(
                            'const errors=[...document.querySelectorAll(".layerfs .error-box")].map(e=>e.textContent); if(errors.length)throw new Error(JSON.stringify(errors));return JSON.stringify(' +
                                expression +
                                ")",
                        ),
                    label,
                    8000,
                );
            const settle = async () => {
                await wait(
                    'document.getAnimations().every(a=>a.effect?.getComputedTiming().endTime===Infinity||a.playState!=="running"||a.effect?.target?.closest?.(".notices"))',
                    "finite animations end",
                );
                await new Promise((done) => setTimeout(done, 600));
            };
            const click = async (selector: string, text: string) => {
                await settle();
                const at = await evaluate<{ x: number; y: number; hit: boolean }>(
                    "const es=[...document.querySelectorAll(" +
                        JSON.stringify(selector) +
                        ")].filter(e=>e.textContent.replaceAll(' ','').replaceAll(String.fromCharCode(10),'').trim()===" +
                        JSON.stringify(
                            text.replaceAll(" ", "").replaceAll(String.fromCharCode(10), "").trim(),
                        ) +
                        '&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0);if(es.length!==1)throw new Error("Expected 1 visible target: "+es.length);const e=es[0];e.scrollIntoView({block:"center",inline:"center"});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,h=document.elementFromPoint(x,y);return JSON.stringify({x,y,hit:h===e||e.contains(h)})',
                );
                assert.equal(at.hit, true, "visible target must receive a real click: " + text);
                await page!.click({ x: at.x, y: at.y });
            };
            await page.navigate(
                fixture.base + "/login?token=" + encodeURIComponent(fixture.actors.owner.token),
            );
            await page.navigate(fixture.base + "/s/" + fixture.session);
            await page.evaluate(
                'globalThis.__treeRequests=[];const originalFetch=globalThis.fetch;globalThis.fetch=async(...args)=>{const url=String(args[0]?.url??args[0]);try{const response=await originalFetch(...args);if(url.includes("/api/x/pocket-layerfs/")){globalThis.__treeRequests.push({url,status:response.status,body:await response.clone().text()});}return response;}catch(error){if(url.includes("/api/x/pocket-layerfs/"))globalThis.__treeRequests.push({url,error:String(error)});throw error;}};return "recording"',
            );
            await wait(
                "Boolean(document.querySelector('.sidebar .rail-ext[title=\"LayerFS\"]'))",
                "LayerFS rail",
            );
            await click('.sidebar .rail-ext[title="LayerFS"]', "");
            await wait('Boolean(document.querySelector(".layerfs-row.file"))', "root Tree rows");
            for (const directory of ["/", "/docs"]) {
                if (directory === "/docs") {
                    await click(".layerfs-row.dir", "dirdocs");
                    await wait(
                        'document.querySelector(".layerfs-row.file")?.textContent.includes("nested.txt")===true',
                        "nested directory rows",
                    );
                }
                const name = directory === "/" ? "public.txt" : "nested.txt";
                for (const view of ["File", "Blame", "File history", "History", "Diff"]) {
                    await click(".layerfs-row.file", "file" + name);
                    await wait(
                        'document.querySelector(".layerfs-code")?.textContent.includes("BBBB")===true',
                        "real file content " + name,
                    );
                    if (view !== "File") {
                        await click(".layerfs-tabs button", view);
                        const content =
                            view === "Blame"
                                ? 'document.querySelector(".layerfs-blame-text")?.textContent.includes("BBBB")===true'
                                : view === "File history"
                                  ? 'document.querySelector(".layerfs-panel")?.textContent.includes("modified · same inode and same size edit")===true'
                                  : view === "History"
                                    ? 'document.querySelector(".layerfs-commit-row")?.textContent.includes("same inode and same size edit")===true'
                                    : 'document.querySelector(".layerfs-diff summary")?.textContent.includes("/public.txt")===true';
                        await wait(content, view + " actual content");
                    }
                    const mark = await evaluate<number>(
                        "return JSON.stringify(globalThis.__treeRequests.length)",
                    );
                    await click(".layerfs-tabs button", "Tree");
                    await wait(
                        'document.querySelector(".layerfs-row.file")?.textContent.includes(' +
                            JSON.stringify(name) +
                            ")===true && !document.querySelector('.layerfs [aria-label=\"Reading tree\"]')",
                        "usable Tree after " + directory + " " + view,
                    );
                    const requests = await evaluate<
                        { url: string; status: number; body: string }[]
                    >("return JSON.stringify(globalThis.__treeRequests.slice(" + mark + "))");
                    const tree = requests.find((entry) => entry.url.includes("/tree?"));
                    assert.ok(tree, "Tree must request a fresh directory response");
                    assert.equal(
                        new URL(tree.url, fixture.base).searchParams.get("path"),
                        directory,
                    );
                    assert.equal(tree.status, 200);
                    assert.ok(
                        JSON.parse(tree.body).items.some(
                            (item: { path: string }) =>
                                item.path === (directory === "/" ? PATH : "/docs/nested.txt"),
                        ),
                    );
                    assert.deepEqual(
                        requests.filter((entry) => entry.status >= 400),
                        [],
                    );
                    accepted.push({ directory, view, treePath: directory, status: tree.status });
                }
            }
            const errors = page.logs().filter((entry) => entry.level === "error");
            assert.deepEqual(errors, [], "browser console must have no request/runtime error");
            writeFileSync(join(LOGS, "accepted.json"), JSON.stringify(accepted, null, 2));
            console.log("TREE_UI_ACCEPTED", JSON.stringify(accepted));
        } catch (error) {
            if (page) {
                try {
                    writeFileSync(
                        join(LOGS, "failure-dom.json"),
                        await page.evaluate(
                            'return JSON.stringify({dom:document.querySelector(".ext-page")?.outerHTML,requests:globalThis.__treeRequests,selected:[...document.querySelectorAll(".layerfs select")].map(e=>e.value)})',
                        ),
                    );
                    writeFileSync(
                        join(LOGS, "failure-console.json"),
                        JSON.stringify(page.logs(), null, 2),
                    );
                    const shot = await page.screenshot({ fullPage: true });
                    writeFileSync(join(LOGS, "failure.jpg"), Buffer.from(shot.data, "base64"));
                } catch (capture) {
                    console.log("TREE_UI_CAPTURE_ERROR", String(capture));
                }
            }
            throw error;
        } finally {
            await browsers?.closeAll({ final: true });
            await fixture?.close();
            await peer?.close();
            console.log("TREE_UI_LOGS", LOGS);
            console.log("TREE_UI_OWN_CLEANUP_DONE");
        }
    },
);
