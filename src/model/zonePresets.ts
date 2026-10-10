/**
 * Ready-made zones (ZN): one preset per action, each a correctly set-up *zone body* — a static ghost body with a
 * `zone` component, sized and tinted for its job — and, where an action needs something to point at, the helper
 * bodies too (a teleporter's destination, a spawner's template, the platform a pressure plate moves).
 *
 * The Add tab, the "Add zone" commands, the prefabs and the example scenes all build zones through `buildZone`, so a
 * zone made from any of them behaves exactly the same. Pure data: no engine, no DOM.
 */
import type { Vec3 } from '../core/math';
import { makeComponent } from './componentRegistry';
import { createBody } from './factory';
import type { BodyEntity, ComponentParams } from './types';
import { zoneActionInfo, type ZoneAction } from './zones';

export interface ZonePreset {
  action: ZoneAction;
  /** Base name; the editor makes it unique ("Checkpoint 2"). */
  name: string;
  shape: 'box' | 'sphere' | 'cylinder';
  size: Vec3;
  /** Lift above the ground of the zone's centre; default half its height. */
  lift?: number;
  params: ComponentParams;
}

export const ZONE_PRESETS: Record<ZoneAction, ZonePreset> = {
  none: { action: 'none', name: 'Trigger zone', shape: 'box', size: [4, 3, 4], params: {} },
  checkpoint: {
    action: 'checkpoint',
    name: 'Checkpoint',
    shape: 'box',
    size: [1, 4, 8],
    params: { race: 'race', index: 1 },
  },
  start: { action: 'start', name: 'Start line', shape: 'box', size: [1.2, 3, 8], params: { race: 'race' } },
  finish: {
    action: 'finish',
    name: 'Finish line',
    shape: 'box',
    size: [1.2, 4, 8],
    params: { race: 'race', laps: 1 },
  },
  kill: {
    action: 'kill',
    name: 'Kill zone',
    shape: 'box',
    size: [8, 1.5, 8],
    params: { killMode: 'remove' },
  },
  respawnAt: { action: 'respawnAt', name: 'Respawn point', shape: 'box', size: [3, 2, 3], params: {} },
  teleport: {
    action: 'teleport',
    name: 'Teleporter',
    shape: 'cylinder',
    size: [2.4, 0.3, 2.4],
    params: { velocity: 'keep' },
  },
  launch: {
    action: 'launch',
    name: 'Launch pad',
    shape: 'box',
    size: [3, 0.4, 3],
    params: { launchMode: 'deltaV', launch: [0, 12, 0] },
  },
  gravity: {
    action: 'gravity',
    name: 'Zero-g bubble',
    shape: 'sphere',
    size: [10, 10, 10],
    lift: 5,
    params: { gravity: [0, 0, 0] },
  },
  force: {
    action: 'force',
    name: 'Updraft',
    shape: 'box',
    size: [5, 8, 5],
    params: { forceMode: 'uniform', force: [0, 16, 0], perMass: true },
  },
  spawn: {
    action: 'spawn',
    name: 'Ball emitter',
    shape: 'box',
    size: [1.6, 0.4, 1.6],
    params: { when: 'timer', interval: 1.2, maxAlive: 8, lifetime: 12, spawnOffset: [0, 2.2, 0] },
  },
  sound: { action: 'sound', name: 'Sound zone', shape: 'box', size: [3, 2, 3], params: { sound: 'chime' } },
  score: {
    action: 'score',
    name: 'Coin',
    shape: 'sphere',
    size: [1.6, 1.6, 1.6],
    lift: 1.2,
    params: { points: 10, message: 'Coin!', maxTriggers: 1 },
  },
  toggle: {
    action: 'toggle',
    name: 'Pressure plate',
    shape: 'box',
    size: [3, 0.3, 3],
    params: { componentType: 'zone', switchTo: 'enable', revertOnExit: true },
  },
  custom: {
    action: 'custom',
    name: 'Event zone',
    shape: 'box',
    size: [3, 3, 3],
    params: { customEvent: 'my_event' },
  },
};

