/**
 * LayerFS release 0.3.0 module factory.
 *
 * A valid config gets nine read-only model tools (gated at call time), the
 * existing read routes, the owner write/fork routes, and the owner
 * Configuration routes. A missing config keeps the no-tool bootstrap mode.
 */
import { defineExtension } from "@earendil-works/pi-durable";
import { defaultConfigPath, loadConfigFile } from "./config.ts";
import { configFileHash } from "./config-store.ts";
import { LayerfsRefusal } from "./errors.ts";
import { createRuntime, dynamicObject, dynamicService } from "./runtime.ts";
import { registerConfigRoutes, registerRoutes } from "./routes.ts";
import { registerGuiRoutes } from "./routes-gui.ts";
import { createTools } from "./tools.ts";

export const pocketApi = 1;

/**
 * @param {any} host
 * @param {any} web
 */
export default function createLayerfs(host, web) {
    let loaded = null;
    try {
        loaded = loadConfigFile(defaultConfigPath(host));
    } catch (error) {
        const message =
            error instanceof LayerfsRefusal || error instanceof Error
                ? error.message
                : "The LayerFS configuration is missing or invalid.";
        host.notice("warning", `LayerFS: ${safeConfigMessage(message)}`);
        registerDiagnostic(host, web, message);
        return defineExtension({ name: "layerfs" });
    }

    const runtime = createRuntime({ host, path: loaded.path, config: loaded.config });
    for (const warning of loaded.warnings) host.notice("info", `LayerFS: ${warning}`);

    registerRoutes({
        config: dynamicObject(() => runtime.config),
        web,
        service: dynamicService(() => runtime.service),
        tickets: runtime.tickets,
    });
    registerConfigRoutes({ web, host, activeHash: () => runtime.activeHash });
    registerGuiRoutes({ web, host, runtime });
    web.client("pocket-layerfs", { access: "owner" });

    const tools = createTools({
        host,
        runtime,
        onError: (name, error) => {
            const code = error instanceof LayerfsRefusal ? error.code : "Upstream";
            console.error(`[pocket-layerfs] ${name}: ${code}`);
        },
    });

    web.onDispose(() => {
        runtime.disposed = true;
        runtime.tickets.clear();
        runtime.client.close();
    });

    return defineExtension({ name: "layerfs", tools });
}

/**
 * No valid config: no tools, only the safe diagnostic status and the
 * management routes the current release already exposes.
 *
 * @param {any} host
 * @param {any} web
 * @param {string} message
 */
function registerDiagnostic(host, web, message) {
    registerConfigRoutes({ web, host, activeHash: null });
    registerGuiRoutes({ web, host, runtime: null });
    web.route("GET", "status", () => ({
        configured: false,
        service: {
            ok: false,
            code: "NotConfigured",
            message: "The LayerFS plugin has no valid configuration.",
        },
        config: { version: 1, toolsEnabled: false, writeEnabled: false, projects: [] },
        diagnostic: safeConfigMessage(message),
    }));
    web.client("pocket-layerfs", { access: "owner" });
    web.onDispose(() => {});
}

/** @param {unknown} message */
function safeConfigMessage(message) {
    const text = String(message ?? "The LayerFS configuration is missing or invalid.").replace(
        /[\r\n\t]+/g,
        " ",
    );
    return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}
