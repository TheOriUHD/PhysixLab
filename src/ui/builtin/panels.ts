/**
 * The built-in panels as registrations: the library tabs on the left (Add, Prefabs, Maps, Scenes), the editing tabs
 * on the right (Inspector, Outliner, World) and the telemetry dock at the bottom (Energy, Selection).
 */
import type { PanelDef } from '../../app/registry/panels';
import { registerPanel } from '../../app/registry/panels';
import { Inspector } from '../inspector';
import { LIBRARY_PANELS } from '../libraryPanels';
import { Outliner } from '../outliner';
import { energyPanel, selectionPanel } from '../telemetry';
import { buildWorldPanel } from '../worldPanel';

const inspectorPanel: PanelDef = {
  id: 'inspector',
  label: 'Inspector',
  icon: 'settings',
  region: 'right',
  order: 10,
  title: 'Properties of the selection',
  build: (app) => ({ el: new Inspector(app).el }),
};

const outlinerPanel: PanelDef = {
  id: 'outliner',
  label: 'Outliner',
  icon: 'layers',
  region: 'right',
  order: 20,
  title: 'Every object in the scene, as a tree',
  build: (app) => {
    const outliner = new Outliner(app);
    return { el: outliner.el, onShow: () => outliner.activate() };
  },
};

const worldPanel: PanelDef = {
  id: 'world',
  label: 'World',
  icon: 'zap',
  region: 'right',
  order: 30,
  title: 'Gravity, ground, simulation rate and the rest of the scene settings',
  build: (app) => {
    // Selecting something while on the World tab: jump to the inspector for convenience.
    app.store.on('selection', () => {
      if (app.store.selection.length && app.prefs.value.rightTab === 'world') app.prefs.set({ rightTab: 'inspector' });
    });
    return { el: buildWorldPanel(app) };
  },
};

export function registerBuiltinPanels(): void {
  for (const p of [...LIBRARY_PANELS, inspectorPanel, outlinerPanel, worldPanel, energyPanel, selectionPanel])
    registerPanel(p);
}
