/**
 * Controlled term lists shared by the extractor and the support rules, so a term the extractor reports is judged by
 * the same definition when it is checked.
 */

export const SETTING_TERMS: [string, RegExp][] = [
  ["primary care", /\bprimary\s+care\b/i],
  ["eye care", /\beye\s+care\b/i],
  ["ophthalmology", /\bophthalmolog(?:y|ist)\b/i],
  ["emergency department", /\bemergency\s+(?:department|room|setting)\b/i],
  ["acute setting", /\bacute\s+setting\b/i],
  ["hospital network", /\bhospital\s+networks?\b/i],
  ["healthcare facility", /\bhealth\s?care\s+facilit(?:y|ies)\b/i],
  ["hospital", /\bhospitals?\b(?!\s+networks?)/i],
  ["outpatient", /\boutpatient\b/i],
  ["inpatient", /\binpatient\b/i],
  ["point of care", /\bpoint[- ]of[- ]care\b/i],
  ["intensive care", /\b(?:intensive\s+care|ICU)\b/i],
  ["clinic", /\bclinics?\b/i],
];

export const PURPOSE_TERMS: [string, RegExp][] = [
  ["triage", /\btriage\b/i],
  ["notification", /\bnotification\b/i],
  ["prioritization", /\bprioriti[sz]ation\b/i],
  ["detection", /\bdetect(?:ion|s|ing)?\b/i],
  ["screening", /\bscreening\b/i],
  ["concurrent reading aid", /\bconcurrent\s+read(?:ing|er)\b/i],
  ["diagnostic aid", /\baid\s+(?:in|to)\s+(?:the\s+)?diagnos/i],
  ["guidance", /\bguidance\b/i],
];

export const GROUP_TERMS: [string, RegExp][] = [
  ["adults", /\badults?\b/i],
  ["transitional adolescents", /\btransitional\s+adolescents?\b/i],
  ["pediatric", /\b(?:pediatric|paediatric|children)\b/i],
  ["women", /\bwomen\b/i],
  ["men", /\bmen\b/i],
];

export const TERM_PREDICATES: Record<string, [string, RegExp][]> = {
  "indication.setting_term": SETTING_TERMS,
  "indication.purpose_term": PURPOSE_TERMS,
  "population.group_term": GROUP_TERMS,
};

/**
 * A development, training or tuning context: the numbers there describe the data the algorithm learned from, not
 * the data it was tested on. "Operator training" is not model training and does not match.
 */
export const DEVELOPMENT =
  /\b(?:training\s+(?:set|data|dataset|cases|images|process)|(?:was|were)\s+trained\s+(?:on|using|with)|trained\s+(?:on|using)|algorithm\s+training|model\s+training|development\s+(?:set|data|dataset|cases)|algorithm\s+development|set-aside|derivation|tuning|validation\s+set|internal\s+validation|cross[- ]validation)\b/i;
