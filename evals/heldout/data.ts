/**
 * Held-out claim set for ScopeShift (B). CONSTRUCTED claims about five FDA 510(k) summaries that no development claim
 * uses. Written from the documents alone, before any Sakaime run and before any other arm was run on them.
 *
 * Labelling: single builder, two passes (a hand label, then a per-dimension table fed to a mechanical oracle,
 * evals/heldout/oracle.ts), not independent. No clinician has read the key. See evals/SEALED.md.
 *
 * Vocabulary: unlike the development claims (whose setting and purpose strings are the Gate 0 key's own and are mapped
 * by evals/lib/vocabulary.ts), these claims use the compiler's taxonomy keys directly where one exists. A term the
 * taxonomy cannot place is left as written, which the product treats as a reason for review.
 */
import type { CaseKey, Dimension, Label } from "../lib/types.ts";

export const NOTICE =
  "CONSTRUCTED CLAIM. Written for this test in the style of a vendor claim; it is not a statement by any vendor and says nothing about any vendor.";

export interface HeldoutSource {
  id: string;
  device: string;
  name: string;
  file: string;
  url: string;
  pdfSha256: string;
  /** The clearance letter date, quoted from the first page; this is when the authorization took effect. */
  decisionDate: string;
}

export const SOURCES: HeldoutSource[] = [
  { id: "K253801", device: "device:fda:K253801", name: "ECG-AI Cardiac Amyloidosis (CA) 12-Lead Algorithm (Anumana)", file: "evals/heldout/text/K253801_pages.txt", url: "https://www.accessdata.fda.gov/cdrh_docs/pdf25/K253801.pdf", pdfSha256: "64f33af7ee25ee51907c3da996b099ca2ec910c6211c756d26c650e1c7c81169", decisionDate: "2026-04-07" },
  { id: "K252360", device: "device:fda:K252360", name: "ECG-AI Pulmonary Hypertension 12-Lead algorithm (Anumana)", file: "evals/heldout/text/K252360_pages.txt", url: "https://www.accessdata.fda.gov/cdrh_docs/pdf25/K252360.pdf", pdfSha256: "baa24227cdf949a659bece9926c8855b9d2f23f0a320a506cb60c6ac61bce702", decisionDate: "2026-03-28" },
  { id: "K253825", device: "device:fda:K253825", name: "Saige-Dx (DeepHealth)", file: "evals/heldout/text/K253825_pages.txt", url: "https://www.accessdata.fda.gov/cdrh_docs/pdf25/K253825.pdf", pdfSha256: "dd0325fed31557a4822cefc4dbd420c73c2ae6b5b4d246a642430e4bbe8e6b8e", decisionDate: "2026-06-15" },
  { id: "K250680", device: "device:fda:K250680", name: "Bayesian Health Sepsis Flagging Device", file: "evals/heldout/text/K250680_pages.txt", url: "https://www.accessdata.fda.gov/cdrh_docs/pdf25/K250680.pdf", pdfSha256: "46ce487a01089308731a628b66a8dbe255b4512139398f81973af510ee0dc065", decisionDate: "2026-04-30" },
  { id: "K253163", device: "device:fda:K253163", name: "EFAI ERSUITE CT Appendicitis Assessment System (Ever Fortune.AI)", file: "evals/heldout/text/K253163_pages.txt", url: "https://www.accessdata.fda.gov/cdrh_docs/pdf25/K253163.pdf", pdfSha256: "359517c2eca2c17d148b92d2ac036a754734c3eb704316d90e00ac3c5e0542ff", decisionDate: "2026-04-22" },
];

