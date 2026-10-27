import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const root = fileURLToPath(new URL("../..", import.meta.url));
const PORT = Number(process.env["SAKAIME_UI_TEST_PORT"] ?? 8788);

/**
 * UI tests drive the built web app against a server that implements the HTTP contract. By default that is the fixture
 * server in ui/dev-server (real compiler, real recorded evidence). Set SAKAIME_UI_BASE_URL to run the same tests against
 * the real service instead; the server is then not started here.
 *
 * The browser is the installed Google Chrome (channel "chrome"), a Chromium build, so no browser download is needed.
 */
const external = process.env["SAKAIME_UI_BASE_URL"];

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "./.results",
  use: {
    baseURL: external ?? `http://127.0.0.1:${PORT}`,
    channel: "chrome",
    headless: true,
    viewport: { width: 1440, height: 900 },
    screenshot: "off",
    trace: "retain-on-failure",
  },
  ...(external
    ? {}
    : {
        webServer: {
          command: "npx vite build --config ui/vite.config.ts && npx tsx ui/dev-server/server.ts --static",
          cwd: root,
          url: `http://127.0.0.1:${PORT}/api/health`,
          env: { PORT: String(PORT) },
          reuseExistingServer: false,
          timeout: 240_000,
          stdout: "ignore",
          stderr: "pipe",
        },
      }),
});
