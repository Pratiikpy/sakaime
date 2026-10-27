/**
 * Properties that must hold for any sequence of requests: registration is idempotent (C-17), the result always has the
 * contract's shape, and nothing registers without a contract.
 */
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { OnboardingResultSchema } from "../../src/api/contract.ts";
import { onboardSource, requestId } from "../../src/discovery/index.ts";
import { clearances, csv, harness, urlOf, type Harness } from "./helpers/fixtures.ts";
import { modelMapping } from "./helpers/doubles.ts";

let h: Harness | undefined;
afterEach(() => h?.close());

const MAP = { k_number: "submission_number", applicant: "applicant", device_name: "device_name" };

describe("idempotent registration", () => {
  it("any sequence of repeated and interleaved requests creates one table and one snapshot per distinct request", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(fc.constantFrom("a.csv", "b.csv", "c.csv"), fc.constantFrom("org-1", "org-2")), { minLength: 1, maxLength: 8 }), async (sequence) => {
        const g = await harness({ model: modelMapping(MAP) });
        try {
          for (const name of ["a.csv", "b.csv", "c.csv"]) g.fetcher.set(urlOf(name), csv(["k_number", "applicant", "device_name"], clearances().map((r) => [r[0]!, r[1]!, r[2]!])));
          const ids = new Set<string>();
          for (const [name, orgId] of sequence) {
            const req = await g.request(name, { orgId, expectedJoinRate: 0.8 });
            const result = await onboardSource(req, g.deps);
            if (!OnboardingResultSchema.safeParse(result).success || result.outcome !== "registered") return false;
            ids.add(requestId(req));
          }
          return g.engine.tablesIn("sk_onboarded").length === ids.size && g.store.objects.size === ids.size && g.engine.ddl.filter((s) => s.sql.startsWith("CREATE LIGHTNING FILESTORE TABLE")).length === ids.size;
        } finally {
          g.close();
        }
      }),
      { numRuns: 20 },
    );
  });

  it("nothing registers without a contract, whatever else is true of the source", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(undefined, null, "", 0, {}, [], "a contract"), async (contract) => {
        const g = await harness({ model: modelMapping(MAP) });
        try {
          g.fetcher.set(urlOf("a.csv"), csv(["k_number", "applicant", "device_name"], clearances().map((r) => [r[0]!, r[1]!, r[2]!])));
          const req = await g.request("a.csv", { expectedJoinRate: 0.8 });
          const result = await onboardSource({ ...req, contract }, g.deps);
          return result.outcome === "declined" && g.store.puts === 0 && g.engine.ddl.length === 0;
        } finally {
          g.close();
        }
      }),
      { numRuns: 7 },
    );
  });

  it("every result, whatever the outcome, parses against the API contract and lists all eight stages once, in order", async () => {
    h = await harness({ model: modelMapping(MAP) });
    h.fetcher.set(urlOf("a.csv"), csv(["k_number", "applicant", "device_name"], clearances().map((r) => [r[0]!, r[1]!, r[2]!])));
    h.fetcher.set(urlOf("down.csv"), "busy", 503);
    for (const [name, over] of [["a.csv", {}], ["down.csv", {}], ["a.csv", { url: "https://example.org/x.csv" }], ["a.csv", { contract: undefined, description: "a second description of the same source" }]] as const) {
      const r = await onboardSource(await h.request(name, over), h.deps);
      expect(OnboardingResultSchema.safeParse(r).success).toBe(true);
      expect(r.stages.map((s) => s.stage)).toEqual(["authorization", "capability_discovery", "bounded_probe", "mapping_proposal", "semantic_validation", "human_review", "registration", "monitoring"]);
    }
  });
});
