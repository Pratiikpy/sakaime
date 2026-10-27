/**
 * ClinicalTrials.gov API v2 parser: one study (/studies/{nct}) or a search response ({ totalCount, studies }).
 *
 * Reads enrolment, sites, eligibility (ages, sex, conditions, inclusion and exclusion items), interventions,
 * references, status and dates. An absent field stays absent: "N/A" for an age limit is an open bound, not zero.
 * The results section is NOT parsed (no fixture holds one); a study with results is flagged and nothing is invented.
 */
import { PortError } from "../../ports/index.ts";
import { parseRegistryAge } from "../age.ts";
import { sentenceSpans } from "../text.ts";
import type { VerifyOptions } from "../verify.ts";
import {
  asNumber,
  asRecord,
  asString,
  drifted,
  FieldCollector,
  isoOrPartialDate,
  parseJson,
  type StructuredExtraction,
} from "./collector.ts";

const SOURCE = "ClinicalTrials.gov";

export interface CriterionItem {
  text: string;
  /** Offsets into the eligibilityCriteria text. */
  start: number;
  end: number;
}

export interface StudyFacts {
  nctId: string;
  title?: string;
  status?: string;
  statusVerified?: string;
  lastUpdate?: string;
  startDate?: string;
  primaryCompletionDate?: string;
  completionDate?: string;
  enrollment?: { count: number; type?: string };
  sponsor?: string;
  conditions: string[];
  interventions: string[];
  studyType?: string;
  timePerspective?: string;
  observationalModel?: string;
  allocation?: string;
  masking?: string;
  population: {
    /** In years. Absent means the registry states no limit. */
    ageMin?: number;
    ageMax?: number;
    sex?: string;
    stdAges: string[];
    healthyVolunteers?: boolean;
    description?: string;
    samplingMethod?: string;
  };
  inclusion: string[];
  exclusion: string[];
  siteCount?: number;
  countries: string[];
  references: { pmid?: string; type?: string }[];
  /** K, DEN and P numbers written in the title, description or interventions. */
  submissionsMentioned: string[];
  secondaryIds: { id: string; type?: string }[];
  hasResults?: boolean;
}

type Opts = Pick<VerifyOptions, "model">;

/**
 * Split the free-text eligibility criteria into inclusion and exclusion items. Bulleted lists give one item per
 * bullet (continuation lines are joined); an unbulleted list gives one item per non-empty line.
 */
export function parseCriteria(text: string): { inclusion: CriterionItem[]; exclusion: CriterionItem[] } {
  const out = { inclusion: [] as CriterionItem[], exclusion: [] as CriterionItem[] };
  const heads = [...text.matchAll(/^[ \t]*(Inclusion|Exclusion)\s+Criteria\s*:?[ \t]*$/gim)];
  const blocks: { kind: "inclusion" | "exclusion"; start: number; end: number }[] = [];
  heads.forEach((h, i) => {
    const kind = (h[1] as string).toLowerCase() === "inclusion" ? "inclusion" : "exclusion";
    blocks.push({ kind, start: (h.index as number) + h[0].length, end: i + 1 < heads.length ? (heads[i + 1] as RegExpMatchArray).index ?? text.length : text.length });
  });
  if (blocks.length === 0) return out; // criteria with no headings are kept as one text and not split
  for (const b of blocks) {
    const body = text.slice(b.start, b.end);
    const lines: { raw: string; start: number }[] = [];
    let pos = 0;
    for (const raw of body.split("\n")) {
      lines.push({ raw, start: b.start + pos });
      pos += raw.length + 1;
    }
    const bulleted = lines.some((l) => /^\s*(?:[*\u2022-]|\d+[.)])\s+\S/.test(l.raw));
    let current: CriterionItem | undefined;
    const flush = () => {
      if (current && current.text.trim()) {
        const trimmed = current.text.replace(/\s+$/, "");
        out[b.kind].push({ text: trimmed, start: current.start, end: current.start + trimmed.length });
      }
      current = undefined;
    };
    for (const l of lines) {
      if (l.raw.trim() === "") {
        if (!bulleted) flush();
        else if (current) flush();
        continue;
      }
      const m = /^(\s*(?:[*\u2022-]|\d+[.)])\s+)(\S.*)$/.exec(l.raw);
      if (bulleted) {
        if (m) {
          flush();
          current = { text: m[2] as string, start: l.start + (m[1] as string).length, end: 0 };
        } else if (current) {
          // continuation of the previous bullet: keep the original characters between the two lines
          const gap = text.slice(current.start + current.text.length, l.start + (l.raw.length - l.raw.trimStart().length));
          current.text += gap + l.raw.trimStart();
        } else {
          current = { text: l.raw.trimStart(), start: l.start + (l.raw.length - l.raw.trimStart().length), end: 0 };
        }
      } else {
        flush();
        current = { text: l.raw.trimStart(), start: l.start + (l.raw.length - l.raw.trimStart().length), end: 0 };
        flush();
      }
    }
    flush();
  }
  return out;
}

