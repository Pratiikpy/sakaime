// Runs the live smoke test with LIVE=1 set. `LIVE=1 vitest ...` inside an npm script works in POSIX shells only; npm runs scripts
// through cmd.exe on Windows, where that form fails. This wrapper sets the variable itself and forwards any extra arguments.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const vitest = createRequire(import.meta.url).resolve("vitest/vitest.mjs");
const result = spawnSync(process.execPath, [vitest, "run", "tests/service/live.test.ts", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, LIVE: "1" },
});
process.exit(result.status ?? 1);
