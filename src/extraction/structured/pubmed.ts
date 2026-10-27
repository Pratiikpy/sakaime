/**
 * PubMed efetch XML parser (PubmedArticle and PubmedBookArticle).
 *
 * Reads identifiers (PMID, DOI, PMC), title, journal and dates, publication types, structured abstract sections,
 * registered-trial identifiers from the DataBank list and from the abstract text, version strings, population ages,
 * sample and site counts and performance statements in the abstract, and correction notices (ErratumIn,
 * RetractionIn...). Entities are decoded once, in one pass. The XML parser does not fetch the DTD, so external
 * entities are never resolved.
 */
import { XMLParser } from "fast-xml-parser";
import { PortError } from "../../ports/index.ts";
import { documentFromFields } from "../document.ts";
import { extractStudy, extractVersionStrings, type Builder } from "../study.ts";
import type { VerifyOptions } from "../verify.ts";
import { drifted, FieldCollector, type StructuredExtraction } from "./collector.ts";

const SOURCE = "PubMed";

// ------------------------------------------------------------------------------------------ tiny DOM

interface El {
  name: string;
  attrs: Record<string, string>;
  children: (El | string)[];
}

type RawNode = Record<string, unknown>;

function toEl(node: RawNode): El | string | undefined {
  if ("#text" in node) return String(node["#text"]);
  const name = Object.keys(node).find((k) => k !== ":@");
  if (!name) return undefined;
  const attrsRaw = (node[":@"] ?? {}) as Record<string, string>;
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrsRaw)) attrs[k.replace(/^@_/, "")] = String(v);
  const kids = Array.isArray(node[name]) ? (node[name] as RawNode[]) : [];
  const children: (El | string)[] = [];
  for (const k of kids) {
    const c = toEl(k);
    if (c !== undefined) children.push(c);
  }
  return { name, attrs, children };
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x")) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return NAMED[body] ?? whole;
  });
}

/** All text below an element, in document order, entities decoded once. Inline markup (<i>, <sup>) adds no spaces. */
function text(el: El | string | undefined): string {
  if (el === undefined) return "";
  if (typeof el === "string") return el;
  return el.children.map(text).join("");
}

function kids(el: El | undefined, name: string): El[] {
  return (el?.children.filter((c): c is El => typeof c !== "string" && c.name === name)) ?? [];
}
function kid(el: El | undefined, name: string): El | undefined {
  return kids(el, name)[0];
}
function path(el: El | undefined, ...names: string[]): El | undefined {
  let cur = el;
  for (const n of names) cur = kid(cur, n);
  return cur;
}

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };

function partialDate(el: El | undefined): string | undefined {
  if (!el) return undefined;
  const y = decodeEntities(text(kid(el, "Year"))).trim();
  if (!/^\d{4}$/.test(y)) return undefined;
  const mRaw = decodeEntities(text(kid(el, "Month"))).trim();
  const m = /^\d{1,2}$/.test(mRaw) ? mRaw.padStart(2, "0") : MONTHS[mRaw.slice(0, 3).toLowerCase()];
  if (!m) return y;
  const d = decodeEntities(text(kid(el, "Day"))).trim();
  return /^\d{1,2}$/.test(d) ? `${y}-${m}-${d.padStart(2, "0")}` : `${y}-${m}`;
}

// ------------------------------------------------------------------------------------------------- facts

export interface AbstractSection {
  label?: string;
  text: string;
}

export interface PublicationFacts {
  kind: "article" | "book";
  pmid: string;
  title?: string;
  journal?: string;
  year?: number;
  date?: string;
  epubDate?: string;
  doi?: string;
  pmcid?: string;
  publicationTypes: string[];
  abstractSections: AbstractSection[];
  /** NCT identifiers from the DataBank list or written in the abstract. */
  nctIds: string[];
  corrections: { refType: string; pmid?: string; source?: string }[];
  /** True when PubMed carries a retraction notice or types the record "Retracted Publication". */
  retracted: boolean;
  /** True when an erratum or correction is recorded against it. */
  corrected: boolean;
}

type Opts = Pick<VerifyOptions, "model">;

const xmlParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
  ignoreDeclaration: true,
});

interface Located {
  facts: PublicationFacts;
  abstractPages: number[];
  subjectId: string;
}

/**
 * Parse an efetch response. An empty PubmedArticleSet (no articles) is EMPTY; a body that is not a PubmedArticleSet
 * is DRIFTED; text that is not XML is INVALID.
 */
