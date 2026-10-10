/**
 * Zones (package ZN) as a UI extension: the Zones tab of the bottom dock, and the commands that add zones, fit the
 * world bounds and mute zone sounds — all of them found by the command palette (Ctrl/⌘+K).
 */
import { registerCommand, registerPanel } from '../../app/registry';
import { zoneSound } from '../../app/zoneSound';
import { ZONE_PRESETS } from '../../model/zonePresets';
import { ZONE_ACTIONS } from '../../model/zones';
import { zonesPanel } from '../zonesPanel';

registerPanel(zonesPanel);

for (const a of ZONE_ACTIONS) {
  registerCommand({
    id: `zones.add.${a.id}`,
    label: `Add ${ZONE_PRESETS[a.id].name}`,
    category: 'Add',
    icon: a.icon,
    description: a.blurb,
    keywords: ['zone', 'trigger', 'volume', a.label.toLowerCase()],
    enabled: (app) => !app.sim.active,
    run: ({ app }) => {
      app.zones.add(a.id);
    },
  });
}

registerCommand({
  id: 'zones.addRace',
  label: 'Add a race: start / finish line and two checkpoints',
  category: 'Add',
  icon: 'flag',
  description: 'A start / finish line for three laps and two numbered checkpoints, in a row along the X axis',
  keywords: ['race', 'lap', 'timing', 'checkpoint', 'zone'],
  enabled: (app) => !app.sim.active,
  run: ({ app }) => {
    const t = app.viewport.controls.target;
    const x0 = Math.round(t.x);
    const z = Math.round(t.z);
    const ids: string[] = [];
    app.store.begin('Add a race');
    const finish = app.zones.add('finish', [x0, 0, z]);
    app.store.update(
      finish.id,
      {
        components: finish.components.map((c) => ({ ...c, params: { ...c.params, laps: 3, startsClock: true } })),
      },
      'Race lines',
    );
    ids.push(finish.id);
    for (let i = 1; i <= 2; i++) ids.push(app.zones.add('checkpoint', [x0 + i * 20, 0, z]).id);
    app.store.end();
    app.store.setSelection(ids);
  },
});

registerCommand({
  id: 'zones.sounds',
  label: 'Zone sounds',
  category: 'World',
  icon: 'speaker',
  description: 'Play the sounds of Sound zones (the Zones tab has the same switch)',
  setting: true,
  keywords: ['mute', 'audio', 'sound'],
  checked: () => !zoneSound.muted,
  run: () => zoneSound.setMuted(!zoneSound.muted),
});

registerCommand({
  id: 'zones.bounds',
  label: 'World bounds',
  category: 'World',
  icon: 'bounds',
  description: 'Keep bodies inside a box: kill sides, soft spring walls, respawn policy',
  setting: true,
  keywords: ['kill', 'respawn', 'boundary', 'limits', 'box', 'void'],
  checked: (app) => app.store.settings.bounds.enabled,
  run: ({ app }) => {
    const b = app.store.settings.bounds;
    app.store.updateSettings(
      { bounds: { ...b, enabled: !b.enabled } },
      b.enabled ? 'Disable world bounds' : 'Enable world bounds',
    );
  },
});
