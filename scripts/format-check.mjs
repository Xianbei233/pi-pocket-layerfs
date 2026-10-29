import { spawnSync } from "node:child_process";
import { projectRoot, tool } from "./tools.mjs";

const prettier = spawnSync(tool("prettier"), ["--check", "."], {
    cwd: projectRoot,
    stdio: "inherit",
});
if (prettier.error) throw prettier.error;
if (prettier.status !== 0) process.exit(prettier.status ?? 1);

console.log("layerfs: prettier passed");
