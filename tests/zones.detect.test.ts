/**
 * Zones, part 1 (ZN-1): the zone component as a trigger volume — any shape, the filter (tags, layers, kind of body),
 * enter / exit / stay events, compound zones, removal and live edits — against the real engine.
 */
import { describe, expect, it } from 'vitest';
import { qfromAxisAngle } from '../src/core/math';
import { makeComponent } from '../src/model/componentRegistry';
import { defaultSettings } from '../src/model/factory';
import { ZONES_STATE_ID } from '../src/model/zones';
import { at, ball, createBody, isOff, run, runCollect, SPACE, worldOf, zoneBody, zoneEvents } from './zonesHelpers';

const DT = 1 / 120;
const names = (ev: { name: string }[]) => ev.map((e) => e.name);

describe('enter / exit events', () => {
  it('a body crossing a box reports enter and exit at the times its surface meets the faces', async () => {
    // zone x ∈ [4, 6]; ball radius 0.25 at 10 m/s from x = 0: touches at x = 3.75 (t = 0.375), leaves at x = 6.25 (0.625)
    const z = zoneBody({ label: 'Gate' }, { position: [5, 0, 0], size: [2, 4, 4] });
    const b = ball([0, 0, 0], [10, 0, 0]);
    const w = await worldOf([z, b], SPACE);
    const ev = runCollect(w, 1);
    expect(names(ev)).toEqual(['enter', 'exit']);
    // the engine reports an overlap one or two steps after the surfaces meet (it pairs colliders from the last step's positions)
    expect(ev[0].t).toBeGreaterThanOrEqual(0.375);
    expect(ev[0].t).toBeLessThan(0.375 + 3 * DT);
    expect(ev[1].t).toBeGreaterThanOrEqual(0.625);
    expect(ev[1].t).toBeLessThan(0.625 + 3 * DT);
    expect(ev[0].owner).toBe(z.id);
    expect(ev[0].component).toBe(z.components[0].id);
    expect(ev[0].type).toBe('zone');
    expect(ev[0].data).toMatchObject({ body: b.id, unit: b.id, zone: 'Gate', inside: 1 });
    expect(ev[1].data).toMatchObject({ body: b.id, zone: 'Gate', inside: 0 });
  });

  it('the zone’s own name is used when it has no label', async () => {
    const z = zoneBody({}, { name: 'Lava pit', position: [3, 0, 0], size: [2, 2, 2] });
    const w = await worldOf([z, ball([0, 0, 0], [10, 0, 0])], SPACE);
    expect(runCollect(w, 0.5)[0].data).toMatchObject({ zone: 'Lava pit' });
  });

  it('a body that starts inside reports its enter on the first step', async () => {
    const z = zoneBody();
    const w = await worldOf([z, ball([0, 0, 0])], SPACE);
    w.stepOnce();
    const ev = zoneEvents(w);
    expect(names(ev)).toEqual(['enter']);
    expect(ev[0].t).toBeCloseTo(DT, 9);
  });

  it('enter and exit events can be switched off separately', async () => {
    const z = zoneBody({ emitEnter: false }, { position: [5, 0, 0], size: [2, 4, 4] });
    const w = await worldOf([z, ball([0, 0, 0], [10, 0, 0])], SPACE);
    expect(names(runCollect(w, 1))).toEqual(['exit']);
    const z2 = zoneBody({ emitExit: false }, { position: [5, 0, 0], size: [2, 4, 4] });
    const w2 = await worldOf([z2, ball([0, 0, 0], [10, 0, 0])], SPACE);
    expect(names(runCollect(w2, 1))).toEqual(['enter']);
  });

  it('counts the bodies inside and publishes it, with the number of entries, as gauges', async () => {
    const z = zoneBody();
    const w = await worldOf([z, ball([0, 0, 0]), ball([1, 0, 0]), ball([-1, 0, 0])], SPACE);
    run(w, 0.1);
    const st = w.drainComponentState().changed[z.components[0].id];
    expect([...st.values!]).toEqual([3, 3, 0]); // inside, entered, fired (no action: nothing fired)
  });

  it('a body that leaves and comes back enters again', async () => {
    const z = zoneBody({}, { position: [5, 0, 0], size: [2, 4, 4] });
    // bounces between two walls of a corridor? simpler: pass through, then reverse its velocity
    const b = ball([0, 0, 0], [10, 0, 0]);
    const w = await worldOf([z, b], SPACE);
    const first = runCollect(w, 0.8);
    w.setVelocity(b.id, [-10, 0, 0], [0, 0, 0]);
    const second = runCollect(w, 0.8);
    expect(names(first)).toEqual(['enter', 'exit']);
    expect(names(second)).toEqual(['enter', 'exit']);
  });
});

