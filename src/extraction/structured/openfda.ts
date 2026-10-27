/**
 * openFDA parsers: 510(k)/De Novo clearance records, GUDID device records (UDI), PMA records and product
 * classifications. Typed code, no model. Each returns anchors on the JSON path of the field it read.
 *
 * Outcomes are kept apart: a 404 "No matches found" is EMPTY (the source answered, nothing matches), any other error
 * body is UNAVAILABLE, and a body without the expected envelope is DRIFTED. They are never merged.
 */
import { PortError } from "../../ports/index.ts";
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
import type { VerifyOptions } from "../verify.ts";

const SOURCE = "openFDA";

interface Envelope {
  results: Record<string, unknown>[];
  total: number;
  skip: number;
  limit: number;
}

function unwrap(raw: unknown, endpoint: string): Envelope | "EMPTY" {
  const json = asRecord(parseJson(raw, `${SOURCE} ${endpoint}`));
  if (!json) throw drifted(SOURCE, `${endpoint}: the body is not an object`);
  const error = asRecord(json.error);
  if (error) {
    if (error.code === "NOT_FOUND") return "EMPTY";
    throw new PortError("UNAVAILABLE", `${SOURCE} ${endpoint} returned an error: ${String(error.code)}: ${String(error.message)}`, { error });
  }
  const meta = asRecord(json.meta);
  const results = json.results;
  const counts = asRecord(meta?.results);
  if (!meta || !counts || !Array.isArray(results)) throw drifted(SOURCE, `${endpoint}: expected meta.results and a results array`, { keys: Object.keys(json) });
  const total = asNumber(counts.total);
  if (total === undefined) throw drifted(SOURCE, `${endpoint}: meta.results.total is missing`);
  const rows = results.map((r) => asRecord(r));
  if (rows.some((r) => r === undefined)) throw drifted(SOURCE, `${endpoint}: a result is not an object`);
  return { results: rows as Record<string, unknown>[], total, skip: asNumber(counts.skip) ?? 0, limit: asNumber(counts.limit) ?? rows.length };
}

function truncation(env: Envelope): StructuredExtraction["truncated"] | undefined {
  return env.total > env.skip + env.results.length ? { returned: env.results.length, total: env.total } : undefined;
}

type Opts = Pick<VerifyOptions, "model">;

async function emptyResult<F>(recordId: string, facts: F, c: FieldCollector, opts: Opts): Promise<StructuredExtraction<F>> {
  return c.finish(recordId, facts, "EMPTY", opts);
}

// ------------------------------------------------------------------------------------------ 510(k) / De Novo

export interface Clearance {
  number: string;
  deviceName?: string;
  applicant?: string;
  decisionDate?: string;
  dateReceived?: string;
  decisionCode?: string;
  decisionDescription?: string;
  clearanceType?: string;
  productCode?: string;
  regulationNumber?: string;
  deviceClass?: string;
  summaryOrStatement?: string;
}

export async function parseOpenFda510k(raw: unknown, recordId: string, opts: Opts = {}): Promise<StructuredExtraction<{ clearances: Clearance[] }>> {
  const env = unwrap(raw, "device/510k");
  const c = new FieldCollector(`record:${recordId}`, "authorization");
  if (env === "EMPTY") return emptyResult(recordId, { clearances: [] }, c, opts);
  const clearances: Clearance[] = [];
  env.results.forEach((r, i) => {
    const number = asString(r.k_number);
    if (!number || !/^(K\d{6}|DEN\d{6}|P\d{6})$/.test(number)) throw drifted(SOURCE, `device/510k: result ${i} has no valid k_number`, { k_number: r.k_number });
    const subject = `device:fda:${number}`;
    const p = `$.results[${i}]`;
    const open = asRecord(r.openfda);
    const x: Clearance = { number };
    const put = <K extends keyof Clearance>(key: K, value: Clearance[K] | undefined) => {
      if (value !== undefined) x[key] = value;
    };
    put("deviceName", asString(r.device_name));
    put("applicant", asString(r.applicant));
    put("decisionDate", isoOrPartialDate(r.decision_date));
    put("dateReceived", isoOrPartialDate(r.date_received));
    put("decisionCode", asString(r.decision_code));
    put("decisionDescription", asString(r.decision_description));
    put("clearanceType", asString(r.clearance_type));
    put("productCode", asString(r.product_code));
    put("regulationNumber", asString(open?.regulation_number));
    put("deviceClass", asString(open?.device_class));
    put("summaryOrStatement", asString(r.statement_or_summary));
    clearances.push(x);

    const s = { subjectId: subject };
    c.scalar(`${p}.k_number`, number, "document.identifier", number, s);
    c.scalar(`${p}.device_name`, x.deviceName, "device.name", x.deviceName, s);
    c.scalar(`${p}.applicant`, x.applicant, "authorization.applicant", x.applicant, s);
    c.scalar(`${p}.decision_date`, r.decision_date as string | undefined, "authorization.decision_date", x.decisionDate, s);
    c.scalar(`${p}.date_received`, r.date_received as string | undefined, "authorization.date_received", x.dateReceived, s);
    c.scalar(`${p}.decision_code`, x.decisionCode, "authorization.decision_code", x.decisionCode, s);
    c.scalar(`${p}.decision_description`, x.decisionDescription, "authorization.decision", x.decisionDescription, s);
    c.scalar(`${p}.clearance_type`, x.clearanceType, "authorization.pathway", x.clearanceType, s);
    c.scalar(`${p}.product_code`, x.productCode, "authorization.product_code", x.productCode, s);
    c.scalar(`${p}.openfda.regulation_number`, x.regulationNumber, "authorization.regulation_number", x.regulationNumber, s);
    c.scalar(`${p}.openfda.device_class`, x.deviceClass, "authorization.device_class", x.deviceClass, s);
    c.scalar(`${p}.statement_or_summary`, x.summaryOrStatement, "authorization.summary_kind", x.summaryOrStatement, s);
  });
  const out = await c.finish(recordId, { clearances }, "OK", opts);
  const t = truncation(env);
  return t ? { ...out, truncated: t } : out;
}

