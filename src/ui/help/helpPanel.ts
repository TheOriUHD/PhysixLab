/**
 * The Help panel: a search box, the list of pages (or the search results) and the page being read. Pages are the
 * Markdown files of `docs/help/`. `openHelp(app, 'page#anchor')` opens the panel on a page / section from anywhere
 * (the F1 command, menu entries, links in tooltips and dialogs).
 */
import type { App } from '../../app/app';
import { runCommand } from '../../app/registry/commands';
import type { PanelDef } from '../../app/registry/panels';
import { h } from '../dom';
import { icon } from '../icons';
import { emptyState } from '../emptyState';
import { renderMarkdown } from './markdown';
import { HELP_PAGES, getHelpPage, type HelpPage } from './pages';
import { highlightHtml, indexPages, queryTerms, searchSections } from './search';

interface Controller {
  show(target: string, query?: string): void;
}

let controller: Controller | null = null;
/** A request made before the panel was built; the panel shows it when it appears. */
let pending: { target: string; query?: string } | null = null;

/** Split "page#anchor" (either part may be empty). */
export function parseTarget(target: string): { page: string; anchor: string } {
  const [page = '', anchor = ''] = target.split('#');
  return { page, anchor };
}

/** Open the Help panel on a page, optionally at a section (`'joints-and-motors#motors'`), optionally highlighting a query. */
export function openHelp(app: App, target = '', query?: string): void {
  pending = { target, query };
  runCommand('panel.help', app); // reveals the panel wherever the user docked it
  // The region builds the panel on first need and calls onShow; when it was already built, show right away.
  if (controller) {
    pending = null;
    controller.show(target, query);
  }
}

/** Wrap every occurrence of the query words inside the text nodes of `root` in <mark>. Returns the first mark. */
export function markTerms(root: HTMLElement, terms: readonly string[]): HTMLElement | null {
  if (!terms.length) return null;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  let first: HTMLElement | null = null;
  for (const t of nodes) {
    if (t.parentElement?.closest('mark')) continue;
    const parts = t.data.split(re);
    if (parts.length < 2) continue;
    const frag = document.createDocumentFragment();
    parts.forEach((p, i) => {
      if (i % 2) {
        const m = document.createElement('mark');
        m.textContent = p;
        first ??= m;
        frag.appendChild(m);
      } else if (p) frag.appendChild(document.createTextNode(p));
    });
    t.replaceWith(frag);
  }
  return first;
}

export const helpPanel: PanelDef = {
  id: 'help',
  label: 'Help',
  icon: 'info',
  region: 'right',
  order: 90,
  title: 'Searchable help pages (F1)',
  build: () => {
    const sections = indexPages(HELP_PAGES);
    const input = h('input', {
      class: 'help-search',
      type: 'search',
      placeholder: 'Search help…',
      spellcheck: false,
      'aria-label': 'Search help',
      title: 'Search every help page',
    });
    const body = h('div', { class: 'help-body' });
    const back = h(
      'button',
      { class: 'help-back', type: 'button', title: 'All help pages' },
      icon('chevron'),
      'All pages',
    );
    const bar = h('div', { class: 'help-bar' }, input);
    const el = h('div', { class: 'help-panel' }, bar, body);
    let current: HelpPage | null = null;
    let lastQuery = '';

    const pageList = () => {
      body.replaceChildren();
      current = null;
      bar.classList.remove('reading');
      const list = h('div', { class: 'help-list' });
      for (const p of HELP_PAGES) {
        const b = h(
          'button',
          { class: 'help-item', type: 'button', 'data-page': p.id },
          h('b', null, p.title),
          h('span', null, p.summary),
        );
        b.addEventListener('click', () => showPage(p.id, '', ''));
        list.appendChild(b);
      }
      body.appendChild(list);
    };

    const results = (q: string) => {
      body.replaceChildren();
      current = null;
      bar.classList.remove('reading');
      const terms = queryTerms(q);
      const hits = searchSections(sections, q);
      if (!hits.length) {
        body.appendChild(
          emptyState({
            art: 'search',
            title: 'Nothing found',
            hint: `No help page mentions “${q}”. Try fewer or different words.`,
          }),
        );
        return;
      }
      const list = h('div', { class: 'help-list' });
      for (const hit of hits) {
        const b = h('button', { class: 'help-item hit', type: 'button', 'data-page': hit.pageId });
        b.append(
          h('b', null, hit.heading ? `${hit.pageTitle} › ${hit.heading}` : hit.pageTitle),
          h('span', { innerHTML: highlightHtml(hit.snippet, terms) }),
        );
        b.addEventListener('click', () => showPage(hit.pageId, hit.anchor, q));
        list.appendChild(b);
      }
      body.appendChild(list);
    };

    function showPage(id: string, anchor: string, query: string): void {
      const page = getHelpPage(id);
      if (!page) {
        pageList();
        return;
      }
      current = page;
      lastQuery = query;
      bar.classList.add('reading');
      body.replaceChildren();
      const head = h('div', { class: 'help-head' }, back);
      const doc = h('article', { class: 'help-doc' });
      doc.innerHTML = renderMarkdown(page.md);
      body.append(head, doc);
      const mark = markTerms(doc, queryTerms(query));
      const target = anchor ? doc.querySelector<HTMLElement>(`#${CSS.escape(anchor)}`) : null;
      const scrollTo = target ?? mark;
      body.scrollTop = 0;
      if (scrollTo) scrollTo.scrollIntoView({ block: 'start' });
    }

    back.addEventListener('click', () => {
      if (lastQuery) results(lastQuery);
      else pageList();
    });
    input.addEventListener('input', () => {
      const q = input.value.trim();
      lastQuery = q;
      if (q) results(q);
      else pageList();
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // typing must not trigger shortcuts
      if (e.key === 'Escape') {
        input.value = '';
        input.dispatchEvent(new Event('input'));
      } else if (e.key === 'Enter') body.querySelector<HTMLElement>('.help-item')?.click();
    });
    // Links inside a page: other pages, anchors, external.
    body.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[data-help]');
      if (!a) return;
      e.preventDefault();
      const t = parseTarget(a.dataset.help ?? '');
      showPage(t.page || current?.id || '', t.anchor, '');
    });

    const show = (target: string, query?: string) => {
      const t = parseTarget(target);
      if (query !== undefined) input.value = query;
      if (t.page) showPage(t.page, t.anchor, query ?? '');
      else if (query) results(query);
      else pageList();
    };
    controller = { show };
    pageList();
    return {
      el,
      onShow: () => {
        if (pending) {
          const p = pending;
          pending = null;
          show(p.target, p.query);
        }
        if (!current) input.focus({ preventScroll: true });
      },
      dispose: () => {
        controller = null;
      },
    };
  },
};
