// Type-checks our code under the strict tsconfig. The vendored Meterless reference engines in third_party/
// are kept byte-for-byte as the sponsor published them (see third_party/meterless/PROVENANCE.md) and do not
// pass our stricter settings, so diagnostics located inside third_party/ are reported and not counted.
import { spawnSync } from "node:child_process";

const result = spawnSync("npx", ["tsc", "--noEmit", "--pretty", "false"], { encoding: "utf8", shell: true });
const lines = `${result.stdout}${result.stderr}`.split(/\r?\n/).filter((line) => line.trim() !== "");
const isDiagnostic = (line) => /^[^\s].*\(\d+,\d+\): error TS\d+/.test(line);

// A diagnostic can be followed by indented continuation lines; they belong to the diagnostic above them.
const vendored = [];
const ours = [];
let bucket = ours;
for (const line of lines) {
  if (isDiagnostic(line)) bucket = line.replaceAll("\\", "/").startsWith("third_party/") ? vendored : ours;
  bucket.push(line);
}

const vendoredCount = vendored.filter(isDiagnostic).length;
if (vendoredCount > 0) {
  console.log(`typecheck: ${vendoredCount} diagnostics inside the vendored third_party/ tree were not counted.`);
}
if (ours.length > 0) {
  console.error(ours.join("\n"));
  process.exit(1);
}
console.log("typecheck: ok");
