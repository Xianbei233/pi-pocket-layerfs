/**
 * Copy the drop-in to an explicit independent folder. It never touches the
 * live Pi Pocket data folder, never enables the module, and never copies a
 * config/token/Store. The manifest is untrusted on read: paths are fixed to
 * the module prefix, every ancestor is checked for links, and every existing
 * file is hash-verified before a single removal.
 */
import {
    copyFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
    MANIFEST,
    destinationFor,
    hashFile,
    prepareTarget,
    readManifest,
    validateManifest,
    writeManifest,
} from "./install-lib.mjs";

const projectRoot = resolve(import.meta.dirname, "..");

function parse(argv) {
    const options = { target: "", config: "" };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--target") options.target = resolve(argv[++index] ?? "");
        else if (arg === "--config") options.config = resolve(argv[++index] ?? "");
        else if (arg === "--help" || arg === "-h") {
            process.stdout.write(
                "Usage: node scripts/install.mjs --target <independent-folder> [--config <file>]\n",
            );
            process.exit(0);
        } else throw new Error(`Unknown argument: ${arg}`);
    }
    if (options.target === "") throw new Error("--target is required");
    return options;
}

function filesUnder(root, relative = "") {
    const out = [];
    for (const name of readdirSync(join(root, relative), { withFileTypes: true })) {
        if (name.name === "_pocket.d.ts" || name.name === MANIFEST) continue;
        const next = relative === "" ? name.name : join(relative, name.name);
        if (name.isSymbolicLink()) throw new Error(`The source contains a link: ${next}`);
        if (name.isDirectory()) out.push(...filesUnder(root, next));
        else if (name.isFile()) out.push(next);
        else throw new Error(`The source contains a non-regular file: ${next}`);
    }
    return out;
}

function sourceFiles() {
    const files = [{ from: join(projectRoot, "src/pocket-layerfs.ts"), path: "pocket-layerfs.ts" }];
    for (const relative of filesUnder(join(projectRoot, "src/pocket-layerfs"))) {
        files.push({
            from: join(projectRoot, "src/pocket-layerfs", relative),
            path: `pocket-layerfs/${relative}`,
        });
    }
    // Validate the exact shape before creating anything.
    validateManifest({
        name: "pi-pocket-layerfs",
        version: "0",
        files: files.map((entry) => ({ path: entry.path, sha256: "0".repeat(64) })),
    });
    for (const entry of files) {
        const info = lstatSync(entry.from);
        if (!info.isFile() || info.isSymbolicLink())
            throw new Error(`The source is not a regular file: ${entry.path}`);
    }
    return files;
}

function install(options) {
    const source = sourceFiles();
    const target = prepareTarget(options.target, { create: true });
    const previous = readManifest(target);
    if (previous === null && readdirSync(target).length > 0) {
        throw new Error(
            "The target is not empty and has no pi-pocket-layerfs manifest. Use a new folder.",
        );
    }
    const oldPaths = new Set(previous?.files.map((entry) => entry.path) ?? []);

    // Preflight every old file before any removal or replacement.
    for (const entry of previous?.files ?? []) {
        const destination = destinationFor(target, entry.path, { createParents: false });
        if (destination === null) continue;
        const info = lstatSync(destination);
        if (!info.isFile() || info.isSymbolicLink())
            throw new Error(`The previous file is not regular: ${entry.path}`);
        if (hashFile(destination) !== entry.sha256)
            throw new Error(`Refusing to replace a changed file: ${entry.path}`);
    }

    // Preflight every new destination. Unknown files are never overwritten.
    for (const entry of source) {
        const destination = destinationFor(target, entry.path, { createParents: true });
        if (destination === null)
            throw new Error(`The destination is not available: ${entry.path}`);
        if (existsSync(destination)) {
            const info = lstatSync(destination);
            if (!info.isFile() || info.isSymbolicLink())
                throw new Error(`The destination is not a regular file: ${entry.path}`);
            if (!oldPaths.has(entry.path))
                throw new Error(`Refusing to overwrite an unknown file: ${entry.path}`);
        }
    }

    const stage = join(target, `.layerfs-stage-${randomBytes(8).toString("hex")}`);
    mkdirSync(stage, { recursive: false, mode: 0o700 });
    try {
        for (const entry of source) {
            const staged = join(stage, entry.path);
            mkdirSync(dirname(staged), { recursive: true, mode: 0o700 });
            copyFileSync(entry.from, staged);
            if (hashFile(staged) !== hashFile(entry.from))
                throw new Error(`The staged copy changed: ${entry.path}`);
        }
        // Old files are hash-verified. Replace new files atomically, then
        // remove the old files that are no longer part of the module.
        for (const entry of source) {
            const destination = destinationFor(target, entry.path, { createParents: true });
            if (destination === null) throw new Error(`The destination disappeared: ${entry.path}`);
            renameSync(join(stage, entry.path), destination);
        }
        for (const entry of previous?.files ?? []) {
            if (source.some((next) => next.path === entry.path)) continue;
            const destination = destinationFor(target, entry.path, { createParents: false });
            if (destination !== null) rmSync(destination, { force: false });
        }
        const manifest = {
            name: "pi-pocket-layerfs",
            version: JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")).version,
            installedAt: new Date().toISOString(),
            files: source.map((entry) => ({
                path: entry.path,
                sha256: hashFile(join(target, entry.path)),
            })),
            configPath: options.config || null,
            enabled: false,
        };
        writeManifest(target, manifest);
        process.stdout.write(`[install] ${source.length} files -> ${target}\n`);
        process.stdout.write(
            "[install] The module is off. The owner turns it on in Menu → Extensions.\n",
        );
        if (options.config)
            process.stdout.write(`[install] Config stays outside the target: ${options.config}\n`);
        process.stdout.write(
            "[install] Start the private service separately; this script never starts or installs a daemon.\n",
        );
    } finally {
        rmSync(stage, { recursive: true, force: true });
    }
}

try {
    install(parse(process.argv.slice(2)));
} catch (error) {
    process.stderr.write(
        `[install] ${error instanceof Error ? error.message : "install failed"}\n`,
    );
    process.exitCode = 1;
}
