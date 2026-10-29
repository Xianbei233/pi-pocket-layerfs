/**
 * Remove exactly the files recorded by install.mjs. Every manifest path is
 * validated and every existing file is hash-checked before the first removal.
 * A changed or missing file refuses the whole uninstall, so a later failure
 * cannot leave a half-deleted earlier set.
 */
import { existsSync, lstatSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { destinationFor, hashFile, prepareTarget, readManifest } from "./install-lib.mjs";

function parse(argv) {
    const options = { target: "" };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--target") options.target = resolve(argv[++index] ?? "");
        else if (arg === "--help" || arg === "-h") {
            process.stdout.write("Usage: node scripts/uninstall.mjs --target <installed-folder>\n");
            process.exit(0);
        } else throw new Error(`Unknown argument: ${arg}`);
    }
    if (options.target === "") throw new Error("--target is required");
    return options;
}

function uninstall(options) {
    const target = prepareTarget(options.target, { create: false });
    const manifest = readManifest(target);
    if (manifest === null) throw new Error("No install manifest in this folder");

    const present = [];
    // Preflight every file before removing anything.
    for (const entry of manifest.files) {
        const destination = destinationFor(target, entry.path, { createParents: false });
        if (destination === null) continue;
        const info = lstatSync(destination);
        if (!info.isFile() || info.isSymbolicLink())
            throw new Error(`Refusing to remove a non-regular file: ${entry.path}`);
        if (hashFile(destination) !== entry.sha256)
            throw new Error(`Refusing to remove a changed file: ${entry.path}`);
        present.push(destination);
    }

    for (const destination of present) {
        rmSync(destination, { force: false });
        let parent = dirname(destination);
        while (parent.startsWith(`${target}/`) && parent !== target) {
            try {
                rmdirSync(parent);
            } catch {
                break;
            }
            parent = dirname(parent);
        }
    }
    const manifestPath = join(target, ".layerfs-install.json");
    if (existsSync(manifestPath)) rmSync(manifestPath);
    process.stdout.write(`[uninstall] removed ${present.length} files from ${target}\n`);
    process.stdout.write("[uninstall] No Store, config, service, or Pi Pocket data was removed.\n");
}

try {
    uninstall(parse(process.argv.slice(2)));
} catch (error) {
    process.stderr.write(
        `[uninstall] ${error instanceof Error ? error.message : "uninstall failed"}\n`,
    );
    process.exitCode = 1;
}
