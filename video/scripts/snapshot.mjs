// Stores the JSON the product itself serves (sample mode) and the judge script's real output under data/snapshots, so the
// figures and the terminal scene in the video come from the running product. Run with the service up (PORT, default 8796).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const repo = join(root, "..");
const out = join(root, "data", "snapshots");
mkdirSync(out, { recursive: true });
import { startService, stopService } from "../footage/service.mjs";

const service = process.env.PORT ? null : await startService(8890);
const base = service ? service.url : `http://127.0.0.1:${process.env.PORT}`;

async function get(path) {
  const res = await fetch(base + path, { headers: { "x-reviewer": "video-snapshot" } });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}
const save = (name, value) => writeFileSync(join(out, name), JSON.stringify(value));

save("health.json", await get("/api/health"));
save("usl.json", await get("/api/usl"));
save("cases.json", await get("/api/cases"));
save("sources.json", await get("/api/sources"));
save("case-eyeart.json", await get("/api/cases/eyeart-k200667"));
save("case-transpara.json", await get("/api/cases/transpara-k221347"));

function findCheck(node, name) {
  if (node && typeof node === "object") {
    if (node.name === name && typeof node.detail === "string") return node;
    for (const v of Object.values(node)) {
      const r = findCheck(v, name);
      if (r) return r;
    }
  }
  return undefined;
}

// Row filter for a reviewer who is not assigned to the case: read from the newest local gate run on the real Zetaris stack.
const dir = join(repo, "infra", "zetaris", ".runtime", "results");
if (existsSync(dir)) {
  const files = readdirSync(dir).filter((f) => f.endsWith("-gates.json")).sort().reverse();
  for (const f of files) {
    const found = findCheck(JSON.parse(readFileSync(join(dir, f), "utf8")), "row filter: unassigned reviewer sees fewer cases than admin");
    const m = found && /admin (\d+) rows, reviewer (\d+) rows/.exec(found.detail);
    if (m) {
      save("zetaris-masking.json", {
        admin: Number(m[1]),
        unassigned: Number(m[2]),
        from: `infra/zetaris/.runtime/results/${f}`,
        check: "row filter: unassigned reviewer sees fewer cases than admin",
      });
      break;
    }
  }
}

// The judge script's real output, for the terminal scene.
let judge;
try {
  judge = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "judge", "--silent"], { cwd: repo, encoding: "utf8", shell: process.platform === "win32", timeout: 240000 });
} catch (e) {
  judge = String(e.stdout ?? e.message);
}
writeFileSync(join(out, "judge.txt"), judge);
if (service) stopService(service.child);
console.log("snapshots written to", out);
