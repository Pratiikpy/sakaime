/**
 * Planted-restriction corpus for the MA-3 ablation.
 *
 * Each document is synthetic, generated from a seed, and long enough that a single prompt must either
 * truncate it or carry all of it. It is built like an FDA decision summary or a study report: the indication
 * is generic, the early pages state the version, the threshold and the enrolment, and ONE scope restriction is
 * planted deep in the text, inside an ordinary paragraph, where only a complete read reaches it. Decoy
 * sentences elsewhere reuse the restriction's key number in a non-restrictive sense.
 *
 * These documents are constructed, not real, and are labelled as such everywhere they are shown. They contain
 * no patient data.
 */
import type { Page } from "../pagination.ts";

export interface PlantedFact {
  field: "software_version" | "sample_size" | "operating_threshold" | "setting";
  page: number;
  /** Tokens that must all appear in a fact's quote or value for it to count as this fact. */
  keys: string[];
}

export interface PlantedRestriction {
  kind: "age" | "setting" | "version" | "condition" | "camera";
  page: number;
  sentence: string;
  /** Lower-case tokens that must all appear in the quote or value of a fact for it to count as this restriction. */
  keys: string[];
}

export interface SyntheticDocument {
  id: string;
  seed: number;
  constructed: true;
  pages: Page[];
  restriction: PlantedRestriction;
  planted: PlantedFact[];
  /** Pages carrying a decoy sentence that reuses the restriction's key without restricting anything. */
  decoyPages: number[];
  bytes: number;
}

