/** The flames, blades and gauges of the powered parts follow the running simulation. */
import { describe, expect, it } from 'vitest';
import { Group } from 'three';
import { vlen } from '../src/core/math';
import { listTemplates } from '../src/model/content';
import { sanitizeDocument } from '../src/model/serialize';
import type { BodyEntity, SceneDocument } from '../src/model/types';
import { ComponentFx } from '../src/render/componentFx';
import {
  planComponentFx,
  type DialFx,
  type DiscFx,
  type FlameFx,
  type FxSource,
  type SlideFx,
} from '../src/render/componentFxPlan';
import { PhysicsWorld } from '../src/physics/world';

const scene = (id: string): SceneDocument => {
  const t = listTemplates().find((x) => x.id === id);
  if (!t) throw new Error(`no example scene "${id}"`);
  return sanitizeDocument(JSON.parse(JSON.stringify(t.build())));
};
const run = (w: PhysicsWorld, s: number) => {
  for (let i = 0; i < Math.round(s * w.settings.physicsHz); i++) w.stepOnce();
};

/** An FxSource over a real physics world: what the app wires up with the live client. */
function sourceOf(doc: SceneDocument, w: PhysicsWorld | null, selected: string[] = []): FxSource & { drain(): void } {
  const published = new Map<string, number[]>();
  const bodies = doc.entities.filter((e): e is BodyEntity => e.kind === 'body');
  return {
    bodies: () => bodies,
    joints: () => doc.entities.filter((e) => e.kind === 'joint'),
    pose: (id) => {
      const p = w?.getPose(id);
      if (p) return { position: p.position, rotation: p.rotation };
      const b = bodies.find((x) => x.id === id);
      return b ? { position: b.position, rotation: b.rotation } : null;
    },
    values: (id) => published.get(id) ?? null,
    live: () => w !== null,
    selected: (id) => selected.includes(id),
    drain() {
      if (!w) return;
      for (const [k, e] of Object.entries(w.drainComponentState().changed))
        if (e.values) published.set(k, [...e.values]);
    },
  };
}
const flames = (src: FxSource) => planComponentFx(src).filter((f): f is FlameFx => f.kind === 'flame');
const discs = (src: FxSource) => planComponentFx(src).filter((f): f is DiscFx => f.kind === 'disc');

describe('flames', () => {
  it('a rocket shows nothing on the pad, a downward flame while firing, and none once the fuel is gone', async () => {
    const doc = scene('rocket-launch');
    const rocket = doc.entities.find((e) => e.name === 'Rocket') as BodyEntity;
    const w = await PhysicsWorld.create(doc);
    const src = sourceOf(doc, w);
    run(w, 0.5);
    src.drain();
    expect(flames(src)).toHaveLength(0); // idle: no flame
    w.setKeys(['KeyF']);
    run(w, 2);
    src.drain();
    const [f] = flames(src);
    expect(f).toBeDefined();
    expect(f.dir[1]).toBeLessThan(-0.99); // the exhaust goes down, the thrust up
    expect(f.intensity).toBeGreaterThan(0.95);
    expect(f.length).toBeCloseTo(1.6 * f.intensity, 2); // the rocket's flameLength is 1.6 m
    const pose = w.getPose(rocket.id)!;
    expect(f.at[1]).toBeCloseTo(pose.position[1] - 1.2, 1); // at the nozzle, 1.2 m below the centre
    run(w, 12);
    src.drain();
    expect(flames(src)).toHaveLength(0); // burnt out
  });

  it('half throttle gives a shorter flame', async () => {
    const doc = scene('rocket-launch');
    const w = await PhysicsWorld.create(doc);
    const src = sourceOf(doc, w);
    w.setAxes({ throttle: 1 });
    run(w, 1.5);
    src.drain();
    const full = flames(src)[0].length;
    w.setAxes({ throttle: 0.5 });
    run(w, 1.5);
    src.drain();
    expect(flames(src)[0].length).toBeCloseTo(full / 2, 1);
  });

  it('the jet afterburner lengthens the flame and turns it orange', async () => {
    const doc = scene('jet-car');
    const w = await PhysicsWorld.create(doc);
    const src = sourceOf(doc, w);
    w.setKeys(['KeyW']);
    run(w, 3.5);
    src.drain();
    const dry = flames(src)[0];
    w.setKeys(['KeyW', 'ShiftLeft']);
    run(w, 1);
    src.drain();
    const burner = flames(src)[0];
    expect(dry.afterburner).toBe(false);
    expect(burner.afterburner).toBe(true);
    expect(burner.length).toBeGreaterThan(dry.length * 1.3);
    expect(burner.color).not.toBe(dry.color);
  });

  it('while editing, only a selected owner shows a faint preview', () => {
    const doc = scene('rocket-launch');
    const rocket = doc.entities.find((e) => e.name === 'Rocket') as BodyEntity;
    expect(flames(sourceOf(doc, null))).toHaveLength(0);
    const [f] = flames(sourceOf(doc, null, [rocket.id]));
    expect(f.preview).toBe(true);
    expect(f.dir[1]).toBeLessThan(-0.99);
  });
});