/** Verbatim passages. build.ts checks each against its document and records the page. */
export const QUOTES: Record<string, { doc: string; quote: string }> = {
  "ca.ifu": { doc: "K253801", quote: "software as a medical device intended to aid in earlier detection of Cardiac Amyloidosis in adults being evaluated for signs or symptoms consistent with cardiac amyloidosis." },
  "ca.standalone": { doc: "K253801", quote: "is not intended to be a stand-alone diagnostic device for cardiac amyloidosis nor to replace current clinical practice guidelines." },
  "ca.negative": { doc: "K253801", quote: "a negative result should not rule out additional clinical evaluation." },
  "ca.study": { doc: "K253801", quote: "The study population included adults aged 18 years and older with both an ECG and TTE obtained within +/- 180 days of each other." },
  "ca.perf": { doc: "K253801", quote: "Sensitivity 78.9 % Specificity 91.2 %" },
  "ca.letter": { doc: "K253801", quote: "April 7, 2026 Anumana, Inc." },
  "ph.ifu": { doc: "K252360", quote: "software intended to aid in earlier detection of elevated mean pulmonary arterial pressure (mPAP), an indicator of pulmonary hypertension, in adults presenting with dyspnea." },
  "ph.pacer": { doc: "K252360", quote: "should not be used on ECGs from adults with an implanted pacemaker or on ECGs with a paced rhythm." },
  "ph.monitor": { doc: "K252360", quote: "is not intended for assessing disease progression or monitoring response to therapy." },
  "ph.serial": { doc: "K252360", quote: "is not intended for repeated testing in a short time interval, serial use during the same hospitalization or for serial monitoring." },
  "ph.version": { doc: "K252360", quote: "Product Name ECG-AI PH 12-Lead algorithm ECG-AI LEF 12-Lead algorithm (v3.1.0) (v2.5.0)" },
  "ph.perf": { doc: "K252360", quote: "sensitivity of 73.0% (95% CI of 72.1% to 73.9%), and a specificity of 74.4% (95% CI of 73.5% to 75.2%)." },
  "ph.inclusion": { doc: "K252360", quote: "age ≥ 18 with at least one dyspnea ICD code" },
  "sd.ifu": { doc: "K253825", quote: "The outputs of Saige-Dx are intended to be used as a concurrent reading aid for interpreting physicians on screening mammograms with compatible DBT hardware." },
  "sd.pop": { doc: "K253825", quote: "The device is intended to be used on women from a screening population undergoing screening mammography." },
  "sd.pred": { doc: "K253825", quote: "Predicate Device: Trade Name: Saige-Dx Device Model: v4.0.0" },
  "sd.adjunct": { doc: "K253825", quote: "is an adjunct tool and is not intended to replace a physician’s own review of a mammogram." },
  "sd.studies": { doc: "K253825", quote: "Saige-Dx was validated through two retrospective, blinded, pivotal standalone performance studies." },
  "sd.letter": { doc: "K253825", quote: "June 15, 2026 DeepHealth, Inc." },
  "se.ifu": { doc: "K250680", quote: "is intended to be used for adult patients (≥18 years old) upon Emergency Department (ED) presentation or hospital admission throughout the duration of the patient’s stay in acute care settings." },
  "se.purpose": { doc: "K250680", quote: "to aid in the early detection and/or risk prediction of sepsis developing within 24 hours." },
  "se.sole": { doc: "K250680", quote: "should not be used as the sole basis to determine the presence of sepsis" },
  "se.ppa": { doc: "K250680", quote: "the device achieved the following performance at the encounter-level: Encounter-level PPA 79.4% (95% CI 74.2-84.6)" },
  "se.notmet": { doc: "K250680", quote: "Although the device did not meet the pre-specified acceptance criteria for encounter-level PPA," },
  "se.n": { doc: "K250680", quote: "evaluated 7732 hospital encounters from 7298 unique patients" },
  "se.letter": { doc: "K250680", quote: "April 30, 2026 Bayesian Health Inc." },
  "ef.ifu": { doc: "K253163", quote: "indicated for use in the analysis of contrast-enhanced abdominal CT images. The device is intended to assist hospital networks and trained clinicians in workflow triage by flagging and communication of suspected positive findings of appendicitis." },
  "ef.notdx": { doc: "K253163", quote: "is not intended to be used as a diagnostic device." },
  "ef.full": { doc: "K253163", quote: "Notified clinicians are responsible for viewing full images per the standard of care." },
  "ef.perf": { doc: "K253163", quote: "sensitivity of 0.928 (95% CI: 0.873–0.960) and specificity of 0.932 (95% CI: 0.882–0.961)" },
  "ef.n": { doc: "K253163", quote: "The study evaluated 300 consecutively collected contrast-enhanced abdominal CT cases from multiple U.S. clinical sites" },
  "ef.letter": { doc: "K253163", quote: "April 22, 2026 Re: K253163" },
};

