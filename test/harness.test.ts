// Harness self-test only: the synthetic probe is NOT the LayerFS product.
import { cleanUp, createPocketFixture, owner } from "./fixtures/pocket-harness.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";

// The helper's temporary data root must outlive all apps, then be removed once.
after(cleanUp);

test("isolated official Pocket harness loads a probe and applies real HTTP access/lifecycle checks", async () => {
    const fixture = await createPocketFixture({
        module: "synthetic-layerfs-probe",
        files: [{ from: new URL("./fixtures/harness-probe.ts", import.meta.url).pathname, name: "synthetic-layerfs-probe.ts" }],
        enable: false,
    });
    try {
        const path = "/api/x/synthetic-layerfs-probe/status";
        assert.equal((await fixture.call("owner", path)).status, 404);
        await fixture.app.setExtensionEnabled(owner(fixture.app), "synthetic-layerfs-probe.ts", true);
        const status = await fixture.call("owner", path);
        assert.equal(status.status, 200);
        assert.deepEqual(status.data, { syntheticHarnessProbe: true });
        for (const actor of ["guest", "viewer", "singleSessionGuest"] as const) {
            assert.equal((await fixture.call(actor, path)).status, 404, actor);
        }
        assert.equal((await fixture.call(null, path)).status, 401);
        assert.equal((await fixture.call("owner", path, { pocketHeader: false })).status, 403);
        const bound = await fixture.call("owner", `/api/x/synthetic-layerfs-probe/source/${fixture.session}`);
        assert.equal(bound.status, 200);
        assert.deepEqual(bound.data, { source: fixture.session, actor: fixture.actors.owner.id });
        assert.equal((await fixture.call("owner", "/api/x/synthetic-layerfs-probe/source/999999999")).status, 404);
        await fixture.app.setExtensionEnabled(owner(fixture.app), "synthetic-layerfs-probe.ts", false);
        assert.equal((await fixture.call("owner", path)).status, 404);
    } finally {
        await fixture.close();
    }
});
