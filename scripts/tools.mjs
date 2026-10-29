/**
 * Find the fixed, read-only check tools that Pi Pocket already installed.
 * This project never installs a shared dependency and never changes Pi
 * Pocket's files. Set PI_POCKET_PRODUCTION when the sibling folder has
 * another name.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const projectRoot = resolve(import.meta.dirname, "..");
export const productionRoot = process.env.PI_POCKET_PRODUCTION
    ? resolve(process.env.PI_POCKET_PRODUCTION)
    : resolve(projectRoot, "..", "pi-pocket-production");

/**
 * @param {string} name
 * @returns {string}
 */
export function tool(name) {
    const local = join(projectRoot, "node_modules", ".bin", name);
    if (existsSync(local)) return local;
    const shared = join(productionRoot, "node_modules", ".bin", name);
    if (existsSync(shared)) return shared;
    throw new Error(
        `The fixed ${name} binary is not available. Set PI_POCKET_PRODUCTION to the Pi Pocket checkout.`,
    );
}
