/**
 * The one fixed private child for Project Init and Store verification.
 *
 * Before it imports any SDK JavaScript it proves:
 * - the request sits in the fixed private import layout under a real dataDir;
 * - the request names the SDK and LayerFS home from the fixed own config;
 * - the Store target is the fixed derived path for this project;
 * - the filtered stage matches the promised stage hash;
 * - the SDK tree and native addon match the pinned official release.
 *
 * The source path is never in the request and never a native argument.
 */
import {
    closeSync,
    constants,
    lstatSync,
    openSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    readSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_REQUEST = 64 * 1024;
const MAX_JSON = 512 * 1024;
const PROJECT = /^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/;
const PIN = JSON.parse(
    readFileSyncSafe(new URL("./sdk-pin.json", import.meta.url), MAX_JSON).toString("utf8"),
);
const REQUEST_KEYS = new Set([
    "version",
    "mode",
    "operation",
    "importId",
    "project",
    "stage",
    "store",
    "home",
    "sdk",
    "stageHash",
]);

function fail(code) {
    process.stderr.write(`layerfs-import ${code}\n`);
    process.exitCode = 2;
    throw new Error(code);
}

function readFileSyncSafe(pathOrUrl, max) {
    const path = pathOrUrl instanceof URL ? pathOrUrl : String(pathOrUrl);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) fail("request");
    if (info.size > max) fail("request");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const buffer = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < buffer.length) {
            const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
            if (read === 0) break;
            offset += read;
        }
        return buffer.subarray(0, offset);
    } finally {
        closeSync(fd);
    }
}

function assertNoLinks(path) {
    let current = "/";
    for (const part of resolve(path).split("/").filter(Boolean)) {
        current = join(current, part);
        if (lstatSync(current).isSymbolicLink()) fail("link");
    }
}

function privateDir(path, code) {
    assertNoLinks(path);
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) fail(code);
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) fail(code);
    if ((info.mode & 0o777) !== 0o700) fail(code);
    return resolve(path);
}

function privateFile(path, code) {
    assertNoLinks(path);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) fail(code);
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) fail(code);
    if ((info.mode & 0o077) !== 0) fail(code);
    if (info.size > MAX_JSON) fail(code);
    return info.size;
}

function hashFile(path) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) fail("sdk");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const hash = createHash("sha256");
        const buffer = Buffer.alloc(1024 * 1024);
        for (;;) {
            const length = readSync(fd, buffer, 0, buffer.length, null);
            if (length === 0) break;
            hash.update(buffer.subarray(0, length));
        }
        return hash.digest("hex");
    } finally {
        closeSync(fd);
    }
}

/**
 * The same content hash as the setup verifier: sorted relative path, type,
 * size, and bytes; the base `native` folder and `UPSTREAM.json` are excluded.
 *
 * @param {string} root
 */
function treeHash(root) {
    const base = resolve(root);
    const skip = new Set([".git", ...(PIN.exclude ?? ["native", "UPSTREAM.json"])]);
    const hash = createHash("sha256");
    const walk = (dir) => {
        const names = readdirSorted(dir).filter((entry) => !(dir === base && skip.has(entry.name)));
        for (const name of names) {
            const path = join(dir, name.name);
            const rel = relative(base, path).split("\\").join("/");
            const info = lstatSync(path);
            if (info.isSymbolicLink()) {
                hash.update(`l\0${rel}\0${readlinkSync(path)}\0`);
            } else if (info.isDirectory()) {
                hash.update(`d\0${rel}\0`);
                walk(path);
            } else if (info.isFile()) {
                hash.update(`f\0${rel}\0${info.size}\0`);
                const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
                try {
                    const buffer = Buffer.alloc(1024 * 1024);
                    for (;;) {
                        const length = readSync(fd, buffer, 0, buffer.length, null);
                        if (length === 0) break;
                        hash.update(buffer.subarray(0, length));
                    }
                } finally {
                    closeSync(fd);
                }
            } else {
                fail("sdk");
            }
        }
    };
    walk(base);
    return hash.digest("hex");
}

function readdirSorted(dir) {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
}

function readdirSyncNames(dir) {
    return readdirSorted(dir);
}

/**
 * The stage hash promised by the parent: sorted file entries and counts.
 *
 * @param {string} root
 */
