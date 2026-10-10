/**
 * Zones & races (package ZN): two example scenes and the zone prefabs.
 *
 *  - **Zones playground** — five lanes, each showing a zone at work: a launch pad and a coin, a teleporter, a zero-g
 *    bubble, a kill zone that sends the ball back to its start for ever, and an emitter feeding an updraft.
 *  - **Drag strip** — the drivable car (one group = one racer) on a straight with a start line, two checkpoints and a
 *    finish line, the world bounds as soft side walls and a kill plane that respawns the car with a time penalty.
 *
 * Both are built from the same zone presets the Add tab uses (`model/zonePresets.ts`).
 */
import type { Vec3 } from '../../core/math';
import { buildCar } from '../templates';
import { Builder } from '../builder';
import { createGroup } from '../factory';
import { buildZone, zoneEntity, ZONE_PRESETS } from '../zonePresets';
import type { BodyEntity, Entity, SceneDocument } from '../types';
import { zoneActionInfo, type ZoneAction } from '../zones';
import { registerPrefab, registerTemplate } from './registry';

const CATEGORY = 'Zones & races';

// ── Zones playground ─────────────────────────────────────────────────────────────────────────────────

function zonesPlayground(): SceneDocument {
  const b = new Builder('Zones playground');
  b.doc.settings.ground.halfSize = 40;
  const lane = (n: number): number => (n - 2) * 7; // z of lane 0 … 4
  const runner = (name: string, at: Vec3, v: Vec3, color: string): BodyEntity =>
    b.body(name, 'sphere', [0.8, 0.8, 0.8], at, {
      velocity: v,
      material: { preset: 'rubber', color },
      canSleep: false,
      tags: ['runner'],
    });
  const add = (zs: BodyEntity[]): BodyEntity => {
    b.doc.entities.push(...zs);
    return zs[0];
  };

  // Lane 0: a launch pad throws the ball over a coin (zones: launch, score, sound)
  runner('Runner A', [-12, 0.4, lane(0)], [7, 0, 0], '#fb923c');
  add(buildZone('launch', { at: [-5, 0, lane(0)], params: { launch: [2, 9, 0], label: 'Launch pad' } }));
  add(
    buildZone('score', {
      at: [4, 2.4, lane(0)],
      params: { points: 25, message: 'Coin! +25', maxTriggers: 0, label: 'Coin' },
    }),
  );
  add(
    buildZone('sound', {
      at: [10, 0, lane(0)],
      params: { sound: 'boing', label: 'Boing gate' },
      // tall, so the ball flying over the ground at any height goes through it
      body: { position: [10, 4, lane(0)], shape: { type: 'box', size: [2, 8, 4] } },
    }),
  );

  // Lane 1: a teleporter skips the ball ten metres ahead, keeping its speed
  runner('Runner B', [-12, 0.4, lane(1)], [6, 0, 0], '#a78bfa');
  const [pad, marker] = buildZone('teleport', { at: [-4, 0, lane(1)] });
  b.doc.entities.push(pad, { ...marker, position: [8, 0.55, lane(1)] });

  // Lane 2: a zero-g bubble — the ball falls in, stops falling and floats on
  runner('Runner C', [-6, 4.5, lane(2)], [3, 0, 0], '#38bdf8');
  add(buildZone('gravity', { at: [0, 0, lane(2)], params: { label: 'Zero-g bubble' } }));

  // Lane 3: a kill zone that respawns the ball at its start, over and over
  runner('Runner D', [-12, 0.4, lane(3)], [8, 0, 0], '#ff5d73');
  add(
    buildZone('kill', {
      at: [4, 0, lane(3)],
      params: { killMode: 'respawn', respawnTo: 'start', respawnDelay: 0.6, label: 'Trap' },
    }),
  );

  // Lane 4: an emitter drops balls into an updraft
  add(buildZone('force', { at: [4, 0, lane(4)], params: { label: 'Updraft' } }));
  add(
    buildZone('spawn', { at: [-4, 6, lane(4)], params: { label: 'Emitter', interval: 1, spawnOffset: [0, -0.5, 0] } }),
  );
  return b.done();
}

