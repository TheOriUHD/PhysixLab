/**
 * A docked region (left, right or bottom) generated from the panel registry (`src/app/registry/panels.ts`).
 *
 * The region renders one tab per registered panel of its region, builds each panel's view once (when the panel is
 * first seen), shows the one named by the region's preference — falling back to the first tab when the stored id
 * no longer exists — and follows the registry live: a panel registered or removed later appears or disappears.
 * `PanelView.onShow` runs each time a panel becomes the visible tab; `PanelView.toolbar` is shown at the right end
 * of the tab strip while it is.
 */
import type { App } from '../app/app';
import {
  listPanels,
  panelRegistry,
  REGION_PREFS,
  type PanelDef,
  type PanelRegionId,
  type PanelView,
} from '../app/registry/panels';
import { h } from './dom';
import { icon } from './icons';

export interface RegionOptions {
  region: PanelRegionId;
  rootTag: 'aside' | 'div';
  rootClass: string;
  /** Class of the tab strip. */
  headClass: string;
  /** Show the panel icons next to the labels. */
  icons: boolean;
  /** Toggle the root's `collapsed` class when this preference is false (the bottom dock). */
  collapseWhenOff?: boolean;
}

interface Entry {
  def: PanelDef;
  view: PanelView;
  tab: HTMLButtonElement;
}

export function buildPanelRegion(app: App, o: RegionOptions): HTMLElement {
  const keys = REGION_PREFS[o.region];
  const { prefs } = app;
  const entries = new Map<string, Entry>();
  let shown: string | null = null;

  const head = h('div', { class: o.headClass, role: 'tablist', 'aria-label': `${o.region} panels` });
  const toolbar = h('div', { class: 'tab-toolbar' });
  const host = h('div', { style: { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' } });
  const root = h(o.rootTag, { class: o.rootClass }, head, host);

  const currentId = (): string | null => {
    const defs = listPanels(o.region);
    const want = prefs.value[keys.tab] as string;
    return defs.some((d) => d.id === want) ? want : (defs[0]?.id ?? null);
  };
  const isActive = (id: string): boolean => shown === id;

  const makeTab = (def: PanelDef): HTMLButtonElement => {
    const t = h(
      'button',
      {
        class: 'tab',
        type: 'button',
        role: 'tab',
        id: `tab-${def.id}`,
        title: def.title ?? def.label,
        'aria-selected': 'false',
        'aria-controls': `panel-${def.id}`,
      },
      o.icons ? icon(def.icon) : null,
      def.label,
    );
    t.addEventListener('click', () => prefs.set({ [keys.tab]: def.id }));
    return t;
  };

  /** Bring the built views and the tab strip in line with the registry. */
  const sync = () => {
    const defs = listPanels(o.region);
    for (const def of defs) {
      if (entries.has(def.id)) continue;
      const view = def.build(app, { active: () => isActive(def.id) });
      view.el.id = `panel-${def.id}`;
      view.el.setAttribute('role', 'tabpanel');
      view.el.setAttribute('aria-labelledby', `tab-${def.id}`);
      entries.set(def.id, { def, view, tab: makeTab(def) });
    }
    for (const [id, e] of entries)
      if (!panelRegistry.has(id)) {
        e.view.dispose?.();
        e.view.el.remove();
        entries.delete(id);
        if (shown === id) shown = null;
      }
    head.replaceChildren(...defs.map((d) => (entries.get(d.id) as Entry).tab), toolbar);
    host.replaceChildren(...defs.map((d) => (entries.get(d.id) as Entry).view.el));
    show();
  };

  /** Show the tab the preference names (and tell the panel when it newly became visible). */
  const show = () => {
    const id = currentId();
    for (const [pid, e] of entries) {
      const on = pid === id;
      e.tab.classList.toggle('on', on);
      e.tab.setAttribute('aria-selected', on ? 'true' : 'false');
      e.tab.tabIndex = on ? 0 : -1;
      e.view.el.style.display = on ? '' : 'none';
    }
    const view = id ? entries.get(id)?.view : undefined;
    toolbar.replaceChildren(...(view?.toolbar ?? []));
    toolbar.style.display = view?.toolbar?.length ? '' : 'none';
    if (id !== shown) {
      shown = id;
      view?.onShow?.();
    }
  };

  const collapse = () => {
    if (o.collapseWhenOff) root.classList.toggle('collapsed', !prefs.value[keys.show]);
  };

  // Arrow keys move between tabs, as in any tab list.
  head.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    // While a simulation runs the arrow keys may be bound to motors and thrusters, and a tab that still has focus from
    // a click must not take them (they reach the shortcuts and the simulation instead).
    if (app.sim.active) return;
    const defs = listPanels(o.region);
    const i = defs.findIndex((d) => d.id === currentId());
    const next = defs[(i + (e.key === 'ArrowRight' ? 1 : -1) + defs.length) % defs.length];
    if (!next) return;
    e.preventDefault();
    // The arrow keys are the tab list's: they must not also reach the shortcuts (nudging the selection).
    e.stopPropagation();
    prefs.set({ [keys.tab]: next.id });
    entries.get(next.id)?.tab.focus();
  });

  prefs.on('change', (changed) => {
    if (changed.includes(keys.tab)) show();
    if (changed.includes(keys.show)) collapse();
  });
  panelRegistry.onChange(sync);
  sync();
  collapse();
  return root;
}
