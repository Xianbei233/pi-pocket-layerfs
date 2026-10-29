// Layout and syntax check. Type checking is `tsc`; formatting is Prettier.
import { spawnSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { productionRoot, projectRoot, tool } from "./tools.mjs";

// TypeScript resolves the fixed Pi Pocket packages through a read-only link.
// This never writes to Pi Pocket and is ignored by git.
const link = join(projectRoot, "node_modules");
if (!existsSync(link)) {
    const target = join(productionRoot, "node_modules");
    if (!existsSync(target))
        throw new Error("Pi Pocket node_modules is missing; set PI_POCKET_PRODUCTION.");
    symlinkSync(target, link, "dir");
}

const tsc = spawnSync(tool("tsc"), ["--noEmit", "-p", "tsconfig.json"], {
    cwd: projectRoot,
    stdio: "inherit",
});
if (tsc.error) throw tsc.error;
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

console.log("layerfs: tsc passed");
