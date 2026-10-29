import { spawnSync } from "node:child_process";
import { projectRoot, tool } from "./tools.mjs";

const eslint = spawnSync(tool("eslint"), ["."], { cwd: projectRoot, stdio: "inherit" });
if (eslint.error) throw eslint.error;
if (eslint.status !== 0) process.exit(eslint.status ?? 1);

console.log("layerfs: eslint passed");