registerTemplate({
  id: 'zones-playground',
  name: 'Zones playground',
  category: CATEGORY,
  blurb:
    'Five lanes, five zones: a launch pad and a coin, a teleporter, a zero-g bubble, an endless kill-and-respawn trap, an emitter and an updraft.',
  hint: 'Press Simulate and watch the coloured zones act on the balls. Open the Zones tab at the bottom to see the events they raise; select a zone to change what it does.',
  view: { position: [4, 12, 30], target: [2, 1.5, 0] },
  build: zonesPlayground,
});

// ── Drag strip ───────────────────────────────────────────────────────────────────────────────────────

/** The drivable car as one group (one racer), a straight, race lines and world bounds. */
export function dragStrip(): SceneDocument {
  const doc = buildCar(false);
  doc.name = 'Drag strip';
  doc.settings.ground.halfSize = 100;
  const group = createGroup({ name: 'Car' });
  const entities: Entity[] = [group];
  for (const e of doc.entities) entities.push(e.kind === 'body' ? { ...e, parent: group.id } : e);
  const gate = (action: ZoneAction, x: number, params: Record<string, unknown>, name: string): BodyEntity => {
    const z = zoneEntity(ZONE_PRESETS[action], [x, 0, 0], {
      params: { race: 'drag', unit: 'group', ...params },
      uniqueName: () => name,
    });
    return { ...z, shape: { ...z.shape, size: [1.2, 4, 12] }, position: [x, 2, 0] };
  };
  entities.push(
    gate('start', 4, {}, 'Start line'),
    gate('checkpoint', 28, { index: 1 }, 'Checkpoint 1'),
    gate('checkpoint', 52, { index: 2 }, 'Checkpoint 2'),
    gate('finish', 76, { laps: 1 }, 'Finish line'),
  );
  doc.entities = entities;
  // The strip is 100 m long: soft walls at the sides and the far end, a kill plane under it that sends the car back
  doc.settings.bounds = {
    ...doc.settings.bounds,
    enabled: true,
    min: [-14, -4, -16],
    max: [100, 40, 16],
    policy: 'respawn',
    edges: { nx: 'soft', px: 'soft', ny: 'kill', py: 'open', nz: 'soft', pz: 'soft' },
    soft: { margin: 4, stiffness: 30, damping: 5 },
    respawn: { to: 'checkpoint', delay: 1, penaltySeconds: 5, penaltyPoints: 0, max: 0, wholeGroups: true },
  };
  return doc;
}

registerTemplate({
  id: 'drag-strip',
  name: 'Drag strip',
  category: CATEGORY,
  blurb:
    'The drivable car on a straight with a start line, two checkpoints and a finish line — timed to the millisecond. Soft side walls and a respawn floor keep it on the track.',
  hint: 'Press Simulate, then hold W to drive (A / D steer). The race board on top shows the clock; the Zones tab keeps the splits and the events.',
  view: { position: [-8, 5, 12], target: [8, 0.5, 0] },
  follow: 'Chassis',
  build: dragStrip,
});

// ── prefabs ──────────────────────────────────────────────────────────────────────────────────────────

const PREFAB_ACTIONS: ZoneAction[] = ['launch', 'teleport', 'kill', 'gravity', 'force', 'score', 'toggle', 'spawn'];

registerPrefab({
  id: 'zones-race-gates',
  name: 'Race gates',
  icon: 'flag',
  blurb: 'A start / finish line for three laps and two numbered checkpoints, 15 m apart along X.',
  category: CATEGORY,
  build(): Entity[] {
    const finish = zoneEntity(ZONE_PRESETS.finish, [0, 0, 0], {
      params: { laps: 3, startsClock: true },
      uniqueName: () => 'Start / finish line',
    });
    const cps = [1, 2].map((i) =>
      zoneEntity(ZONE_PRESETS.checkpoint, [i * 15, 0, 0], { index: i, uniqueName: () => `Checkpoint ${i}` }),
    );
    return [finish, ...cps];
  },
});

for (const action of PREFAB_ACTIONS) {
  const preset = ZONE_PRESETS[action];
  const info = zoneActionInfo(action);
  registerPrefab({
    id: `zones-${action}`,
    name: preset.name,
    icon: info.icon,
    blurb: info.blurb,
    category: CATEGORY,
    build: () => buildZone(action),
  });
}
