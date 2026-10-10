/** Adding zones to the scene (the Add tab, the "Add … zone" commands and the Zones menu all come here). */
import { Vector3 } from 'three';
import type { Vec3 } from '../core/math';
import { buildZone, ZONE_PRESETS } from '../model/zonePresets';
import type { BodyEntity } from '../model/types';
import type { ZoneAction } from '../model/zones';
import type { App } from './app';

/** The race a new checkpoint / line joins, and the next checkpoint number in it. */
export function nextCheckpoint(app: App, race = 'race'): number {
  let max = 0;
  for (const z of app.zones.zones()) if (z.action === 'checkpoint' && z.race === race) max = Math.max(max, z.index);
  return max + 1;
}

/**
 * Add a zone of the given action in front of the view (on the ground, snapped like new shapes) as one undo step, with
 * whatever it needs (a destination marker, a template). The zone is selected. Returns the zone body.
 */
export function addZone(app: App, action: ZoneAction, at?: Vec3): BodyEntity {
  const t = app.viewport.controls.target;
  const s = app.prefs.value.snap ? app.prefs.value.snapGrid : 0.01;
  const where: Vec3 = at ?? [Math.round(t.x / s) * s, 0, Math.round(t.z / s) * s];
  const bodies = buildZone(action, {
    at: where,
    uniqueName: (base) => app.store.uniqueName(base),
    index: action === 'checkpoint' ? nextCheckpoint(app) : undefined,
  });
  // a helper body must not take the name of a sibling created in the same call
  const used = new Set<string>();
  const named = bodies.map((b) => {
    let name = b.name;
    for (let i = 2; used.has(name); i++) name = `${b.name} ${i}`;
    used.add(name);
    return name === b.name ? b : { ...b, name };
  });
  app.store.add(named, `Add ${ZONE_PRESETS[action].name}`, false);
  app.store.setSelection([named[0].id]);
  app.effects.ping(new Vector3(where[0], 0, where[2]));
  return named[0];
}
