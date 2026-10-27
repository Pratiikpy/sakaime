// Copies the licensed font files, the recorded clips and the narration audio into public/ so Remotion can serve them.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const repo = join(root, "..");

mkdirSync(join(root, "public", "fonts"), { recursive: true });
for (const f of ["Outfit-Regular.ttf", "Outfit-SemiBold.ttf", "JetBrainsMono-Regular.ttf", "JetBrainsMono-Medium.ttf"]) {
  cpSync(join(repo, "ui", "public", "fonts", f), join(root, "public", "fonts", f));
}
for (const [from, to] of [["footage/clips", "footage"], ["audio", "audio"]]) {
  const src = join(root, from);
  if (existsSync(src)) {
    mkdirSync(join(root, "public", to), { recursive: true });
    cpSync(src, join(root, "public", to), { recursive: true });
  }
}
console.log("assets synced");
