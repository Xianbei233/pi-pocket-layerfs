/**
 * LayerFS for Pi Pocket: a read-only page, owner-only reads, read-only tools
 * bound to the current task requester, and owner-confirmed internal recovery
 * Branches through a private LayerFS service.
 *
 * This module never downloads or builds LayerFS, never starts a container,
 * never runs Docker, and never imports a real project by itself. The owner
 * runs the pinned setup and the private service first. LayerFS data is
 * untrusted; use host.text.defang and data labels before a model sees it.
 * The owner can read the safe status of this module's own config and write or
 * remove it atomically through owner-only routes. A missing config stays
 * deny-all; these routes never add a tool.
 */
import { defineExtension } from "@earendil-works/pi-durable";
import { defaultConfigPath, loadConfigFile } from "./pocket-layerfs/config.ts";
import { configFileHash } from "./pocket-layerfs/config-store.ts";
import { LazyServiceClient } from "./pocket-layerfs/lazy.ts";
import { LayerfsFacade } from "./pocket-layerfs/service.ts";
import { TicketStore } from "./pocket-layerfs/tickets.ts";
import { registerConfigRoutes, registerRoutes } from "./pocket-layerfs/routes.ts";
import { createTools } from "./pocket-layerfs/tools.ts";
import { LayerfsRefusal } from "./pocket-layerfs/errors.ts";

/** The extension API this module was written for. */
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

    const { config } = loaded;
    for (const warning of loaded.warnings) host.notice("info", `LayerFS: ${warning}`);

    const client = new LazyServiceClient({
        socketPath: config.service.socketPath,
        tokenFile: config.service.tokenFile,
        timeoutMs: config.service.requestTimeoutMs,
        maxResponseBytes: config.service.maxResponseBytes,
    });
    const service = new LayerfsFacade({ client, config });
    const tickets = new TicketStore({ ttlMs: config.write.ticketTtlMs });

    registerRoutes({ config, web, service, tickets });
    registerConfigRoutes({ web, host, activeHash: configFileHash(loaded.path) });
    web.client("pocket-layerfs", { access: "owner" });

    const tools = config.tools.enabled
        ? createTools({
              host,
              config,
              service,
              onError: (name, error) => {
                  const code = error instanceof LayerfsRefusal ? error.code : "Upstream";
                  console.error(`[pocket-layerfs] ${name}: ${code}`);
              },
          })
        : [];

    web.onDispose(() => {
        client.close();
        tickets.clear();
    });

    return defineExtension({ name: "layerfs", tools });
}

/**
 * A module that only adds a small diagnostic route and page when its config
 * is absent. It never reads another file or starts the service.
 *
 * @param {{ dataDir: string }} host
 * @param {any} web
 * @param {string} message
 */
function registerDiagnostic(host, web, message) {
    registerConfigRoutes({ web, host, activeHash: null });
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

/**
 * Keep a config error short and free of a store path, socket path, token, or
 * JSON parser detail. The owner sees it in the page and a notice.
 *
 * @param {unknown} message
 */
function safeConfigMessage(message) {
    const text = String(message ?? "The LayerFS configuration is missing or invalid.").replace(
        /[\r\n\t]+/g,
        " ",
    );
    return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}
