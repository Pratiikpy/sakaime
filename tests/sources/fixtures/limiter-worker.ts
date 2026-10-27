// Child process used by limiter.test.ts: tries to take `attempts` slots from a shared on-disk budget.
import { RateLimiter } from "../../../src/sources/limiter.ts";

const [stateFile, attemptsText, capText] = process.argv.slice(2);
const limiter = new RateLimiter({ group: "shared", stateFile, windows: [{ requests: Number(capText), perSeconds: 86_400 }], maxWaitMs: 1 });
let granted = 0;
for (let i = 0; i < Number(attemptsText); i++) {
  try {
    await limiter.acquire();
    limiter.release();
    granted++;
  } catch {
    // budget used up
  }
}
console.log(JSON.stringify({ granted }));
