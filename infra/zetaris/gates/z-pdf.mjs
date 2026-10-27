// Z-PDF: FORMAT PDF file-store tables on three real FDA summary PDFs. The preview column is 1000 characters by default;
// the gate sets the length explicitly, detects truncation, and compares the text with poppler's pdftotext and with
// pdfjs-dist (the extractor available to the Sakaime parser).

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../scripts/zt.mjs';
import { Gate } from './context.mjs';

const docs = ['K200667', 'DEN180001', 'K253265'];
const pdfDir = join(repoRoot, 'data', 'silos', 'documents', 'fda_summaries');
const squash = (s) => s.replace(/\s+/g, ' ').trim();
const noSpace = (s) => s.replace(/\s+/g, '').toLowerCase();
const words = (s) => new Set((s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []));

function poppler(file) {
  const r = spawnSync('pdftotext', [file, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

async function pdfjs(file) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(readFileSync(file));
  const doc = await pdfjsLib.getDocument({ data, useSystemFonts: false, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(content.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join(''));
  }
  return pages.join('\n');
}

const recall = (reference, candidate) => {
  const ref = words(reference);
  const cand = words(candidate);
  let hit = 0;
  for (const w of ref) if (cand.has(w)) hit += 1;
  return ref.size === 0 ? 0 : hit / ref.size;
};

export async function run(ctx) {
  const gate = new Gate('Z-PDF', 'FORMAT PDF file-store tables against pdftotext and pdfjs');

  const full = await ctx.q('admin', 'SELECT path, sizeinbytes, length(preview) AS chars, preview FROM sk_docs.fda_summaries ORDER BY path');
  const def = await ctx.q('admin', 'SELECT path, length(preview) AS chars FROM sk_docs.fda_summaries_default ORDER BY path');
  gate.check('PDF file-store table returns one row per PDF', full.outcome === 'OK' && full.rows.length === 3, full.outcome === 'OK' ? `${full.rows.length} rows in ${full.ms} ms` : full.message);
  if (full.outcome !== 'OK') return gate.finish();
  const defByDoc = Object.fromEntries(def.rows.map((r) => [r.path.split('/').pop().replace('.pdf', ''), Number(r.chars)]));
  const limitDefault = 1000;
  const limitExplicit = 2_000_000;

  for (const id of docs) {
    const row = full.rows.find((r) => r.path.endsWith(`/${id}.pdf`));
    const file = join(pdfDir, `${id}.pdf`);
    const pop = poppler(file);
    const js = await pdfjs(file);
    const zet = row.preview;
    gate.check(`${id}: the default table is cut at exactly ${limitDefault} characters`, defByDoc[id] === limitDefault, `default preview ${defByDoc[id]} chars`);
    const truncatedDefault = defByDoc[id] >= limitDefault;
    gate.check(`${id}: truncation is detected for the default table (length equals the limit while the file is ${row.sizeinbytes} bytes)`, truncatedDefault, '');
    gate.check(`${id}: the explicit table is not truncated (length ${row.chars} is below the ${limitExplicit} limit)`, Number(row.chars) < limitExplicit && Number(row.chars) > limitDefault, `${row.chars} chars`);
    const rZP = recall(pop ?? '', zet);
    const rPZ = recall(zet, pop ?? '');
    const rJZ = recall(js, zet);
    gate.check(`${id}: Zetaris text covers at least 98% of the distinct words of pdftotext`, rZP >= 0.98, `recall of poppler words in Zetaris ${(rZP * 100).toFixed(2)}%, of Zetaris words in poppler ${(rPZ * 100).toFixed(2)}%, of pdfjs words in Zetaris ${(rJZ * 100).toFixed(2)}%`);

    // A quoted passage that must survive extraction, found in pdftotext output and searched for in Zetaris text.
    const flat = squash(pop ?? '');
    const at = flat.search(/(is|are) (indicated|intended) (for use )?(by|in|to|for)/i);
    const quote = at >= 0 ? flat.slice(at, at + 90) : '';
    gate.check(`${id}: an indication sentence quoted from pdftotext is found in the Zetaris text`, quote !== '' && noSpace(zet).includes(noSpace(quote)), `"${quote}"`);
    // The same passage at the 1000-character cut: usually missing, which is the reason the length must be set.
    const inDefault = quote !== '' && noSpace(zet.slice(0, limitDefault)).includes(noSpace(quote));
    gate.note(`${id}: the quoted indication sentence ${inDefault ? 'is' : 'is NOT'} inside the first ${limitDefault} characters (${inDefault ? 'the cut would not have hidden it here' : 'a default table would have lost it silently'}). Zetaris text ${zet.length} chars, pdftotext ${pop?.length} chars, pdfjs ${js.length} chars.`);
  }

  const k = full.rows.find((r) => r.path.endsWith('/K200667.pdf'));
  gate.check('K200667: the pivotal-study registry id is present in the Zetaris text', noSpace(k.preview).includes('nct03112005'), '');
  gate.show('SELECT path, sizeinbytes, length(preview) FROM sk_docs.fda_summaries', full.rows.map((r) => ({ path: r.path.split('/').pop(), bytes: r.sizeinbytes, chars: r.chars })));
  gate.show('SELECT path, length(preview) FROM sk_docs.fda_summaries_default', defByDoc);
  const gaps = [];
  for (const id of docs) {
    const row = full.rows.find((r) => r.path.endsWith(`/${id}.pdf`));
    const pop = poppler(join(pdfDir, `${id}.pdf`));
    const pw = words(pop ?? '');
    const zw = words(row.preview);
    gaps.push(`${id}: ${[...pw].filter((w) => !zw.has(w)).slice(0, 8).join(', ') || 'none'}`);
  }
  gate.note(`Words in pdftotext but not in the Zetaris text (first 8 each): ${gaps.join(' | ')}.`);
  gate.note('Findings: (1) the option that sets the preview length is preview_len; pdf_preview_len (the name in the open-source code) and eight other spellings are stored without error and ignored, so the preview silently stays at 1000. (2) The table exposes no character offsets, page numbers or layout, only the text, so it cannot replace the Sakaime locator layer; it is a second extractor for agreement checks. (3) The extractor is PDFBox text stripping (the open-source reader uses PDFTextStripper); this was not confirmed for the installed build.');
  return gate.finish();
}
