import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { buildResults } from "./dev-server/results.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = fileURLToPath(new URL("..", import.meta.url));

/**
 * The About screen reads /results.json. The service does not serve it (it is not part of the HTTP contract), so the build writes it
 * from the repository's result files and any static host serves it with the app; the dev server answers from the same function.
 */
function resultsFile(): Plugin {
  return {
    name: "sakaime-results-file",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "results.json", source: JSON.stringify(buildResults()) });
    },
    configureServer(server) {
      server.middlewares.use("/results.json", (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(buildResults()));
      });
    },
  };
}

/**
 * The web app is a static bundle. In development it proxies /api to the service (the real server, or the fixture
 * server in ui/dev-server). SAKAIME_API overrides the target.
 */
export default defineConfig({
  root: here,
  plugins: [react(), resultsFile()],
  resolve: {
    alias: {
      // The HTTP contract is shared with the service so a mismatch is a compile error, not a runtime surprise.
      "@contract": fileURLToPath(new URL("../src/api/contract.ts", import.meta.url)),
      "@schemas": fileURLToPath(new URL("../src/schemas/index.ts", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    fs: { allow: [repo] },
    proxy: {
      "/api": { target: process.env["SAKAIME_API"] ?? "http://127.0.0.1:8787", changeOrigin: false },
    },
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false, target: "es2022" },
});
