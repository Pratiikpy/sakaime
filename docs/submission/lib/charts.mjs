// Inline SVG charts drawn from numbers read out of the results files.
const TONE = { green: "var(--green)", ink: "var(--ink)", rust: "var(--rust)", grey: "var(--line-strong)" };

/**
 * Horizontal bars. rows: [{label, value, text, tone}], value in 0..max. Every bar carries its number as text,
 * so the chart never relies on colour alone.
 */
export function hbars({ rows, width = 800, labelW = 330, max = 1, barH = 34, gap = 16, fontSize = 23, title = "", textW = 150 }) {
  const trackW = width - labelW - textW;
  const head = title ? 44 : 0;
  const h = head + rows.length * (barH + gap);
  const body = rows
    .map((r, i) => {
      const y = head + i * (barH + gap);
      const w = Math.max(2, (r.value / max) * trackW);
      return `<text x="0" y="${y + barH - 9}" font-size="${fontSize}" ${r.bold ? 'font-weight="600"' : ""}>${r.label}</text>
        <rect x="${labelW}" y="${y}" width="${trackW}" height="${barH}" fill="var(--paper-3)"/>
        <rect x="${labelW}" y="${y}" width="${w}" height="${barH}" fill="${TONE[r.tone ?? "ink"]}"/>
        <text x="${labelW + trackW + 14}" y="${y + barH - 9}" font-size="${fontSize}" class="m" font-weight="500">${r.text}</text>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${width} ${h}" width="100%" role="img" aria-label="${title}">${title ? `<text x="0" y="26" font-size="25" font-weight="600">${title}</text>` : ""}${body}</svg>`;
}