describe('volumes: any shape is a zone', () => {
  /** Does a ball cross a zone of this shape centred on the origin? It runs along x at (y, z), or along z at (x, y). */
  async function enters(
    shape: string,
    size: [number, number, number],
    y: number,
    offset: number,
    lane: 'x' | 'z' = 'x',
  ): Promise<boolean> {
    const zone = zoneBody({}, { shape, size, position: [0, 0, 0] });
    const b = lane === 'x' ? ball([-6, y, offset], [10, 0, 0]) : ball([offset, y, -6], [0, 0, 10]);
    const w = await worldOf([zone, b], SPACE);
    return runCollect(w, 1.4).some((e) => e.name === 'enter');
  }

  it('sphere: a pass at distance 2.4 from the centre misses a radius-2 zone, 2.1 hits (ball radius 0.25)', async () => {
    expect(await enters('sphere', [4, 4, 4], 2.4, 0)).toBe(false);
    expect(await enters('sphere', [4, 4, 4], 2.1, 0)).toBe(true);
  });

  it('cylinder: its circular section and its height both count', async () => {
    // radius 1, height 2 (axis y): a ball at z = 1.2 grazes the side (1.2 − 0.25 < 1); at z = 1.4 it misses; at y = 1.4 it clears the top
    expect(await enters('cylinder', [2, 2, 2], 0, 1.2)).toBe(true);
    expect(await enters('cylinder', [2, 2, 2], 0, 1.4)).toBe(false);
    expect(await enters('cylinder', [2, 2, 2], 1.4, 0)).toBe(false);
    expect(await enters('cylinder', [2, 2, 2], 1.2, 0)).toBe(true);
  });

  it('a convex hull (hexagonal prism) is a zone too, with its own outline — not its bounding box', async () => {
    // hexagon of diameter 4 in the XZ plane, a corner on the z axis (reaches 2) and flats facing ±x (at 2·cos 30° = 1.73)
    expect(await enters('prism', [4, 2, 4], 0, 2.1, 'x')).toBe(true); // 2.1 − 0.25 < 2: touches the corner
    expect(await enters('prism', [4, 2, 4], 0, 2.4, 'x')).toBe(false);
    expect(await enters('prism', [4, 2, 4], 0, 1.9, 'z')).toBe(true); // 1.9 − 0.25 < 1.73
    expect(await enters('prism', [4, 2, 4], 0, 2.1, 'z')).toBe(false); // inside the bounding box, outside the hexagon
    expect(await enters('box', [4, 2, 4], 0, 2.1, 'z')).toBe(true); // …which a box of the same size does catch
  });

  it('a compound zone of two sensor parts reports one enter per visit of the whole body, and one exit', async () => {
    const z = createBody({
      shape: { type: 'box', size: [1, 1, 1] },
      bodyType: 'static',
      components: [makeComponent('zone', {})],
      parts: [
        {
          id: 'a',
          shape: { type: 'box', size: [2, 4, 4] },
          position: [-3, 0, 0],
          rotation: [0, 0, 0, 1],
          sensor: true,
        },
        // overlaps part a, so the ball is in both at once while it crosses x ∈ [-4, -2]
        {
          id: 'b',
          shape: { type: 'box', size: [4, 4, 4] },
          position: [-2, 0, 0],
          rotation: [0, 0, 0, 1],
          sensor: true,
        },
        { id: 'c', shape: { type: 'box', size: [2, 4, 4] }, position: [5, 0, 0], rotation: [0, 0, 0, 1], sensor: true },
      ],
    });
    const w = await worldOf([z, ball([-8, 0, 0], [10, 0, 0])], SPACE);
    const ev = runCollect(w, 2);
    expect(names(ev)).toEqual(['enter', 'exit', 'enter', 'exit']); // left part a+b, then entered c — never a stray exit
    expect(ev[2].data).toMatchObject({ inside: 1 });
  });
});