// ------------------------------------------------------------------------------------------------ GUDID (UDI)

export interface UdiDevice {
  primaryDi?: string;
  brandName?: string;
  /** version_or_model_number exactly as the labeler filed it. Absent stays absent. */
  versionOrModel?: string;
  companyName?: string;
  description?: string;
  premarketSubmissions: { number: string; supplement?: string }[];
  distributionStatus?: string;
  distributionEnd?: string;
  publicVersionDate?: string;
  recordStatus?: string;
  productCodes: string[];
}

export async function parseOpenFdaUdi(raw: unknown, recordId: string, opts: Opts = {}): Promise<StructuredExtraction<{ devices: UdiDevice[] }>> {
  const env = unwrap(raw, "device/udi");
  const c = new FieldCollector(`record:${recordId}`, "vendor");
  if (env === "EMPTY") return emptyResult(recordId, { devices: [] }, c, opts);
  const devices: UdiDevice[] = [];
  env.results.forEach((r, i) => {
    const p = `$.results[${i}]`;
    const ids = Array.isArray(r.identifiers) ? r.identifiers.map(asRecord).filter((x): x is Record<string, unknown> => !!x) : [];
    const primary = ids.find((x) => x.type === "Primary") ?? ids[0];
    const primaryDi = asString(primary?.id);
    const subs = (Array.isArray(r.premarket_submissions) ? r.premarket_submissions : [])
      .map(asRecord)
      .filter((x): x is Record<string, unknown> => !!x && !!asString(x.submission_number))
      .map((x) => ({ number: x.submission_number as string, ...(asString(x.supplement_number) ? { supplement: x.supplement_number as string } : {}) }));
    const codes = (Array.isArray(r.product_codes) ? r.product_codes : []).map((x) => asString(asRecord(x)?.code)).filter((x): x is string => !!x);
    const d: UdiDevice = { premarketSubmissions: subs, productCodes: codes };
    const set = <K extends keyof UdiDevice>(k: K, v: UdiDevice[K] | undefined) => {
      if (v !== undefined) d[k] = v;
    };
    set("primaryDi", primaryDi);
    set("brandName", asString(r.brand_name));
    set("versionOrModel", asString(r.version_or_model_number));
    set("companyName", asString(r.company_name));
    set("description", asString(r.device_description));
    set("distributionStatus", asString(r.commercial_distribution_status));
    set("distributionEnd", isoOrPartialDate(r.commercial_distribution_end_date));
    set("publicVersionDate", isoOrPartialDate(r.public_version_date));
    set("recordStatus", asString(r.record_status));
    devices.push(d);

    const subject = `device:gudid:${primaryDi ?? `${recordId}#${i}`}`;
    const s = { subjectId: subject };
    c.scalar(`${p}.brand_name`, d.brandName, "device.name", d.brandName, s);
    c.scalar(`${p}.version_or_model_number`, d.versionOrModel, "device.version", d.versionOrModel, { ...s, detail: { qualifiers: ["gudid_label"] } });
    c.scalar(`${p}.company_name`, d.companyName, "device.manufacturer", d.companyName, s);
    c.scalar(`${p}.device_description`, d.description, "device.description", d.description, s);
    c.scalar(`${p}.commercial_distribution_status`, d.distributionStatus, "device.distribution_status", d.distributionStatus, s);
    c.scalar(`${p}.commercial_distribution_end_date`, r.commercial_distribution_end_date as string | undefined, "device.distribution_end", d.distributionEnd, s);
    c.scalar(`${p}.public_version_date`, r.public_version_date as string | undefined, "device.record_version_date", d.publicVersionDate, s);
    subs.forEach((sub, j) => {
      c.scalar(`${p}.premarket_submissions[${j}].submission_number`, sub.number, "device.premarket_submission", sub.number, s);
    });
  });
  const out = await c.finish(recordId, { devices }, "OK", opts);
  const t = truncation(env);
  return t ? { ...out, truncated: t } : out;
}

