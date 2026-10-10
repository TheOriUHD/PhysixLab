/**
 * The dock layout model (UI-1) — pure data and pure functions, no DOM.
 *
 * Panels live in *groups* (a tab strip with one visible panel). A group is either docked in one of the three regions
 * (`left`, `right`, `bottom`; several groups in a region form a split) or floating (a window with a rectangle and a
 * z-order). Every operation returns a new layout; `reconcile` repairs any layout against the panels that are
 * registered right now (new panels land in their home region, vanished ones disappear), so a stored layout never
 * hides a panel and never refers to a missing one.
 */

export type RegionId = 'left' | 'right' | 'bottom';
export const REGION_IDS: readonly RegionId[] = ['left', 'right', 'bottom'];

export interface DockGroup {
  id: string;
  tabs: string[];
  active: string;
  /** Relative size among the groups of a region (flex-grow). */
  weight: number;
  collapsed?: boolean;
}

export interface FloatGroup extends DockGroup {
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

export interface DockLayout {
  version: 1;
  regions: Record<RegionId, DockGroup[]>;
  floats: FloatGroup[];
  /** Pixel size of each region along its short axis (width, width, height); null = the stylesheet default. */
  sizes: Record<RegionId, number | null>;
  /** Id of the maximised group. */
  maximised: string | null;
  seq: number;
}

/** What `reconcile` needs to know about a registered panel. */
export interface PanelRef {
  id: string;
  /** Home region. */
  region: RegionId;
  order: number;
}

export type DropTarget =
  | { type: 'tabs'; groupId: string; index?: number }
  | { type: 'split'; groupId: string; side: 'before' | 'after' }
  | { type: 'region'; region: RegionId }
  | { type: 'float'; x: number; y: number; w?: number; h?: number };

export const MIN_FLOAT = { w: 220, h: 120 };
export const DEFAULT_FLOAT = { w: 340, h: 380 };

export function emptyLayout(): DockLayout {
  return {
    version: 1,
    regions: { left: [], right: [], bottom: [] },
    floats: [],
    sizes: { left: null, right: null, bottom: null },
    maximised: null,
    seq: 0,
  };
}

const clone = (l: DockLayout): DockLayout => JSON.parse(JSON.stringify(l)) as DockLayout;

function newGroupId(l: DockLayout): string {
  l.seq += 1;
  return `g${l.seq}`;
}

/** Every group, docked first. */
export function allGroups(l: DockLayout): DockGroup[] {
  return [...l.regions.left, ...l.regions.right, ...l.regions.bottom, ...l.floats];
}

export function findGroup(l: DockLayout, groupId: string): DockGroup | undefined {
  return allGroups(l).find((g) => g.id === groupId);
}

export interface PanelLocation {
  group: DockGroup;
  /** Undefined for a floating group. */
  region?: RegionId;
}

export function locate(l: DockLayout, panelId: string): PanelLocation | undefined {
  for (const r of REGION_IDS)
    for (const g of l.regions[r]) if (g.tabs.includes(panelId)) return { group: g, region: r };
  const f = l.floats.find((g) => g.tabs.includes(panelId));
  return f ? { group: f } : undefined;
}

/** The region a group is docked in (undefined for floats). */
export function regionOf(l: DockLayout, groupId: string): RegionId | undefined {
  return REGION_IDS.find((r) => l.regions[r].some((g) => g.id === groupId));
}

/** The default layout: one group per region with every panel in its home region, in registry order. */
export function defaultLayout(panels: readonly PanelRef[]): DockLayout {
  return reconcile(emptyLayout(), panels);
}

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/**
 * Repair a layout: drop unknown / duplicate tabs, add panels that are missing to the end of the first group of
 * their home region, fix `active`, remove empty groups, clamp numbers. Never throws.
 */
export function reconcile(input: DockLayout, panels: readonly PanelRef[]): DockLayout {
  const l = clone(input);
  const known = new Map(panels.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const fix = <G extends DockGroup>(g: G): G | null => {
    g.tabs = (Array.isArray(g.tabs) ? g.tabs : []).filter((t) => {
      if (typeof t !== 'string' || !known.has(t) || seen.has(t)) return false;
      seen.add(t);
      return true;
    });
    if (!g.tabs.length) return null;
    if (!g.tabs.includes(g.active)) g.active = g.tabs[0];
    g.weight = Math.max(0.1, num(g.weight, 1));
    return g;
  };
  for (const r of REGION_IDS) l.regions[r] = (l.regions[r] ?? []).map(fix).filter((g): g is DockGroup => !!g);
  l.floats = (l.floats ?? []).map(fix).filter((g): g is FloatGroup => !!g);
  for (const f of l.floats) {
    f.w = Math.max(MIN_FLOAT.w, num(f.w, DEFAULT_FLOAT.w));
    f.h = Math.max(MIN_FLOAT.h, num(f.h, DEFAULT_FLOAT.h));
    f.x = num(f.x, 80);
    f.y = num(f.y, 80);
    f.z = num(f.z, 1);
  }
  // Panels no group mentions go home, in registry order.
  const missing = [...panels].filter((p) => !seen.has(p.id)).sort((a, b) => a.order - b.order);
  for (const p of missing) {
    let g = l.regions[p.region][0];
    if (!g) {
      g = { id: newGroupId(l), tabs: [], active: p.id, weight: 1 };
      l.regions[p.region].push(g);
    }
    g.tabs.push(p.id);
  }
  l.sizes = { ...emptyLayout().sizes, ...(l.sizes ?? {}) };
  for (const r of REGION_IDS) {
    const s = l.sizes[r];
    l.sizes[r] = typeof s === 'number' && Number.isFinite(s) && s > 40 ? s : null;
  }
  if (l.maximised && !findGroup(l, l.maximised)) l.maximised = null;
  l.seq = Math.max(num(l.seq, 0), ...allGroups(l).map((g) => Number(g.id.slice(1)) || 0));
  l.version = 1;
  return l;
}

/** Make `panelId` the visible tab of its group. */
export function setActive(input: DockLayout, panelId: string): DockLayout {
  const loc = locate(input, panelId);
  if (!loc || loc.group.active === panelId) return input;
  const l = clone(input);
  const g = (locate(l, panelId) as PanelLocation).group;
  g.active = panelId;
  g.collapsed = false;
  return l;
}

function removeEmpty(l: DockLayout): void {
  for (const r of REGION_IDS) l.regions[r] = l.regions[r].filter((g) => g.tabs.length);
  l.floats = l.floats.filter((g) => g.tabs.length);
  if (l.maximised && !findGroup(l, l.maximised)) l.maximised = null;
}

/** Move a panel to a drop target. Dropping a panel on its own group's tab strip reorders it. */
export function moveTab(input: DockLayout, panelId: string, dest: DropTarget): DockLayout {
  const src = locate(input, panelId);
  if (!src) return input;
  const l = clone(input);
  const take = (): void => {
    const g = (locate(l, panelId) as PanelLocation).group;
    g.tabs = g.tabs.filter((t) => t !== panelId);
    if (g.active === panelId) g.active = g.tabs[0] ?? '';
  };
  switch (dest.type) {
    case 'tabs': {
      const target = findGroup(l, dest.groupId);
      if (!target) return input;
      const before = target.tabs.indexOf(panelId);
      take();
      let i = dest.index ?? target.tabs.length;
      if (before >= 0 && before < i) i -= 1;
      target.tabs.splice(Math.max(0, Math.min(i, target.tabs.length)), 0, panelId);
      target.active = panelId;
      target.collapsed = false;
      break;
    }
    case 'split': {
      const target = findGroup(l, dest.groupId);
      const region = regionOf(l, dest.groupId);
      if (!target || !region) return input;
      // Splitting a group off its only panel is a no-op.
      if (target.tabs.length === 1 && target.tabs[0] === panelId) return input;
      take();
      const g: DockGroup = { id: newGroupId(l), tabs: [panelId], active: panelId, weight: target.weight };
      const list = l.regions[region];
      const at = list.findIndex((x) => x.id === dest.groupId);
      list.splice(dest.side === 'before' ? at : at + 1, 0, g);
      break;
    }
    case 'region': {
      take();
      const list = l.regions[dest.region];
      const first = list[0];
      if (first) {
        first.tabs.push(panelId);
        first.active = panelId;
        first.collapsed = false;
      } else list.push({ id: newGroupId(l), tabs: [panelId], active: panelId, weight: 1 });
      break;
    }
    case 'float': {
      // A float holding just this panel is merely moved.
      if (!src.region && src.group.tabs.length === 1) {
        const f = (locate(l, panelId) as PanelLocation).group as FloatGroup;
        f.x = dest.x;
        f.y = dest.y;
        break;
      }
      take();
      const z = Math.max(0, ...l.floats.map((f) => f.z)) + 1;
      l.floats.push({
        id: newGroupId(l),
        tabs: [panelId],
        active: panelId,
        weight: 1,
        x: dest.x,
        y: dest.y,
        w: dest.w ?? DEFAULT_FLOAT.w,
        h: dest.h ?? DEFAULT_FLOAT.h,
        z,
      });
      break;
    }
  }
  removeEmpty(l);
  return l;
}

/** Bring a floating group to the front. */
export function raiseFloat(input: DockLayout, groupId: string): DockLayout {
  const f = input.floats.find((g) => g.id === groupId);
  if (!f) return input;
  const top = Math.max(...input.floats.map((g) => g.z));
  if (f.z === top && input.floats.filter((g) => g.z === top).length === 1) return input;
  const l = clone(input);
  (l.floats.find((g) => g.id === groupId) as FloatGroup).z = top + 1;
  return l;
}

export function setFloatRect(
  input: DockLayout,
  groupId: string,
  r: Partial<Pick<FloatGroup, 'x' | 'y' | 'w' | 'h'>>,
): DockLayout {
  if (!input.floats.some((g) => g.id === groupId)) return input;
  const l = clone(input);
  const f = l.floats.find((g) => g.id === groupId) as FloatGroup;
  Object.assign(f, r);
  f.w = Math.max(MIN_FLOAT.w, f.w);
  f.h = Math.max(MIN_FLOAT.h, f.h);
  return l;
}

export function setWeights(input: DockLayout, region: RegionId, weights: readonly number[]): DockLayout {
  if (weights.length !== input.regions[region].length) return input;
  const l = clone(input);
  l.regions[region].forEach((g, i) => (g.weight = Math.max(0.1, weights[i])));
  return l;
}

export function setSize(input: DockLayout, region: RegionId, px: number | null): DockLayout {
  if (input.sizes[region] === px) return input;
  const l = clone(input);
  l.sizes[region] = px;
  return l;
}

export function setMaximised(input: DockLayout, groupId: string | null): DockLayout {
  if (input.maximised === groupId) return input;
  if (groupId && !findGroup(input, groupId)) return input;
  const l = clone(input);
  l.maximised = groupId;
  return l;
}

export function setCollapsed(input: DockLayout, groupId: string, collapsed: boolean): DockLayout {
  const g = findGroup(input, groupId);
  if (!g || !!g.collapsed === collapsed) return input;
  const l = clone(input);
  (findGroup(l, groupId) as DockGroup).collapsed = collapsed;
  return l;
}

/** Re-dock every panel of a floating group into its home region. */
export function dockFloat(input: DockLayout, groupId: string, panels: readonly PanelRef[]): DockLayout {
  const f = input.floats.find((g) => g.id === groupId);
  if (!f) return input;
  let l = input;
  for (const id of [...f.tabs]) {
    const home = panels.find((p) => p.id === id)?.region ?? 'right';
    l = moveTab(l, id, { type: 'region', region: home });
  }
  return l;
}

// ---------------------------------------------------------------------------------------------- presets

/** A named arrangement written by panel ids; ids that are not registered are skipped, the rest go home. */
export interface PresetSpec {
  /** Per region: a list of groups, each a list of panel ids (the first is the visible tab). */
  regions: Record<RegionId, string[][]>;
  /** Which regions are shown. */
  show: Record<RegionId, boolean>;
  floats?: { tabs: string[]; x: number; y: number; w: number; h: number }[];
  sizes?: Partial<Record<RegionId, number>>;
}

export function layoutFromPreset(spec: PresetSpec, panels: readonly PanelRef[]): DockLayout {
  const l = emptyLayout();
  const ok = new Set(panels.map((p) => p.id));
  const used = new Set<string>();
  const take = (ids: readonly string[]): string[] => ids.filter((id) => ok.has(id) && !used.has(id) && !!used.add(id));
  for (const r of REGION_IDS)
    for (const ids of spec.regions[r]) {
      const tabs = take(ids);
      if (tabs.length) l.regions[r].push({ id: newGroupId(l), tabs, active: tabs[0], weight: 1 });
    }
  let z = 1;
  for (const f of spec.floats ?? []) {
    const tabs = take(f.tabs);
    if (tabs.length)
      l.floats.push({ id: newGroupId(l), tabs, active: tabs[0], weight: 1, x: f.x, y: f.y, w: f.w, h: f.h, z: z++ });
  }
  for (const r of REGION_IDS) l.sizes[r] = spec.sizes?.[r] ?? null;
  return reconcile(l, panels);
}

/** Validate a layout read from storage (shape only; `reconcile` does the semantic repair). */
export function parseLayout(raw: unknown): DockLayout | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<DockLayout>;
  if (o.version !== 1 || !o.regions || typeof o.regions !== 'object') return null;
  const l = emptyLayout();
  for (const r of REGION_IDS) {
    const list = (o.regions as Record<string, unknown>)[r];
    if (Array.isArray(list)) l.regions[r] = list.filter((g): g is DockGroup => !!g && typeof g === 'object');
  }
  if (Array.isArray(o.floats)) l.floats = o.floats.filter((g): g is FloatGroup => !!g && typeof g === 'object');
  if (o.sizes && typeof o.sizes === 'object') l.sizes = { ...l.sizes, ...o.sizes };
  l.maximised = typeof o.maximised === 'string' ? o.maximised : null;
  l.seq = num(o.seq, 0);
  return l;
}
