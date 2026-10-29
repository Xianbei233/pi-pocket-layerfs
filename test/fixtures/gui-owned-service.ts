import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Start only one explicitly owned isolated service. No process discovery or broad kill. */
export async function ownedGuiService(entry: string, config: string, root: string) {
    const log = createWriteStream(join(root, "owned-service.log"), { flags: "a", mode: 0o600 });
    const child = spawn(process.execPath, [entry, "--config", config], {
        env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root, LANG: "C" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = ""; child.stdout.pipe(log); child.stderr.pipe(log);
    await writeFile(join(root, "owned-service.json"), JSON.stringify({ pid: child.pid, entry, config }));
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Owned service readiness timeout: " + output)), 15_000);
        const onData = (chunk: Buffer) => { output += chunk.toString(); if (output.includes("listening socket=")) { clearTimeout(timer); resolve(); } };
        child.stdout.on("data", onData); child.stderr.on("data", onData);
        child.once("error", (e) => { clearTimeout(timer); reject(e); });
        child.once("exit", (code) => { clearTimeout(timer); if (!output.includes("listening socket=")) reject(new Error("Owned service exited " + code + ":" + output)); });
    });
    return { child, async stop() {
        if (child.exitCode !== null) return;
        child.kill("SIGTERM");
        const code = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Owned service did not settle; do not force-kill")), 20_000); child.once("exit", (code) => { clearTimeout(timer); resolve(code); }); });
        await writeFile(join(root, "owned-service.exit"), String(code)); log.end(); assert.equal(code, 0);
    } };
}
