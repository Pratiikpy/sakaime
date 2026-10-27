// Freezes the built web app (ui/dist) into footage/ui-snapshot. Refuses a half-built bundle.
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "..", "ui", "dist");
const out = join(here, "ui-snapshot");
const index = join(dist, "index.html");
if (!existsSync(index)) throw new Error("ui/dist/index.html is missing: run npm run ui:build at the repository root first");
const assets = [...readFileSync(index, "utf8").matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)].map((m) => m[1]);
for (const a of assets) if (!existsSync(join(dist, a))) throw new Error(`ui/dist is mid-build: ${a} is missing`);
rmSync(out, { recursive: true, force: true });
cpSync(dist, out, { recursive: true });
console.log(`ui snapshot written (${assets.length} assets)`);
