/**
 * Run the independent test suite if it exists. This project does not write
 * tests; test/ is owned by the independent test agent. The script reports an
 * empty suite honestly instead of claiming a pass.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function testsUnder(root, relative = "") {
    const out = [];
    for (const name of readdirSync(join(root, relative), { withFileTypes: true })) {
        const next = relative === "" ? name.name : join(relative, name.name);
        if (name.isDirectory()) out.push(...testsUnder(root, next));
        else if (name.isFile() && /\.test\.(?:ts|mjs|js)$/.test(name.name))
            out.push(join(root, next));
    }
    return out;
}

const files = testsUnder(join(import.meta.dirname, "..", "test")).filter((path) =>
    statSync(path).isFile(),
);
if (files.length === 0) {
    process.stdout.write("layerfs: no independent tests yet (test/ is owned by the test agent)\n");
    process.exit(0);
}
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
