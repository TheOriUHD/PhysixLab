/**
 * A docked region (left, right or bottom) generated from the panel registry (`src/app/registry/panels.ts`).
 *
 * The region is a host for dock groups (`src/ui/dock/`): by default one group with one tab per registered panel of the
 * region, shown per the region's preference (`leftTab` …) and following the registry live. Panels can also be dragged
 * between regions, tabbed, split, floated and maximised; see `DockManager`. The panel API is unchanged:
 * `PanelView.onShow` runs each time a panel becomes the visible tab, `PanelView.toolbar` is shown at the right end
 * of the tab strip while it is.
 */
import type { App } from '../app/app';
import type { PanelRegionId } from '../app/registry/panels';
import { getDock } from './dock/dockManager';

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

export function buildPanelRegion(app: App, o: RegionOptions): HTMLElement {
  return getDock(app).attachRegion(o);
}
