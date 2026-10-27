import { z } from "zod";
import { cmp, normKey, normText } from "./util.ts";

/**
 * Hierarchies are data, not code. A taxonomy is a forest: each node names its parent, the next broader node.
 * Evidence established on a node covers a claimed node that is that node or any of its descendants.
 * Settings read "emergency department, inside hospital, inside any care setting". Purposes read
 * "triage notification, inside detection aid, inside diagnosis" (the broader purpose is the more consequential one).
 * A term the taxonomy cannot place is never guessed at: the compiler reports UNKNOWN and raises a review flag.
 */
export const TaxonomySchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    nodes: z.record(z.string().min(1), z.object({ label: z.string().min(1), parent: z.string().min(1).optional() })),
    /** Alternative spellings that resolve to a node key. */
    aliases: z.record(z.string().min(1), z.string().min(1)).default({}),
  })
  .superRefine((t, ctx) => {
    for (const [key, node] of Object.entries(t.nodes)) {
      if (normKey(key) !== key) ctx.addIssue({ code: "custom", message: `node key "${key}" is not in normalised form`, path: ["nodes", key] });
      if (node.parent !== undefined && !(node.parent in t.nodes)) {
        ctx.addIssue({ code: "custom", message: `parent "${node.parent}" of "${key}" is not a node`, path: ["nodes", key, "parent"] });
      }
    }
    for (const key of Object.keys(t.nodes)) {
      const seen = new Set<string>();
      let cur: string | undefined = key;
      while (cur !== undefined) {
        if (seen.has(cur)) {
          ctx.addIssue({ code: "custom", message: `cycle through "${cur}"`, path: ["nodes", key] });
          break;
        }
        seen.add(cur);
        cur = t.nodes[cur]?.parent;
      }
    }
    for (const [alias, target] of Object.entries(t.aliases)) {
      if (!(target in t.nodes)) ctx.addIssue({ code: "custom", message: `alias "${alias}" points at unknown node "${target}"`, path: ["aliases", alias] });
      if (normKey(alias) in t.nodes) ctx.addIssue({ code: "custom", message: `alias "${alias}" shadows a node key`, path: ["aliases", alias] });
    }
  });
export type Taxonomy = z.infer<typeof TaxonomySchema>;
export type TaxonomyInput = z.input<typeof TaxonomySchema>;

export class Hierarchy {
  readonly taxonomy: Taxonomy;
  private readonly aliasMap: Map<string, string>;

  constructor(taxonomy: Taxonomy) {
    this.taxonomy = taxonomy;
    this.aliasMap = new Map(Object.entries(taxonomy.aliases).map(([a, t]) => [normKey(a), t]));
  }

  /** The canonical key for a raw term. Unplaced terms come back normalised so they can still be compared for equality. */
  resolve(raw: string): { key: string; placed: boolean } {
    const k = normKey(raw);
    if (k in this.taxonomy.nodes) return { key: k, placed: true };
    const aliased = this.aliasMap.get(k);
    if (aliased !== undefined) return { key: aliased, placed: true };
    return { key: k, placed: false };
  }

  has(key: string): boolean {
    return key in this.taxonomy.nodes;
  }

  label(key: string): string {
    return this.taxonomy.nodes[key]?.label ?? key.replace(/_/g, " ");
  }

  ancestorsOrSelf(key: string): string[] {
    const out: string[] = [];
    let cur: string | undefined = key;
    while (cur !== undefined && this.has(cur)) {
      out.push(cur);
      cur = this.taxonomy.nodes[cur]?.parent;
    }
    return out;
  }

  /** True when `broad` is `narrow` or one of its ancestors. Both must be placed. */
  covers(broad: string, narrow: string): boolean {
    if (!this.has(broad) || !this.has(narrow)) return false;
    return this.ancestorsOrSelf(narrow).includes(broad);
  }

  /** Keep only the broadest nodes: a node whose ancestor is already in the set adds nothing. */
  maximal(keys: Iterable<string>): string[] {
    const set = new Set(keys);
    return [...set]
      .filter((k) => !this.has(k) || !this.ancestorsOrSelf(k).slice(1).some((a) => set.has(a)))
      .sort(cmp);
  }

