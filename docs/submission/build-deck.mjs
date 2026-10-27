// Builds sakaime-deck.html and speaker-notes.md from the slide sources and the repository's result files.
//   node docs/submission/build-deck.mjs
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SUB } from "./lib/data.mjs";
import { buildAll, renderDocument, speakerNotes } from "./lib/deck.mjs";

const deck = buildAll();
writeFileSync(resolve(SUB, "sakaime-deck.html"), renderDocument(deck));
writeFileSync(resolve(SUB, "speaker-notes.md"), speakerNotes(deck));
console.log(`built ${deck.total} slides`);
for (const s of deck.slides) console.log(`${String(s.n).padStart(2)}  ${s.title}${s.crit ? `   [${s.crit}]` : ""}`);
