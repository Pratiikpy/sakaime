// Records every clip (or the ones named on the command line). Each clip gets its own fresh service in sample mode, on its
// own port, serving the frozen web app: no decision or run made for one clip can leak into another, and a service that dies
// during a take only costs that take.
//
//   node footage/snapshot-ui.mjs          freeze ui/dist first (after npm run ui:build at the repository root)
//   node footage/record-all.mjs [clip ...]
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { session, setBase } from "./lib.mjs";
import { startService, stopService } from "./service.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "scripts");
const wanted = process.argv.slice(2);
const names = readdirSync(dir).filter((f) => f.endsWith(".mjs")).map((f) => f.replace(/\.mjs$/, ""));
const order = ["addsource", "console", "matrix", "usl", "identity", "xray", "lab", "timeline", "desk", "investigation", "guard", "drills", "dossier"];
const todo = (wanted.length ? wanted : order).filter((n) => names.includes(n));

let failed = 0;
let port = 8820;
for (const name of todo) {
  const { run } = await import(pathToFileURL(join(dir, `${name}.mjs`)).href);
  let ok = false;
  for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
    const svc = await startService(port++);
    setBase(svc.url);
    const s = await session(name);
    try {
      await run(s);
      ok = true;
    } catch (e) {
      console.error(`${name}: attempt ${attempt} failed: ${e.message.split("\n")[0]}`);
    }
    await s.finish().catch((e) => console.error(`${name}: finish failed: ${e.message}`));
    stopService(svc.child);
  }
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
