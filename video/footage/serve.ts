/**
 * Serves the product for recording: the real service in sample mode, with the web app taken from a frozen copy
 * (video/footage/ui-snapshot) so a rebuild of ui/dist during a take cannot change what is filmed.
 *
 *   node footage/snapshot-ui.mjs                      freeze the current ui/dist
 *   SAMPLE_MODE=true PORT=8796 npx tsx video/footage/serve.ts   (from the repository root)
 */
import { fileURLToPath } from "node:url";
import { createApp, listen } from "../../src/api/server.ts";
import { SakaimeService } from "../../src/service/service.ts";

const uiDir = fileURLToPath(new URL("./ui-snapshot", import.meta.url));

const svc = await SakaimeService.create();
const mode = await svc.runMode();
if (!mode.sample) console.warn("note: not in sample mode; the banner on every screen says which mode this is");
for (const c of svc.cases) await svc.ensureRun(c.spec.id);
const app = createApp(svc, { uiDir });
const listening = await listen(app, svc.config.host, svc.config.port);
console.log(`Sakaime service on ${listening.url} (ui from ${uiDir})`);
const stop = (): void => {
  void listening.close().then(() => {
    svc.close();
    process.exit(0);
  });
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
