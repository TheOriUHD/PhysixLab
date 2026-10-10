/**
 * The dock manager (UI-1): turns the panel registry plus a `DockLayout` into DOM.
 *
 * The three regions (left / right / bottom) still come from `buildPanelRegion` and keep their old DOM classes, so
 * the panel registry API (`registerPanel({ region, ... })`) is unchanged and every registered panel is dockable
 * without edits: it starts in its home region, can be dragged between regions, tabbed with other panels, split
 * into a second group, popped out as a floating window, collapsed and maximised, and the arrangement persists.
 * Panel views are built once and only ever re-parented, so their state (scroll, drafts, charts) survives moves.
 */
import type { App } from '../../app/app';
import { registerCommand } from '../../app/registry/commands';
import {
  panelRegistry,
  REGION_PREFS,
  setPanelRevealer,
  type PanelDef,
  type PanelView,
} from '../../app/registry/panels';
import { Vector3 } from 'three';
import { h } from '../dom';
import { icon } from '../icons';
import { openMenu } from '../menu';
import type { RegionOptions } from '../panelRegion';
import {
  allGroups,
  defaultLayout,
  dockFloat,
  findGroup,
  layoutFromPreset,
  locate,
  moveTab,
  parseLayout,
  raiseFloat,
  reconcile,
  regionOf,
  REGION_IDS,
  setActive,
  setCollapsed,
  setFloatRect,
  setMaximised,
  setSize,
  setWeights,
  DEFAULT_FLOAT,
  MIN_FLOAT,
  type DockGroup,
  type DockLayout,
  type DropTarget,
  type FloatGroup,
  type PanelRef,
  type PresetSpec,
  type RegionId,
} from './layout';

const STORE_KEY = 'physicslab:dock:v1';
const SIZE_VAR: Record<RegionId, string> = { left: '--left-w', right: '--right-w', bottom: '--dock-h' };
const SIZE_LIMITS: Record<RegionId, [number, number]> = { left: [180, 640], right: [220, 720], bottom: [90, 640] };

interface RegionUi {
  opts: RegionOptions;
  root: HTMLElement;
  list: HTMLElement;
}

interface GroupUi {
  root: HTMLElement;
  head: HTMLElement;
  tabsBox: HTMLElement;
  toolbar: HTMLElement;
  buttons: HTMLElement;
  body: HTMLElement;
  handles: HTMLElement[];
}

interface Built {
  def: PanelDef;
  view: PanelView;
}

export interface SavedLayout {
  name: string;
  layout: DockLayout;
  show: Record<RegionId, boolean>;
}

/** The dock of one App (created by the first region that is built). */
const docks = new WeakMap<App, DockManager>();
/** The dock of an app if one exists (menus built before the UI exists must not create it). */
export const peekDock = (app: App): DockManager | undefined => docks.get(app);
export function getDock(app: App): DockManager {
  let d = docks.get(app);
  if (!d) {
    d = new DockManager(app);
    docks.set(app, d);
  }
  return d;
}

const setChildren = (parent: HTMLElement, kids: readonly Node[]): void => {
  const cur = parent.children;
  if (cur.length === kids.length && kids.every((k, i) => cur[i] === k)) return;
  parent.replaceChildren(...kids);
};

function glyph(kind: 'float' | 'dock' | 'max' | 'restore' | 'collapse' | 'expand' | 'pin' | 'follow'): SVGSVGElement {
  const paths: Record<string, string> = {
    float: 'M5 3h8v8M13 3L6 10M3 6v7h7',
    dock: 'M3 3h10v10H3zM3 9h10',
    max: 'M3 3h10v10H3z',
    restore: 'M5 3h8v8M3 5h8v8H3z',
    collapse: 'M4 10l4-4 4 4',
    expand: 'M4 6l4 4 4-4',
    pin: 'M9 2l5 5-2 1-2 3-1-1-3 3-1-1 3-3-1-1 3-2zM3 13l3-3',
    follow: 'M8 2v3M8 11v3M2 8h3M11 8h3M8 6.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3z',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'icon dock-glyph');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', paths[kind]);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.5');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(p);
  return svg;
}

export class DockManager {
  layout: DockLayout;
  /** Named layouts the user saved. */
  saved: SavedLayout[] = [];
  readonly floatLayer = h('div', { class: 'dock-float-layer' });
  private readonly regions = new Map<RegionId, RegionUi>();
  private readonly built = new Map<string, Built>();
  private readonly groupUis = new Map<string, GroupUi>();
  private readonly activeIds = new Set<string>();
  private readonly cmdOffs = new Map<string, () => void>();
  private readonly overlay = h('div', { class: 'dock-drop' });
  private lastActive: string | null = null;
  private saveTimer = 0;
  private dragging = false;
  private readonly listeners = new Set<() => void>();
  /** Floating panels that follow the selection (UI-2): `pinned` freezes them where they are. */
  private readonly follow = new Map<string, { pinned: boolean }>();
  private readonly tmp = new Vector3();

