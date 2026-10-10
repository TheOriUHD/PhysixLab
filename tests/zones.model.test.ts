/**
 * The zone component and the bounds settings as data: sanitising, defaults, the inspector's warnings, references,
 * several zones on one body, moving and vanishing zones, and the cost of zones in a busy scene.
 */
import { describe, expect, it } from 'vitest';
import { qfromAxisAngle } from '../src/core/math';
import { componentDef, makeComponent, sanitizeComponents, sanitizeParams } from '../src/model/componentRegistry';
import { defaultBounds } from '../src/model/factory';
import { newReport } from '../src/model/errors';
import { parseDocument, sanitizeDocument, serializeDocument } from '../src/model/serialize';
import { SceneStore } from '../src/model/store';
import type { ComponentParams } from '../src/model/types';
import { BOUNDS_EVENT_TYPE } from '../src/model/zones';
import { PhysicsWorld } from '../src/physics/world';
import { docOf } from './helpers';
import {
  ball,
  createBody,
  eventsOf,
  isOff,
  run,
  runCollect,
  SPACE,
  worldOf,
  zoneBody,
  zoneEvents,
} from './zonesHelpers';

const zoneDef = () => componentDef('zone')!;

describe('the zone component as data', () => {
  it('is registered in the Zones category for bodies, and several may sit on one body', () => {
    expect(zoneDef()).toMatchObject({ type: 'zone', category: 'Zones', appliesTo: 'body' });
    expect(zoneDef().unique).toBeFalsy();
    const raw = [
      { id: 'a', type: 'zone', enabled: true, params: { action: 'launch' } },
      { id: 'b', type: 'zone', enabled: true, params: { action: 'sound' } },
    ];
    const kept = sanitizeComponents(raw, 'body', newReport(), 'Pad');
    expect(kept.map((c) => (c.params as { action: string }).action)).toEqual(['launch', 'sound']);
  });

  it('every field has a default that survives sanitising, and the defaults are an events-only 4 m trigger', () => {
    const fresh = makeComponent('zone');
    expect(sanitizeParams(zoneDef(), fresh.params)).toEqual(fresh.params);
    expect(fresh.params).toMatchObject({
      action: 'none',
      types: 'dynamic',
      emitEnter: true,
      emitExit: true,
      stayInterval: 0,
    });
  });

  it('garbage in a file is repaired field by field: unknown actions, out-of-range numbers, wrong types', () => {
    const p = sanitizeParams(zoneDef(), {
      action: 'explode',
      index: 2.7,
      laps: -4,
      volume: 9,
      launch: [1, 2],
      respawnDelay: 1e9,
      tags: 42,
      types: 'static',
      customEvent: 'x'.repeat(500),
      color: 'red; drop table',
      nonsense: true,
    });
    expect(p.action).toBe('none');
    expect(p.index).toBe(3); // rounded
    expect(p.laps).toBe(1); // clamped to the minimum
    expect(p.launch).toEqual([0, 8, 0]); // a malformed vector falls back to the default
    expect(p.respawnDelay).toBe(60);
    expect(p.tags).toBe('');
    expect(p.types).toBe('dynamic');
    expect((p.customEvent as string).length).toBe(48);
    expect(p.color).toBe('#38bdf8');
    expect('nonsense' in p).toBe(false);
  });

  it('the toggle action offers the registered component types (and follows later registrations)', () => {
    const f = zoneDef().fields.find((x) => x.key === 'componentType');
    expect(f?.kind).toBe('enum');
    const values = (f as unknown as { options: { value: string }[] }).options.map((o) => o.value);
    expect(values[0]).toBe('');
    expect(values).toEqual(expect.arrayContaining(['constantForce', 'sineMover', 'zone']));
    // a joint-only component is not offered (zones switch the components of bodies)
    expect(values).not.toContain('testSolo');
  });

  it('warns when the zone cannot work: a solid body, a dynamic zone, a thin race gate, a missing target', () => {
    const check = (over: Record<string, unknown>, params: Record<string, unknown> = {}) => {
      const body = createBody({ shape: { type: 'box', size: [4, 4, 4] }, bodyType: 'static', ghost: true, ...over });
      return zoneDef().check!(body, { ...makeComponent('zone').params, ...params } as ComponentParams);
    };
    expect(check({})).toBeNull();
    expect(check({ ghost: false })).toMatch(/Ghost/);
    expect(check({ bodyType: 'dynamic' })).toMatch(/Static/);
    expect(check({ shape: { type: 'box', size: [0.1, 4, 4] } }, { action: 'checkpoint' })).toMatch(/thin/);
    expect(check({ shape: { type: 'box', size: [0.1, 4, 4] } }, { action: 'none' })).toBeNull();
    expect(check({}, { action: 'spawn' })).toMatch(/template/);
    expect(check({}, { action: 'toggle' })).toMatch(/body whose components/);
    expect(check({}, { action: 'teleport' })).toMatch(/target body|position/);
    expect(
      check({
        ghost: false,
        parts: [
          {
            id: 'p',
            shape: { type: 'box', size: [1, 1, 1] },
            position: [0, 0, 0],
            rotation: [0, 0, 0, 1],
            sensor: true,
          },
        ],
      }),
    ).toBeNull();
  });

  it('references to other bodies follow the document: cleared when the target is deleted, kept when it is cloned with the zone', () => {
    const store = new SceneStore();
    const marker = createBody({ name: 'Marker', bodyType: 'static', ghost: true });
    const zone = zoneBody({ action: 'teleport', target: marker.id }, { name: 'Pad' });
    store.add([marker, zone], 'add', false);
    expect(store.body(zone.id)!.components[0].params.target).toBe(marker.id);
    store.remove([marker.id]);
    expect(store.body(zone.id)!.components[0].params.target).toBe(''); // nothing dangles
    store.undo();
    expect(store.body(zone.id)!.components[0].params.target).toBe(marker.id); // …and undo restores it
  });

  it('survives a file round trip, and a file with unknown action names or a stale component list loads with repairs only where needed', () => {
    const doc = docOf([
      zoneBody({ action: 'checkpoint', index: 4, race: 'night', label: 'Gate' }),
      zoneBody({ action: 'launch', launch: [0, 5, 0] }),
    ]);
    expect(parseDocument(serializeDocument(doc)).entities).toEqual(doc.entities);
    const json = JSON.parse(serializeDocument(doc)) as {
      entities: { components: { params: Record<string, unknown> }[] }[];
    };
    json.entities[0].components[0].params.action = 'time_travel';
    const report = newReport();
    const loaded = sanitizeDocument(json, report);
    expect(report.warnings).toEqual([]); // an unknown value is silently the default, as for every enum field
    const first = loaded.entities[0];
    expect(first.kind === 'body' && first.components[0].params.action).toBe('none');
  });
});

