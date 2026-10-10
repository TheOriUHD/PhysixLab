/**
 * The panel registry — the tabs of the three docked regions.
 *
 *   left     library: Add, Prefabs, Maps, Scenes
 *   right    editing: Inspector, Outliner, World
 *   bottom   telemetry dock: Energy, Selection
 *
 * A `PanelDef` says in which region the tab lives, its label / icon / order, and how to build its content. The
 * regions (`src/ui/panelRegion.ts`) render the tab strip from the registry, keep one built view per panel, show the
 * one named by the region's preference (`leftTab` / `rightTab` / `bottomTab`) and follow the registry live, so a
 * panel registered later simply appears. Registering a panel also registers the command `panel.<id>`
 * ("Show Inspector"), which switches to it and opens its region — it is what the palette offers.
 */
import { Registry } from '../../core/registry';
import type { App } from '../app';
import type { Prefs } from '../prefs';
import { registerCommand, unregisterCommand } from './commands';

export type PanelRegionId = 'left' | 'right' | 'bottom';

/** The preferences that remember the active tab of a region and whether the region is shown. */
export const REGION_PREFS: Record<PanelRegionId, { tab: keyof Prefs; show: keyof Prefs }> = {
  left: { tab: 'leftTab', show: 'showLeft' },
  right: { tab: 'rightTab', show: 'showRight' },
  bottom: { tab: 'bottomTab', show: 'showBottom' },
};

/** What a panel's `build` returns. */
export interface PanelView {
  /** The panel's DOM. The region shows and hides it; it stays alive while the panel is registered. */
  el: HTMLElement;
  /** Called every time the panel becomes the visible tab (rebuild stale content here). */
  onShow?: () => void;
  /** Controls placed at the right end of the tab strip while this panel is the visible tab. */
  toolbar?: readonly HTMLElement[];
  /** Called when the panel is unregistered. */
  dispose?: () => void;
}

export interface PanelContext {
  /** Is this panel the selected tab of its region right now? (The region itself may be hidden.) */
  active: () => boolean;
}

export interface PanelDef {
  /** Unique id; it is what the region preference stores (`leftTab: 'scenes'`). */
  id: string;
  label: string;
  /** Key of `src/ui/icons.ts` (shown in the left and right regions). */
  icon: string;
  region: PanelRegionId;
  /** Tabs are sorted by this, then by registration. */
  order: number;
  /** Tooltip of the tab. */
  title?: string;
  /** Build the view once; the region calls it when the panel is first needed. */
  build: (app: App, ctx: PanelContext) => PanelView;
}

// -- UI-A: the dock (src/ui/dock) shows a panel wherever the user moved it --
type Revealer = (app: App, id: string) => boolean;
let revealer: Revealer | null = null;
/** Installed by the dock manager so "Show <panel>" finds a panel that was moved, floated or tabbed elsewhere. */
export function setPanelRevealer(fn: Revealer | null): void {
  revealer = fn;
}

export const panelRegistry = new Registry<PanelDef>({
  kind: 'panel',
  order: (p) => p.order,
  validate(p) {
    if (!p.label.trim()) throw new Error(`panel "${p.id}" needs a label`);
    if (!p.icon) throw new Error(`panel "${p.id}" needs an icon`);
    if (!(p.region in REGION_PREFS)) throw new Error(`panel "${p.id}": region must be left, right or bottom`);
    if (!Number.isFinite(p.order)) throw new Error(`panel "${p.id}" needs a numeric order`);
    if (typeof p.build !== 'function') throw new Error(`panel "${p.id}" needs a build() function`);
  },
});

/** Register a panel and its "Show …" command. Returns the function that removes both. */
export function registerPanel(def: PanelDef): () => void {
  const off = panelRegistry.register(def);
  const keys = REGION_PREFS[def.region];
  try {
    const offCommand = registerCommand({
      id: `panel.${def.id}`,
      label: `Show ${def.label}`,
      category: 'View',
      icon: def.icon,
      description: `Switch to the ${def.label} ${def.region === 'bottom' ? 'dock' : 'panel'}`,
      keywords: ['panel', 'tab', def.region],
      checked: (app) => app.prefs.value[keys.tab] === def.id && !!app.prefs.value[keys.show],
      run: ({ app }) => {
        app.prefs.set({ [keys.tab]: def.id, [keys.show]: true });
        revealer?.(app, def.id);
      },
    });
    return () => {
      offCommand();
      off();
    };
  } catch (e) {
    panelRegistry.unregister(def.id);
    throw e;
  }
}

export const unregisterPanel = (id: string): boolean => {
  if (!panelRegistry.has(id)) return false;
  unregisterCommand(`panel.${id}`);
  return panelRegistry.unregister(id);
};

export const getPanel = (id: string): PanelDef | undefined => panelRegistry.get(id);

/** The tabs of one region in order. */
export function listPanels(region: PanelRegionId): readonly PanelDef[] {
  return panelRegistry.list().filter((p) => p.region === region);
}
