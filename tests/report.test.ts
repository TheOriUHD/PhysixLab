import { describe, expect, it } from 'vitest';
import { buildReportHtml, esc, lineChartSvg, type ReportInput } from '../src/app/export/report';

const table = {
  name: 'Energy',
  columns: [
    { key: 't', label: 'Time (s)' },
    { key: 'ke', label: 'Kinetic <J>' },
    { key: 'pe', label: 'Potential (J)' },
  ],
  rows: [
    [0, 0, 10],
    [1, 5, 5],
    [2, Number.NaN, 2],
    [3, 9, 1],
  ],
};

describe('lab report (DT-3)', () => {
  it('charts: one path per series, breaks the line at NaN, escapes labels', () => {
    const svg = lineChartSvg(table);
    expect((svg.match(/<path /g) ?? []).length).toBe(2);
    expect(svg).toContain('Kinetic &lt;J&gt;');
    expect(svg).not.toContain('Kinetic <J>');
    const ke = /<path d="([^"]+)"[^>]*><title>Kinetic/.exec(svg)![1];
    expect((ke.match(/M/g) ?? []).length).toBe(2); // NaN split the kinetic line into two segments
    expect(lineChartSvg({ ...table, rows: [] })).toContain('No data recorded');
  });
  it('page is standalone, escaped and contains every section', () => {
    const input: ReportInput = {
      title: '<script>alert(1)</script>',
      generatedAt: new Date(0),
      screenshot: 'data:image/png;base64,AAAA',
      parameters: [['Gravity', '0, −9.81, 0 m/s²']],
      objects: {
        header: ['Name', 'Shape'],
        rows: [
          ['Ball "A"', 'sphere'],
          ['<img onerror=x>', 'box'],
        ],
      },
      charts: [{ title: 'Energy', table }],
      notes: 'line1\nline2 <b>',
    };
    const html = buildReportHtml(input);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain('<img onerror');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Ball &quot;A&quot;');
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain('<h2>Parameters</h2>');
    expect(html).toContain('<h2>Energy</h2>');
    expect(html).toContain('line1<br>line2 &lt;b&gt;');
    expect(html).not.toMatch(/(src|href)="https?:/);
    expect(buildReportHtml({ ...input, screenshot: 'javascript:alert(1)' })).not.toContain('javascript:');
    expect(esc(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});
