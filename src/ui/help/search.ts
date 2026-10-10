/** Full-text search over the help pages (DOM-free): section-level index, AND of all words, ranked. */
import { escapeHtml, plainText, slugify } from './markdown';
import type { HelpPage } from './pages';

export interface HelpSection {
  pageId: string;
  pageTitle: string;
  /** Heading text ('' for the intro of a page) and its anchor id. */
  heading: string;
  anchor: string;
  level: number;
  text: string;
}

export interface HelpHit {
  pageId: string;
  pageTitle: string;
  heading: string;
  anchor: string;
  score: number;
  /** Plain-text excerpt around the first match. */
  snippet: string;
}

const escapeRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Split every page into sections at its headings (the anchors follow `renderMarkdown`'s unique-slug rule). */
export function indexPages(pages: readonly HelpPage[]): HelpSection[] {
  const out: HelpSection[] = [];
  for (const p of pages) {
    const used = new Map<string, number>();
    let cur: HelpSection = { pageId: p.id, pageTitle: p.title, heading: '', anchor: '', level: 1, text: '' };
    let buf: string[] = [];
    let fence = false;
    const flush = () => {
      cur.text = plainText(buf.join('\n'));
      out.push(cur);
      buf = [];
    };
    for (const line of p.md.split('\n')) {
      if (/^```/.test(line)) fence = !fence;
      const h = !fence ? /^(#{1,4})\s+(.*?)\s*#*\s*$/.exec(line) : null;
      if (h) {
        flush();
        const base = slugify(h[2]) || 'section';
        const n = used.get(base) ?? 0;
        used.set(base, n + 1);
        cur = {
          pageId: p.id,
          pageTitle: p.title,
          heading: h[2].replace(/[`*]/g, ''),
          anchor: n ? `${base}-${n}` : base,
          level: h[1].length,
          text: '',
        };
      } else buf.push(line);
    }
    flush();
  }
  return out;
}

/** Query words (lower case, deduplicated); empty for a blank query. */
export function queryTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[\s,]+/)
        .filter(Boolean),
    ),
  ];
}

function snippetOf(text: string, terms: string[], width = 120): string {
  const low = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = low.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return text.slice(0, width);
  const start = Math.max(0, at - 30);
  const s = text.slice(start, start + width);
  return `${start > 0 ? '…' : ''}${s}${start + width < text.length ? '…' : ''}`;
}

/**
 * Rank sections for a query. Every word must occur in the section (page title, heading or text). Score: matches in the
 * page title (+30) and heading (+20, +10 more for a word-start), body occurrences (+2 each, capped), exact phrase bonus.
 * Results are sorted best first, at most one per section; ties keep the reading order.
 */
export function searchSections(sections: readonly HelpSection[], query: string, limit = 40): HelpHit[] {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const phrase = query.trim().toLowerCase();
  const hits: (HelpHit & { seq: number })[] = [];
  sections.forEach((s, seq) => {
    const title = s.pageTitle.toLowerCase();
    const head = s.heading.toLowerCase();
    const body = s.text.toLowerCase();
    let score = 0;
    for (const t of terms) {
      let found = false;
      if (title.includes(t)) {
        score += 30;
        found = true;
      }
      if (head.includes(t)) {
        score += 20;
        if (new RegExp(`(^|[^a-z0-9])${escapeRe(t)}`).test(head)) score += 10;
        found = true;
      }
      let n = 0;
      for (let i = body.indexOf(t); i >= 0 && n < 5; i = body.indexOf(t, i + t.length)) n++;
      if (n) {
        score += 2 * n;
        found = true;
      }
      if (!found) return;
    }
    if (terms.length > 1 && (head.includes(phrase) || body.includes(phrase))) score += 15;
    if (s.heading === '') score += 1; // a page's intro is a slightly better landing than a deep section
    hits.push({
      pageId: s.pageId,
      pageTitle: s.pageTitle,
      heading: s.heading,
      anchor: s.anchor,
      score,
      snippet: snippetOf(s.text, terms),
      seq,
    });
  });
  hits.sort((a, b) => b.score - a.score || a.seq - b.seq);
  return hits.slice(0, limit).map((h) => ({
    pageId: h.pageId,
    pageTitle: h.pageTitle,
    heading: h.heading,
    anchor: h.anchor,
    score: h.score,
    snippet: h.snippet,
  }));
}

/** HTML-escape `text` and wrap every occurrence of a query word in `<mark>`. */
export function highlightHtml(text: string, terms: readonly string[]): string {
  if (!terms.length) return escapeHtml(text);
  const re = new RegExp(`(${terms.map(escapeRe).join('|')})`, 'gi');
  return text
    .split(re)
    .map((part, i) => (i % 2 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part)))
    .join('');
}
