// Small HTML builders for the slides. Findings are always shown with words and an icon, never colour alone.
export const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const ICONS = {
  check: '<path d="M3 8.5 6.5 12 13 4.5"/>',
  "check-partial": '<path d="M2.5 8.5 5.5 11.5 9 7"/><path d="M11 5.5h3M11 8h3M11 10.5h3" opacity="0.65"/>',
  cross: '<path d="M4 4l8 8M12 4l-8 8"/>',
  gap: '<path d="M3 8h2.2M7 8h2M10.8 8H13"/>',
  person: '<circle cx="8" cy="5.5" r="2.4"/><path d="M3.2 13c.4-2.6 2.2-4 4.8-4s4.4 1.4 4.8 4"/>',
  lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7"/>',
  warn: '<path d="M8 2.5 14 13H2L8 2.5z"/><path d="M8 6.5v3M8 11.2v.1"/>',
  arrow: '<path d="M3 8h9.5M8.5 4l4 4-4 4"/>',
};
export const icon = (name) => `<svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;

export const LABELS = {
  SUPPORTED_FOR_SCOPE: { words: "Supported for this use", tone: "good", icon: "check", gloss: "The evidence covers every part of the use." },
  SUPPORTED_ONLY_FOR_NARROWER_SCOPE: { words: "Supported only for a narrower use", tone: "partial", icon: "check-partial", gloss: "It covers a narrower use, which the finding states." },
  CONTRADICTED_BY_SPECIFIED_EVIDENCE: { words: "Contradicted by specified evidence", tone: "bad", icon: "cross", gloss: "Relevant, adequate evidence points the other way." },
  INSUFFICIENT_EVIDENCE: { words: "Not enough evidence", tone: "unk", icon: "gap", gloss: "A required piece is missing, unreadable or unavailable." },
  REQUIRES_DOMAIN_REVIEW: { words: "Needs domain review", tone: "rev", icon: "person", gloss: "The rule needs clinical judgement the code refuses to make." },
};
export const labelBadge = (label, size = "") => {
  const m = LABELS[label];
  if (!m) throw new Error(`unknown label ${label}`);
  return `<span class="lab ${m.tone} ${size}">${icon(m.icon)}<span>${m.words}</span></span>`;
};
export const RELATIONS = {
  CONTAINED: { words: "Contained", tone: "good", icon: "check" },
  PARTIAL: { words: "Partial", tone: "partial", icon: "check-partial" },
  DISJOINT: { words: "Disjoint", tone: "bad", icon: "cross" },
  UNKNOWN: { words: "Unknown", tone: "unk", icon: "gap" },
};
export const relBadge = (rel) => {
  const m = RELATIONS[rel];
  if (!m) throw new Error(`unknown relation ${rel}`);
  return `<span class="rel ${m.tone}">${icon(m.icon)}<span>${m.words}</span></span>`;
};

export const chip = (t, kind = "") => `<span class="chip ${kind}">${t}</span>`;
export const rd = (t) => `<span class="rd">${esc(t)}</span>`;
export const stat = (n, label, { tone = "", size = "", unit = "" } = {}) =>
  `<div class="stat"><div class="n ${size} ${tone}">${n}${unit ? `<small>${unit}</small>` : ""}</div><div class="l">${label}</div></div>`;
export const card = (inner, cls = "") => `<div class="card ${cls}">${inner}</div>`;
export const pts = (items, cls = "") => `<ul class="pts ${cls}">${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
export const tbl = (head, rows, cls = "") =>
  `<table class="${cls}"><thead><tr>${head.map((h) => `<th${h.startsWith(">") ? ' class="n"' : ""}>${h.replace(/^>/, "")}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => {
      const rowCls = Array.isArray(r) ? "" : r.cls ?? "";
      const cells = Array.isArray(r) ? r : r.cells;
      return `<tr class="${rowCls}">${cells.map((c, i) => `<td${head[i]?.startsWith(">") ? ' class="n"' : ""}>${c}</td>`).join("")}</tr>`;
    })
    .join("")}</tbody></table>`;

/** A product screenshot in a browser frame. `file` is relative to docs/submission/images. */
export const shot = (file, url, cap = "", { h = 0, top = 0, left = 0, zoom = 100, extra = "" } = {}) =>
  `<figure style="margin:0" class="${extra}"><div class="shot"><div class="bar"><i></i><i></i><i></i><span style="margin-left:10px">${esc(url)}</span></div>${h ? `<div style="height:${h}px; overflow:hidden"><img src="images/${file}" alt="${esc(cap || url)}" style="width:${zoom}%; max-width:none; margin-top:-${top}px; margin-left:-${left}px"></div>` : `<img src="images/${file}" alt="${esc(cap || url)}">`}</div>${cap ? `<figcaption class="cap">${cap}</figcaption>` : ""}</figure>`;

/** A row of redaction lines, used as texture on title and divider slides. */
export const rdlines = (widths, tone = "") => widths.map((w) => `<span class="rdline ${tone}" style="width:${w}%"></span>`).join("");