  constructor(private readonly app: App) {
    const raw = this.readStore();
    const refs = this.refs();
    this.layout = reconcile(raw?.layout ?? defaultLayout(refs), refs);
    this.saved = raw?.saved ?? [];
    // The stored active tab of a region follows the legacy preference when that names a docked panel of the region.
    for (const r of REGION_IDS) {
      const id = app.prefs.value[REGION_PREFS[r].tab] as string;
      if (locate(this.layout, id)?.region === r) this.layout = setActive(this.layout, id);
    }
    document.getElementById('app')?.appendChild(this.floatLayer);
    document.body.appendChild(this.overlay);
    panelRegistry.onChange(() => this.sync());
    app.prefs.on('change', (keys) => this.onPrefs(keys as string[]));
    setPanelRevealer((a, id) => (a === app ? (this.reveal(id), true) : false));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.layout.maximised && !document.querySelector('.modal-back,.palette-back,.menu')) {
        this.setLayout(setMaximised(this.layout, null));
      }
    });
    window.addEventListener('resize', () => this.clampFloats());
    app.on('frame', ({ dt }) => this.followTick(dt));
  }

  // ------------------------------------------------------------------------------------------ public API

  /** Called by `buildPanelRegion`: the element of one docked region. */
  attachRegion(o: RegionOptions): HTMLElement {
    const list = h('div', { class: `dock-groups ${o.region === 'bottom' ? 'row' : 'col'}` });
    const root = h(o.rootTag, { class: `${o.rootClass} dock-region`, 'data-region': o.region }, list);
    const handle = h('div', {
      class: `dock-rsplit ${o.region}`,
      role: 'separator',
      'aria-orientation': o.region === 'bottom' ? 'horizontal' : 'vertical',
      'aria-label': `Resize the ${o.region} panels`,
      title: 'Drag to resize · double-click to reset',
      tabindex: 0,
    });
    this.wireRegionSplit(handle, o.region, root);
    root.appendChild(handle);
    root.appendChild(h('div', { class: 'dock-empty-hint' }, `Drop a panel here`));
    this.regions.set(o.region, { opts: o, root, list });
    this.sync();
    return root;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  panelRefs(): PanelRef[] {
    return this.refs();
  }

  /** Is this panel floating? */
  isFloating(id: string): boolean {
    const loc = locate(this.layout, id);
    return !!loc && !loc.region;
  }

  /** Make a panel visible wherever it lives: select its tab, raise its window, show its region. */
  reveal(id: string): void {
    const loc = locate(this.layout, id);
    if (!loc) return;
    let l = setActive(this.layout, id);
    if (!loc.region) l = raiseFloat(l, loc.group.id);
    else if (this.app.prefs.value[REGION_PREFS[loc.region].show] === false)
      this.app.prefs.set({ [REGION_PREFS[loc.region].show]: true });
    this.lastActive = id;
    this.setLayout(l);
    this.syncPrefsTab(id);
  }

  floatPanel(id: string, at?: { x: number; y: number }): void {
    const loc = locate(this.layout, id);
    if (!loc) return;
    const n = this.layout.floats.length;
    const x = at?.x ?? 120 + n * 28;
    const y = at?.y ?? 110 + n * 28;
    this.setLayout(moveTab(this.layout, id, { type: 'float', x, y }));
  }

  dockPanel(id: string, region?: RegionId): void {
    const loc = locate(this.layout, id);
    if (!loc) return;
    const home = region ?? this.refs().find((p) => p.id === id)?.region ?? 'right';
    this.setLayout(moveTab(this.layout, id, { type: 'region', region: home }));
    this.reveal(id);
  }

  toggleFloat(id: string): void {
    if (this.isFloating(id)) this.dockPanel(id);
    else this.floatPanel(id);
    this.reveal(id);
  }

  /** A floating panel that stays next to the selected object (until pinned). */
  enableFollow(id: string): void {
    this.follow.set(id, { pinned: false });
    this.render();
  }

  disableFollow(id: string): void {
    this.follow.delete(id);
    this.render();
  }

  isFollowing(id: string): boolean {
    return this.follow.has(id);
  }

  isPinned(id: string): boolean {
    return this.follow.get(id)?.pinned ?? false;
  }

  /** Move the followed floating windows next to the selection's screen position. */
  private followTick(dt: number): void {
    if (!this.follow.size || this.dragging) return;
    const { store, viewport } = this.app;
    let n = 0;
    let sx = 0;
    let sy = 0;
    const rect = viewport.dom.getBoundingClientRect();
    for (const id of store.selection) {
      const view = this.app.bodies.get(id);
      const pos = (store.get(id) as { position?: readonly number[] } | undefined)?.position;
      if (view) this.tmp.copy(view.position);
      else if (pos) this.tmp.set(pos[0], pos[1], pos[2]);
      else continue;
      this.tmp.project(viewport.camera);
      if (this.tmp.z > 1) continue;
      sx += rect.left + ((this.tmp.x + 1) / 2) * rect.width;
      sy += rect.top + ((1 - this.tmp.y) / 2) * rect.height;
      n++;
    }
    if (!n) return;
    sx /= n;
    sy /= n;
    for (const [id, st] of this.follow) {
      if (st.pinned) continue;
      const loc = locate(this.layout, id);
      const ui = loc && !loc.region ? this.groupUis.get(loc.group.id) : undefined;
      if (!loc || !ui || this.layout.maximised === loc.group.id) continue;
      const f = loc.group as FloatGroup;
      let x = sx + 40;
      if (x + f.w > rect.right - 8) x = sx - 40 - f.w;
      x = Math.max(rect.left + 8, Math.min(rect.right - f.w - 8, x));
      const y = Math.max(rect.top + 8, Math.min(rect.bottom - Math.min(f.h, rect.height - 16) - 8, sy - 60));
      // Ease towards the target so the window glides instead of jittering with the camera.
      if (Math.abs(x - f.x) < 0.5 && Math.abs(y - f.y) < 0.5) continue;
      const k = 1 - Math.exp(-Math.min(dt, 0.5) * 14);
      f.x += (x - f.x) * k;
      f.y += (y - f.y) * k;
      ui.root.style.left = `${f.x}px`;
      ui.root.style.top = `${f.y}px`;
      this.persist();
    }
  }

  /** Maximise / restore the group holding `id` (default: the panel used last). */
  toggleMaximise(id: string | null = this.lastActive): void {
    const loc = id ? locate(this.layout, id) : undefined;
    if (!loc) return;
    this.setLayout(setMaximised(this.layout, this.layout.maximised === loc.group.id ? null : loc.group.id));
  }

  applyPreset(spec: PresetSpec): void {
    this.layout = layoutFromPreset(spec, this.refs());
    this.app.prefs.set({ showLeft: spec.show.left, showRight: spec.show.right, showBottom: spec.show.bottom });
    for (const r of REGION_IDS) {
      const g = this.layout.regions[r][0];
      if (g) this.app.prefs.set({ [REGION_PREFS[r].tab]: g.active });
    }
    this.render();
  }

  resetLayout(): void {
    this.layout = defaultLayout(this.refs());
    this.app.prefs.set({ showLeft: true, showRight: true, showBottom: true });
    for (const r of REGION_IDS) {
      const g = this.layout.regions[r][0];
      if (g) this.app.prefs.set({ [REGION_PREFS[r].tab]: g.active });
    }
    this.render();
  }

  saveCurrent(name: string): void {
    const p = this.app.prefs.value;
    const entry: SavedLayout = {
      name,
      layout: JSON.parse(JSON.stringify(this.layout)) as DockLayout,
      show: { left: p.showLeft, right: p.showRight, bottom: p.showBottom },
    };
    this.saved = [...this.saved.filter((s) => s.name !== name), entry];
    this.persist();
    this.listeners.forEach((f) => f());
  }

  applySaved(name: string): boolean {
    const s = this.saved.find((x) => x.name === name);
    if (!s) return false;
    this.layout = reconcile(s.layout, this.refs());
    this.app.prefs.set({ showLeft: s.show.left, showRight: s.show.right, showBottom: s.show.bottom });
    this.render();
    return true;
  }

  deleteSaved(name: string): void {
    this.saved = this.saved.filter((s) => s.name !== name);
    this.persist();
    this.listeners.forEach((f) => f());
  }

  // ------------------------------------------------------------------------------------------- internals

  private refs(): PanelRef[] {
    return panelRegistry.list().map((p) => ({ id: p.id, region: p.region, order: p.order }));
  }

  private readStore(): { layout: DockLayout | null; saved: SavedLayout[] } | null {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw) as { layout?: unknown; saved?: unknown };
      const saved: SavedLayout[] = [];
      if (Array.isArray(o.saved))
        for (const s of o.saved as Partial<SavedLayout>[]) {
          const layout = parseLayout(s?.layout);
          if (layout && typeof s.name === 'string' && s.show)
            saved.push({
              name: s.name,
              layout,
              show: { left: !!s.show.left, right: !!s.show.right, bottom: !!s.show.bottom },
            });
        }
      return { layout: parseLayout(o.layout), saved };
    } catch {
      return null;
    }
  }

  private persist(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify({ layout: this.layout, saved: this.saved }));
      } catch {
        /* storage unavailable */
      }
    }, 150);
  }

  private setLayout(l: DockLayout): void {
    if (l === this.layout) return;
    this.layout = l;
    this.render();
  }

  /** Follow the registry: build views of new panels, drop removed ones, repair the layout, redraw. */
  private sync(): void {
    for (const def of panelRegistry.list()) {
      if (this.built.has(def.id)) continue;
      const view = def.build(this.app, { active: () => this.activeIds.has(def.id) });
      view.el.id = `panel-${def.id}`;
      view.el.setAttribute('role', 'tabpanel');
      view.el.setAttribute('aria-labelledby', `tab-${def.id}`);
      this.built.set(def.id, { def, view });
      this.registerFloatCommand(def);
    }
    for (const [id, b] of this.built)
      if (!panelRegistry.has(id)) {
        b.view.dispose?.();
        b.view.el.remove();
        this.built.delete(id);
        this.cmdOffs.get(id)?.();
        this.cmdOffs.delete(id);
      }
    this.layout = reconcile(this.layout, this.refs());
    this.render();
  }

  private registerFloatCommand(def: PanelDef): void {
    try {
      const off = registerCommand({
        id: `panel.${def.id}.float`,
        label: `Float ${def.label}`,
        labelFor: () => (this.isFloating(def.id) ? `Dock ${def.label}` : `Float ${def.label}`),
        category: 'View',
        icon: def.icon,
        description: `Pop ${def.label} out into a floating window, or dock it back`,
        keywords: ['panel', 'window', 'float', 'dock', 'pop out'],
        run: () => this.toggleFloat(def.id),
      });
      this.cmdOffs.set(def.id, off);
    } catch {
      /* a command with this id already exists (a hot-reloaded registration) */
    }
  }

  private onPrefs(keys: string[]): void {
    for (const r of REGION_IDS) {
      const k = REGION_PREFS[r];
      if (keys.includes(k.tab)) {
        const id = this.app.prefs.value[k.tab] as string;
        if (panelRegistry.has(id)) {
          const loc = locate(this.layout, id);
          if (loc && !loc.region) this.setLayout(raiseFloat(setActive(this.layout, id), loc.group.id));
          else this.setLayout(setActive(this.layout, id));
        } else {
          // An id that no longer exists falls back to the first tab of the region.
          const g = this.layout.regions[r][0];
          if (g) this.setLayout(setActive(this.layout, g.tabs[0]));
        }
      }
      if (keys.includes(k.show)) this.applyRegionState();
    }
  }

  private syncPrefsTab(id: string): void {
    const loc = locate(this.layout, id);
    const def = this.built.get(id)?.def;
    if (!loc?.region || !def) return;
    this.app.prefs.set({ [REGION_PREFS[loc.region].tab]: id });
  }

  private activate(id: string): void {
    this.lastActive = id;
    this.setLayout(setActive(this.layout, id));
    this.syncPrefsTab(id);
  }

  // ---------------------------------------------------------------------------------------------- render

  render(): void {
    const l = this.layout;
    const live = new Set(allGroups(l).map((g) => g.id));
    for (const [gid, ui] of this.groupUis)
      if (!live.has(gid)) {
        ui.root.remove();
        this.groupUis.delete(gid);
      }
    for (const r of REGION_IDS) {
      const ui = this.regions.get(r);
      const groups = l.regions[r];
      if (!ui) {
        // A region that is not mounted: its groups are drawn when it is.
        continue;
      }
      const kids: Node[] = [];
      groups.forEach((g, i) => {
        if (i > 0) kids.push(this.groupSplitter(r, i));
        kids.push(this.renderGroup(g, r).root);
      });
      setChildren(ui.list, kids);
    }
    const floatKids: Node[] = [];
    for (const f of [...l.floats].sort((a, b) => a.z - b.z)) floatKids.push(this.renderGroup(f, undefined).root);
    setChildren(this.floatLayer, floatKids);
    this.applyRegionState();
    this.clampFloats(false);
    // Tell panels that just became visible.
    const nowActive = new Set<string>();
    for (const g of allGroups(l)) if (g.active) nowActive.add(g.active);
    const newly = [...nowActive].filter((id) => !this.activeIds.has(id));
    this.activeIds.clear();
    nowActive.forEach((id) => this.activeIds.add(id));
    for (const id of newly) this.built.get(id)?.view.onShow?.();
    this.persist();
    this.listeners.forEach((f) => f());
  }

  private applyRegionState(): void {
    const l = this.layout;
    const app = document.getElementById('app');
    for (const r of REGION_IDS) {
      const ui = this.regions.get(r);
      if (!ui) continue;
      const empty = l.regions[r].length === 0;
      ui.root.classList.toggle('dock-empty', empty);
      if (ui.opts.collapseWhenOff) ui.root.classList.toggle('collapsed', !this.app.prefs.value[REGION_PREFS[r].show]);
      const size = l.sizes[r];
      const target = app;
      if (!target) continue;
      if (empty && !this.dragging) target.style.setProperty(SIZE_VAR[r], '0px');
      else if (empty) target.style.setProperty(SIZE_VAR[r], r === 'bottom' ? '64px' : '84px');
      else if (size) target.style.setProperty(SIZE_VAR[r], `${size}px`);
      else target.style.removeProperty(SIZE_VAR[r]);
    }
    app?.classList.toggle('dock-has-max', !!l.maximised);
    app?.classList.toggle('dock-dragging', this.dragging);
  }

  private renderGroup(g: DockGroup, region: RegionId | undefined): GroupUi {
    let ui = this.groupUis.get(g.id);
    if (!ui) {
      const head = h('div', { 'data-group': g.id });
      const tabsBox = h('div', { class: 'dock-tabs', role: 'tablist' });
      const toolbar = h('div', { class: 'tab-toolbar' });
      const buttons = h('div', { class: 'dock-gbtns' });
      head.append(tabsBox, toolbar, buttons);
      const body = h('div', { class: 'dock-group-body' });
      const root = h('div', { class: 'dock-group', 'data-group': g.id }, head, body);
      ui = { root, head, tabsBox, toolbar, buttons, body, handles: [] };
      this.groupUis.set(g.id, ui);
      this.wireGroup(g.id, ui);
    }
    const isFloat = !region;
    const opts = region ? this.regions.get(region)?.opts : undefined;
    ui.head.className = `${isFloat ? 'tabs dock-float-head' : (opts?.headClass ?? 'tabs')} dock-ghead`;
    ui.root.classList.toggle('dock-floating', isFloat);
    ui.root.classList.toggle('collapsed', !!g.collapsed);
    ui.root.classList.toggle('maximised', this.layout.maximised === g.id);
    if (region) ui.root.style.flex = g.collapsed ? '0 0 auto' : `${g.weight} 1 0`;
    else ui.root.style.flex = '';
    const showIcons = isFloat ? true : (opts?.icons ?? true);
    // Tabs.
    const tabEls = g.tabs.map((id) => this.makeTab(id, g, showIcons));
    setChildren(ui.tabsBox, tabEls);
    // Body: only re-parent when the set changed, hide all but the active view.
    const views = g.tabs.map((id) => (this.built.get(id) as Built).view.el);
    setChildren(ui.body, views);
    for (const id of g.tabs) {
      const el = (this.built.get(id) as Built).view.el;
      el.style.display = id === g.active ? '' : 'none';
    }
    const active = this.built.get(g.active)?.view;
    const tb = active?.toolbar ?? [];
    setChildren(ui.toolbar, tb);
    ui.toolbar.style.display = tb.length ? '' : 'none';
    // Group buttons.
    const btns: HTMLElement[] = [];
    const mk = (label: string, g_: SVGSVGElement, fn: () => void): HTMLButtonElement => {
      const b = h('button', { class: 'dock-gbtn', type: 'button', title: label, 'aria-label': label }, g_);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      return b;
    };
    const first = g.tabs[0];
    if (region && this.layout.regions[region].length > 1)
      btns.push(
        mk(g.collapsed ? 'Expand' : 'Collapse', glyph(g.collapsed ? 'expand' : 'collapse'), () =>
          this.setLayout(setCollapsed(this.layout, g.id, !g.collapsed)),
        ),
      );
    btns.push(
      mk(isFloat ? 'Dock back' : 'Pop out as a floating window', glyph(isFloat ? 'dock' : 'float'), () =>
        isFloat ? this.setLayout(dockFloat(this.layout, g.id, this.refs())) : this.floatPanel(g.active || first),
      ),
    );
    if (isFloat && this.follow.has(g.active)) {
      const pinned = this.isPinned(g.active);
      const pin = mk(
        pinned ? 'Pinned here — click to follow the selection again' : 'Following the selection — click to pin here',
        glyph(pinned ? 'pin' : 'follow'),
        () => {
          const st = this.follow.get(g.active);
          if (st) st.pinned = !st.pinned;
          this.render();
        },
      );
      pin.classList.toggle('on', pinned);
      btns.unshift(pin);
    }
    const max = this.layout.maximised === g.id;
    btns.push(
      mk(max ? 'Restore (Esc)' : 'Maximise', glyph(max ? 'restore' : 'max'), () =>
        this.setLayout(setMaximised(this.layout, max ? null : g.id)),
      ),
    );
    setChildren(ui.buttons, btns);
    // Floating geometry + resize handles.
    if (isFloat) {
      const f = g as FloatGroup;
      Object.assign(ui.root.style, {
        left: `${f.x}px`,
        top: `${f.y}px`,
        width: `${f.w}px`,
        height: g.collapsed ? 'auto' : `${f.h}px`,
        zIndex: String(10 + f.z),
      });
      if (!ui.handles.length) {
        for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
          const hd = h('div', { class: `dock-resize ${dir}`, 'data-dir': dir });
          this.wireFloatResize(hd, g.id, dir);
          ui.handles.push(hd);
          ui.root.appendChild(hd);
        }
      }
    } else {
      Object.assign(ui.root.style, { left: '', top: '', width: '', height: '', zIndex: '' });
      ui.handles.forEach((x) => x.remove());
      ui.handles = [];
    }
    ui.root.toggleAttribute('hidden', false);
    return ui;
  }

  private makeTab(id: string, g: DockGroup, showIcons: boolean): HTMLButtonElement {
    const def = (this.built.get(id) as Built).def;
    const on = g.active === id;
    const t = h(
      'button',
      {
        class: `tab${on ? ' on' : ''}`,
        type: 'button',
        role: 'tab',
        id: `tab-${id}`,
        title: def.title ?? def.label,
        'aria-selected': on ? 'true' : 'false',
        'aria-controls': `panel-${id}`,
        tabindex: on ? 0 : -1,
        'data-panel': id,
      },
      showIcons ? icon(def.icon) : null,
      def.label,
    );
    t.addEventListener('click', () => {
      if (this.suppressClick) return;
      this.activate(id);
    });
    t.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.tabMenu(id, e.clientX, e.clientY);
    });
    t.addEventListener('pointerdown', (e) => this.beginTabDrag(e, id, t));
    return t;
  }

  private tabMenu(id: string, x: number, y: number): void {
    const loc = locate(this.layout, id);
    if (!loc) return;
    const label = this.built.get(id)?.def.label ?? id;
    const items = [
      { heading: label },
      ...(['left', 'right', 'bottom'] as const).map((r) => ({
        label: `Move to ${r === 'bottom' ? 'bottom dock' : `${r} panels`}`,
        checked: loc.region === r,
        action: () => this.dockPanel(id, r),
      })),
      { sep: true as const },
      { label: loc.region ? 'Pop out as window' : 'Dock back', action: () => this.toggleFloat(id) },
      {
        label: this.layout.maximised === loc.group.id ? 'Restore size' : 'Maximise',
        action: () => this.toggleMaximise(id),
      },
    ];
    openMenu(items, { x, y });
  }

  // ----------------------------------------------------------------------------------------- group wiring

  private wireGroup(gid: string, ui: GroupUi): void {
    // Arrow keys move between the tabs of the group, as in any tab list.
    ui.tabsBox.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      // While a simulation runs the arrow keys may be bound to motors and thrusters, and a tab that still has focus
      // from a click must not take them (they reach the shortcuts and the simulation instead).
      if (this.app.sim.active) return;
      const g = findGroup(this.layout, gid);
      if (!g) return;
      const i = g.tabs.indexOf(g.active);
      const next = g.tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + g.tabs.length) % g.tabs.length];
      if (!next) return;
      e.preventDefault();
      // The arrow keys are the tab list's: they must not also reach the shortcuts (nudging the selection).
      e.stopPropagation();
      this.activate(next);
      document.getElementById(`tab-${next}`)?.focus();
    });
    // Double-click on the empty strip maximises; pointer down on a floating window raises it and drags it.
    ui.head.addEventListener('dblclick', (e) => {
      if (e.target === ui.head || e.target === ui.tabsBox || e.target === ui.toolbar) {
        const g = findGroup(this.layout, gid);
        if (g) this.setLayout(setMaximised(this.layout, this.layout.maximised === gid ? null : gid));
      }
    });
    ui.root.addEventListener('pointerdown', () => {
      if (this.layout.floats.some((f) => f.id === gid)) this.setLayout(raiseFloat(this.layout, gid));
    });
    ui.head.addEventListener('pointerdown', (e) => {
      const f = this.layout.floats.find((x) => x.id === gid);
      if (!f || e.button !== 0 || this.layout.maximised === gid) return;
      if (e.target !== ui.head && e.target !== ui.tabsBox && e.target !== ui.toolbar) return;
      this.dragFloat(e, f, ui);
    });
  }

  private groupSplitter(region: RegionId, index: number): HTMLElement {
    const row = region === 'bottom';
    const s = h('div', {
      class: `dock-gsplit ${row ? 'v' : 'h'}`,
      role: 'separator',
      'aria-orientation': row ? 'vertical' : 'horizontal',
    });
    s.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const groups = this.layout.regions[region];
      const a = this.groupUis.get(groups[index - 1].id)?.root;
      const b = this.groupUis.get(groups[index].id)?.root;
      if (!a || !b) return;
      const size = (el: HTMLElement) => (row ? el.getBoundingClientRect().width : el.getBoundingClientRect().height);
      const sa = size(a);
      const sb = size(b);
      const wa = groups[index - 1].weight;
      const wb = groups[index].weight;
      const total = sa + sb;
      const start = row ? e.clientX : e.clientY;
      let wa2 = wa;
      let wb2 = wb;
      s.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const d = (row ? ev.clientX : ev.clientY) - start;
        const na = Math.max(60, Math.min(total - 60, sa + d));
        wa2 = (na / total) * (wa + wb);
        wb2 = ((total - na) / total) * (wa + wb);
        a.style.flex = `${wa2} 1 0`;
        b.style.flex = `${wb2} 1 0`;
      };
      const up = () => {
        s.removeEventListener('pointermove', move);
        s.removeEventListener('pointerup', up);
        const ws = this.layout.regions[region].map((g) => g.weight);
        ws[index - 1] = wa2;
        ws[index] = wb2;
        this.setLayout(setWeights(this.layout, region, ws));
      };
      s.addEventListener('pointermove', move);
      s.addEventListener('pointerup', up);
    });
    return s;
  }

  private wireRegionSplit(handle: HTMLElement, region: RegionId, root: HTMLElement): void {
    const [min, max] = SIZE_LIMITS[region];
    const apply = (px: number) => {
      const v = Math.round(Math.max(min, Math.min(max, px)));
      document.getElementById('app')?.style.setProperty(SIZE_VAR[region], `${v}px`);
      return v;
    };
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      let last = 0;
      const move = (ev: PointerEvent) => {
        const r = root.getBoundingClientRect();
        last = apply(
          region === 'left' ? ev.clientX - r.left : region === 'right' ? r.right - ev.clientX : r.bottom - ev.clientY,
        );
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        if (last) this.setLayout(setSize(this.layout, region, last));
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
    handle.addEventListener('dblclick', () => this.setLayout(setSize(this.layout, region, null)));
    handle.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 48 : 16;
      const grow = region === 'left' || region === 'bottom' ? 1 : -1;
      const key = region === 'bottom' ? { ArrowUp: 1, ArrowDown: -1 } : { ArrowRight: grow, ArrowLeft: -grow };
      const dir = (key as Record<string, number | undefined>)[e.key];
      if (!dir) return;
      e.preventDefault();
      e.stopPropagation();
      const r = root.getBoundingClientRect();
      const cur = region === 'bottom' ? r.height : r.width;
      this.setLayout(setSize(this.layout, region, Math.max(min, Math.min(max, cur + dir * step))));
    });
  }

  // ------------------------------------------------------------------------------------- floating windows

  private clampFloats(rerender = true): void {
    const W = window.innerWidth;
    const H = window.innerHeight;
    let l = this.layout;
    for (const f of l.floats) {
      const x = Math.max(-f.w + 96, Math.min(W - 96, f.x));
      const y = Math.max(0, Math.min(H - 34, f.y));
      if (x !== f.x || y !== f.y) l = setFloatRect(l, f.id, { x, y });
    }
    if (l !== this.layout) {
      this.layout = l;
      if (rerender) this.render();
    }
  }

  private dragFloat(e: PointerEvent, f: FloatGroup, ui: GroupUi): void {
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const ox = f.x;
    const oy = f.y;
    let x = ox;
    let y = oy;
    ui.head.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      x = ox + ev.clientX - sx;
      y = Math.max(0, oy + ev.clientY - sy);
      ui.root.style.left = `${x}px`;
      ui.root.style.top = `${y}px`;
    };
    const up = () => {
      ui.head.removeEventListener('pointermove', move);
      ui.head.removeEventListener('pointerup', up);
      const st = this.follow.get(f.active);
      if (st && (x !== ox || y !== oy)) st.pinned = true;
      this.setLayout(setFloatRect(this.layout, f.id, { x, y }));
    };
    ui.head.addEventListener('pointermove', move);
    ui.head.addEventListener('pointerup', up);
  }

  private wireFloatResize(handle: HTMLElement, gid: string, dir: string): void {
    handle.addEventListener('pointerdown', (e) => {
      const f = this.layout.floats.find((x) => x.id === gid);
      const ui = this.groupUis.get(gid);
      if (!f || !ui) return;
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      const r = { x: f.x, y: f.y, w: f.w, h: f.h };
      const sx = e.clientX;
      const sy = e.clientY;
      let cur = { ...r };
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - sx;
        const dy = ev.clientY - sy;
        let { x, y, w, h: hh } = r;
        if (dir.includes('e')) w = Math.max(MIN_FLOAT.w, r.w + dx);
        if (dir.includes('s')) hh = Math.max(MIN_FLOAT.h, r.h + dy);
        if (dir.includes('w')) {
          w = Math.max(MIN_FLOAT.w, r.w - dx);
          x = r.x + r.w - w;
        }
        if (dir.includes('n')) {
          hh = Math.max(MIN_FLOAT.h, r.h - dy);
          y = Math.max(0, r.y + r.h - hh);
        }
        cur = { x, y, w, h: hh };
        Object.assign(ui.root.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${hh}px` });
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        this.setLayout(setFloatRect(this.layout, gid, cur));
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  // --------------------------------------------------------------------------------------- tab dragging

  /** A click that ends a drag must not also select the tab. */
  private suppressClick = false;

  private beginTabDrag(e: PointerEvent, id: string, tab: HTMLElement): void {
    if (e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    let started = false;
    let ghost: HTMLElement | null = null;
    let drop: { target: DropTarget; rect: { x: number; y: number; w: number; h: number } | null } | null = null;
    const label = this.built.get(id)?.def.label ?? id;
    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        started = true;
        this.dragging = true;
        ghost = h('div', { class: 'dock-ghost' }, label);
        document.body.appendChild(ghost);
        this.applyRegionState();
        try {
          tab.releasePointerCapture(ev.pointerId);
        } catch {
          /* not captured */
        }
      }
      if (ghost) {
        ghost.style.left = `${ev.clientX + 12}px`;
        ghost.style.top = `${ev.clientY + 8}px`;
      }
      drop = this.resolveDrop(ev.clientX, ev.clientY, id);
      this.showOverlay(drop?.rect ?? null);
    };
    const finish = (apply: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key, true);
      ghost?.remove();
      this.showOverlay(null);
      if (started) {
        this.dragging = false;
        this.suppressClick = true;
        setTimeout(() => (this.suppressClick = false), 0);
        if (apply && drop) {
          const wasMax = this.layout.maximised;
          this.layout = moveTab(this.layout, id, drop.target);
          if (wasMax && !findGroup(this.layout, wasMax)) this.layout = setMaximised(this.layout, null);
          this.lastActive = id;
          this.syncPrefsTab(id);
        }
        this.render();
      }
    };
    const up = () => finish(true);
    const key = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        finish(false);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key, true);
  }

  private showOverlay(r: { x: number; y: number; w: number; h: number } | null): void {
    const o = this.overlay;
    if (!r) {
      o.classList.remove('show');
      return;
    }
    Object.assign(o.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    o.classList.add('show');
  }

  /** Where would a tab dropped at (x, y) land, and which rectangle shows it? */
  private resolveDrop(
    x: number,
    y: number,
    id: string,
  ): { target: DropTarget; rect: { x: number; y: number; w: number; h: number } | null } | null {
    const els = document.elementsFromPoint(x, y);
    const gEl = els.map((el) => el.closest<HTMLElement>('.dock-group')).find((el) => !!el);
    const rr = (r: DOMRect) => ({ x: r.left, y: r.top, w: r.width, h: r.height });
    if (gEl) {
      const gid = gEl.dataset.group as string;
      const g = findGroup(this.layout, gid);
      const ui = this.groupUis.get(gid);
      if (g && ui) {
        const gr = gEl.getBoundingClientRect();
        const hr = ui.head.getBoundingClientRect();
        if (y >= hr.top && y <= hr.bottom) {
          // Over the tab strip: insert before the first tab whose centre is right of the pointer.
          const tabs = [...ui.tabsBox.querySelectorAll<HTMLElement>('.tab')].filter((t) => t.dataset.panel !== id);
          let index = tabs.length;
          let lineX = tabs.length ? tabs[tabs.length - 1].getBoundingClientRect().right : hr.left + 4;
          for (let i = 0; i < tabs.length; i++) {
            const tr = tabs[i].getBoundingClientRect();
            if (x < tr.left + tr.width / 2) {
              index = i;
              lineX = tr.left;
              break;
            }
          }
          // `index` counts the other tabs; moveTab expects the position in the full list.
          const full = g.tabs.indexOf(id) >= 0 ? g.tabs.filter((t) => t !== id) : g.tabs;
          const targetIndex = Math.min(index, full.length);
          const adj = g.tabs.indexOf(id) >= 0 && g.tabs.indexOf(id) < targetIndex ? targetIndex + 1 : targetIndex;
          return {
            target: { type: 'tabs', groupId: gid, index: adj },
            rect: { x: lineX - 1, y: hr.top + 3, w: 3, h: hr.height - 6 },
          };
        }
        const region = regionOf(this.layout, gid);
        if (region) {
          const row = region === 'bottom';
          const f = row ? (x - gr.left) / gr.width : (y - gr.top) / gr.height;
          const solo = g.tabs.length === 1 && g.tabs[0] === id;
          if (!solo && f < 0.22)
            return {
              target: { type: 'split', groupId: gid, side: 'before' },
              rect: row
                ? { x: gr.left, y: gr.top, w: gr.width / 2, h: gr.height }
                : { x: gr.left, y: gr.top, w: gr.width, h: gr.height / 2 },
            };
          if (!solo && f > 0.78)
            return {
              target: { type: 'split', groupId: gid, side: 'after' },
              rect: row
                ? { x: gr.left + gr.width / 2, y: gr.top, w: gr.width / 2, h: gr.height }
                : { x: gr.left, y: gr.top + gr.height / 2, w: gr.width, h: gr.height / 2 },
            };
        }
        return { target: { type: 'tabs', groupId: gid }, rect: rr(gr) };
      }
    }
    const rEl = els.map((el) => el.closest<HTMLElement>('.dock-region')).find((el) => !!el);
    if (rEl)
      return {
        target: { type: 'region', region: rEl.dataset.region as RegionId },
        rect: rr(rEl.getBoundingClientRect()),
      };
    // Anywhere else: a floating window whose title bar sits under the pointer.
    return {
      target: { type: 'float', x: Math.max(0, x - 60), y: Math.max(0, y - 14), w: DEFAULT_FLOAT.w, h: DEFAULT_FLOAT.h },
      rect: { x: Math.max(0, x - 60), y: Math.max(0, y - 14), w: DEFAULT_FLOAT.w, h: DEFAULT_FLOAT.h },
    };
  }
}