export type Relation = "CONTAINED" | "PARTIAL" | "DISJOINT" | "UNKNOWN";

/** Pass 2: the reader's per-dimension relations, fed to the mechanical oracle (oracle.ts). */
export interface Pass2 {
  relations: Partial<Record<Dimension, Relation>>;
  /** An authorization record states a numeric limit or a named exclusion that the claim extends beyond (rule R10). */
  explicitLimit?: boolean;
  /** The source states in words that the claimed use is not intended (the key's extension beyond the rule table). */
  textNegatesUse?: boolean;
  /** A hospital policy or an unplaced term sends the claim to a reviewer. */
  reviewFlag?: boolean;
  /** A relevant, adequate study reports a result wholly below the claim. */
  contraryAdequate?: boolean;
}

export interface HeldoutClaim {
  id: string;
  source: string;
  kind: "positive control" | "mismatch";
  text: string;
  use: Record<string, unknown>;
  performance?: { metric: string; atLeast: number };
  policy?: { stalenessWindowDays: number };
  key: CaseKey;
  quotes: string[];
  pass2: Pass2;
}

const L = (l: Label): Label => l;

export const CLAIMS: HeldoutClaim[] = [
  // ------------------------------------------------------------------------------------------- K253801 cardiac amyloidosis
  {
    id: "HO-CA-01",
    source: "K253801",
    kind: "positive control",
    text: "We use the ECG-AI Cardiac Amyloidosis 12-Lead Algorithm as an aid to earlier detection of cardiac amyloidosis in adults who are being evaluated for signs or symptoms consistent with it, together with clinician judgment. FDA's summary reports a sensitivity of 78.9% and a specificity of 91.2%.",
    use: { product: "device:fda:K253801", population: { age: { min: 18 }, conditions: ["adults being evaluated for signs or symptoms consistent with cardiac amyloidosis"] }, purpose: "detection_aid" },
    key: { expectedLabel: L("SUPPORTED_FOR_SCOPE"), acceptableLabels: [], keyConfidence: "clear", mismatches: [], note: "Population and purpose equal the indication; the validation enrolled adults 18 and older. No software version appears in the summary, so the claim names none." },
    quotes: ["ca.ifu", "ca.study", "ca.perf"],
    pass2: { relations: { product: "CONTAINED", population: "CONTAINED", purpose: "CONTAINED" } },
  },
  {
    id: "HO-CA-02",
    source: "K253801",
    kind: "mismatch",
    text: "The algorithm can be run on every adult who has a 12-lead ECG, whether or not cardiac amyloidosis is suspected, to flag possible cardiac amyloidosis.",
    use: { product: "device:fda:K253801", population: { age: { min: 18 }, conditions: ["adults being evaluated for signs or symptoms consistent with cardiac amyloidosis", "adults not being evaluated for signs or symptoms of cardiac amyloidosis"] }, purpose: "detection_aid" },
    key: {
      expectedLabel: L("SUPPORTED_ONLY_FOR_NARROWER_SCOPE"),
      acceptableLabels: [L("REQUIRES_DOMAIN_REVIEW"), L("CONTRADICTED_BY_SPECIFIED_EVIDENCE")],
      keyConfidence: "contestable",
      mismatches: [{ dimension: "population", claimed: "adults not being evaluated for signs or symptoms of cardiac amyloidosis (unselected adults with an ECG)", established: "adults being evaluated for signs or symptoms consistent with cardiac amyloidosis" }],
      supportedNarrowerScope: "adults being evaluated for signs or symptoms consistent with cardiac amyloidosis",
      note: "Whether the indication's population statement is an explicit limit (contradicted) or the covered part of a wider claim (narrower scope) is a labelling-policy question, as for CP-01 in the development set.",
    },
    quotes: ["ca.ifu", "ca.study"],
    pass2: { relations: { product: "CONTAINED", population: "PARTIAL", purpose: "CONTAINED" } },
  },
  {
    id: "HO-CA-03",
    source: "K253801",
    kind: "mismatch",
    text: "A negative result from the algorithm is enough for our cardiologists to rule out cardiac amyloidosis, so no further work-up is ordered.",
    use: { product: "device:fda:K253801", population: { age: { min: 18 }, conditions: ["adults being evaluated for signs or symptoms consistent with cardiac amyloidosis"] }, purpose: "diagnosis" },
    key: {
      expectedLabel: L("CONTRADICTED_BY_SPECIFIED_EVIDENCE"),
      acceptableLabels: [L("REQUIRES_DOMAIN_REVIEW"), L("INSUFFICIENT_EVIDENCE")],
      keyConfidence: "contestable",
      mismatches: [{ dimension: "purpose", claimed: "rule out cardiac amyloidosis on a negative result (diagnosis)", established: "aid to earlier detection; not a stand-alone diagnostic; a negative result should not rule out further evaluation" }],
      note: "The summary says in words that a negative result does not rule out further evaluation. The rule table has no rule for a sentence that negates a use, so a system that reads only the purpose taxonomy may report the wider purpose as a narrower scope.",
    },
    quotes: ["ca.standalone", "ca.negative"],
    pass2: { relations: { product: "CONTAINED", population: "CONTAINED", purpose: "PARTIAL" }, textNegatesUse: true },
  },
  {
    id: "HO-CA-04",
    source: "K253801",
    kind: "mismatch",
    text: "From 1 July 2030 our program will rely on the evidence behind K253801, which we regard as current.",
    use: { product: "device:fda:K253801", timing: { from: "2030-07-01" } },
    policy: { stalenessWindowDays: 1095 },
    key: {
      expectedLabel: L("REQUIRES_DOMAIN_REVIEW"),
      acceptableLabels: [],
      keyConfidence: "clear",
      mismatches: [{ dimension: "timing", claimed: "evidence relied on from 2030-07-01", established: "clearance letter dated 2026-04-07; no source states a window for how long it stays current" }],
      note: "The hospital policy passed with the case sets a staleness window of 1095 days; the gap is about four years. No source sets a threshold, so the label is a review, never a verdict.",
    },
    quotes: ["ca.letter"],
    pass2: { relations: { product: "CONTAINED", timing: "CONTAINED" }, reviewFlag: true },
  },
  // ------------------------------------------------------------------------------------------- K252360 pulmonary hypertension
  {
    id: "HO-PH-01",
    source: "K252360",
    kind: "positive control",
    text: "ECG-AI PH 12-Lead (v3.1.0) aids earlier detection of elevated mean pulmonary arterial pressure in adults presenting with dyspnea; we do not run it on ECGs with a paced rhythm or an implanted pacemaker. FDA's summary reports a sensitivity of 73.0% and a specificity of 74.4%.",
    use: { product: "device:fda:K252360", versions: ["3.1.0"], population: { age: { min: 18 }, conditions: ["adults presenting with dyspnea"], exclusions: ["implanted pacemaker or paced rhythm"] }, purpose: "detection_aid" },
    key: { expectedLabel: L("SUPPORTED_FOR_SCOPE"), acceptableLabels: [], keyConfidence: "clear", mismatches: [], note: "Version 3.1.0 is the subject device in the substantial-equivalence table; the pacemaker exclusion in the claim equals the one in the indication." },
    quotes: ["ph.ifu", "ph.pacer", "ph.version", "ph.inclusion", "ph.perf"],
    pass2: { relations: { product: "CONTAINED", version: "CONTAINED", population: "CONTAINED", purpose: "CONTAINED" } },
  },
  {
    id: "HO-PH-02",
    source: "K252360",
    kind: "mismatch",
    text: "ECG-AI PH 12-Lead (v3.1.0) can also be run on ECGs from patients with an implanted pacemaker or a paced rhythm in our dyspnea clinic.",
    use: { product: "device:fda:K252360", versions: ["3.1.0"], population: { age: { min: 18 }, conditions: ["adults presenting with dyspnea", "adults with an implanted pacemaker or paced rhythm"] }, purpose: "detection_aid" },
    key: {
      expectedLabel: L("CONTRADICTED_BY_SPECIFIED_EVIDENCE"),
      acceptableLabels: [L("REQUIRES_DOMAIN_REVIEW"), L("INSUFFICIENT_EVIDENCE")],
      keyConfidence: "clear",
      mismatches: [{ dimension: "population", claimed: "ECGs from adults with an implanted pacemaker or a paced rhythm", established: "should not be used on ECGs from adults with an implanted pacemaker or on ECGs with a paced rhythm" }],
      note: "A named exclusion in the indication that the claim extends beyond (rule R10).",
    },
    quotes: ["ph.pacer", "ph.version"],
    pass2: { relations: { product: "CONTAINED", version: "CONTAINED", population: "PARTIAL", purpose: "CONTAINED" }, explicitLimit: true },
  },
  {
    id: "HO-PH-03",
    source: "K252360",
    kind: "mismatch",
    text: "We use ECG-AI PH 12-Lead (v3.1.0) to monitor response to therapy in patients already being treated for pulmonary hypertension, with a repeat ECG at each clinic visit.",
    use: { product: "device:fda:K252360", versions: ["3.1.0"], population: { conditions: ["patients already being treated for pulmonary hypertension"] }, purpose: "monitoring" },
    key: {
      expectedLabel: L("CONTRADICTED_BY_SPECIFIED_EVIDENCE"),
      acceptableLabels: [L("INSUFFICIENT_EVIDENCE"), L("REQUIRES_DOMAIN_REVIEW")],
      keyConfidence: "contestable",
      mismatches: [{ dimension: "purpose", claimed: "monitoring response to therapy with repeated ECGs", established: "not intended for assessing disease progression or monitoring response to therapy; not intended for serial monitoring" }],
      note: "The summary excludes monitoring in words. A purpose taxonomy that only places monitoring apart from detection sees a different purpose, which also withholds support.",
    },
    quotes: ["ph.monitor", "ph.serial", "ph.version"],
    pass2: { relations: { product: "CONTAINED", version: "CONTAINED", population: "DISJOINT", purpose: "DISJOINT" }, textNegatesUse: true },
  },
  {
    id: "HO-PH-04",
    source: "K252360",
    kind: "mismatch",
    text: "ECG-AI PH 12-Lead (v2.5.0) detects elevated mean pulmonary arterial pressure in adults presenting with dyspnea, as FDA's summary shows (sensitivity 73.0%).",
    use: { product: "device:fda:K252360", versions: ["2.5.0"], population: { age: { min: 18 }, conditions: ["adults presenting with dyspnea"] }, purpose: "detection_aid" },
    key: {
      expectedLabel: L("INSUFFICIENT_EVIDENCE"),
      acceptableLabels: [L("REQUIRES_DOMAIN_REVIEW")],
      keyConfidence: "contestable",
      mismatches: [{ dimension: "version", claimed: "2.5.0", established: "3.1.0 (the subject device); 2.5.0 is the predicate ECG-AI LEF 12-Lead algorithm" }],
      note: "The only version string tied to the subject is 3.1.0. The 2.5.0 in the same table row belongs to the predicate (a different Anumana product).",
    },
    quotes: ["ph.version", "ph.perf"],
    pass2: { relations: { product: "CONTAINED", version: "DISJOINT", population: "CONTAINED", purpose: "CONTAINED" } },
  },
  // ------------------------------------------------------------------------------------------- K253825 Saige-Dx
  {
    id: "HO-SD-01",
    source: "K253825",
    kind: "positive control",
    text: "Saige-Dx is our concurrent reading aid for interpreting physicians on screening digital breast tomosynthesis mammograms of women in our screening program, on compatible systems.",
    use: { product: "device:fda:K253825", population: { conditions: ["women from a screening population undergoing screening mammography"] }, purpose: "detection_aid" },
    key: { expectedLabel: L("SUPPORTED_FOR_SCOPE"), acceptableLabels: [], keyConfidence: "clear", mismatches: [], note: "No software version is stated for the subject device, so the claim names none." },
    quotes: ["sd.ifu", "sd.pop"],
    pass2: { relations: { product: "CONTAINED", population: "CONTAINED", purpose: "CONTAINED" } },
  },
  {
    id: "HO-SD-02",
    source: "K253825",
    kind: "mismatch",
    text: "Saige-Dx v4.0.0, the release we run, is the version FDA reviewed in the pivotal standalone studies of K253825.",
    use: { product: "device:fda:K253825", versions: ["4.0.0"], purpose: "detection_aid" },
    key: {
      expectedLabel: L("INSUFFICIENT_EVIDENCE"),
      acceptableLabels: [L("REQUIRES_DOMAIN_REVIEW")],
      keyConfidence: "contestable",
      mismatches: [{ dimension: "version", claimed: "4.0.0", established: "the summary names no version for the subject device; v4.0.0 is the model number of the predicate (K251873)" }],
      note: "The one version string in the document belongs to the predicate. The subject is described only as 'the current version'.",
    },
    quotes: ["sd.pred", "sd.studies"],
    pass2: { relations: { product: "CONTAINED", version: "UNKNOWN", purpose: "CONTAINED" } },
  },
  {
    id: "HO-SD-03",
    source: "K253825",
    kind: "mismatch",
    text: "Saige-Dx lets us skip the radiologist's own read of screening tomosynthesis exams that it rates as low suspicion.",
    use: { product: "device:fda:K253825", population: { conditions: ["women from a screening population undergoing screening mammography"] }, purpose: "autonomous_reading" },
    key: {
      expectedLabel: L("CONTRADICTED_BY_SPECIFIED_EVIDENCE"),
      acceptableLabels: [L("REQUIRES_DOMAIN_REVIEW"), L("INSUFFICIENT_EVIDENCE")],
      keyConfidence: "contestable",
      mismatches: [{ dimension: "purpose", claimed: "autonomous reading: no radiologist read for low-suspicion exams", established: "adjunct tool, not intended to replace a physician's own review; concurrent reading aid" }],
      note: "Same kind of claim as MS-02 in the development set.",
    },
    quotes: ["sd.adjunct", "sd.ifu"],
    pass2: { relations: { product: "CONTAINED", population: "CONTAINED", purpose: "DISJOINT" }, textNegatesUse: true, reviewFlag: true },
  },
  {
    id: "HO-SD-04",
    source: "K253825",
    kind: "mismatch",
    text: "Saige-Dx supports the interpretation of diagnostic mammograms of symptomatic women recalled from screening.",
    use: { product: "device:fda:K253825", population: { conditions: ["symptomatic women undergoing diagnostic mammography"] }, purpose: "detection_aid" },
    key: {
      expectedLabel: L("INSUFFICIENT_EVIDENCE"),
      acceptableLabels: [L("REQUIRES_DOMAIN_REVIEW"), L("CONTRADICTED_BY_SPECIFIED_EVIDENCE")],
      keyConfidence: "contestable",
      mismatches: [{ dimension: "population", claimed: "symptomatic women undergoing diagnostic mammography", established: "women from a screening population undergoing screening mammography" }],
    },
    quotes: ["sd.pop", "sd.ifu"],
    pass2: { relations: { product: "CONTAINED", population: "DISJOINT", purpose: "CONTAINED" } },
  },
  // ------------------------------------------------------------------------------------------- K250680 sepsis
  {
    id: "HO-SE-01",
    source: "K250680",
    kind: "positive control",
    text: "We run the Bayesian Health Sepsis Flagging Device on adult patients (18 and older) from emergency department presentation or hospital admission through their stay, as an aid to early detection and risk prediction of sepsis within 24 hours, never as the sole basis for a decision.",
    use: { product: "device:fda:K250680", population: { age: { min: 18 } }, settings: ["hospital"], purpose: "detection_aid" },
    key: { expectedLabel: L("SUPPORTED_FOR_SCOPE"), acceptableLabels: [], keyConfidence: "clear", mismatches: [], note: "The indication names ED presentation or hospital admission through the stay in acute care settings; the study covered emergency department, intensive care unit and ward at four hospitals." },
    quotes: ["se.ifu", "se.purpose", "se.sole", "se.n"],
    pass2: { relations: { product: "CONTAINED", population: "CONTAINED", setting: "CONTAINED", purpose: "CONTAINED" } },
  },
  {
    id: "HO-SE-02",
    source: "K250680",
    kind: "mismatch",
    text: "We also run the Bayesian Health Sepsis Flagging Device on adolescent inpatients aged 12 and older.",
    use: { product: "device:fda:K250680", population: { age: { min: 12 } }, settings: ["inpatient_ward"], purpose: "detection_aid" },
    key: {
      expectedLabel: L("CONTRADICTED_BY_SPECIFIED_EVIDENCE"),
      acceptableLabels: [L("REQUIRES_DOMAIN_REVIEW"), L("INSUFFICIENT_EVIDENCE")],
      keyConfidence: "clear",
      mismatches: [{ dimension: "population", claimed: "aged 12 and older", established: "adult patients (18 years old and older)" }],
      note: "A numeric age limit in the indication that the claim extends beyond (rule R10).",
    },
    quotes: ["se.ifu"],
    pass2: { relations: { product: "CONTAINED", population: "PARTIAL", setting: "CONTAINED", purpose: "CONTAINED" }, explicitLimit: true },
  },
  {
    id: "HO-SE-03",
    source: "K250680",
    kind: "mismatch",
    text: "The Bayesian Health Sepsis Flagging Device reaches an encounter-level positive percent agreement of at least 85% in adult hospital encounters.",
    use: { product: "device:fda:K250680", population: { age: { min: 18 } }, settings: ["hospital"], purpose: "detection_aid" },
    performance: { metric: "ppa", atLeast: 0.85 },
    key: {
      expectedLabel: L("CONTRADICTED_BY_SPECIFIED_EVIDENCE"),
      acceptableLabels: [L("REQUIRES_DOMAIN_REVIEW")],
      keyConfidence: "contestable",
      mismatches: [{ dimension: "metric", claimed: "encounter-level PPA of at least 85%", established: "encounter-level PPA 79.4% (95% CI 74.2-84.6), which did not meet the study's own 80% acceptance criterion" }],
      note: "The whole interval lies below the claim. Whether the study counts as adequate to contradict a claim is a judgement; the validation was the FDA-reviewed multi-site study.",
    },
    quotes: ["se.ppa", "se.notmet"],
    pass2: { relations: { product: "CONTAINED", population: "CONTAINED", setting: "CONTAINED", purpose: "CONTAINED", metric: "DISJOINT" }, contraryAdequate: true },
  },
  {
    id: "HO-SE-04",
    source: "K250680",
    kind: "mismatch",
    text: "We use the Bayesian Health Sepsis Flagging Device in our outpatient primary-care clinics to flag adults at risk of sepsis in the next 24 hours.",
    use: { product: "device:fda:K250680", population: { age: { min: 18 } }, settings: ["primary_care"], purpose: "detection_aid" },
    key: {
      expectedLabel: L("INSUFFICIENT_EVIDENCE"),
      acceptableLabels: [L("REQUIRES_DOMAIN_REVIEW"), L("CONTRADICTED_BY_SPECIFIED_EVIDENCE")],
      keyConfidence: "contestable",
      mismatches: [{ dimension: "setting", claimed: "outpatient primary care", established: "emergency department presentation, hospital admission and the stay in acute care settings" }],
    },
    quotes: ["se.ifu", "se.n"],
    pass2: { relations: { product: "CONTAINED", population: "CONTAINED", setting: "DISJOINT", purpose: "CONTAINED" } },
  },
  // ------------------------------------------------------------------------------------------- K253163 appendicitis triage
  {
    id: "HO-EF-01",
    source: "K253163",
    kind: "positive control",
    text: "EFAI Appendicitis notifies clinicians in our hospital network of suspected appendicitis on contrast-enhanced abdominal CT so that the worklist can be prioritised. FDA's summary reports a sensitivity of 0.928 and a specificity of 0.932 in 300 cases.",
    use: { product: "device:fda:K253163", population: { conditions: ["contrast-enhanced abdominal CT"] }, settings: ["hospital"], purpose: "triage_notification" },
    key: { expectedLabel: L("SUPPORTED_FOR_SCOPE"), acceptableLabels: [], keyConfidence: "clear", mismatches: [], note: "The summary states no age range and no software version, so the claim names neither." },
    quotes: ["ef.ifu", "ef.perf", "ef.n"],
    pass2: { relations: { product: "CONTAINED", population: "CONTAINED", setting: "CONTAINED", purpose: "CONTAINED" } },
  },
  {
    id: "HO-EF-02",
    source: "K253163",
    kind: "mismatch",
    text: "EFAI Appendicitis triages all abdominal CT in our hospital network, with or without contrast.",
    use: { product: "device:fda:K253163", population: { conditions: ["contrast-enhanced abdominal CT", "non-contrast abdominal CT"] }, settings: ["hospital"], purpose: "triage_notification" },
    key: {
      expectedLabel: L("SUPPORTED_ONLY_FOR_NARROWER_SCOPE"),
      acceptableLabels: [L("REQUIRES_DOMAIN_REVIEW"), L("CONTRADICTED_BY_SPECIFIED_EVIDENCE")],
      keyConfidence: "contestable",
      mismatches: [{ dimension: "population", claimed: "abdominal CT without contrast", established: "contrast-enhanced abdominal CT images" }],
      supportedNarrowerScope: "contrast-enhanced abdominal CT",
      note: "Whether the stated image type is an explicit limit (contradicted) or the covered part of a wider claim is a labelling-policy question.",
    },
    quotes: ["ef.ifu", "ef.n"],
    pass2: { relations: { product: "CONTAINED", population: "PARTIAL", setting: "CONTAINED", purpose: "CONTAINED" } },
  },
  {
    id: "HO-EF-03",
    source: "K253163",
    kind: "mismatch",
    text: "Our radiologists confirm appendicitis from the EFAI Appendicitis notification and send the patient to surgery without separately reviewing the images.",
    use: { product: "device:fda:K253163", population: { conditions: ["contrast-enhanced abdominal CT"] }, settings: ["hospital"], purpose: "diagnosis" },
    key: {
      expectedLabel: L("CONTRADICTED_BY_SPECIFIED_EVIDENCE"),
      acceptableLabels: [L("REQUIRES_DOMAIN_REVIEW"), L("INSUFFICIENT_EVIDENCE")],
      keyConfidence: "contestable",
      mismatches: [{ dimension: "purpose", claimed: "diagnosis from the notification without image review", established: "not intended to be used as a diagnostic device; notified clinicians are responsible for viewing full images" }],
      note: "A purpose taxonomy that places triage inside diagnosis can report the wider purpose as a narrower scope; the summary states in words that the device is not diagnostic.",
    },
    quotes: ["ef.notdx", "ef.full"],
    pass2: { relations: { product: "CONTAINED", population: "CONTAINED", setting: "CONTAINED", purpose: "PARTIAL" }, textNegatesUse: true },
  },
  {
    id: "HO-EF-04",
    source: "K253163",
    kind: "mismatch",
    text: "Since 1 January 2026 our hospital network has run EFAI Appendicitis triage in production on contrast-enhanced abdominal CT.",
    use: { product: "device:fda:K253163", population: { conditions: ["contrast-enhanced abdominal CT"] }, settings: ["hospital"], purpose: "triage_notification", timing: { from: "2026-01-01" } },
    key: {
      expectedLabel: L("CONTRADICTED_BY_SPECIFIED_EVIDENCE"),
      acceptableLabels: [L("REQUIRES_DOMAIN_REVIEW")],
      keyConfidence: "clear",
      mismatches: [{ dimension: "timing", claimed: "in production since 2026-01-01", established: "clearance letter dated 2026-04-22; the authorization took effect on that date" }],
      note: "The claimed use began before the authorization existed.",
    },
    quotes: ["ef.letter"],
    pass2: { relations: { product: "CONTAINED", population: "CONTAINED", setting: "CONTAINED", purpose: "CONTAINED", timing: "DISJOINT" }, explicitLimit: true },
  },
];
