/**
 * A small, safe Markdown renderer for the in-app Help pages (no dependencies, DOM-free).
 *
 * Supported: `#`–`####` headings (with anchor ids), paragraphs, ordered / unordered / nested lists, fenced code,
 * block quotes, tables, horizontal rules, `**bold**`, `*italic*`, `` `code` `` and `[links](…)`. Every piece of text
 * is HTML-escaped; link targets are limited to http(s), `#anchor` and other help pages (`page` / `page#anchor`),
 * anything else is shown as plain text. The output is therefore safe to assign to `innerHTML`.
 */

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** GitHub-style heading slug: lower case, words joined by "-". */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

export interface LinkTarget {
  kind: 'external' | 'help' | 'none';
  /** For `help`: page id (empty = the current page) and optional anchor. */
  page?: string;
  anchor?: string;
  href?: string;
}

/** Classify a Markdown link destination. */
export function classifyLink(dest: string): LinkTarget {
  const d = dest.trim();
  if (/^https?:\/\/[^\s]+$/i.test(d)) return { kind: 'external', href: d };
  const m = /^([a-z0-9][a-z0-9-]*)?(?:#([a-z0-9-]+))?$/.exec(d);
  if (m && (m[1] || m[2])) return { kind: 'help', page: m[1] ?? '', anchor: m[2] };
  return { kind: 'none' };
}

function inline(text: string): string {
  // Split out code spans first so nothing inside them is interpreted.
  const parts = text.split(/(`[^`]+`)/g);
  return parts
    .map((p, i) => {
      if (i % 2 === 1) return `<code>${escapeHtml(p.slice(1, -1))}</code>`;
      let s = escapeHtml(p);
      // links: [label](dest)
      s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, dest: string) => {
        const t = classifyLink(dest.replace(/&amp;/g, '&'));
        if (t.kind === 'external')
          return `<a href="${escapeHtml(t.href!)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
        if (t.kind === 'help') {
          const target = `${t.page ?? ''}${t.anchor ? `#${t.anchor}` : ''}`;
          return `<a href="#" data-help="${escapeHtml(target)}">${label}</a>`;
        }
        return label;
      });
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>');
      return s;
    })
    .join('');
}

const splitRow = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

const isTableSep = (line: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const LIST_RE = /^(\s*)([-*]|\d+[.)])\s+(.*)$/;

export interface Heading {
  level: number;
  text: string;
  id: string;
}

/** Render Markdown to safe HTML. `headings` (if given) receives the headings found, for tables of contents. */
export function renderMarkdown(src: string, headings?: Heading[]): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  const used = new Map<string, number>();
  const uniqueId = (text: string): string => {
    const base = slugify(text) || 'section';
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    // fenced code
    if (/^```\s*[\w-]*\s*$/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const hd = /^(#{1,4})\s+(.*?)\s*#*\s*$/.exec(line);
    if (hd) {
      const level = hd[1].length;
      const text = hd[2];
      const id = uniqueId(text);
      headings?.push({ level, text: text.replace(/[`*]/g, ''), id });
      out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${inline(body.join(' '))}</blockquote>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] ?? '')}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      );
      continue;
    }
    if (LIST_RE.test(line)) {
      const stack: { indent: number; tag: 'ul' | 'ol' }[] = [];
      let html = '';
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]);
        if (!m) break;
        const indent = m[1].replace(/\t/g, '  ').length;
        const tag = /\d/.test(m[2]) ? 'ol' : 'ul';
        while (stack.length && indent < stack[stack.length - 1].indent) html += `</li></${stack.pop()!.tag}>`;
        const top = stack[stack.length - 1];
        if (!top || indent > top.indent) {
          html += `<${tag}>`;
          stack.push({ indent, tag });
        } else html += '</li>';
        html += `<li>${inline(m[3])}`;
        i++;
        // continuation lines (indented, not a list item)
        while (i < lines.length && lines[i].trim() && /^\s+\S/.test(lines[i]) && !LIST_RE.test(lines[i]))
          html += ` ${inline(lines[i++].trim())}`;
      }
      while (stack.length) html += `</li></${stack.pop()!.tag}>`;
      out.push(html);
      continue;
    }
    // paragraph
    const body: string[] = [line.trim()];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4}\s|```|>\s?)/.test(lines[i]) &&
      !LIST_RE.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))
    )
      body.push(lines[i++].trim());
    out.push(`<p>${inline(body.join(' '))}</p>`);
  }
  return out.join('\n');
}

/** Plain text of a Markdown source (for search): markup removed, links reduced to their label. */
export function plainText(src: string): string {
  return src
    .replace(/```[\w-]*\n([\s\S]*?)```/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,4}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/[`*|]/g, ' ')
    .replace(/^\s*:?-{2,}[-:\s]*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** All help-link destinations of a Markdown source (for the broken-link test). */
export function helpLinks(src: string): { page: string; anchor?: string }[] {
  const res: { page: string; anchor?: string }[] = [];
  const stripped = src.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  for (const m of stripped.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)) {
    const t = classifyLink(m[1]);
    if (t.kind === 'help') res.push({ page: t.page ?? '', anchor: t.anchor });
  }
  return res;
}