export interface CorpusOptions {
  seed: number;
  pages?: number;
  /** The restriction lands at a page between these fractions of the document. Default 0.6 to 0.9. */
  depth?: [number, number];
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const between = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
const fixed = (r: () => number, lo: number, hi: number, d = 1): string => (lo + r() * (hi - lo)).toFixed(d);

const DEVICES = ["RetinaScope", "CardioSense", "DermaVue", "NeuroTrace", "PulmoAssist", "OncoLens", "GlucoSight", "AortaView"];
const SUBMITTERS = ["Meridian Diagnostics Inc.", "Northfield Medical Systems", "Calder Health Imaging Ltd.", "Aster Clinical AI", "Halcyon Devices Corp."];
const CONDITIONS = ["type 1 or type 2 diabetes", "known atrial fibrillation", "suspected pulmonary embolism", "a prior stroke", "chronic kidney disease"];
const SITES = ["a large urban academic centre", "three community clinics", "a regional referral hospital", "two primary care networks", "a university eye institute"];
const CAMERAS = ["Topcon NW400", "Canon CR-2 AF", "Optos Daytona", "Zeiss VISUCAM 524"];

type Slots = { dev: string; ver: string; n: number; thr: string; site: string; cond: string; r: () => number };

const BACKGROUND: ((s: Slots) => string)[] = [
  (s) => `Image quality was assessed by trained graders using a standardised protocol, and ${between(s.r, 3, 9)}.${between(s.r, 0, 9)}% of encounters were excluded for insufficient quality.`,
  (s) => `The ${s.dev} software is installed on a dedicated workstation and receives images over a validated DICOM connection.`,
  (s) => `Sensitivity was ${fixed(s.r, 84, 97)}% (95% CI ${fixed(s.r, 78, 88)} to ${fixed(s.r, 92, 99)}) and specificity was ${fixed(s.r, 80, 96)}% (95% CI ${fixed(s.r, 74, 86)} to ${fixed(s.r, 90, 98)}).`,
  (s) => `Adverse events were not observed during the study, and no device malfunction required intervention at any of the ${between(s.r, 3, 9)} participating locations.`,
  (s) => `The reference standard was a consensus reading by ${between(s.r, 2, 4)} independent specialists who were masked to the device output.`,
  (s) => `Repeatability testing across ${between(s.r, 20, 60)} operators gave a within-device standard deviation of ${fixed(s.r, 0.5, 3.5)} percentage points.`,
  (s) => `A hazard analysis identified ${between(s.r, 12, 41)} hazardous situations; each was mitigated to an acceptable level and verified in design validation.`,
  (s) => `Cybersecurity documentation follows the premarket guidance and includes a software bill of materials and a threat model reviewed in ${2019 + between(s.r, 0, 5)}.`,
  (s) => `The study population was ${fixed(s.r, 44, 58, 0)}% female with a mean age of ${fixed(s.r, 48, 63)} years and a mean disease duration of ${fixed(s.r, 6, 14)} years.`,
  (s) => `Subgroup analyses by sex, race and ethnicity showed overlapping confidence intervals, although several cells had fewer than ${between(s.r, 15, 40)} participants.`,
  (s) => `Training of site staff took ${between(s.r, 1, 3)} hours, delivered remotely, and was documented in the training log for each operator.`,
  (s) => `The algorithm outputs a categorical result and a continuous score; the categorical result is determined by comparing the score with the fixed cut-off.`,
  (s) => `Missing data were handled by complete-case analysis; ${between(s.r, 1, 5)}.${between(s.r, 0, 9)}% of records lacked a reference-standard reading and were excluded.`,
  (s) => `Software verification covered ${between(s.r, 600, 2400)} test cases, of which ${between(s.r, 3, 14)} were repeated after a defect fix, and all passed in the final build.`,
  (s) => `Labeling includes instructions for use, a quick reference card, and an on-screen notice that results must be reviewed by a clinician.`,
  (s) => `Environmental testing covered temperature, humidity and electromagnetic compatibility according to the applicable consensus standards.`,
  (s) => `The pivotal study was registered before enrolment began, and the statistical analysis plan was finalised before the database was locked.`,
  (s) => `Concordance between the two reading sessions was ${fixed(s.r, 90, 99)}% and the kappa statistic was ${fixed(s.r, 0.78, 0.96, 2)}.`,
  (s) => `The predicate device has the same fundamental technology; differences in the user interface do not raise new questions of safety or effectiveness.`,
  (s) => `Data were captured in an electronic system with an audit trail, and source data verification covered ${between(s.r, 10, 100)}% of case report forms.`,
  (s) => `The manufacturer will report post-market performance annually, and a complaint-handling process is in place for software defects.`,
  (s) => `Site ${between(s.r, 1, 9)} enrolled the largest share of participants, and a sensitivity analysis excluding it did not change the conclusions.`,
  (s) => `Interpretation of borderline scores is left to the clinician, and the labeling advises confirmatory examination when the score is within ${fixed(s.r, 0.02, 0.08, 2)} of the cut-off.`,
  (s) => `Bench testing used ${between(s.r, 40, 400)} archived images with known findings, none of which were used for training the algorithm.`,
  (s) => `Power calculations assumed a prevalence of ${fixed(s.r, 6, 18, 0)}% and a target lower bound for sensitivity of ${fixed(s.r, 75, 85, 0)}%.`,
];

export function buildDocument(opts: CorpusOptions): SyntheticDocument {
  const r = rng(opts.seed);
  const total = opts.pages ?? 60;
  const dev = pick(r, DEVICES);
  const submitter = pick(r, SUBMITTERS);
  const major = between(r, 1, 3);
  const ver = `${major}.${between(r, 0, 9)}.${between(r, 0, 9)}`;
  const n = between(r, 420, 2400);
  const thr = r() < 0.5 ? fixed(r, 0.35, 0.8, 2) : fixed(r, 0.05, 0.3, 2);
  const site = pick(r, SITES);
  const cond = pick(r, CONDITIONS);
  const slots: Slots = { dev, ver, n, thr, site, cond, r };
  const period = `${2019 + between(r, 0, 2)}-${String(between(r, 1, 12)).padStart(2, "0")} to ${2022 + between(r, 0, 2)}-${String(between(r, 1, 12)).padStart(2, "0")}`;

  // Restriction: where it lands, what kind it is.
  const [lo, hi] = opts.depth ?? [0.6, 0.9];
  const restrictionPage = Math.max(8, Math.min(total - 2, Math.floor(total * (lo + r() * (hi - lo)))));
  const kind = pick(r, ["age", "age", "setting", "version", "condition", "camera"] as const);
  let restriction: PlantedRestriction;
  let decoy: ((s: Slots) => string) | undefined;
  if (kind === "age") {
    const age = between(r, 18, 25);
    const phrase = pick(r, [
      `The ${dev} is not indicated for patients under ${age} years of age, because the study did not enrol participants in that group.`,
      `Use in patients younger than ${age} years has not been established and the device should not be used in them.`,
      `The device does not support use in patients under ${age}; no performance data exist for that population.`,
    ]);
    restriction = { kind, page: restrictionPage, sentence: phrase, keys: [String(age)] };
    decoy = () => `Of the enrolled participants, ${fixed(r, 1.5, 6)}% were under ${age} years of age at the screening visit.`;
  } else if (kind === "setting") {
    const out = pick(r, ["primary care", "emergency department", "inpatient wards"]);
    restriction = {
      kind,
      page: restrictionPage,
      sentence: `All data were collected in specialist outpatient clinics; performance in ${out} settings was not evaluated and should not be assumed.`,
      keys: [out.split(" ")[0] as string, "not evaluated"],
    };
    decoy = () => `Referral from ${out} accounted for ${fixed(r, 4, 15, 0)}% of the scheduled visits.`;
  } else if (kind === "version") {
    const other = `${major}.${between(r, 0, 9)}.${between(r, 0, 9)}`;
    restriction = {
      kind,
      page: restrictionPage,
      sentence: `These results apply only to software version ${ver}; earlier and later builds, including ${other === ver ? `${major}.9.9` : other}, were not evaluated.`,
      keys: [ver, "only"],
    };
    decoy = () => `The prior generation of the software, version ${major - 1}.${between(r, 0, 9)}.${between(r, 0, 9)}, was used in the feasibility work.`;
  } else if (kind === "condition") {
    restriction = {
      kind,
      page: restrictionPage,
      sentence: `Participants with ${cond} were excluded from the study and the device must not be used in this group.`,
      keys: [cond.split(" ").slice(-1)[0] as string, "excluded"],
    };
    decoy = () => `Comorbidity data, including ${cond}, were recorded at baseline for descriptive purposes.`;
  } else {
    const cam = pick(r, CAMERAS);
    restriction = {
      kind,
      page: restrictionPage,
      sentence: `The ${dev} was validated only with images from the ${cam}; use with any other camera is not supported.`,
      keys: [cam.split(" ")[0]?.toLowerCase() as string, "only"],
    };
    decoy = () => `Images from the ${cam} were also used in the human factors evaluation for the training module.`;
  }

  const decoyPages = new Set<number>();
  const planned: PlantedFact[] = [
    { field: "software_version", page: 3, keys: [ver] },
    { field: "operating_threshold", page: 9, keys: [thr] },
    { field: "setting", page: 13, keys: ["outpatient"] },
    { field: "sample_size", page: 14, keys: [String(n)] },
  ];

  const pages: Page[] = [];
  for (let p = 1; p <= total; p++) {
    const paras: string[] = [];
    if (p === 1) {
      paras.push(`510(k) SUBSTANTIAL EQUIVALENCE DETERMINATION DECISION SUMMARY (constructed example)`);
      paras.push(`Device: ${dev} Software. Submitter: ${submitter}. Product code: ${pick(r, ["QAS", "PIB", "QKQ", "MYN"])}. The submission concerns an AI-based image analysis aid for use by trained clinicians.`);
    } else if (p === 2) {
      paras.push(`INDICATIONS FOR USE`);
      paras.push(`The ${dev} software is an adjunctive aid intended to analyse images acquired from adult patients with ${cond} and to indicate whether findings warrant referral. It is not a stand-alone diagnostic.`);
    } else if (p === 3) {
      paras.push(`DEVICE DESCRIPTION`);
      paras.push(`In this summary, "the Device" means the ${dev} software, software version ${ver}, running on a validated workstation. The algorithm produces a score between 0 and 1 for each case.`);
    } else if (p === 9) {
      paras.push(`The categorical output is determined by an operating point of ${thr} that was fixed before the pivotal study and was not adjusted afterwards.`);
    } else if (p === 13) {
      paras.push(`STUDY DESIGN`);
      paras.push(`The pivotal study was conducted prospectively in specialist outpatient clinics at ${site}, and data were collected between ${period}.`);
    } else if (p === 14) {
      paras.push(`In total ${n.toLocaleString("en-US")} participants were prospectively enrolled, of whom ${between(r, 20, 90)} were withdrawn before the reference reading.`);
    }
    const target = between(r, 1800, 3400);
    let size = paras.join(" ").length;
    while (size < target) {
      const s = pick(r, BACKGROUND)(slots);
      paras.push(s);
      size += s.length + 1;
    }
    if (p === restrictionPage) paras.splice(between(r, 1, Math.max(1, paras.length - 1)), 0, restriction.sentence);
    else if (decoy && p !== 1 && p !== 2 && r() < 0.06 && Math.abs(p - restrictionPage) > 3) {
      paras.splice(between(r, 0, paras.length), 0, decoy(slots));
      decoyPages.add(p);
    }
    if (p === total - 1) paras.push(`CONCLUSION: the data support substantial equivalence for the indicated use described in this summary.`);
    pages.push({ page: p, text: paras.join("\n\n") });
  }
  if (decoy && decoyPages.size === 0) {
    const p = restrictionPage > total / 2 ? 5 + Math.floor(total / 8) : total - 4;
    const page = pages[p - 1] as Page;
    page.text = `${page.text}\n\n${decoy(slots)}`;
    decoyPages.add(p);
  }

  const bytes = pages.reduce((s, p) => s + Buffer.byteLength(p.text, "utf8"), 0);
  return { id: `synthetic-${opts.seed}`, seed: opts.seed, constructed: true, pages, restriction, planted: planned, decoyPages: [...decoyPages].sort((a, b) => a - b), bytes };
}

export function buildCorpus(count: number, base: { seed: number; pages?: number; depth?: [number, number] }): SyntheticDocument[] {
  return Array.from({ length: count }, (_, i) => buildDocument({ ...base, seed: base.seed + i * 7919 }));
}
