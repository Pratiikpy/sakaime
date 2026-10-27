// Starts and stops the real service (sample mode, frozen web app) for recording and snapshots.
import { execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");

export async function startService(port) {
  const child = spawn(process.execPath, [join(repo, "node_modules", "tsx", "dist", "cli.mjs"), join(repo, "video", "footage", "serve.ts")], {
    cwd: repo,
    env: { ...process.env, SAMPLE_MODE: "true", PORT: String(port) },
    stdio: "ignore",
    windowsHide: true,
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return { child, url };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  child.kill();
  throw new Error(`service did not start on port ${port}`);
}

export function stopService(child) {
  try {
    execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    child.kill();
  }
}