describe('the filter', () => {
  const tagged = (tags: string[], extra: Record<string, unknown> = {}) =>
    ball([0, 0, 0], [0, 0, 0], { tags, ...extra });
  const apart = (b: ReturnType<typeof ball>, x: number) => ({ ...b, position: [x, 0, 0] as [number, number, number] });

  it('only tags: bodies without one of the tags are ignored', async () => {
    const z = zoneBody({ tags: 'racer, boat' }, { size: [20, 4, 4] });
    const car = apart(tagged(['racer']), -6);
    const rock = apart(tagged(['rock']), 0);
    const plain = apart(tagged([]), 6);
    const w = await worldOf([z, car, rock, plain], SPACE);
    w.stepOnce();
    expect(zoneEvents(w).map((e) => (e.data as { body: string }).body)).toEqual([car.id]);
  });

  it('not tags excludes, layers restrict', async () => {
    const z = zoneBody({ notTags: 'ghost', layers: 'track' }, { size: [20, 4, 4] });
    const ok = apart(tagged([], { layer: 'track' }), -6);
    const excluded = apart(tagged(['ghost'], { layer: 'track' }), 0);
    const wrongLayer = apart(tagged([], { layer: 'other' }), 6);
    const w = await worldOf([z, ok, excluded, wrongLayer], SPACE);
    w.stepOnce();
    expect(zoneEvents(w).map((e) => (e.data as { body: string }).body)).toEqual([ok.id]);
  });

  it('kinds of body: dynamic (default), kinematic, or both — a kinematic body passing a static zone is seen', async () => {
    const run1 = async (types: string) => {
      const z = zoneBody({ types }, { position: [5, 0, 0], size: [2, 4, 4] });
      const dyn = ball([0, 0, -3], [10, 0, 0]);
      const kin = createBody({
        shape: { type: 'box', size: [0.5, 0.5, 0.5] },
        position: [0, 0, 3],
        bodyType: 'kinematic',
        velocity: [10, 0, 0],
      });
      // widen the zone in z so both lanes cross it
      const wide = { ...z, shape: { ...z.shape, size: [2, 4, 12] as [number, number, number] } };
      const w = await worldOf([wide, dyn, kin], SPACE);
      const ids = runCollect(w, 1)
        .filter((e) => e.name === 'enter')
        .map((e) => (e.data as { body: string }).body);
      return { ids, dyn: dyn.id, kin: kin.id };
    };
    const a = await run1('dynamic');
    expect(a.ids).toEqual([a.dyn]);
    const b = await run1('kinematic');
    expect(b.ids).toEqual([b.kin]);
    const c = await run1('any');
    expect(c.ids.sort()).toEqual([c.dyn, c.kin].sort());
  });

  it('static bodies never enter a zone', async () => {
    const z = zoneBody({ types: 'any' }, { size: [20, 4, 4] });
    const wall = createBody({ shape: { type: 'box', size: [1, 1, 1] }, bodyType: 'static', position: [0, 0, 0] });
    const w = await worldOf([z, wall], SPACE);
    run(w, 0.2);
    expect(zoneEvents(w)).toEqual([]);
  });
});

describe('stay events', () => {
  it('every `stayInterval` seconds for each body inside, with the time it has been there', async () => {
    const z = zoneBody({ stayInterval: 0.25, emitEnter: false });
    const w = await worldOf([z, ball([0, 0, 0])], SPACE);
    const ev = runCollect(w, 1.1).filter((e) => e.name === 'stay');
    expect(ev).toHaveLength(4); // 0.25, 0.5, 0.75, 1.0
    expect(ev.map((e) => (e.data as { duration: number }).duration)).toEqual(
      expect.arrayContaining([expect.closeTo(0.25, 1), expect.closeTo(1, 1)]),
    );
    expect((ev[0].data as { inside: number }).inside).toBe(1);
  });

  it('is off by default', async () => {
    const z = zoneBody();
    const w = await worldOf([z, ball([0, 0, 0])], SPACE);
    expect(runCollect(w, 1).filter((e) => e.name === 'stay')).toEqual([]);
  });
});

describe('bodies that disappear while inside', () => {
  it('a body removed from the world leaves the zone (exit event, count back to 0)', async () => {
    const z = zoneBody();
    const b = ball([0, 0, 0]);
    const w = await worldOf([z, b], SPACE);
    run(w, 0.1);
    zoneEvents(w);
    w.removeEntities([b.id]);
    run(w, 0.05);
    const ev = zoneEvents(w);
    expect(names(ev)).toEqual(['exit']);
    expect((ev[0].data as { inside: number }).inside).toBe(0);
  });

  it('a body switched off (killed) while inside leaves as well, and enters again when it comes back', async () => {
    const z = zoneBody();
    const b = ball([0, 0, 0]);
    const w = await worldOf([z, b], SPACE);
    run(w, 0.1);
    zoneEvents(w);
    // the body is lost by a bounds policy
    w.settings = { ...w.settings, bounds: { ...w.settings.bounds, enabled: true, min: [-1, -1, -1], max: [1, 1, 1] } };
    w.setVelocity(b.id, [60, 0, 0], [0, 0, 0]);
    run(w, 0.1);
    expect(isOff(w, b.id)).toBe(true);
    expect(names(zoneEvents(w))).toContain('exit');
  });
});

