/** The “Zones” section of the Add tab: one tile per zone action. */
import type { App } from '../app/app';
import { ZONE_PRESETS } from '../model/zonePresets';
import { ZONE_ACTIONS } from '../model/zones';
import { zonePlaceable } from '../app/placeables';
import { h } from './dom';
import { icon } from './icons';
import { bindPlaceable } from './placementTiles';

export function zoneTiles(app: App): HTMLElement[] {
  const tiles = h('div', { class: 'tiles three zone-tiles' });
  for (const a of ZONE_ACTIONS) {
    const preset = ZONE_PRESETS[a.id];
    const t = h(
      'button',
      {
        class: 'tile zone-tile',
        type: 'button',
        title: `${preset.name} — ${a.blurb}\nDrag into the scene, or click and then click where it should go.`,
        dataset: { zone: a.id },
        style: `--zone-color:${a.color}`,
      },
      icon(a.icon),
      a.id === 'none' ? 'Trigger' : a.label.replace(' zone', '').replace(' line', ''),
    );
    bindPlaceable(app, t, `zone:${a.id}`, () => zonePlaceable(a.id)); // -- ghost placement --
    tiles.appendChild(t);
  }
  return [
    h('div', { class: 'group-title' }, 'Zones & race'),
    tiles,
    h(
      'p',
      { class: 'hint-text', style: { padding: '8px 12px 0' } },
      'Zones are invisible triggers: bodies pass through them and something happens — a lap is timed, a body is launched, teleported or respawned. They are drawn as coloured volumes in the editor.',
    ),
  ];
}
