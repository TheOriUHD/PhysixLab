/**
 * Lab report (DT-3): one standalone HTML page — screenshot, scene parameters, object table, charts as inline SVG —
 * that opens anywhere and prints cleanly. No scripts and no external resources; every piece of user text is escaped.
 */
import type { DataTable } from './dataExport';

export interface ReportChart {
  title: string;
  /** Column 0 is the x axis (time), the other columns are series. */
  table: DataTable;
}

export interface ReportInput {
  title: string;
  generatedAt: Date;
  /** PNG data URL of the viewport, if one could be captured. */
  screenshot?: string;
  /** Label → value pairs of the scene settings. */
  parameters: [string, string][];
  /** Object table: header + rows of plain strings. */
  objects: { header: string[]; rows: string[][] };
  charts: ReportChart[];
  notes?: string;
}

export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const COLORS = ['#0e7490', '#b45309', '#7c3aed', '#be123c', '#15803d', '#1d4ed8'];

const num = (v: number) =>
  Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(2) : String(+v.toFixed(3));

/** A line chart of `table` (column 0 = x) as an SVG string. Non-finite samples break the line. */
export function lineChartSvg(table: DataTable, w = 640, h = 240): string {
  const padL = 58,
    padR = 12,
    padT = 10,
    padB = 26;
  const xs = table.rows.map((r) => Number(r[0]));
  const series = table.columns.slice(1).map((c, i) => ({
    label: c.label,
    color: COLORS[i % COLORS.length],
    ys: table.rows.map((r) => Number(r[i + 1])),
  }));
  const finite = (v: number) => Number.isFinite(v);
  const xMin = Math.min(...xs.filter(finite));
  const xMax = Math.max(...xs.filter(finite));
  const all = series.flatMap((s) => s.ys.filter(finite));
  if (!all.length || !finite(xMin) || xMin === xMax)
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img"><text x="${w / 2}" y="${h / 2}" text-anchor="middle" fill="#6b7280">No data recorded</text></svg>`;
  let yMin = Math.min(...all);
  let yMax = Math.max(...all);
  if (yMin === yMax) {
    yMin -= 1;
    yMax += 1;
  }
  const px = (x: number) => padL + ((x - xMin) / (xMax - xMin)) * (w - padL - padR);
  const py = (y: number) => padT + (1 - (y - yMin) / (yMax - yMin)) * (h - padT - padB);
  const parts: string[] = [];
  for (let i = 0; i <= 4; i++) {
    const y = yMin + ((yMax - yMin) * i) / 4;
    parts.push(
      `<line x1="${padL}" x2="${w - padR}" y1="${py(y).toFixed(1)}" y2="${py(y).toFixed(1)}" stroke="#e5e7eb"/>`,
      `<text x="${padL - 6}" y="${(py(y) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#4b5563">${num(y)}</text>`,
    );
    const x = xMin + ((xMax - xMin) * i) / 4;
    parts.push(
      `<text x="${px(x).toFixed(1)}" y="${h - 8}" text-anchor="middle" font-size="10" fill="#4b5563">${num(x)}</text>`,
    );
  }
  for (const s of series) {
    let d = '';
    let pen = false;
    s.ys.forEach((y, i) => {
      if (!finite(y) || !finite(xs[i])) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${px(xs[i]).toFixed(1)} ${py(y).toFixed(1)}`;
      pen = true;
    });
    parts.push(
      `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="1.6"><title>${esc(s.label)}</title></path>`,
    );
  }
  const legend = series
    .map((s) => `<span class="lg"><i style="background:${s.color}"></i>${esc(s.label)}</span>`)
    .join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${esc(table.name)}">${parts.join('')}</svg><div class="legend">${legend}</div>`;
}

export function buildReportHtml(r: ReportInput): string {
  const params = r.parameters.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
  const objects = r.objects.rows.length
    ? `<table class="grid"><thead><tr>${r.objects.header.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${r.objects.rows
        .map((row) => `<tr>${row.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`
    : '<p class="muted">The scene has no objects.</p>';
  const charts = r.charts.map((c) => `<section><h2>${esc(c.title)}</h2>${lineChartSvg(c.table)}</section>`).join('');
  const shot =
    r.screenshot && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(r.screenshot)
      ? `<img class="shot" alt="Scene screenshot" src="${r.screenshot}">`
      : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(r.title)} — PhysicsLab report</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;max-width:860px;margin:32px auto;padding:0 20px;color:#111827}
h1{margin:0 0 4px}h2{margin:28px 0 8px;font-size:18px;border-bottom:1px solid #e5e7eb;padding-bottom:4px}
.muted{color:#6b7280}.shot{max-width:100%;border:1px solid #e5e7eb;border-radius:8px}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #f3f4f6;font-size:13px}
.grid th{background:#f9fafb}.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:#374151}
.lg i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px}
@media print{body{margin:0}section{break-inside:avoid}}
</style></head><body>
<h1>${esc(r.title)}</h1>
<p class="muted">PhysicsLab lab report · generated ${esc(r.generatedAt.toLocaleString())}</p>
${shot}
<h2>Parameters</h2><table>${params}</table>
<h2>Objects</h2>${objects}
${charts}
${r.notes ? `<h2>Notes</h2><p>${esc(r.notes).replace(/\n/g, '<br>')}</p>` : ''}
</body></html>`;
}
