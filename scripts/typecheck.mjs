// Type-checks every TypeScript project in the repository under strict settings:
// the server and tests (root tsconfig.json), then the web app, its dev server and its browser tests when each has
// its own tsconfig. The vendored Meterless reference engines in third_party/ are kept byte-for-byte as the sponsor
// published them (see third_party/meterless/PROVENANCE.md) and do not pass our stricter settings, so diagnostics
// located inside third_party/ are reported and not counted.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

// Run the compiler with this Node binary instead of through a shell: no dependency on npx or on how the platform resolves
// .cmd shims, and no shell-argument deprecation warning.
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");

const isDiagnostic = (line) => /^[^\s].*\(\d+,\d+\): error TS\d+/.test(line);
const projects = ["tsconfig.json", "ui/tsconfig.json", "ui/dev-server/tsconfig.json", "tests/ui/tsconfig.json"].filter((p) => existsSync(p));

let failed = false;
let vendoredCount = 0;
for (const project of projects) {
  const result = spawnSync(process.execPath, [tsc, "--noEmit", "--pretty", "false", "-p", project], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status === null) {
    // The compiler did not run to completion. An empty report must never read as "no errors".
    failed = true;
    console.error(`typecheck: ${project} could not be checked: ${result.error?.message ?? `terminated by signal ${result.signal}`}`);
    continue;
  }
  const lines = `${result.stdout}${result.stderr}`.split(/\r?\n/).filter((line) => line.trim() !== "");

  // A diagnostic can be followed by indented continuation lines; they belong to the diagnostic above them.
  const ours = [];
  let bucket = ours;
  const vendored = [];
  for (const line of lines) {
    if (isDiagnostic(line)) bucket = line.replaceAll("\\", "/").startsWith("third_party/") ? vendored : ours;
    bucket.push(line);
  }
  vendoredCount += vendored.filter(isDiagnostic).length;
  if (ours.length === 0 && result.status !== 0 && vendored.length === 0) {
    failed = true;
    console.error(`typecheck: ${project} exited with status ${result.status} and reported nothing`);
  } else if (ours.length > 0) {
    failed = true;
    console.error(`typecheck: ${project} failed`);
    console.error(ours.join("\n"));
  } else {
    console.log(`typecheck: ${project} ok`);
  }
}
if (vendoredCount > 0) console.log(`typecheck: ${vendoredCount} diagnostics inside the vendored third_party/ tree were not counted.`);
process.exit(failed ? 1 : 0);
