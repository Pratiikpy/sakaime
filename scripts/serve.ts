/**
 * Starts the HTTP service.
 *
 *   npx tsx scripts/serve.ts            live when keys and services are configured, otherwise says what is missing
 *   SAMPLE_MODE=true npx tsx scripts/serve.ts    every external read replayed from the committed recordings; needs no key
 *
 * Binds to 127.0.0.1 by default (HOST and PORT override). Serves ui/dist when it has been built.
 */
import { createApp, listen } from "../src/api/server.ts";
import { SakaimeService } from "../src/service/service.ts";

async function main(): Promise<void> {
  const svc = await SakaimeService.create();
  const mode = await svc.runMode();
  const { host, port } = svc.config;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    console.warn(`warning: binding to ${host}. The API has no sign-in; expose it only on a network you trust.`);
  }
  if (svc.config.sample) {
    // A replay is quick: investigate every case up front so the first screen has something to show.
    for (const c of svc.cases) {
      await svc.ensureRun(c.spec.id);
      console.log(`investigated ${c.spec.id} from recordings`);
    }
  }
  const app = createApp(svc);
  const listening = await listen(app, host, port);
  console.log(`Sakaime service on ${listening.url}`);
  console.log(`mode: ${mode.sample ? "sample (recorded responses)" : "live"}; federation ${mode.federation}; model ${mode.model}; sources ${mode.sources}`);
  for (const n of mode.degradedNotes) console.log(`note: ${n}`);
  const stop = (): void => {
    void listening.close().then(() => {
      svc.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