describe('blades', () => {
  it('a propeller turns into a blur as it spins up, and the rotor disc leans with the cyclic', async () => {
    const doc = scene('propeller-cart');
    const w = await PhysicsWorld.create(doc);
    const src = sourceOf(doc, w);
    src.drain();
    run(w, 0.1);
    src.drain();
    const idle = discs(src)[0].rpm; // the engine idles, so the propeller already turns slowly
    w.setKeys(['KeyW']);
    run(w, 4);
    src.drain();
    expect(discs(src)[0].rpm).toBeGreaterThan(idle * 1.5);

    const heli = scene('helicopter');
    const hw = await PhysicsWorld.create(heli);
    const hs = sourceOf(heli, hw);
    hw.setKeys(['KeyR']);
    run(hw, 3);
    hs.drain();
    const level = discs(hs).find((d) => d.radius === 2.5)!;
    hw.setAxes({ pitch: 1 });
    run(hw, 0.3);
    hs.drain();
    const tilted = discs(hs).find((d) => d.radius === 2.5)!;
    // 6° of maximum tilt on top of the -5° roll trim: the axis moves away from the hull's vertical
    const lean = (d: DiscFx) => Math.hypot(d.axis[0], d.axis[2]);
    expect(lean(tilted)).toBeGreaterThan(lean(level) + 0.03);
  });
});

describe('gauges', () => {
  it('a servo draws its angle against its target and its travel; a cylinder its stroke', async () => {
    const doc = scene('servo-arm');
    const w = await PhysicsWorld.create(doc);
    const src = sourceOf(doc, w);
    w.setKeys(['KeyD']);
    run(w, 1);
    src.drain();
    const dials = planComponentFx(src).filter((f): f is DialFx => f.kind === 'dial');
    expect(dials.length).toBeGreaterThan(0);
    const d = dials[0];
    expect(vlen(d.axis)).toBeCloseTo(1, 6);
    expect(Math.abs(d.current)).toBeGreaterThan(0.01);
    expect(d.min).not.toBeNull();

    const crane = scene('hydraulic-crane');
    const cw = await PhysicsWorld.create(crane);
    const cs = sourceOf(crane, cw);
    cw.setKeys(['KeyW']);
    run(cw, 1);
    cs.drain();
    const slides = planComponentFx(cs).filter((f): f is SlideFx => f.kind === 'slide');
    expect(slides.length).toBeGreaterThan(0);
    expect(slides.some((s) => Math.abs(s.current) > 0.01)).toBe(true);
  });
});

describe('ComponentFx (three.js objects)', () => {
  it('creates one object per flame and removes it when the fire stops', async () => {
    const doc = scene('rocket-launch');
    const w = await PhysicsWorld.create(doc);
    const src = sourceOf(doc, w);
    const fx = new ComponentFx(new Group(), src);
    fx.update(1 / 60);
    expect(fx.count).toBe(0);
    w.setKeys(['KeyF']);
    run(w, 1);
    src.drain();
    fx.update(1 / 60);
    expect(fx.count).toBe(1);
    const flame = fx.group.children[0];
    expect(flame.position.y).toBeGreaterThan(1); // at the nozzle, above the pad
    w.setKeys([]);
    run(w, 1);
    src.drain();
    fx.update(1 / 60);
    // the fire is out (thrust spooled down to nothing) or nearly: either way nothing leaks
    for (let i = 0; i < 30; i++) {
      run(w, 0.1);
      src.drain();
      fx.update(1 / 60);
    }
    expect(fx.count).toBe(0);
    fx.dispose();
    expect(fx.group.parent).toBeNull();
  });
});
