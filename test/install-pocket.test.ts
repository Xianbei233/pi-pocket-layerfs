// Official isolation first; exercise actual installer output in actual Pocket.
import {
    cleanUp,
    openApp,
    owner,
    root,
    scriptedModel,
} from "/home/xianbei233/Work/pi-pocket-production/test/helpers.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { createPocketFixture } from "./fixtures/pocket-harness.ts";

const PROJECT = resolve(import.meta.dirname, "..");
after(cleanUp);
const LOGS = mkdtempSync(join(process.env.LAYERFS_TEST_LOG_DIR ?? root, "pocket-smoke-"));
function run(script: string, target: string) {
    const result = spawnSync(
        process.execPath,
        [join(PROJECT, `scripts/${script}.mjs`), "--target", target],
        {
            cwd: PROJECT,
            encoding: "utf8",
            timeout: 15_000,
            env: { ...process.env, HOME: join(root, "home") },
        },
    );
    const logs = LOGS;
    mkdirSync(logs, { recursive: true });
    writeFileSync(
        join(logs, `pocket-smoke-${script}.log`),
        `${result.stdout}\n${result.stderr}\n${result.error?.message ?? ""}`,
    );
    writeFileSync(join(logs, `pocket-smoke-${script}.exit`), `${result.status}\n`);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
}

test("actual install is off by default; product loader/browser HTTP enable-disable-restart smoke; uninstall preserves host data", async () => {
    const fixture = await createPocketFixture({
        files: [],
        enable: false,
        async beforeOpen({ dropIns }) {
            run("install", dropIns);
        },
    });
    let closed = false;
    let reopened: Awaited<ReturnType<typeof openApp>> | undefined;
    try {
        const listed = (await fixture.app.extensions(owner(fixture.app))).modules.find(
            (module) => module.file === "pocket-layerfs.ts",
        );
        assert.ok(listed);
        assert.equal(listed.enabled, false);
        assert.equal((await fixture.call("owner", "/api/x/pocket-layerfs/status")).status, 404);
        await fixture.app.setExtensionEnabled(owner(fixture.app), "pocket-layerfs.ts", true);
        const status = await fixture.call("owner", "/api/x/pocket-layerfs/status");
        assert.equal(status.status, 200);
        assert.equal((status.data as { configured: boolean }).configured, false);
        const ui = fixture.app.webs
            .clients(owner(fixture.app))
            .find((client) => client.module === "pocket-layerfs");
        assert.ok(ui, "actual browser module is registered");
        const hello = (await fixture.call("owner", "/api/me")).data as {
            server: { ui: { module: string; url: string }[] };
        };
        const asset = hello.server.ui.find((client) => client.module === "pocket-layerfs");
        assert.ok(asset);
        assert.equal((await fixture.call("owner", asset.url)).status, 200);
        assert.equal((await fixture.call("guest", asset.url)).status, 404);
        await fixture.app.setExtensionEnabled(owner(fixture.app), "pocket-layerfs.ts", false);
        assert.equal((await fixture.call("owner", "/api/x/pocket-layerfs/status")).status, 404);
        await fixture.app.setExtensionEnabled(owner(fixture.app), "pocket-layerfs.ts", true);
        await fixture.close();
        closed = true;
        reopened = await openApp(scriptedModel(), fixture.dataDir);
        const afterRestart = (await reopened.extensions(owner(reopened))).modules.find(
            (module) => module.file === "pocket-layerfs.ts",
        );
        assert.equal(afterRestart?.enabled, true);
        await reopened.close();
        reopened = undefined;
        const userFile = join(fixture.dropIns, "unrelated-user-data.txt");
        writeFileSync(userFile, "SYNTHETIC_USER_DATA_MUST_REMAIN");
        run("uninstall", fixture.dropIns);
        assert.equal(existsSync(join(fixture.dropIns, "pocket-layerfs.ts")), false);
        assert.equal(existsSync(userFile), true);
        assert.equal(
            existsSync(join(fixture.dataDir, "pocket.sqlite")),
            true,
            "temporary Pocket session database remains",
        );
    } finally {
        if (!closed) await fixture.close();
        await reopened?.close();
    }
});