export async function parsePubMedXml(raw: string, recordId: string, opts: Opts = {}): Promise<StructuredExtraction<{ articles: PublicationFacts[] }>> {
  let tree: RawNode[];
  try {
    tree = xmlParser.parse(raw) as RawNode[];
  } catch (error) {
    throw new PortError("INVALID", `${SOURCE} response is not XML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const roots = tree.map(toEl).filter((x): x is El => typeof x !== "string" && x !== undefined);
  const set = roots.find((r) => r.name === "PubmedArticleSet");
  if (!set) {
    const err =
      roots.find((r) => /error/i.test(r.name)) ??
      roots.flatMap((r) => r.children).find((c): c is El => typeof c !== "string" && /error/i.test(c.name));
    if (err) throw new PortError("UNAVAILABLE", `${SOURCE} returned an error document: ${text(err).trim().slice(0, 200)}`);
    throw drifted(SOURCE, "no PubmedArticleSet element", { roots: roots.map((r) => r.name) });
  }

  const c = new FieldCollector(`record:${recordId}`, "study");
  const located: Located[] = [];
  const items = set.children.filter((x): x is El => typeof x !== "string" && (x.name === "PubmedArticle" || x.name === "PubmedBookArticle"));

  items.forEach((item, i) => {
    const base = `$.PubmedArticleSet.${item.name}[${i}]`;
    const isBook = item.name === "PubmedBookArticle";
    const citation = isBook ? kid(item, "BookDocument") : kid(item, "MedlineCitation");
    const article = isBook ? citation : kid(citation, "Article");
    const pmid = decodeEntities(text(kid(citation, "PMID"))).trim();
    if (!/^\d+$/.test(pmid)) throw drifted(SOURCE, `${base}: no numeric PMID`);
    const subject = `publication:pmid:${pmid}`;
    const s = { subjectId: subject };
    const cp = isBook ? `${base}.BookDocument` : `${base}.MedlineCitation`;
    const ap = isBook ? cp : `${cp}.Article`;

    const f: PublicationFacts = {
      kind: isBook ? "book" : "article",
      pmid,
      publicationTypes: [],
      abstractSections: [],
      nctIds: [],
      corrections: [],
      retracted: false,
      corrected: false,
    };

    c.scalar(`${cp}.PMID`, pmid, "document.identifier", pmid, s);

    const title = decodeEntities(text(kid(article, "ArticleTitle"))).replace(/\s+/g, " ").trim();
    if (title) {
      f.title = title;
      c.scalar(`${ap}.ArticleTitle`, title, "publication.title", title, s);
    }

    // identifiers
    const idList = isBook ? kid(citation, "ArticleIdList") : path(item, "PubmedData", "ArticleIdList");
    const idPath = isBook ? `${cp}.ArticleIdList` : `${base}.PubmedData.ArticleIdList`;
    kids(idList, "ArticleId").forEach((a, j) => {
      const t = decodeEntities(text(a)).trim();
      if (!t) return;
      const type = a.attrs.IdType;
      if (type === "doi") {
        f.doi = t;
        c.scalar(`${idPath}.ArticleId[${j}]`, t, "publication.doi", t, s);
      } else if (type === "pmc") {
        f.pmcid = t;
        c.scalar(`${idPath}.ArticleId[${j}]`, t, "publication.pmcid", t, s);
      }
    });

    // journal and dates
    if (!isBook) {
      const journal = kid(article, "Journal");
      const jt = decodeEntities(text(kid(journal, "Title"))).trim();
      if (jt) {
        f.journal = jt;
        c.scalar(`${ap}.Journal.Title`, jt, "publication.journal", jt, s);
      }
      const pd = path(journal, "JournalIssue", "PubDate");
      const medline = decodeEntities(text(kid(pd, "MedlineDate"))).trim();
      const date = partialDate(pd);
      if (date) {
        f.date = date;
        f.year = Number(date.slice(0, 4));
        const dpath = `${ap}.Journal.JournalIssue.PubDate`;
        // the date is read from Year/Month/Day, which together are one field in the record
        c.scalar(dpath, [text(kid(pd, "Year")), text(kid(pd, "Month")), text(kid(pd, "Day"))].filter(Boolean).join("-"), "publication.date", date, { ...s, detail: { qualifiers: ["from_parts"] } });
      } else if (medline) {
        const y = /^(\d{4})/.exec(medline)?.[1];
        if (y) {
          f.year = Number(y);
          c.scalar(`${ap}.Journal.JournalIssue.PubDate.MedlineDate`, medline, "publication.year", Number(y), { ...s, numbers: [{ value: Number(y), form: "count" }] });
        }
      }
      const ad = kids(article, "ArticleDate").find((x) => x.attrs.DateType === "Electronic");
      const epub = partialDate(ad);
      if (epub) {
        f.epubDate = epub;
        c.scalar(`${ap}.ArticleDate`, [text(kid(ad, "Year")), text(kid(ad, "Month")), text(kid(ad, "Day"))].join("-"), "publication.epub_date", epub, { ...s, detail: { qualifiers: ["from_parts"] } });
      }
    } else {
      const bookPd = partialDate(path(citation, "Book", "PubDate"));
      if (bookPd) {
        f.date = bookPd;
        f.year = Number(bookPd.slice(0, 4));
      }
    }

    // publication types
    const typeParent = article;
    kids(typeParent, isBook ? "PublicationType" : "PublicationTypeList").forEach((tl, j) => {
      const entries = isBook ? [tl] : kids(tl, "PublicationType");
      entries.forEach((pt, k) => {
        const t = decodeEntities(text(pt)).trim();
        if (!t) return;
        f.publicationTypes.push(t);
        const tpath = isBook ? `${ap}.PublicationType[${j}]` : `${ap}.PublicationTypeList.PublicationType[${k}]`;
        c.scalar(tpath, t, "publication.type", t, s);
        if (/retracted publication/i.test(t)) f.retracted = true;
      });
    });

    // trial identifiers registered with the paper
    if (!isBook) {
      kids(kid(article, "DataBankList"), "DataBank").forEach((db, j) => {
        const name = decodeEntities(text(kid(db, "DataBankName"))).trim();
        if (!/clinicaltrials\.gov/i.test(name)) return;
        kids(kid(db, "AccessionNumberList"), "AccessionNumber").forEach((an, k) => {
          const id = decodeEntities(text(an)).trim();
          if (/^NCT\d{8}$/.test(id)) {
            if (!f.nctIds.includes(id)) f.nctIds.push(id);
            c.scalar(`${ap}.DataBankList.DataBank[${j}].AccessionNumberList.AccessionNumber[${k}]`, id, "document.cites_nct", id, { ...s, detail: { qualifiers: ["databank"] } });
          }
        });
      });
    }

    // corrections and retractions
    if (!isBook) {
      kids(kid(citation, "CommentsCorrectionsList"), "CommentsCorrections").forEach((cc, j) => {
        const refType = cc.attrs.RefType;
        if (!refType) return;
        const refPmid = decodeEntities(text(kid(cc, "PMID"))).trim() || undefined;
        const source = decodeEntities(text(kid(cc, "RefSource"))).trim() || undefined;
        f.corrections.push({ refType, ...(refPmid ? { pmid: refPmid } : {}), ...(source ? { source } : {}) });
        if (/^Retraction(In|Of)$/i.test(refType)) f.retracted = f.retracted || /RetractionIn/i.test(refType);
        if (/^(ErratumIn|CorrectedandRepublishedIn|RepublishedIn|UpdateIn)$/i.test(refType)) f.corrected = true;
        if (/^(Erratum|Retraction|Corrected|Republished|ExpressionOfConcern)/i.test(refType)) {
          c.scalar(`${cp}.CommentsCorrectionsList.CommentsCorrections[${j}].@RefType`, refType, "publication.correction", refType, {
            ...s,
            ...(refPmid ? { detail: { qualifiers: [`pmid:${refPmid}`] } } : {}),
          });
        }
      });
    }

    // abstract sections
    const abs = kid(article, "Abstract");
    const abstractPages: number[] = [];
    kids(abs, "AbstractText").forEach((at, j) => {
      const t = decodeEntities(text(at)).replace(/[ \t]+\n/g, "\n").trim();
      if (!t) return;
      const label = at.attrs.Label;
      f.abstractSections.push({ ...(label ? { label } : {}), text: t });
      const page = c.field(`${ap}.Abstract.AbstractText[${j}]`, t, label ? `Abstract: ${label}` : "Abstract");
      if (page !== undefined) abstractPages.push(page);
    });

    located.push({ facts: f, abstractPages, subjectId: subject });
  });

  // Free-text extraction runs over the abstract fields only, one article at a time.
  const interim = documentFromFields(recordId, c.fields);
  for (const loc of located) {
    const b: Builder = { doc: interim, sections: [], subjectId: loc.subjectId, proposals: [], seen: new Set(), pageFilter: (p) => loc.abstractPages.includes(p) };
    extractStudy(b, { unbound: 0, unresolvedRows: 0 });
    extractVersionStrings(b, "study");
    for (const prop of b.proposals) {
      c.proposals.push(prop);
      if (prop.predicate === "document.cites_nct" && !loc.facts.nctIds.includes(String(prop.value))) loc.facts.nctIds.push(String(prop.value));
    }
  }

  const articles = located.map((l) => l.facts);
  const out = await c.finish(recordId, { articles }, articles.length === 0 ? "EMPTY" : "OK", opts);
  return out;
}
