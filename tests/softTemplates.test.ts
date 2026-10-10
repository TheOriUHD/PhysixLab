/**
 * Package SF — the soft-body example scenes, loaded from the registered templates into the real engine and checked
 * against what each one promises (a few simulated seconds each, with tolerances).
 */
import { describe, expect, it } from 'vitest';
import { listTemplates } from '../src/model/content';
import { sanitizeDocument } from '../src/model/serialize';
import type { BodyEntity, SceneDocument } from '../src/model/types';
import { PhysicsWorld } from '../src/physics/world';

const log = (...a: unknown[]) =>
  process.stderr.write('\n' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
void log;

const run = (w: PhysicsWorld, s: number) => {
  for (let i = 0; i < Math.round(s * w.settings.physicsHz); i++) w.stepOnce();
};

interface Loaded {
  doc: SceneDocument;
  w: PhysicsWorld;
  body: (name: string) => BodyEntity;
  pos: (name: string) => [number, number, number];
  /** All soft particles, flat xyz. */
  particles: () => Float32Array;
}

async function load(id: string): Promise<Loaded> {
  const t = listTemplates().find((x) => x.id === id);
  if (!t) throw new Error(`template ${id} is not registered`);
  const doc = sanitizeDocument(JSON.parse(JSON.stringify(t.build())));
  const w = await PhysicsWorld.create(doc);
  const body = (name: string) => {
    const e = doc.entities.find((x) => x.kind === 'body' && x.name === name);
    if (!e) throw new Error(`no body ${name}`);
    return e as BodyEntity;
  };
  return {
    doc,
    w,
    body,
    pos: (name) => w.getPose(body(name).id)!.position,
    particles: () => w.readSoft().positions,
  };
}

const finite = (a: ArrayLike<number>) => Array.from(a).every(Number.isFinite);
const extent = (p: Float32Array, axis: number) => {
  let lo = Infinity,
    hi = -Infinity;
  for (let i = axis; i < p.length; i += 3) {
    lo = Math.min(lo, p[i]);
    hi = Math.max(hi, p[i]);
  }
  return { lo, hi };
};

describe('SF templates: attached soft bodies', () => {
  it('Sail on a mast: the wind swings yard and boom out against the sheet and the laced sail goes with them', async () => {
    const s = await load('sail-on-a-mast');
    const p0 = s.particles().slice();
    run(s.w, 3);
    const swing = (name: string) => {
      const p = s.pos(name);
      return Math.atan2(p[2], p[0]);
    };
    log('sail swing', swing('Boom'), swing('Yard'));
    // hinge limit (the sheet) is 0.95 rad: the wind pushes both spars right up to it
    expect(swing('Boom')).toBeGreaterThan(0.8);
    expect(swing('Boom')).toBeLessThan(1.0);
    expect(Math.abs(swing('Yard') - swing('Boom'))).toBeLessThan(0.1); // the sail keeps the two spars together
    const p = s.particles();
    expect(finite(p)).toBe(true);
    // the cloth itself travelled with the spars: it now reaches well into +z
    expect(extent(p0, 2).hi).toBeLessThan(0.05);
    expect(extent(p, 2).hi).toBeGreaterThan(1.5);
    expect(extent(p, 1).hi).toBeGreaterThan(2.9); // the head stays at the yard
    expect(extent(p, 1).lo).toBeGreaterThan(0.8);
  });

  it('Net between posts: the net catches a 6 kg ball and sags under it', async () => {
    const s = await load('net-between-posts');
    const p0 = s.particles().slice();
    expect(extent(p0, 1).lo).toBeGreaterThan(1.45); // starts flat
    let minBall = Infinity;
    for (let k = 0; k < 4; k++) {
      run(s.w, 1);
      minBall = Math.min(minBall, s.pos('Heavy ball')[1]);
    }
    const ball = s.pos('Heavy ball');
    const p = s.particles();
    log('net', ball, minBall, extent(p, 1));
    expect(finite(p)).toBe(true);
    expect(minBall).toBeGreaterThan(0.2);
    expect(ball[1]).toBeGreaterThan(0.6); // still held well above the ground
    expect(Math.abs(ball[0]) < 1 && Math.abs(ball[2]) < 1).toBe(true); // inside the posts
    expect(extent(p, 1).lo).toBeLessThan(1.5 - 0.15); // the net sags under it
    expect(extent(p, 1).hi).toBeGreaterThan(1.45); // the corners stay fastened to the posts
  });

  it('Curtain on a rail: pulling the end ring along the rail drags the whole curtain', async () => {
    const s = await load('curtain-on-a-rail');
    const rings = [1, 2, 3, 4, 5];
    const x0 = rings.map((i) => s.pos(`Ring ${i}`)[0]);
    run(s.w, 3.5);
    const x1 = rings.map((i) => s.pos(`Ring ${i}`)[0]);
    log('curtain', x0, x1);
    expect(x1[4] - x0[4]).toBeGreaterThan(0.6); // the driven ring runs
    expect(x1[0] - x0[0]).toBeGreaterThan(0.25); // the far ring is towed by the cloth alone
    for (const i of rings) expect(Math.abs(s.pos(`Ring ${i}`)[1] - 2.6)).toBeLessThan(0.05); // rings stay on the rail
    const p = s.particles();
    expect(finite(p)).toBe(true);
    expect(extent(p, 0).hi).toBeGreaterThan(1.5 + 0.5); // the curtain's right edge travelled with the ring
    expect(extent(p, 1).lo).toBeGreaterThan(0.5); // and it still hangs
  });

  it('Cable hanging a weight: the 5 kg block settles within the cable length and does not drift', async () => {
    const s = await load('cable-hanging-a-weight');
    const world = s.w as unknown as { s: { bodies: Map<string, { rb: { mass(): number } }> } };
    expect(world.s.bodies.get(s.body('Weight').id)!.rb.mass()).toBeCloseTo(5, 2);
    run(s.w, 2.5);
    // sample the next two seconds: the cable is stretchy, so the block bobs a little, but it must not creep or wander
    const ys: number[] = [];
    let drift = 0;
    for (let i = 0; i < 240; i++) {
      s.w.stepOnce();
      if (i % 4 === 0) {
        const p = s.pos('Weight');
        ys.push(p[1]);
        drift = Math.max(drift, Math.hypot(p[0], p[2]));
      }
    }
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    const h = ys.length / 2;
    log('hang', mean(ys.slice(0, h)), mean(ys.slice(h)), Math.min(...ys), Math.max(...ys));
    // top face 3 m below the pin (5.2): block centre at 5.2 - 3 - 0.2 = 2.0, stretching only a little
    expect(Math.max(...ys)).toBeLessThan(2.0 + 0.02); // never above the cable length
    expect(Math.min(...ys)).toBeGreaterThan(2.0 - 0.2); // stretch under 7 %
    expect(Math.abs(mean(ys.slice(h)) - mean(ys.slice(0, h)))).toBeLessThan(0.02); // at rest: no creep
    expect(drift).toBeLessThan(0.1); // no sideways wander
    expect(finite(s.particles())).toBe(true);
  });
});