function parseStudy(
  c: FieldCollector,
  study: Record<string, unknown>,
  prefix: string,
  warnings: string[],
): StudyFacts | undefined {
  const proto = asRecord(study.protocolSection);
  const ident = asRecord(proto?.identificationModule);
  const nctId = asString(ident?.nctId);
  if (!proto || !nctId) throw drifted(SOURCE, `${prefix}: protocolSection.identificationModule.nctId is missing`);
  if (!/^NCT\d{8}$/.test(nctId)) throw drifted(SOURCE, `${prefix}: nctId "${nctId}" is not an NCT identifier`);
  const subjectId = `study:${nctId}`;
  const s = { subjectId };
  const pp = `${prefix}.protocolSection`;

  const facts: StudyFacts = {
    nctId,
    conditions: [],
    interventions: [],
    population: { stdAges: [] },
    inclusion: [],
    exclusion: [],
    countries: [],
    references: [],
    submissionsMentioned: [],
    secondaryIds: [],
  };

  c.scalar(`${pp}.identificationModule.nctId`, nctId, "document.identifier", nctId, s);

  const official = asString(ident?.officialTitle);
  const brief = asString(ident?.briefTitle);
  const title = official ?? brief;
  if (title) {
    facts.title = title;
    const path = official ? `${pp}.identificationModule.officialTitle` : `${pp}.identificationModule.briefTitle`;
    c.scalar(path, title, "study.title", title, s);
  }

  const orgId = asRecord(ident?.orgStudyIdInfo);
  const orgIdValue = asString(orgId?.id);
  if (orgIdValue) {
    facts.secondaryIds.push({ id: orgIdValue, type: "ORG_STUDY_ID" });
    c.scalar(`${pp}.identificationModule.orgStudyIdInfo.id`, orgIdValue, "study.secondary_id", orgIdValue, { ...s, detail: { qualifiers: ["ORG_STUDY_ID"] } });
  }
  (Array.isArray(ident?.secondaryIdInfos) ? (ident?.secondaryIdInfos as unknown[]) : []).forEach((x, i) => {
    const r = asRecord(x);
    const id = asString(r?.id);
    if (!id) return;
    const type = asString(r?.type);
    facts.secondaryIds.push({ id, ...(type ? { type } : {}) });
    c.scalar(`${pp}.identificationModule.secondaryIdInfos[${i}].id`, id, "study.secondary_id", id, { ...s, ...(type ? { detail: { qualifiers: [type] } } : {}) });
  });

  const status = asRecord(proto.statusModule);
  facts.status = asString(status?.overallStatus);
  c.scalar(`${pp}.statusModule.overallStatus`, facts.status, "study.status", facts.status, s);
  const verified = isoOrPartialDate(status?.statusVerifiedDate);
  if (verified) {
    facts.statusVerified = verified;
    c.scalar(`${pp}.statusModule.statusVerifiedDate`, verified, "study.status_verified", verified, s);
  }
  const dateOf = (key: string): { value: string; path: string; type?: string } | undefined => {
    const st = asRecord(status?.[key]);
    const d = isoOrPartialDate(st?.date);
    return d ? { value: d, path: `${pp}.statusModule.${key}.date`, ...(asString(st?.type) ? { type: st?.type as string } : {}) } : undefined;
  };
  const start = dateOf("startDateStruct");
  if (start) {
    facts.startDate = start.value;
    c.scalar(start.path, start.value, "study.start_date", start.value, { ...s, ...(start.type ? { detail: { qualifiers: [start.type.toLowerCase()] } } : {}) });
  }
  const pcd = dateOf("primaryCompletionDateStruct");
  if (pcd) {
    facts.primaryCompletionDate = pcd.value;
    c.scalar(pcd.path, pcd.value, "study.primary_completion_date", pcd.value, { ...s, ...(pcd.type ? { detail: { qualifiers: [pcd.type.toLowerCase()] } } : {}) });
  }
  const cd = dateOf("completionDateStruct");
  if (cd) {
    facts.completionDate = cd.value;
    c.scalar(cd.path, cd.value, "study.completion_date", cd.value, { ...s, ...(cd.type ? { detail: { qualifiers: [cd.type.toLowerCase()] } } : {}) });
  }
  const upd = dateOf("lastUpdatePostDateStruct");
  if (upd) {
    facts.lastUpdate = upd.value;
    c.scalar(upd.path, upd.value, "study.last_update", upd.value, s);
  }

  const lead = asRecord(asRecord(proto.sponsorCollaboratorsModule)?.leadSponsor);
  facts.sponsor = asString(lead?.name);
  c.scalar(`${pp}.sponsorCollaboratorsModule.leadSponsor.name`, facts.sponsor, "study.sponsor", facts.sponsor, s);

  const conds = asRecord(proto.conditionsModule);
  const condList = (Array.isArray(conds?.conditions) ? (conds?.conditions as unknown[]) : []).map(asString).filter((x): x is string => !!x);
  facts.conditions = condList;
  condList.forEach((cn, i) => c.scalar(`${pp}.conditionsModule.conditions[${i}]`, cn, "population.condition", cn, s));

  const design = asRecord(proto.designModule);
  facts.studyType = asString(design?.studyType);
  c.scalar(`${pp}.designModule.studyType`, facts.studyType, "study.type", facts.studyType, s);
  const di = asRecord(design?.designInfo);
  facts.timePerspective = asString(di?.timePerspective);
  c.scalar(`${pp}.designModule.designInfo.timePerspective`, facts.timePerspective, "study.time_perspective", facts.timePerspective, s);
  facts.observationalModel = asString(di?.observationalModel);
  c.scalar(`${pp}.designModule.designInfo.observationalModel`, facts.observationalModel, "study.observational_model", facts.observationalModel, s);
  facts.allocation = asString(di?.allocation);
  c.scalar(`${pp}.designModule.designInfo.allocation`, facts.allocation, "study.allocation", facts.allocation, s);
  facts.masking = asString(asRecord(di?.maskingInfo)?.masking);
  c.scalar(`${pp}.designModule.designInfo.maskingInfo.masking`, facts.masking, "study.masking", facts.masking, s);

  const enr = asRecord(design?.enrollmentInfo);
  const count = asNumber(enr?.count);
  if (count !== undefined) {
    const type = asString(enr?.type);
    facts.enrollment = { count, ...(type ? { type } : {}) };
    // ESTIMATED enrolment is a plan, not what happened; the qualifier travels with the number
    c.scalar(`${pp}.designModule.enrollmentInfo.count`, count, "study.sample_size", count, {
      ...s,
      unit: "participants",
      assertionType: "study",
      numbers: [{ value: count, form: "count" }],
      detail: { qualifiers: [type ? type.toLowerCase() : "enrolment_type_unstated"] },
    });
  }

  const elig = asRecord(proto.eligibilityModule);
  if (elig) {
    const minAge = asString(elig.minimumAge);
    const maxAge = asString(elig.maximumAge);
    const lo = parseRegistryAge(minAge);
    const hi = parseRegistryAge(maxAge);
    if (lo !== undefined) {
      facts.population.ageMin = lo;
      c.scalar(`${pp}.eligibilityModule.minimumAge`, minAge, "population.age_min", lo, { ...s, unit: "years" });
    } else if (minAge && !/^n\/a$/i.test(minAge.trim())) {
      warnings.push(`${nctId}: minimumAge "${minAge}" was not understood and is left open`);
    }
    if (hi !== undefined) {
      facts.population.ageMax = hi;
      c.scalar(`${pp}.eligibilityModule.maximumAge`, maxAge, "population.age_max", hi, { ...s, unit: "years" });
    } else if (maxAge && !/^n\/a$/i.test(maxAge.trim())) {
      warnings.push(`${nctId}: maximumAge "${maxAge}" was not understood and is left open`);
    }
    const sex = asString(elig.sex);
    if (sex) {
      facts.population.sex = sex;
      c.scalar(`${pp}.eligibilityModule.sex`, sex, "population.sex", sex, s);
    }
    const std = (Array.isArray(elig.stdAges) ? (elig.stdAges as unknown[]) : []).map(asString).filter((x): x is string => !!x);
    facts.population.stdAges = std;
    if (std.length) c.scalar(`${pp}.eligibilityModule.stdAges`, std.join(", "), "population.age_groups", std, s);
    if (typeof elig.healthyVolunteers === "boolean") {
      facts.population.healthyVolunteers = elig.healthyVolunteers;
      c.scalar(`${pp}.eligibilityModule.healthyVolunteers`, elig.healthyVolunteers ? "true" : "false", "population.healthy_volunteers", elig.healthyVolunteers, s);
    }
    const desc = asString(elig.studyPopulation);
    if (desc) {
      facts.population.description = desc;
      c.scalar(`${pp}.eligibilityModule.studyPopulation`, desc, "population.description", desc, s);
    }
    const sampling = asString(elig.samplingMethod);
    if (sampling) {
      facts.population.samplingMethod = sampling;
      c.scalar(`${pp}.eligibilityModule.samplingMethod`, sampling, "study.sampling_method", sampling, s);
    }
    const criteria = asString(elig.eligibilityCriteria);
    if (criteria) {
      const items = parseCriteria(criteria);
      const cpath = `${pp}.eligibilityModule.eligibilityCriteria`;
      for (const it of items.inclusion) {
        facts.inclusion.push(it.text);
        c.excerpt(cpath, criteria, it.text, "population.inclusion_criterion", it.text, { label: "Eligibility criteria", subjectId });
      }
      for (const it of items.exclusion) {
        facts.exclusion.push(it.text);
        c.excerpt(cpath, criteria, it.text, "population.exclusion_criterion", it.text, { label: "Eligibility criteria", subjectId });
      }
      if (items.inclusion.length + items.exclusion.length === 0) {
        warnings.push(`${nctId}: eligibility criteria have no Inclusion/Exclusion headings and were kept as text only`);
      }
    }
  }

  const arms = asRecord(proto.armsInterventionsModule);
  (Array.isArray(arms?.interventions) ? (arms?.interventions as unknown[]) : []).forEach((x, i) => {
    const r = asRecord(x);
    const name = asString(r?.name);
    if (!name) return;
    facts.interventions.push(name);
    c.scalar(`${pp}.armsInterventionsModule.interventions[${i}].name`, name, "study.intervention", name, s);
    const d = asString(r?.description);
    if (d) c.field(`${pp}.armsInterventionsModule.interventions[${i}].description`, d, "Intervention description");
  });

  const locs = asRecord(proto.contactsLocationsModule)?.locations;
  if (Array.isArray(locs)) {
    facts.siteCount = locs.length;
    const countries = new Set<string>();
    for (const l of locs) {
      const country = asString(asRecord(l)?.country);
      if (country) countries.add(country);
    }
    facts.countries = [...countries];
    if (locs.length > 0) {
      // the list itself is the evidence; one field holds it so the count and countries can be quoted
      const listing = locs
        .map((l) => {
          const r = asRecord(l);
          return [asString(r?.facility), asString(r?.city), asString(r?.country)].filter(Boolean).join(", ");
        })
        .join("\n");
      const lpath = `${pp}.contactsLocationsModule.locations`;
      const page = c.field(lpath, listing, "Study locations");
      if (page !== undefined) {
        c.proposals.push({
          subjectId,
          predicate: "study.site_count",
          value: locs.length,
          unit: "sites",
          assertionType: "study",
          extractionMethod: "structured",
          quote: listing,
          page,
          detail: { qualifiers: ["count_of_lines"] },
        });
      }
      for (const country of countries) {
        const cpage = c.field(lpath, listing, "Study locations");
        if (cpage !== undefined) {
          c.proposals.push({
            subjectId,
            predicate: "study.country",
            value: country,
            assertionType: "study",
            extractionMethod: "structured",
            quote: listing,
            page: cpage,
          });
        }
      }
    }
  }

  const refs = asRecord(proto.referencesModule)?.references;
  (Array.isArray(refs) ? refs : []).forEach((x, i) => {
    const r = asRecord(x);
    const pmid = asString(r?.pmid);
    const type = asString(r?.type);
    facts.references.push({ ...(pmid ? { pmid } : {}), ...(type ? { type } : {}) });
    if (pmid) c.scalar(`${pp}.referencesModule.references[${i}].pmid`, pmid, "document.cites_pmid", pmid, { ...s, assertionType: "study", ...(type ? { detail: { qualifiers: [type] } } : {}) });
  });

  // K, DEN and P numbers written in free text link the registry record to an authorization
  const texts: { path: string; text: string; label: string }[] = [];
  if (title) texts.push({ path: official ? `${pp}.identificationModule.officialTitle` : `${pp}.identificationModule.briefTitle`, text: title, label: "Title" });
  const dm = asRecord(proto.descriptionModule);
  for (const [k, label] of [["briefSummary", "Brief summary"], ["detailedDescription", "Detailed description"]] as const) {
    const t = asString(dm?.[k]);
    if (t) texts.push({ path: `${pp}.descriptionModule.${k}`, text: t, label });
  }
  (Array.isArray(arms?.interventions) ? (arms?.interventions as unknown[]) : []).forEach((x, i) => {
    const r = asRecord(x);
    for (const k of ["name", "description"] as const) {
      const t = asString(r?.[k]);
      if (t) texts.push({ path: `${pp}.armsInterventionsModule.interventions[${i}].${k}`, text: t, label: "Intervention" });
    }
  });
  const mentioned = new Set<string>();
  for (const t of texts) {
    for (const span of sentenceSpans(t.text)) {
      const sentence = t.text.slice(span.start, span.end);
      for (const m of sentence.matchAll(/(?<![A-Z0-9])(K\d{6}|DEN\d{6}|P\d{6})(?!\d)/g)) {
        const id = m[1] as string;
        if (!mentioned.has(id)) mentioned.add(id);
        c.excerpt(t.path, t.text, sentence, "document.cites_submission", id, { assertionType: "study", label: t.label, subjectId });
      }
      for (const design of ["prospective", "retrospective"] as const) {
        if (new RegExp(`\\b${design}\\b`, "i").test(sentence)) {
          c.excerpt(t.path, t.text, sentence, "study.design", design, { assertionType: "study", label: t.label, subjectId, detail: { qualifiers: ["registry_text_plan"] } });
        }
      }
    }
  }
  facts.submissionsMentioned = [...mentioned];

  if (typeof study.hasResults === "boolean") {
    facts.hasResults = study.hasResults;
    if (study.hasResults) warnings.push(`${nctId}: the record has a results section, which this parser does not read`);
  }
  return facts;
}

