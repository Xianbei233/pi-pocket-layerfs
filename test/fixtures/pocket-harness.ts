// OFFICIAL HELPERS MUST BE FIRST: isolate Pi auth/settings/data before host imports.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    scriptedModel,
} from "/home/xianbei233/Work/pi-pocket-production/test/helpers.ts";
import { cp, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join } from "node:path";
import { createHandler } from "/home/xianbei233/Work/pi-pocket-production/src/server/http.ts";

export { cleanUp, newSession, owner, root, scriptedModel };

export type ActorName = "owner" | "guest" | "viewer" | "singleSessionGuest";
export type Actor = { id: string; token: string };
export type PocketFixture = Awaited<ReturnType<typeof createPocketFixture>>;

/**
 * Actual Pocket loader and loopback HTTP, never a fake handler. Caller owns
 * extension config/setup via prepare(); it runs after the temporary owner and
 * conversations exist, but before the drop-in is enabled. Import this helper
 * before any other module that might initialize Pocket.
 */
export async function createPocketFixture(options: {
    files: readonly { from: string; name: string }[];
    module?: string;
    dataParent?: string;
    model?: ReturnType<typeof scriptedModel>;
    beforeOpen?: (paths: { dataDir: string; dropIns: string }) => Promise<void>;
    prepare?: (fixture: {
        app: App;
        dataDir: string;
        session: Awaited<ReturnType<typeof newSession>>;
        otherSession: Awaited<ReturnType<typeof newSession>>;
        actors: Record<ActorName, Actor>;
    }) => Promise<void>;
    enable?: boolean;
}) {
    const module = options.module ?? "pocket-layerfs";
    const dataDir = join(options.dataParent ?? root, `layerfs-data-${crypto.randomUUID()}`);
    const dropIns = join(dataDir, "extensions");
    await mkdir(dropIns, { recursive: true });
    for (const file of options.files) {
        if (
            !file.name ||
            file.name === "." ||
            file.name === ".." ||
            basename(file.name) !== file.name ||
            file.name.includes("\\") ||
            file.name.includes("\0")
        ) {
            throw new Error("Unsafe test drop-in destination");
        }
        await cp(file.from, join(dropIns, file.name), {
            recursive: true,
            dereference: false,
            errorOnExist: true,
            force: false,
        });
    }
    await options.beforeOpen?.({ dataDir, dropIns });
    const app = await openApp(options.model ?? scriptedModel(), dataDir);
    const server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    try {
        const session = await newSession(app);
        const otherSession = await newSession(app);
        const guest = app.config.addUser("Synthetic guest", "guest");
        const viewer = app.config.addUser("Synthetic viewer", "viewer");
        const single = app.config.addUser("Synthetic session guest", "guest", [String(session)]);
        const actors: Record<ActorName, Actor> = {
            owner: { id: owner(app).id, token: app.config.ownerToken },
            guest: { id: guest.user.id, token: guest.token },
            viewer: { id: viewer.user.id, token: viewer.token },
            singleSessionGuest: { id: single.user.id, token: single.token },
        };
        await options.prepare?.({ app, dataDir, session, otherSession, actors });
        if (options.enable !== false) {
            await app.setExtensionEnabled(owner(app), `${module}.ts`, true);
        }
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
                server.off("error", reject);
                resolve();
            });
        });
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("Missing test TCP address");
        const base = `http://127.0.0.1:${address.port}`;
        async function call(
            actor: ActorName | null,
            path: string,
            options: {
                method?: string;
                body?: unknown;
                pocketHeader?: boolean;
                signal?: AbortSignal;
            } = {},
        ) {
            // Always target this fixture. A route path cannot redirect a test's token.
            if (!path.startsWith("/") || path.startsWith("//")) {
                throw new Error("Test HTTP path must be local and absolute");
            }
            const response = await fetch(`${base}${path}`, {
                method: options.method ?? (options.body === undefined ? "GET" : "POST"),
                redirect: "error",
                signal: options.signal ?? AbortSignal.timeout(10_000),
                headers: {
                    ...(actor === null ? {} : { authorization: `Bearer ${actors[actor].token}` }),
                    ...(options.pocketHeader === false ? {} : { "x-pocket": "1" }),
                    ...(options.body === undefined ? {} : { "content-type": "application/json" }),
                },
                ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
            });
            const text = await response.text();
            let data: unknown = text;
            try {
                data = JSON.parse(text);
            } catch {
                // Browser assets need not be JSON.
            }
            return { status: response.status, headers: response.headers, data, text };
        }
        return {
            app,
            base,
            dataDir,
            dropIns,
            session,
            otherSession,
            actors,
            call,
            async close() {
                server.closeAllConnections();
                await new Promise<void>((resolve, reject) => {
                    server.close((error) => (error ? reject(error) : resolve()));
                });
                await app.close();
            },
        };
    } catch (error) {
        server.closeAllConnections();
        server.close();
        await app.close();
        throw error;
    }
}
