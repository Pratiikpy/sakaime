/**
 * IdentityShift (docs/06 section 3): does the resolver keep devices, releases, submissions and studies apart, and link the right ones?
 *
 * This wraps the existing labelled-corpus evaluation (src/identity, data/identity-corpus) without changing it: same corpus, same
 * leave-one-family-out protocol, same resolver. It adds what the protocol asks for and the committed report does not have in one
 * place: cluster-aware intervals from the shared statistics module, the effective sample size, a fuzzy-name baseline on the same
 * pairs, and an exact paired test against it.
 *
 * Labels are builder-labelled by one reader (data/identity-corpus/RESULTS.md); class: builder-labelled.
 *
 *   npx tsx evals/suites/identityshift.ts
 */
import { loadCorpus } from "../../src/identity/corpus.ts";
import { runLeaveOneFamilyOut, summarise, type PairOutcome, type Verdict } from "../../src/identity/evaluate.ts";
import { loadReference } from "../../src/identity/run-eval.ts";
import { clusterBootstrap, effectiveSampleSize, holm, mcnemarExact, wilson, zeroErrorUpperBound } from "../stats/index.ts";
import { hashOfJson, stamp } from "../lib/core.ts";
import { writeResult } from "../lib/results.ts";

const SEED = 20261027;
const GENERIC = new Set(["software", "system", "device", "analysis", "algorithm", "intelligence", "artificial", "learning", "machine", "based", "using", "study", "trial", "with", "from", "that", "this", "assisted", "clinical", "patients", "versus", "evaluation", "validation", "performance", "automated", "detection", "diagnosis", "imaging", "screening", "deep", "model", "models", "real", "world", "prospective", "retrospective", "multicenter", "multi", "center", "randomised", "randomized", "controlled", "analysis", "results", "outcomes", "care", "health", "medical", "radiology", "assessment", "platform", "solution", "technology", "emergency", "department", "computer", "aided", "triage", "notification"]);

const tokens = (s: string): Set<string> => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !GENERIC.has(t)));

type Rec = { id: string; kind: string; name?: string; aliases?: string[]; manufacturer?: string };

/** Fuzzy-name merge: link two records when their names share a non-generic token of four characters or more. No abstention. */
function fuzzyVerdict(a: Rec, b: Rec): Verdict {
  const ta = tokens([a.name ?? "", ...(a.aliases ?? [])].join(" "));
  const tb = tokens([b.name ?? "", ...(b.aliases ?? [])].join(" "));
  for (const t of ta) if (tb.has(t)) return "LINK";
  return "NO";
}

/** A pair is handled correctly when a MATCH is linked, a NON_MATCH is not linked, and an AMBIGUOUS pair is not linked. */
const correct = (truth: string, verdict: Verdict, abstainOk: boolean): boolean =>
  truth === "MATCH" ? verdict === "LINK" : truth === "NON_MATCH" ? verdict !== "LINK" : abstainOk ? verdict === "ABSTAIN" : verdict !== "LINK";