function stageHash(root) {
    const hash = createHash("sha256");
    const stack = [{ path: root, rel: "" }];
    const entries = [];
    let files = 0;
    let bytes = 0;
    while (stack.length > 0) {
        const frame = stack.pop();
        for (const name of readdirSyncNames(frame.path)) {
            const path = join(frame.path, name.name);
            const rel = frame.rel === "" ? name.name : `${frame.rel}/${name.name}`;
            const info = lstatSync(path);
            if (info.isSymbolicLink() || info.uid !== process.getuid()) fail("stage");
            if (info.isDirectory()) {
                stack.push({ path, rel });
            } else if (info.isFile()) {
                files += 1;
                bytes += info.size;
                entries.push(`${rel}\0file\0${info.size}\0${hashFile(path)}\n`);
            } else {
                fail("stage");
            }
        }
    }
    entries.sort();
    for (const entry of entries) hash.update(entry);
    hash.update(`count\0${files}\0${bytes}\n`);
    return hash.digest("hex");
}

function readRequest(path) {
    if (!isAbsolute(path) || path.includes("\0")) fail("request");
    privateFile(path, "request");
    let request;
    try {
        request = JSON.parse(readFileSyncSafe(path, MAX_REQUEST).toString("utf8"));
    } catch {
        fail("request");
    }
    if (request === null || typeof request !== "object" || Array.isArray(request)) fail("request");
    for (const key of Object.keys(request)) if (!REQUEST_KEYS.has(key)) fail("request");
    if ("source" in request || "sourcePath" in request) fail("source");
    if (request.version !== 1) fail("request");
    if (request.mode !== "import" && request.mode !== "verify") fail("request");
    if (
        (request.mode === "import" && request.operation !== "project.init") ||
        (request.mode === "verify" && request.operation !== "project.verify")
    )
        fail("operation");
    if (typeof request.stageHash !== "string" || !/^[0-9a-f]{64}$/.test(request.stageHash))
        fail("stage");
    if (typeof request.importId !== "string" || !/^[0-9a-f]{24}$/.test(request.importId))
        fail("import");
    if (typeof request.project !== "string" || !PROJECT.test(request.project)) fail("project");
    for (const key of ["stage", "store", "home", "sdk"]) {
        if (typeof request[key] !== "string" || !isAbsolute(request[key])) fail("request");
    }
    return request;
}

function checkAuthority(request, requestPath) {
    const importDir = dirname(requestPath);
    const importId = basename(importDir);
    if (!/^[0-9a-f]{24}$/.test(importId)) fail("import");
    if (basename(dirname(importDir)) !== "imports") fail("import");
    if (basename(dirname(dirname(importDir))) !== "pocket-layerfs") fail("import");
    if (request.importId !== importId) fail("import");
    const dataDir = dirname(dirname(dirname(importDir)));
    const own = privateDir(join(dataDir, "pocket-layerfs"), "authority");
    const imports = privateDir(join(own, "imports"), "authority");
    if (resolve(importDir) !== join(imports, importId)) fail("import");
    const configPath = join(own, "config.json");
    privateFile(configPath, "config");
    let config;
    try {
        config = JSON.parse(readFileSyncSafe(configPath, MAX_JSON).toString("utf8"));
    } catch {
        fail("config");
    }
    if (config === null || typeof config !== "object" || config.version !== 1) fail("config");
    if (config.service === null || typeof config.service !== "object") fail("config");
    if (
        typeof config.service.sdkPath !== "string" ||
        typeof config.service.layerfsHome !== "string"
    )
        fail("config");
    if (resolve(config.service.sdkPath) !== resolve(request.sdk)) fail("sdk");
    if (resolve(config.service.layerfsHome) !== resolve(request.home)) fail("home");
    const store = join(own, "projects", request.project, "store.sqlite");
    if (resolve(request.store) !== resolve(store)) fail("store");
    const stage = join(importDir, "stage");
    if (resolve(request.stage) !== resolve(stage)) fail("stage");
    privateDir(stage, "stage");
    privateDir(request.home, "home");
    privateDir(join(own, "projects", request.project), "store");
    privateDir(dirname(request.sdk), "sdk");
    if (stageHash(stage) !== request.stageHash) fail("stage");
}

