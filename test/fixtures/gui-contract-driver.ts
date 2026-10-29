// Test-side adapter only. Bind exact routes after the development freeze.
import assert from "node:assert/strict";

export type GuiOperation = "status" | "sessions" | "preview" | "confirm" | "apply";
export type GuiBinding = { method: "GET" | "POST"; path: string };
export type GuiTransport = (
    actor: "owner" | "guest" | "viewer" | "singleSessionGuest" | null,
    path: string,
    options: { method: string; body?: unknown; pocketHeader?: boolean },
) => Promise<{ status: number; data: unknown; text: string }>;

export function guiContractDriver(call: GuiTransport, bindings: Record<GuiOperation, GuiBinding>) {
    for (const [name, binding] of Object.entries(bindings)) {
        assert.ok(binding.path.startsWith("/api/x/"), name + " must use a plugin route");
        assert.ok(!binding.path.includes("\\") && !binding.path.includes("?"));
        assert.ok(!binding.path.split("/").some((part) => part === ".."));
        assert.ok(!/[\x00-\x20%#]/.test(binding.path), "Only fixed literal paths are permitted");
        assert.ok(binding.method === "GET" || binding.method === "POST");
    }
    return {
        request(operation: GuiOperation, options: {
            actor?: Parameters<GuiTransport>[0]; body?: unknown; pocketHeader?: boolean;
        } = {}) {
            const route = bindings[operation];
            assert.ok(route, "Missing stable GUI binding: " + operation);
            return call(options.actor === undefined ? "owner" : options.actor, route.path, {
                method: route.method,
                ...(options.body === undefined ? {} : { body: options.body }),
                ...(options.pocketHeader === undefined ? {} : { pocketHeader: options.pocketHeader }),
            });
        },
    };
}

/** Supply all logical files from the actual pinned Store, not an importer manifest. */
export function assertImportedFiles(
    actual: ReadonlyMap<string, Uint8Array>,
    expected: ReadonlyMap<string, Uint8Array>,
    excludedMarker: string,
) {
    assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort(), "Imported paths differ");
    for (const [path, bytes] of actual) {
        assert.deepEqual(Buffer.from(bytes), Buffer.from(expected.get(path)!), "Wrong bytes: " + path);
        assert.ok(!Buffer.from(bytes).includes(Buffer.from(excludedMarker)), "Excluded bytes: " + path);
    }
}

/** Exact bindings from HANDOFF.md. */
export const FROZEN_GUI_BINDINGS: Record<GuiOperation, GuiBinding> = {
    status: { method: "GET", path: "/api/x/pocket-layerfs/gui/status" },
    sessions: { method: "GET", path: "/api/x/pocket-layerfs/gui/sessions" },
    preview: { method: "POST", path: "/api/x/pocket-layerfs/gui/import/preview" },
    confirm: { method: "POST", path: "/api/x/pocket-layerfs/gui/import/confirm" },
    apply: { method: "POST", path: "/api/x/pocket-layerfs/gui/apply" },
};