  render(keys: Iterable<string>): string {
    return [...keys].map((k) => this.label(k)).sort(cmp).join(", ");
  }
}

export const DEFAULT_SETTING_TAXONOMY: Taxonomy = TaxonomySchema.parse({
  id: "sakaime-settings",
  version: "1",
  nodes: {
    any_care_setting: { label: "any care setting" },
    hospital: { label: "hospital (any unit)", parent: "any_care_setting" },
    emergency_department: { label: "emergency department", parent: "hospital" },
    inpatient_ward: { label: "inpatient ward", parent: "hospital" },
    intensive_care_unit: { label: "intensive care unit", parent: "hospital" },
    outpatient_care: { label: "outpatient care (any clinic)", parent: "any_care_setting" },
    primary_care: { label: "primary care", parent: "outpatient_care" },
    urgent_care: { label: "urgent care", parent: "outpatient_care" },
    specialty_clinic: { label: "specialty clinic", parent: "outpatient_care" },
    eye_care: { label: "eye care", parent: "specialty_clinic" },
    imaging_centre: { label: "imaging centre", parent: "outpatient_care" },
    home_or_remote: { label: "home or remote care", parent: "any_care_setting" },
  },
  aliases: {
    ed: "emergency_department",
    er: "emergency_department",
    emergency_room: "emergency_department",
    emergency: "emergency_department",
    icu: "intensive_care_unit",
    ward: "inpatient_ward",
    inpatient: "inpatient_ward",
    gp: "primary_care",
    primary: "primary_care",
    outpatient: "outpatient_care",
    ophthalmology_clinic: "eye_care",
    eye_clinic: "eye_care",
    any: "any_care_setting",
    all_settings: "any_care_setting",
    any_setting: "any_care_setting",
  },
});

export const DEFAULT_PURPOSE_TAXONOMY: Taxonomy = TaxonomySchema.parse({
  id: "sakaime-purposes",
  version: "1",
  nodes: {
    diagnosis: { label: "diagnosis" },
    detection_aid: { label: "detection aid", parent: "diagnosis" },
    triage_notification: { label: "triage notification", parent: "detection_aid" },
    screening: { label: "screening of an unselected population" },
    prognosis: { label: "prognosis or risk prediction" },
    monitoring: { label: "monitoring" },
    treatment_planning: { label: "treatment planning" },
    acquisition_guidance: { label: "image acquisition guidance" },
  },
  aliases: {
    triage: "triage_notification",
    prioritisation: "triage_notification",
    prioritization: "triage_notification",
    notification: "triage_notification",
    cad: "detection_aid",
    cade: "detection_aid",
    computer_aided_detection: "detection_aid",
    diagnostic: "diagnosis",
    risk_prediction: "prognosis",
  },
});

/**
 * Metric names. Only definitional equivalences are listed (sensitivity is recall is the true positive rate).
 * A metric not listed here is compared by its normalised name alone.
 */
export const METRIC_TABLE = {
  version: "1",
  aliases: {
    recall: "sensitivity",
    true_positive_rate: "sensitivity",
    tpr: "sensitivity",
    true_negative_rate: "specificity",
    tnr: "specificity",
    precision: "ppv",
    positive_predictive_value: "ppv",
    negative_predictive_value: "npv",
    auroc: "auc",
    roc_auc: "auc",
    area_under_the_curve: "auc",
    area_under_roc_curve: "auc",
  } as Readonly<Record<string, string>>,
  /** Metrics whose value depends on the prevalence of the target condition in the tested population. */
  prevalenceDependent: ["ppv", "npv", "alert_rate", "nnt"] as readonly string[],
} as const;

export function normMetric(raw: string): string {
  const k = normKey(normText(raw));
  return METRIC_TABLE.aliases[k] ?? k;
}

export const isPrevalenceDependent = (metricKey: string): boolean => METRIC_TABLE.prevalenceDependent.includes(metricKey);
