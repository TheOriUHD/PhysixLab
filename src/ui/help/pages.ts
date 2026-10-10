/**
 * The help pages: every `docs/help/NN-name.md` becomes a `HelpPage` (id = name without the number prefix, title from
 * its first `# ` line, summary = the first paragraph below it). The files are bundled with the app at build time.
 */
import { plainText } from './markdown';

export interface HelpPage {
  /** "getting-started" (the file name without the order prefix and extension). */
  id: string;
  title: string;
  /** The one-line summary under the title. */
  summary: string;
  /** The Markdown source (title line included). */
  md: string;
  order: number;
}

/** Build pages from `{ path: markdown }` (paths like `/docs/help/01-getting-started.md`). */
export function parsePages(files: Record<string, string>): HelpPage[] {
  const pages: HelpPage[] = [];
  for (const [path, md] of Object.entries(files)) {
    const file = path.split('/').pop()!.replace(/\.md$/i, '');
    const m = /^(\d+)-(.+)$/.exec(file);
    const id = m ? m[2] : file;
    const order = m ? Number(m[1]) : 999;
    const lines = md.replace(/\r\n?/g, '\n').split('\n');
    const ti = lines.findIndex((l) => /^#\s+\S/.test(l));
    const title = ti >= 0 ? lines[ti].replace(/^#\s+/, '').trim() : '';
    let summary = '';
    if (ti >= 0) {
      const rest: string[] = [];
      for (let i = ti + 1; i < lines.length; i++) {
        if (!lines[i].trim()) {
          if (rest.length) break;
          continue;
        }
        if (/^(#|```|\s*[-*]\s|\||>)/.test(lines[i])) break;
        rest.push(lines[i].trim());
      }
      summary = plainText(rest.join(' '));
    }
    pages.push({ id, title, summary, md, order });
  }
  return pages.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

const raw = import.meta.glob<string>('/docs/help/*.md', { query: '?raw', import: 'default', eager: true });

/** The bundled pages. */
export const HELP_PAGES: readonly HelpPage[] = parsePages(raw);

export const getHelpPage = (id: string, pages: readonly HelpPage[] = HELP_PAGES): HelpPage | undefined =>
  pages.find((p) => p.id === id);
