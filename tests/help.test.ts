/** The help system without a DOM: Markdown rendering, search ranking, and the bundled pages (titles, links). */
import { describe, expect, it } from 'vitest';
import {
  classifyLink,
  escapeHtml,
  helpLinks,
  plainText,
  renderMarkdown,
  slugify,
  type Heading,
} from '../src/ui/help/markdown';
import { HELP_PAGES, parsePages } from '../src/ui/help/pages';
import { highlightHtml, indexPages, queryTerms, searchSections } from '../src/ui/help/search';

describe('markdown renderer', () => {
  it('renders headings with anchors, paragraphs and inline markup', () => {
    const hs: Heading[] = [];
    const html = renderMarkdown('# Title\n\nSome **bold**, *italic* and `code`.\n\n## Second part', hs);
    expect(html).toContain('<h1 id="title">Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<h2 id="second-part">');
    expect(hs.map((h) => h.id)).toEqual(['title', 'second-part']);
  });

  it('makes duplicate heading ids unique', () => {
    const html = renderMarkdown('## Tips\n\n## Tips');
    expect(html).toContain('id="tips"');
    expect(html).toContain('id="tips-1"');
  });

  it('escapes HTML everywhere, including code and link labels', () => {
    const html = renderMarkdown(
      '<script>alert(1)</script> and `<b>` and [<img src=x onerror=1>](#a)\n\n```\n<div>&</div>\n```',
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;div&gt;&amp;&lt;/div&gt;');
  });

  it('only links to http(s), anchors and help pages', () => {
    expect(classifyLink('https://example.com/x').kind).toBe('external');
    expect(classifyLink('javascript:alert(1)').kind).toBe('none');
    expect(classifyLink('data:text/html,x').kind).toBe('none');
    expect(classifyLink('joints#motors')).toMatchObject({ kind: 'help', page: 'joints', anchor: 'motors' });
    expect(classifyLink('#top')).toMatchObject({ kind: 'help', page: '', anchor: 'top' });
    const html = renderMarkdown('[bad](javascript:alert(1)) [ok](page#x) [ext](https://a.b/c)');
    expect(html).not.toContain('javascript');
    expect(html).toContain('data-help="page#x"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('renders lists (nested, ordered), tables, quotes, code blocks and rules', () => {
    const md =
      '- a\n  - b\n- c\n\n1. one\n2. two\n\n| H1 | H2 |\n| --- | --- |\n| x | `y` |\n\n> note\n\n```\ncode **not bold**\n```\n\n---';
    const html = renderMarkdown(md);
    expect(html).toMatch(/<ul><li>a<ul><li>b<\/li><\/ul><\/li><li>c<\/li><\/ul>/);
    expect(html).toContain('<ol><li>one</li><li>two</li></ol>');
    expect(html).toContain('<th>H1</th>');
    expect(html).toContain('<td><code>y</code></td>');
    expect(html).toContain('<blockquote>note</blockquote>');
    expect(html).toContain('<pre><code>code **not bold**</code></pre>');
    expect(html).toContain('<hr>');
  });

  it('slugs, escapes and plain text behave', () => {
    expect(slugify('Joints & motors (new)')).toBe('joints-motors-new');
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    expect(plainText('# T\n\nA [link](x) and **bold** `code`.')).toBe('T A link and bold code .');
    expect(helpLinks('see [a](p#q) and [b](https://x.y) and `[c](z)`')).toEqual([{ page: 'p', anchor: 'q' }]);
  });
});

describe('help search', () => {
  const pages = parsePages({
    '/docs/help/01-alpha.md': '# Alpha page\n\nAbout hinges.\n\n## Motors\n\nA hinge motor spins a wheel.\n',
    '/docs/help/02-beta.md': '# Beta page\n\nMotors are described in alpha.\n\n## Springs\n\nSprings pull.\n',
  });
  const sections = indexPages(pages);

  it('parses id, order, title and summary from file name and content', () => {
    expect(pages.map((p) => [p.id, p.title, p.summary])).toEqual([
      ['alpha', 'Alpha page', 'About hinges.'],
      ['beta', 'Beta page', 'Motors are described in alpha.'],
    ]);
  });

  it('requires every word and ranks headings above body text', () => {
    const hits = searchSections(sections, 'motors');
    expect(hits[0].heading).toBe('Motors');
    expect(hits[0].pageId).toBe('alpha');
    expect(hits.some((h) => h.pageId === 'beta')).toBe(true);
    expect(searchSections(sections, 'motors springs')).toEqual([]);
    expect(searchSections(sections, 'hinge wheel')[0].anchor).toBe('motors');
    expect(searchSections(sections, '   ')).toEqual([]);
  });

  it('highlights query words with escaping', () => {
    expect(highlightHtml('A <b>Motor</b> motor', queryTerms('motor'))).toBe(
      'A &lt;b&gt;<mark>Motor</mark>&lt;/b&gt; <mark>motor</mark>',
    );
  });
});

describe('bundled help pages', () => {
  it('has the expected pages', () => {
    expect(HELP_PAGES.length).toBeGreaterThanOrEqual(10);
    const ids = new Set(HELP_PAGES.map((p) => p.id));
    for (const id of ['getting-started', 'the-editor', 'keyboard-shortcuts']) expect(ids.has(id)).toBe(true);
  });

  it('every page starts with a title and a one-line summary', () => {
    for (const p of HELP_PAGES) {
      expect(p.md.trimStart().startsWith('# '), `${p.id} starts with "# Title"`).toBe(true);
      expect(p.title.length, `${p.id} title`).toBeGreaterThan(2);
      expect(p.summary.length, `${p.id} summary`).toBeGreaterThan(10);
      expect(p.summary.length, `${p.id} summary is one line`).toBeLessThan(200);
    }
  });

  it('has no broken internal links or anchors', () => {
    const anchors = new Map<string, Set<string>>();
    for (const p of HELP_PAGES) {
      const hs: Heading[] = [];
      renderMarkdown(p.md, hs);
      anchors.set(p.id, new Set(hs.map((h) => h.id)));
    }
    const broken: string[] = [];
    for (const p of HELP_PAGES)
      for (const l of helpLinks(p.md)) {
        const target = l.page || p.id;
        if (!anchors.has(target)) broken.push(`${p.id} -> ${target}`);
        else if (l.anchor && !anchors.get(target)!.has(l.anchor)) broken.push(`${p.id} -> ${target}#${l.anchor}`);
      }
    expect(broken).toEqual([]);
  });

  it('renders every page without leaking raw markup', () => {
    for (const p of HELP_PAGES) {
      const html = renderMarkdown(p.md);
      expect(html, p.id).not.toMatch(/\*\*[^*\n]+\*\*/);
      expect(html, p.id).not.toContain('](');
    }
  });
});