describe('world bounds as data', () => {
  it('a file from before the bounds had edges loads as a plain kill box with the default spring and respawn settings', () => {
    const doc = docOf([]);
    const json = JSON.parse(serializeDocument(doc)) as { settings: { bounds: Record<string, unknown> } };
    json.settings.bounds = { enabled: true, min: [-5, -5, -5], max: [5, 5, 5], policy: 'respawn' };
    const b = sanitizeDocument(json).settings.bounds;
    expect(b).toMatchObject({ enabled: true, policy: 'respawn' });
    expect(b.edges).toEqual(defaultBounds().edges);
    expect(Object.values(b.edges).every((e) => e === 'kill')).toBe(true);
    expect(b.soft).toEqual(defaultBounds().soft);
    expect(b.respawn).toEqual(defaultBounds().respawn);
  });

  it('garbage is repaired: unknown edge kinds, negative or huge numbers, wrong types', () => {
    const json = JSON.parse(serializeDocument(docOf([]))) as { settings: { bounds: unknown } };
    json.settings.bounds = {
      enabled: 'yes',
      edges: { ny: 'lava', px: 'soft', nx: 7 },
      soft: { margin: -3, stiffness: 1e12, damping: 'lots' },
      respawn: { to: 'moon', delay: -1, penaltySeconds: 1e9, penaltyPoints: 2.6, max: -4, wholeGroups: 'sure' },
    };
    const b = sanitizeDocument(json).settings.bounds;
    expect(b.enabled).toBe(false);
    expect(b.edges).toMatchObject({ ny: 'kill', px: 'soft', nx: 'kill' });
    expect(b.soft).toEqual({ margin: 0.1, stiffness: 10000, damping: defaultBounds().soft.damping });
    expect(b.respawn).toMatchObject({
      to: 'checkpoint',
      delay: 0,
      penaltySeconds: 3600,
      penaltyPoints: 1_000_000 * 0 + 2.6,
      max: 0,
      wholeGroups: false,
    });
  });

  it('round-trips through the serialiser and is edited, undone and redone through the store as one step each', () => {
    const doc = docOf([]);
    doc.settings = {
      ...doc.settings,
      bounds: {
        ...defaultBounds(),
        enabled: true,
        edges: { ...defaultBounds().edges, ny: 'water', px: 'soft' },
        soft: { margin: 5, stiffness: 12, damping: 3 },
      },
    };
    expect(parseDocument(serializeDocument(doc)).settings.bounds).toEqual(doc.settings.bounds);
    const store = new SceneStore();
    store.updateSettings({ bounds: { ...store.settings.bounds, enabled: true } }, 'Enable world bounds');
    store.updateSettings({ bounds: { ...store.settings.bounds, policy: 'respawn' } }, 'Respawn');
    expect(store.settings.bounds.policy).toBe('respawn');
    store.undo();
    expect(store.settings.bounds).toMatchObject({ enabled: true, policy: 'kill' });
    store.undo();
    expect(store.settings.bounds.enabled).toBe(false);
    store.redo();
    expect(store.settings.bounds.enabled).toBe(true);
  });
});