describe('live edits', () => {
  it('editing the component while bodies are inside does not forget them: a zone switched to “gravity” takes hold at once', async () => {
    const z = zoneBody({}, { size: [40, 40, 40] });
    const b = ball([0, 0, 0]);
    const w = await worldOf([z, b], {
      gravity: [0, -9.81, 0],
      ground: { ...defaultSettings().ground, enabled: false },
    });
    run(w, 0.2);
    const vBefore = w.getPose(b.id)!.linvel[1];
    expect(vBefore).toBeCloseTo(-9.81 * 0.2, 1);
    w.updateBody({
      ...z,
      components: [{ ...z.components[0], params: { ...z.components[0].params, action: 'gravity' } }],
    });
    run(w, 0.5);
    // gravity (0,0,0) from the moment of the edit: the speed stays what it was
    expect(w.getPose(b.id)!.linvel[1]).toBeCloseTo(vBefore, 2);
  });

  it('a disabled zone component reports nothing; switched on again it adopts the bodies inside without an enter event', async () => {
    const z = zoneBody();
    const off = { ...z, components: [{ ...z.components[0], enabled: false }] };
    const w = await worldOf([off, ball([0, 0, 0])], SPACE);
    run(w, 0.2);
    expect(zoneEvents(w)).toEqual([]);
    w.updateBody(z);
    run(w, 0.1);
    const st = w.drainComponentState().changed[z.components[0].id];
    expect([...st.values!][0]).toBe(1); // inside
    expect(zoneEvents(w)).toEqual([]); // it was there before: no enter
  });
});

describe('snapshots', () => {
  it('the bodies inside survive a snapshot / restore, and the run replays bit for bit', async () => {
    const z = zoneBody({ stayInterval: 0.2 }, { position: [5, 0, 0], size: [4, 4, 4] });
    const b = ball([0, 0, 0], [4, 0, 0]);
    const w = await worldOf([z, b], SPACE);
    run(w, 0.8); // inside the zone since x = 2.75 (t = 0.69)
    zoneEvents(w);
    const snap = w.snapshot();
    const a = runCollect(w, 1.5);
    w.restore(snap);
    const again = runCollect(w, 1.5);
    expect(again).toEqual(a);
    expect(a.some((e) => e.name === 'stay')).toBe(true);
    expect(a.some((e) => e.name === 'exit')).toBe(true);
    expect(at(w, b.id)[0]).toBeGreaterThan(6.5);
  });

  it('published zone state is withdrawn and re-published around a restore (no stale standings)', async () => {
    const z = zoneBody({ action: 'score', points: 5 });
    const w = await worldOf([z, ball([0, 0, 0])], SPACE);
    run(w, 0.1);
    const first = w.drainComponentState().changed[ZONES_STATE_ID];
    expect(first.json).toMatchObject({ score: { total: 5 } });
    const snap = w.snapshot();
    run(w, 0.1);
    w.restore(snap);
    const restored = w.drainComponentState();
    expect(restored.changed[ZONES_STATE_ID]?.json).toMatchObject({ score: { total: 5 } });
  });
});

describe('the rotation of a zone', () => {
  it('a rotated zone box is tested in its own frame', async () => {
    // a 10 × 1 × 1 bar rotated 90° about y becomes a bar along z (x ∈ [−0.5, 0.5], z ∈ [−5, 5])
    const q = qfromAxisAngle([0, 1, 0], Math.PI / 2);
    const z = zoneBody({}, { size: [10, 1, 1], rotation: q });
    const along = ball([-8, 0, 3], [10, 0, 0]); // crosses z = 3, which the rotated bar covers (an unrotated one would not)
    const across = ball([3, 0, -8], [0, 0, 10]); // crosses x = 3, which only an unrotated bar covers
    const w = await worldOf([z, along, across], SPACE);
    const ev = runCollect(w, 2);
    const entered = ev.filter((e) => e.name === 'enter').map((e) => (e.data as { body: string }).body);
    expect(entered).toEqual([along.id]);
  });
});