/**
 * Parse a ClinicalTrials.gov v2 response. A single study object and a search response are both accepted.
 */
export async function parseClinicalTrials(
  raw: unknown,
  recordId: string,
  opts: Opts = {},
): Promise<StructuredExtraction<{ studies: StudyFacts[]; totalCount?: number }>> {
  const json = asRecord(parseJson(raw, SOURCE));
  if (!json) throw drifted(SOURCE, "the body is not an object");
  if (asString(json.error) || asString(json.message)) {
    throw new PortError("UNAVAILABLE", `${SOURCE} returned an error: ${String(json.error ?? json.message)}`);
  }
  const c = new FieldCollector(`record:${recordId}`, "study");
  const warnings: string[] = [];
  const studies: StudyFacts[] = [];

  let list: { study: Record<string, unknown>; prefix: string }[];
  let totalCount: number | undefined;
  if (Array.isArray(json.studies)) {
    totalCount = asNumber(json.totalCount);
    if (totalCount === undefined) throw drifted(SOURCE, "a search response has no totalCount");
    list = json.studies.map((st, i) => {
      const r = asRecord(st);
      if (!r) throw drifted(SOURCE, `studies[${i}] is not an object`);
      return { study: r, prefix: `$.studies[${i}]` };
    });
  } else if (json.protocolSection) {
    list = [{ study: json, prefix: "$" }];
  } else {
    throw drifted(SOURCE, "expected a protocolSection or a studies array", { keys: Object.keys(json) });
  }

  for (const item of list) {
    const f = parseStudy(c, item.study, item.prefix, warnings);
    if (f) studies.push(f);
  }
  const health = studies.length === 0 ? "EMPTY" : "OK";
  const out = await c.finish(recordId, { studies, ...(totalCount !== undefined ? { totalCount } : {}) }, health, opts);
  out.warnings.push(...warnings);
  if (totalCount !== undefined && totalCount > studies.length) return { ...out, truncated: { returned: studies.length, total: totalCount } };
  return out;
}
