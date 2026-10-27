/**
 * PubMed efetch XML to a typed article summary.
 *
 * Text is rebuilt in document order (the parser runs with preserveOrder), so a title or abstract containing
 * inline markup such as <i> or <sub> reads exactly as printed. That matters downstream: a quoted passage is only
 * verifiable if the text it is checked against is the text the source published.
 */
import { XMLParser } from "fast-xml-parser";

type Node = Record<string, unknown>;

export interface PubmedArticle {
  pmid: string;
  title: string;
  abstract: Array<{ label?: string; nlmCategory?: string; text: string }>;
  journal?: string;
  /** Four-digit year from the journal issue date; undefined if the record only has a free-text date. */
  year?: string;
  publicationTypes: string[];
  doi?: string;
  pmc?: string;
  /** Registry accession numbers the record itself lists (DataBank), by registry name. */
  databanks: Array<{ name: string; accessions: string[] }>;
  /** NCT numbers found in the title, abstract or databank accessions. */
  nctIds: string[];
  /** Corrections, retractions and comments the record links to, for example RetractionIn or ErratumIn. */
  corrections: Array<{ refType: string; pmid?: string }>;
  /** True when PubMed marks the paper retracted or links a retraction notice. */
  retracted: boolean;
  dateRevised?: string;
}

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
  // PubMed writes non-ASCII characters as numeric references (&#x2013;). Without this they stay as literal text,
  // and a passage quoted from the abstract would not match the published characters.
  htmlEntities: true,
});

const ATTRS = ":@";

const tagOf = (node: Node): string | undefined => Object.keys(node).find((k) => k !== ATTRS && k !== "#text");
const childrenOf = (node: Node): Node[] => {
  const tag = tagOf(node);
  const value = tag ? node[tag] : undefined;
  return Array.isArray(value) ? (value as Node[]) : [];
};
const attrOf = (node: Node, name: string): string | undefined => {
  const attrs = node[ATTRS] as Record<string, string> | undefined;
  return attrs?.[`@_${name}`];
};

function find(nodes: Node[], tag: string): Node | undefined {
  return nodes.find((n) => tagOf(n) === tag);
}
function findAll(nodes: Node[], tag: string): Node[] {
  return nodes.filter((n) => tagOf(n) === tag);
}
function path(nodes: Node[], ...tags: string[]): Node | undefined {
  let current: Node | undefined;
  let level = nodes;
  for (const tag of tags) {
    current = find(level, tag);
    if (!current) return undefined;
    level = childrenOf(current);
  }
  return current;
}

/** All text beneath a node, in document order, with whitespace collapsed. */
function textOf(nodes: Node[]): string {
  let out = "";
  for (const node of nodes) {
    if ("#text" in node) out += String(node["#text"]);
    else out += textOf(childrenOf(node));
  }
  return out.replace(/\s+/g, " ").trim();
}
const textAt = (nodes: Node[], ...tags: string[]): string | undefined => {
  const node = path(nodes, ...tags);
  if (!node) return undefined;
  const t = textOf(childrenOf(node));
  return t === "" ? undefined : t;
};

export class PubmedXmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PubmedXmlError";
  }
}

export function parsePubmedXml(xml: string): PubmedArticle[] {
  let tree: Node[];
  try {
    tree = parser.parse(xml) as Node[];
  } catch (err) {
    throw new PubmedXmlError(`efetch body is not well-formed XML: ${(err as Error).message}`);
  }
  const set = tree.find((n) => tagOf(n) === "PubmedArticleSet");
  if (!set) throw new PubmedXmlError("efetch body has no PubmedArticleSet element");
  return findAll(childrenOf(set), "PubmedArticle").map(articleOf);
}

function articleOf(node: Node): PubmedArticle {
  const children = childrenOf(node);
  const citation = find(children, "MedlineCitation");
  const citationKids = citation ? childrenOf(citation) : [];
  const article = find(citationKids, "Article");
  const articleKids = article ? childrenOf(article) : [];
  const pubmedData = find(children, "PubmedData");
  const dataKids = pubmedData ? childrenOf(pubmedData) : [];

  const pmid = textAt(citationKids, "PMID");
  if (!pmid) throw new PubmedXmlError("a PubmedArticle has no PMID");

  const abstractNode = find(articleKids, "Abstract");
  const abstract = abstractNode
    ? findAll(childrenOf(abstractNode), "AbstractText").map((n) => {
        const label = attrOf(n, "Label");
        const nlmCategory = attrOf(n, "NlmCategory");
        return { ...(label ? { label } : {}), ...(nlmCategory ? { nlmCategory } : {}), text: textOf(childrenOf(n)) };
      })
    : [];

  const publicationTypes = findAll(childrenOf(find(articleKids, "PublicationTypeList") ?? {}), "PublicationType").map((n) => textOf(childrenOf(n)));

  // The record's own identifiers live directly under PubmedData/ArticleIdList; the reference list below it has
  // its own ArticleIdList entries for cited papers, which must not be read as this paper's identifiers.
  const ownIds = findAll(childrenOf(find(dataKids, "ArticleIdList") ?? {}), "ArticleId");
  const idOf = (type: string) => {
    const hit = ownIds.find((n) => attrOf(n, "IdType") === type);
    return hit ? textOf(childrenOf(hit)) : undefined;
  };

  const databanks = findAll(childrenOf(find(articleKids, "DataBankList") ?? {}), "DataBank").map((bank) => ({
    name: textAt(childrenOf(bank), "DataBankName") ?? "",
    accessions: findAll(childrenOf(find(childrenOf(bank), "AccessionNumberList") ?? {}), "AccessionNumber").map((a) => textOf(childrenOf(a))),
  }));

  const title = textAt(articleKids, "ArticleTitle") ?? "";
  const nctIds = [
    ...new Set([
      ...(title + " " + abstract.map((a) => a.text).join(" ") + " " + databanks.flatMap((d) => d.accessions).join(" ")).matchAll(/NCT\d{8}/g),
    ].map((m) => m[0])),
  ];

  const corrections = findAll(childrenOf(find(citationKids, "CommentsCorrectionsList") ?? {}), "CommentsCorrections").map((c) => {
    const pm = textAt(childrenOf(c), "PMID");
    return { refType: attrOf(c, "RefType") ?? "", ...(pm ? { pmid: pm } : {}) };
  });

  const revised = find(citationKids, "DateRevised");
  const dateRevised = revised ? [textAt(childrenOf(revised), "Year"), textAt(childrenOf(revised), "Month"), textAt(childrenOf(revised), "Day")].filter(Boolean).join("-") : undefined;

  const issue = path(articleKids, "Journal", "JournalIssue", "PubDate");
  const year = issue ? textAt(childrenOf(issue), "Year") : undefined;

  return {
    pmid,
    title,
    abstract,
    journal: textAt(articleKids, "Journal", "Title"),
    ...(year && /^\d{4}$/.test(year) ? { year } : {}),
    publicationTypes,
    ...(idOf("doi") ? { doi: idOf("doi")! } : {}),
    ...(idOf("pmc") ? { pmc: idOf("pmc")! } : {}),
    databanks,
    nctIds,
    corrections,
    retracted: publicationTypes.includes("Retracted Publication") || corrections.some((c) => c.refType === "RetractionIn"),
    ...(dateRevised ? { dateRevised } : {}),
  };
}