// -------------------------------------------------------------------------------------------------------- PMA

export interface PmaRecord {
  number: string;
  supplement?: string;
  applicant?: string;
  tradeName?: string;
  genericName?: string;
  productCode?: string;
  decisionDate?: string;
  decisionCode?: string;
  approvalOrderStatement?: string;
}

export async function parseOpenFdaPma(raw: unknown, recordId: string, opts: Opts = {}): Promise<StructuredExtraction<{ records: PmaRecord[] }>> {
  const env = unwrap(raw, "device/pma");
  const c = new FieldCollector(`record:${recordId}`, "authorization");
  if (env === "EMPTY") return emptyResult(recordId, { records: [] }, c, opts);
  const records: PmaRecord[] = [];
  env.results.forEach((r, i) => {
    const number = asString(r.pma_number);
    if (!number || !/^P\d{6}$/.test(number)) throw drifted(SOURCE, `device/pma: result ${i} has no valid pma_number`, { pma_number: r.pma_number });
    const p = `$.results[${i}]`;
    const rec: PmaRecord = { number };
    const set = <K extends keyof PmaRecord>(k: K, v: PmaRecord[K] | undefined) => {
      if (v !== undefined) rec[k] = v;
    };
    set("supplement", asString(r.supplement_number));
    set("applicant", asString(r.applicant));
    set("tradeName", asString(r.trade_name));
    set("genericName", asString(r.generic_name));
    set("productCode", asString(r.product_code));
    set("decisionDate", isoOrPartialDate(r.decision_date));
    set("decisionCode", asString(r.decision_code));
    set("approvalOrderStatement", asString(r.ao_statement));
    records.push(rec);
    const subject = `device:fda:${number}${rec.supplement ? `-${rec.supplement}` : ""}`;
    const s = { subjectId: subject };
    c.scalar(`${p}.pma_number`, number, "document.identifier", number, s);
    c.scalar(`${p}.trade_name`, rec.tradeName, "device.name", rec.tradeName, s);
    c.scalar(`${p}.applicant`, rec.applicant, "authorization.applicant", rec.applicant, s);
    c.scalar(`${p}.decision_date`, r.decision_date as string | undefined, "authorization.decision_date", rec.decisionDate, s);
    c.scalar(`${p}.decision_code`, rec.decisionCode, "authorization.decision_code", rec.decisionCode, s);
    c.scalar(`${p}.product_code`, rec.productCode, "authorization.product_code", rec.productCode, s);
    c.scalar(`${p}.ao_statement`, rec.approvalOrderStatement, "authorization.change_statement", rec.approvalOrderStatement, s);
  });
  const out = await c.finish(recordId, { records }, "OK", opts);
  const t = truncation(env);
  return t ? { ...out, truncated: t } : out;
}

// ------------------------------------------------------------------------------------------ classification

export interface Classification {
  productCode: string;
  deviceName?: string;
  deviceClass?: string;
  regulationNumber?: string;
  medicalSpecialty?: string;
  definition?: string;
  /** How many clearances openFDA lists under this code. The list itself is not carried. */
  clearanceCount: number;
}

export async function parseOpenFdaClassification(raw: unknown, recordId: string, opts: Opts = {}): Promise<StructuredExtraction<{ classifications: Classification[] }>> {
  const env = unwrap(raw, "device/classification");
  const c = new FieldCollector(`record:${recordId}`, "authorization");
  if (env === "EMPTY") return emptyResult(recordId, { classifications: [] }, c, opts);
  const classifications: Classification[] = [];
  env.results.forEach((r, i) => {
    const code = asString(r.product_code);
    if (!code) throw drifted(SOURCE, `device/classification: result ${i} has no product_code`);
    const p = `$.results[${i}]`;
    const open = asRecord(r.openfda);
    const k = open?.k_number;
    const cl: Classification = { productCode: code, clearanceCount: Array.isArray(k) ? k.length : 0 };
    const set = <K extends keyof Classification>(key: K, v: Classification[K] | undefined) => {
      if (v !== undefined) cl[key] = v;
    };
    set("deviceName", asString(r.device_name));
    set("deviceClass", asString(r.device_class));
    set("regulationNumber", asString(r.regulation_number));
    set("medicalSpecialty", asString(r.medical_specialty_description));
    set("definition", asString(r.definition));
    classifications.push(cl);
    const s = { subjectId: `productcode:${code}` };
    c.scalar(`${p}.product_code`, code, "authorization.product_code", code, s);
    c.scalar(`${p}.device_name`, cl.deviceName, "classification.name", cl.deviceName, s);
    c.scalar(`${p}.device_class`, cl.deviceClass, "classification.device_class", cl.deviceClass, s);
    c.scalar(`${p}.regulation_number`, cl.regulationNumber, "classification.regulation_number", cl.regulationNumber, s);
    c.scalar(`${p}.definition`, cl.definition, "classification.definition", cl.definition, s);
  });
  const out = await c.finish(recordId, { classifications }, "OK", opts);
  const t = truncation(env);
  return t ? { ...out, truncated: t } : out;
}