function checkPin(request) {
    const sdk = resolve(request.sdk);
    const info = lstatSync(sdk);
    if (!info.isDirectory() || info.isSymbolicLink()) fail("sdk");
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) fail("sdk");
    if ((info.mode & 0o022) !== 0) fail("sdk");
    assertNoLinks(join(sdk, "src", "index.js"));
    assertNoLinks(join(sdk, "native", "layerfs.node"));
    const markerInfo = lstatSync(join(sdk, "UPSTREAM.json"));
    const pkgInfo = lstatSync(join(sdk, "package.json"));
    if (!markerInfo.isFile() || !pkgInfo.isFile()) fail("sdk");
    let marker;
    let pkg;
    try {
        marker = JSON.parse(
            readFileSyncSafe(join(sdk, "UPSTREAM.json"), MAX_JSON).toString("utf8"),
        );
        pkg = JSON.parse(readFileSyncSafe(join(sdk, "package.json"), MAX_JSON).toString("utf8"));
    } catch {
        fail("sdk");
    }
    if (
        marker?.commit !== PIN.commit ||
        marker?.tag !== PIN.tag ||
        marker?.version !== PIN.version ||
        marker?.archiveSha256 !== PIN.archiveSha256
    )
        fail("sdk");
    if (pkg?.version !== PIN.version) fail("sdk");
    if (treeHash(sdk) !== PIN.sdkTreeSha256) fail("sdk");
    if (hashFile(join(sdk, "native", "layerfs.node")) !== PIN.nativeSha256) fail("sdk");
}

async function main() {
    const argv = process.argv.slice(2);
    const index = argv.indexOf("--request");
    if (index < 0 || typeof argv[index + 1] !== "string") fail("usage");
    const requestPath = resolve(argv[index + 1]);
    const request = readRequest(requestPath);
    checkAuthority(request, requestPath);
    const storeInfo = (() => {
        try {
            return lstatSync(request.store);
        } catch {
            return null;
        }
    })();
    if (request.mode === "import") {
        if (storeInfo !== null) fail("exists");
        try {
            lstatSync(join(request.home, request.project));
            fail("exists");
        } catch (error) {
            if (error instanceof Error && error.message === "exists") throw error;
        }
    } else if (storeInfo === null || !storeInfo.isFile() || storeInfo.isSymbolicLink()) {
        fail("store");
    }
    checkPin(request);
    for (const name of Object.keys(process.env)) {
        if (name.startsWith("LAYERFS_") || name.startsWith("DSH_LAYERFS_"))
            delete process.env[name];
    }
    process.env.LAYERFS_HOME = request.home;
    process.env.LAYERFS_NATIVE = join(request.sdk, "native", "layerfs.node");
    const { LayerFS } = await import(pathToFileURL(join(request.sdk, "src", "index.js")).href);
    const client = new LayerFS(request.project, { storePath: request.store });
    try {
        if (request.mode === "verify") {
            const names = [];
            let pos = 0;
            for (let page = 0; page < 8; page += 1) {
                const result = await client.project.list_branches(100, pos);
                const items = Array.isArray(result.items) ? result.items : [];
                names.push(
                    ...items.map((item) => item.name).filter((name) => typeof name === "string"),
                );
                if (result.hasMore !== true || items.length === 0) break;
                pos = Number.isSafeInteger(result.nextPagePos)
                    ? result.nextPagePos
                    : pos + items.length;
            }
            process.stdout.write(
                `LAYERFS_IMPORT ${JSON.stringify({ ok: true, operation: "project.verify", branches: [...new Set(names)].slice(0, 64) })}\n`,
            );
            return;
        }
        const result = await client.project.init(request.stage);
        process.stdout.write(
            `LAYERFS_IMPORT ${JSON.stringify({ kind: result.kind ?? "Initialized", project: request.project, operation: "project.init" })}\n`,
        );
    } finally {
        await client.close();
    }
}

main().catch((error) => {
    const code = error instanceof Error ? error.message : "failed";
    process.stderr.write(
        `layerfs-import failed: ${code.replace(/[^A-Za-z0-9._-]/g, " ").slice(0, 80)}\n`,
    );
    process.exitCode = 2;
});