export interface ZoneBuildOptions {
  /** Where on the ground the zone goes (its x and z; the height comes from the preset). */
  at?: Vec3;
  /** Makes a name unique in the scene: `(base) => 'Checkpoint 2'`. */
  uniqueName?: (base: string) => string;
  /** Number of the checkpoint (checkpoint zones). */
  index?: number;
  /** Race name (start / checkpoint / finish). */
  race?: string;
  /** Overrides for the zone component's parameters. */
  params?: ComponentParams;
  /** Overrides for the zone body. */
  body?: Partial<BodyEntity>;
}

/** One ghost body carrying a zone component. */
export function zoneEntity(preset: ZonePreset, at: Vec3, o: ZoneBuildOptions = {}): BodyEntity {
  const info = zoneActionInfo(preset.action);
  const lift = preset.lift ?? preset.size[1] / 2;
  const params: ComponentParams = { action: preset.action, ...preset.params, ...(o.params ?? {}) };
  if (o.index !== undefined && preset.action === 'checkpoint') params.index = o.index;
  if (o.race !== undefined && ['checkpoint', 'start', 'finish'].includes(preset.action)) params.race = o.race;
  const base = preset.action === 'checkpoint' && o.index !== undefined ? `${preset.name} ${o.index}` : preset.name;
  return createBody({
    name: o.uniqueName ? o.uniqueName(base) : base,
    shape: { type: preset.shape, size: [...preset.size] },
    position: [at[0], at[1] + lift, at[2]],
    bodyType: 'static',
    ghost: true,
    material: { preset: 'plastic', color: info.color, opacity: 0.25, roughness: 1, metalness: 0 },
    components: [makeComponent('zone', params)],
    ...(o.body ?? {}),
  });
}

/**
 * The bodies of a zone preset placed at ground position `at` (default the origin): the zone first, then whatever it
 * needs — a destination marker, a template, a platform. Component references (`target`, `template`) are wired.
 */
export function buildZone(action: ZoneAction, o: ZoneBuildOptions = {}): BodyEntity[] {
  const preset = ZONE_PRESETS[action];
  const at = o.at ?? [0, 0, 0];
  const unique = o.uniqueName ?? ((s: string) => s);
  const withParams = (p: ComponentParams): ZoneBuildOptions => ({ ...o, params: { ...(o.params ?? {}), ...p } });
  switch (action) {
    case 'respawnAt': {
      const zone = zoneEntity(preset, at, withParams({ offset: [at[0], at[1] + 1.2, at[2]] }));
      return [zone];
    }
    case 'teleport': {
      const marker = createBody({
        name: unique('Teleport target'),
        shape: { type: 'cylinder', size: [2.4, 0.3, 2.4] },
        position: [at[0] + 10, at[1] + 0.15 + 0.4, at[2]],
        bodyType: 'static',
        ghost: true,
        material: { preset: 'plastic', color: '#a78bfa', opacity: 0.18, roughness: 1, metalness: 0 },
      });
      return [zoneEntity(preset, at, withParams({ target: marker.id, offset: [0, 0.6, 0] })), marker];
    }
    case 'spawn': {
      const template = createBody({
        name: unique('Spawn template'),
        shape: { type: 'sphere', size: [0.7, 0.7, 0.7] },
        position: [at[0] + 3, at[1] + 0.35, at[2]],
        material: { preset: 'rubber', color: '#4ade80' },
      });
      return [zoneEntity(preset, at, withParams({ template: template.id })), template];
    }
    case 'toggle': {
      // the plate switches an updraft (itself a zone) on while something stands on it; the updraft starts switched off
      const fan = zoneEntity(ZONE_PRESETS.force, [at[0] + 6, at[1], at[2]], {
        uniqueName: unique,
        params: { label: 'Updraft (plate-controlled)' },
        body: undefined,
      });
      const off = { ...fan, components: fan.components.map((c) => ({ ...c, enabled: false })) };
      return [zoneEntity(preset, at, withParams({ target: off.id, componentType: 'zone' })), off];
    }
    default:
      return [zoneEntity(preset, at, o)];
  }
}

/** The action a body's first zone component has, or null if it is not a zone. */
export function zoneActionOf(body: BodyEntity): ZoneAction | null {
  const c = body.components.find((x) => x.type === 'zone');
  return c ? ((typeof c.params.action === 'string' ? c.params.action : 'none') as ZoneAction) : null;
}