function main(): void {
  const started = stamp("identityshift", SEED);
  const corpus = loadCorpus();
  const reference = loadReference();
  const run = runLeaveOneFamilyOut(corpus, reference);
  const hard = run.outcomes.filter((o) => o.pair.family !== "easy");
  const easy = run.outcomes.filter((o) => o.pair.family === "easy");
  const m = summarise(hard);

  const cluster = (o: PairOutcome) => ({ cluster: o.pair.family, o });
  const rows = hard.map(cluster);
  const boot = (pick: (os: readonly PairOutcome[]) => number) => clusterBootstrap(rows, (s) => pick(s.map((x) => x.o)), { seed: SEED, resamples: 2000 });
  const ratio = (num: (o: PairOutcome) => boolean, den: (o: PairOutcome) => boolean) => (os: readonly PairOutcome[]) => {
    const d = os.filter(den);
    return d.length === 0 ? NaN : d.filter(num).length / d.length;
  };
  const link = (o: PairOutcome) => o.verdict === "LINK";
  const prec = ratio((o) => o.pair.truth === "MATCH", link);
  const rec = ratio(link, (o) => o.pair.truth === "MATCH");
  const surf = ratio((o) => o.verdict === "LINK" || o.verdict === "ABSTAIN", (o) => o.pair.truth === "MATCH");
  const abst = ratio((o) => o.verdict === "ABSTAIN", (o) => o.pair.truth === "AMBIGUOUS");
  const fm = ratio(link, (o) => o.pair.truth === "NON_MATCH");

  const rate = (k: number, n: number, bootstrap?: ReturnType<typeof boot>) => {
    const w = wilson(k, n);
    return {
      k,
      n,
      rate: Number.isFinite(w.rate) ? w.rate : null,
      wilsonLo: w.lo,
      wilsonHi: w.hi,
      ...(k === 0 && n > 0 ? { zeroErrorUpper95: zeroErrorUpperBound(n) } : {}),
      ...(bootstrap ? { clusterLo: bootstrap.lo, clusterHi: bootstrap.hi, clusters: bootstrap.clusters } : {}),
    };
  };

  const truthN = (t: string) => hard.filter((o) => o.pair.truth === t).length;
  const linked = hard.filter(link);
  const summaries: Record<string, unknown> = {
    cases: { pairs: hard.length, families: new Set(hard.map((o) => o.pair.family)).size, effective: effectiveSampleSize(rows), controlsUnrelatedPairs: easy.length },
    resolver: {
      precision: rate(linked.filter((o) => o.pair.truth === "MATCH").length, linked.length, boot(prec)),
      recall: rate(hard.filter((o) => o.pair.truth === "MATCH" && link(o)).length, truthN("MATCH"), boot(rec)),
      surfacedRecall: rate(hard.filter((o) => o.pair.truth === "MATCH" && (o.verdict === "LINK" || o.verdict === "ABSTAIN")).length, truthN("MATCH"), boot(surf)),
      correctAbstention: rate(hard.filter((o) => o.pair.truth === "AMBIGUOUS" && o.verdict === "ABSTAIN").length, truthN("AMBIGUOUS"), boot(abst)),
      falseMergeRate: rate(hard.filter((o) => o.pair.truth === "NON_MATCH" && link(o)).length, truthN("NON_MATCH"), boot(fm)),
      overconfidentOnAmbiguous: rate(hard.filter((o) => o.pair.truth === "AMBIGUOUS" && link(o)).length, truthN("AMBIGUOUS")),
      confirmedWhereTruthIsNotMatch: hard.filter((o) => o.state === "CONFIRMED" && o.pair.truth !== "MATCH").length,
      crossCheckAgainstCommittedReport: { precision: m.precision, recall: m.recall, correctAbstention: m.correctAbstention },
    },
  };

  // The baseline sees the same pairs.
  const recs = (id: string): Rec => corpus.records.get(id)!.record as unknown as Rec;
  const fuzzy = hard.map((o) => ({ o, v: fuzzyVerdict(recs(o.pair.a), recs(o.pair.b)) }));
  const fLinked = fuzzy.filter((x) => x.v === "LINK");
  const fBoot = (pick: (xs: readonly { o: PairOutcome; v: Verdict }[]) => number) => clusterBootstrap(fuzzy.map((x) => ({ cluster: x.o.pair.family, ...x })), (s) => pick(s), { seed: SEED + 1, resamples: 2000 });
  const fRatio = (num: (x: { o: PairOutcome; v: Verdict }) => boolean, den: (x: { o: PairOutcome; v: Verdict }) => boolean) => (xs: readonly { o: PairOutcome; v: Verdict }[]) => {
    const d = xs.filter(den);
    return d.length === 0 ? NaN : d.filter(num).length / d.length;
  };
  summaries["fuzzyNameBaseline"] = {
    description: "Link two records when their names share a non-generic token of four or more characters. No identifiers, no abstention. Same pairs, same families.",
    precision: rate(fLinked.filter((x) => x.o.pair.truth === "MATCH").length, fLinked.length, fBoot(fRatio((x) => x.o.pair.truth === "MATCH", (x) => x.v === "LINK"))),
    recall: rate(fuzzy.filter((x) => x.o.pair.truth === "MATCH" && x.v === "LINK").length, truthN("MATCH"), fBoot(fRatio((x) => x.v === "LINK", (x) => x.o.pair.truth === "MATCH"))),
    falseMergeRate: rate(fuzzy.filter((x) => x.o.pair.truth === "NON_MATCH" && x.v === "LINK").length, truthN("NON_MATCH"), fBoot(fRatio((x) => x.v === "LINK", (x) => x.o.pair.truth === "NON_MATCH"))),
    overconfidentOnAmbiguous: rate(fuzzy.filter((x) => x.o.pair.truth === "AMBIGUOUS" && x.v === "LINK").length, truthN("AMBIGUOUS")),
  };

  // Paired: pairs handled correctly, resolver against baseline, with and without credit for abstaining on ambiguous pairs.
  const paired = (abstainOk: boolean) => {
    let onlyR = 0;
    let onlyF = 0;
    for (const x of fuzzy) {
      const r = correct(x.o.pair.truth, x.o.verdict, abstainOk);
      const f = correct(x.o.pair.truth, x.v, abstainOk);
      if (r && !f) onlyR++;
      else if (!r && f) onlyF++;
    }
    return { onlyResolver: onlyR, onlyBaseline: onlyF, p: mcnemarExact(onlyR, onlyF).p };
  };
  const tests = [{ name: "pair handled correctly, an ambiguous pair must not be linked", ...paired(false) }, { name: "pair handled correctly, an ambiguous pair must be left ambiguous", ...paired(true) }];
  const adj = holm(tests.map((t) => t.p));
  summaries["resolverVersusFuzzy"] = tests.map((t, i) => ({ ...t, pHolm: adj[i] }));

  const perFamily: Record<string, unknown> = {};
  for (const fam of [...new Set(hard.map((o) => o.pair.family))].sort()) {
    const os = hard.filter((o) => o.pair.family === fam);
    perFamily[fam] = { pairs: os.length, linkedTrue: os.filter((o) => link(o) && o.pair.truth === "MATCH").length, linkedFalse: os.filter((o) => link(o) && o.pair.truth !== "MATCH").length, matchesMissed: os.filter((o) => o.pair.truth === "MATCH" && !link(o)).length };
  }
  summaries["perFamily"] = perFamily;

  writeResult("identityshift.json", {
    meta: {
      ...started,
      class: ["builder-labelled"],
      description: "IdentityShift: the existing leave-one-family-out evaluation of src/identity on data/identity-corpus, not re-tuned, with cluster-aware intervals and a fuzzy-name baseline. One reader labelled the corpus; the annotations for studies and papers (purpose tags, manufacturer) were supplied by the builder.",
      corpusHash: hashOfJson({ records: [...corpus.records.values()], pairs: corpus.pairs }).slice(0, 16),
      protocol: "leave-one-family-out; clusters are device families",
    },
    summaries,
    misses: hard.filter((o) => (o.pair.truth === "MATCH" && !link(o)) || (o.pair.truth !== "MATCH" && link(o))).map((o) => ({ pair: o.pair.id, family: o.pair.family, linkType: o.pair.linkType, truth: o.pair.truth, verdict: o.verdict, contestable: o.pair.contestable })),
  });
  const r = summaries["resolver"] as { precision: { k: number; n: number }; recall: { k: number; n: number }; falseMergeRate: { k: number; n: number } };
  console.log(`IdentityShift: ${hard.length} pairs, precision ${r.precision.k}/${r.precision.n}, recall ${r.recall.k}/${r.recall.n}, false merges ${r.falseMergeRate.k}/${r.falseMergeRate.n}`);
}

main();
