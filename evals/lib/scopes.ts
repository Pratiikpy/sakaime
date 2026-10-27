/** Authentic evidence scopes: the items the extraction layer reads from the real FDA summary of a device. */
import { parseFdaSummary } from "../../src/extraction/fda-summary.ts";
import { documentFromText } from "../../src/extraction/document.ts";
import { toEvidenceItems } from "../../src/extraction/to-evidence.ts";
import type { EvidenceItem } from "../../src/schemas/index.ts";
import { fdaDoc } from "./documents.ts";
import { normaliseExtracted } from "./pipeline.ts";

export async function authenticItems(id: string, part: "development" | "held-out"): Promise<{ auth?: EvidenceItem; study?: EvidenceItem }> {
  const d = fdaDoc(`device:fda:${id}`, part);
  const r = await parseFdaSummary(documentFromText(d.id, d.text));
  const absent = Object.entries(r.fields)
    .filter(([, v]) => v.status === "absent")
    .map(([k]) => k);
  const items = toEvidenceItems(r.extraction.kept, { absentFields: absent, versionsFromSameDocument: true }).items.map(normaliseExtracted);
  const out: { auth?: EvidenceItem; study?: EvidenceItem } = {};
  const auth = items.find((i) => i.assertionType === "authorization");
  const study = items.find((i) => i.assertionType === "study");
  if (auth) out.auth = auth;
  if (study) out.study = study;
  return out;
}
