// Numbers a slide computes from a file (a count of array items, a sum) rather than copying a printed figure are declared here,
// so check-numbers.mjs can list them and say how each was derived.
export const ctx = { derived: [] };
export function derive(value, note) {
  ctx.derived.push({ value: String(value), note });
  return value;
}
export const ask = (text, who = "Judges ask") =>
  `<div class="ask"><span class="tag green">${who}</span><span>&ldquo;${text}&rdquo;</span></div>`;
