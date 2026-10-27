// Runs the sponsor's own smoke tests (third_party/meterless/hmem/reference/test) unmodified.
// With SAKAIME_IMPL=ours their import of "../src/index.ts" is redirected to Sakaime's engine.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const ours = process.env.SAKAIME_IMPL === "ours";

export default {
  root: path.join(root, "third_party", "meterless", "hmem", "reference"),
  cacheDir: path.join(os.tmpdir(), "sakaime-vitest-cache-hmem"),
  resolve: ours
    ? { alias: [{ find: /^\.\.\/src\/index\.ts$/, replacement: path.join(root, "src", "engines", "hmem", "index.ts") }] }
    : {},
  test: { include: ["test/**/*.test.ts"] },
};