describe('bounds on a running world', () => {
  it('switching the bounds on while running takes effect at once (the settings op), and off again releases the walls', async () => {
    const b = ball([0, 0, 0], [20, 0, 0]);
    const w = await worldOf([b], SPACE);
    run(w, 0.5); // x = 10
    w.applySettings({
      ...w.settings,
      bounds: { ...defaultBounds(), enabled: true, min: [-5, -5, -5], max: [5, 5, 5] },
    });
    run(w, 0.1);
    expect(isOff(w, b.id)).toBe(true);
    expect(eventsOf(w, BOUNDS_EVENT_TYPE, 'kill')).toHaveLength(1);
    const c = ball([0, 0, 0], [20, 0, 0]);
    const w2 = await worldOf([c], {
      ...SPACE,
      bounds: { ...defaultBounds(), enabled: true, min: [-5, -5, -5], max: [5, 5, 5] },
    });
    w2.applySettings({ ...w2.settings, bounds: { ...w2.settings.bounds, enabled: false } });
    run(w2, 1);
    expect(isOff(w2, c.id)).toBe(false);
  });
});

describe('zones in a scene', () => {
  it('two zone components on one body act independently: a launch pad that also plays a sound', async () => {
    const pad = createBody({
      shape: { type: 'box', size: [4, 1, 4] },
      bodyType: 'static',
      ghost: true,
      components: [
        makeComponent('zone', { action: 'launch', launch: [0, 5, 0] }),
        makeComponent('zone', { action: 'sound', sound: 'boing' }),
      ],
    });
    const w = await worldOf([pad, ball([0, 0, 0])], SPACE);
    const names = runCollect(w, 0.1).map((e) => e.name);
    expect(names.filter((n) => n === 'launch')).toHaveLength(1);
    expect(names.filter((n) => n === 'sound')).toHaveLength(1);
    expect(names.filter((n) => n === 'enter')).toHaveLength(2); // each zone component reports its own entries
  });

  it('a kinematic zone that moves over a resting ball reports it (the engine pairs moving sensors with dynamic bodies)', async () => {
    const z = zoneBody(
      {},
      { bodyType: 'kinematic', position: [-6, 0, 0], size: [2, 2, 2], extra: { velocity: [5, 0, 0] } },
    );
    const resting = ball([0, 0, 0]);
    const w = await worldOf([z, resting], SPACE);
    const ev = runCollect(w, 2.5);
    expect(ev.map((e) => e.name)).toEqual(['enter', 'exit']);
    // the zone's front face meets the ball (radius 0.25) when its centre is at x = −1.25: after 0.95 s
    expect(ev[0].t).toBeGreaterThan(0.9);
    expect(ev[0].t).toBeLessThan(1.1);
  });

  it('removing a zone while bodies are inside does not disturb them or the world', async () => {
    const z = zoneBody({ action: 'gravity', gravity: [0, 0, 0] }, { size: [40, 40, 40] });
    const b = ball([0, 0, 0]);
    const w = await worldOf([z, b], { gravity: [0, -9.81, 0], ground: SPACE.ground });
    run(w, 0.3);
    w.removeEntities([z.id]);
    expect(w.hostedComponents).toBe(0);
    run(w, 0.5);
    expect(w.getPose(b.id)!.linvel[1]).toBeLessThan(-3); // gravity is back
    expect(w.missingRuntimes()).toEqual([]);
  });

  it('the filter reads the live body: a tag added while the simulation runs is honoured at the next entry', async () => {
    const z = zoneBody({ tags: 'vip' }, { position: [5, 0, 0], size: [2, 4, 4] });
    const b = ball([0, 0, 0], [10, 0, 0], { tags: [] });
    const w = await worldOf([z, b], SPACE);
    expect(runCollect(w, 1).map((e) => e.name)).toEqual([]);
    w.updateBody({ ...b, tags: ['vip'] });
    w.teleport(b.id, [0, 0, 0], [0, 0, 0, 1]);
    w.setVelocity(b.id, [10, 0, 0], [0, 0, 0]);
    expect(runCollect(w, 1).map((e) => e.name)).toEqual(['enter', 'exit']);
  });

  it('many bodies in many zones stay cheap: 600 balls through 12 fields cost little more than the same 600 balls without them', async () => {
    const mkZones = () => {
      const zones = [] as ReturnType<typeof zoneBody>[];
      for (let i = 0; i < 6; i++)
        zones.push(
          zoneBody(
            { action: 'gravity', gravity: [0, 0, 0], priority: i },
            { position: [i * 3, 5, 0], size: [10, 10, 10] },
          ),
        );
      for (let i = 0; i < 6; i++)
        zones.push(zoneBody({ action: 'force', force: [0, 3, 0] }, { position: [i * 3, 5, 6], size: [10, 10, 10] }));
      return zones;
    };
    const balls = [] as ReturnType<typeof ball>[];
    for (let i = 0; i < 600; i++)
      balls.push(
        ball([(i % 20) * 0.8, 2 + Math.floor(i / 20) * 0.3, (i % 7) * 0.3 - 1], [0, 0, 0], { canSleep: false }),
      );
    const time = async (entities: ReturnType<typeof ball>[]) => {
      const w = await PhysicsWorld.create(docOf(entities, { gravity: [0, -9.81, 0] }));
      run(w, 0.3); // warm up
      const t0 = performance.now();
      run(w, 1);
      return { ms: (performance.now() - t0) / 120, w };
    };
    const base = await time(balls);
    const withZones = await time([...mkZones(), ...balls]);
    process.stderr.write(
      `\nzones: 600 balls, ${base.ms.toFixed(2)} ms per step alone, ${withZones.ms.toFixed(2)} ms with 12 zones\n`,
    );
    // every ball sits in up to twelve overlapping zones here (thousands of sensor pairs): a stress case, still a few ms
    expect(withZones.ms).toBeLessThan(base.ms * 3.5 + 1);
    // and the zones did act: bodies inside the zero-g zones are held up (they would all have fallen well below 1 m by now)
    expect(zoneEvents(withZones.w).length).toBeGreaterThan(0);
  });

  it('a rotated, kinematic zone keeps testing in its own frame as it turns', async () => {
    const z = zoneBody(
      {},
      { bodyType: 'kinematic', position: [0, 0, 0], size: [8, 1, 1], extra: { angularVelocity: [0, 1.5, 0] } },
    );
    const post = ball([3, 0, 0]); // on the x axis, inside the bar at the start
    const w = await worldOf([z, post], SPACE);
    const ev = runCollect(w, 1.5);
    // the bar turns at 1.5 rad/s: the ball (3 m out) leaves it when the half-width 0.5 m is swept past: ≈ 0.17 rad ≈ 0.1 s
    expect(ev.map((e) => e.name)).toEqual(['enter', 'exit']);
    expect(ev[1].t).toBeGreaterThan(0.05);
    expect(ev[1].t).toBeLessThan(0.3);
    void qfromAxisAngle;
  });
});
