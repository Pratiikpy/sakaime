// Print title, journal, date, abstract, publication types and correction links for PMIDs found in a PubMed efetch XML file.
// Usage: node pm.mjs <xml file> <pmid> [<pmid>...]
import { readFileSync } from "node:fs";
const [file, ...pmids] = process.argv.slice(2);
const xml = readFileSync(file, "utf8");
const dec = (s) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
for (const id of pmids) {
  const i = xml.indexOf(`<PMID Version="1">${id}</PMID>`);
  if (i < 0) { console.log(`PMID ${id}: not in file`); continue; }
  const s = xml.lastIndexOf("<PubmedArticle>", i);
  const e = xml.indexOf("</PubmedArticle>", i);
  const a = xml.slice(s, e);
  const pick = (re) => (a.match(re) || [])[1] || "";
  console.log(`--- PMID ${id}`);
  console.log("TITLE:", dec(pick(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/)));
  console.log("JOURNAL:", dec(pick(/<Title>([\s\S]*?)<\/Title>/)), "|", dec(pick(/<PubDate>([\s\S]*?)<\/PubDate>/)));
  console.log("TYPES:", [...a.matchAll(/<PublicationType[^>]*>([\s\S]*?)<\/PublicationType>/g)].map((m) => dec(m[1])).join("; "));
  console.log("CORRECTIONS:", [...a.matchAll(/<CommentsCorrections RefType="([^"]+)">[\s\S]*?<RefSource>([\s\S]*?)<\/RefSource>/g)].map((m) => m[1] + ": " + dec(m[2])).join(" || "));
  for (const m of a.matchAll(/<AbstractText(?: Label="([^"]*)")?[^>]*>([\s\S]*?)<\/AbstractText>/g)) console.log(`${m[1] ? m[1] + ": " : ""}${dec(m[2])}`);
}
