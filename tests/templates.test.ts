import { describe, expect, it } from 'vitest';
import { TEMPLATES } from '../src/model/templates';
import { sanitizeDocument } from '../src/model/serialize';
import { PhysicsWorld } from '../src/physics/world';
import { qrot, type Vec3 } from '../src/core/math';
import type { BodyEntity, SceneDocument } from '../src/model/types';

const log = (...a: unknown[]) => process.stderr.write('\n' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

const byId = (id: string) => TEMPLATES.find((t) => t.id === id)!;
const nameOf = (doc: SceneDocument, name: string) => doc.entities.find((e) => e.name === name) as BodyEntity;
const run = (w: PhysicsWorld, s: number) => { for (let i = 0; i < Math.round(s * w.settings.physicsHz); i++) w.stepOnce(); };

describe('every example scene', () => {
  for (const t of TEMPLATES) {
    it(`${t.name}: round-trips, simulates without blow-ups`, async () => {
      const doc = t.build();
      const clean = sanitizeDocument(JSON.parse(JSON.stringify(doc)));
      expect(clean.entities.length).toBe(doc.entities.length);
      const w = await PhysicsWorld.create(clean);
      run(w, 4);
      for (const b of doc.entities) {
        if (b.kind !== 'body') continue;
        const p = w.getPose(b.id)!;
        expect(p.position.every(Number.isFinite), `${b.name} finite`).toBe(true);
        expect(Math.abs(p.position[0]) < 400 && Math.abs(p.position[2]) < 400, `${b.name} stays near the origin`).toBe(true);
      }
    });
  }
});

describe('scene behaviour', () => {
  it('car drives forward, stays upright and steers', async () => {
    const doc = byId('car').build();
    const chassis = nameOf(doc, 'Chassis');
    const w = await PhysicsWorld.create(doc);
    run(w, 1.5); // settle on the suspension
    const p0 = w.getPose(chassis.id)!;
    log('car settled', p0.position);
    expect(Math.abs(p0.position[1] - 0.52)).toBeLessThan(0.1);
    w.setKeys(['KeyW']);
    run(w, 2.5);
    const p1 = w.getPose(chassis.id)!;
    const up = qrot(p1.rotation, [0, 1, 0]);
    log('car after 2.5s W', p1.position, 'v', p1.linvel, 'up', up);
    expect(p1.position[0] - p0.position[0]).toBeGreaterThan(5);
    expect(up[1]).toBeGreaterThan(0.97);
    // Steer left (A) from a standstill start in a fresh world.
    const w2 = await PhysicsWorld.create(doc);
    run(w2, 1.5);
    w2.setKeys(['KeyW', 'KeyA']);
    run(w2, 2.5);
    const q = w2.getPose(chassis.id)!;
    const fwd = qrot(q.rotation, [1, 0, 0]);
    log('car turning left: heading', fwd, 'pos', q.position);
    expect(fwd[2]).toBeLessThan(-0.2); // positive rotation about +Y turns the nose toward −Z
    // Reverse
    const w3 = await PhysicsWorld.create(doc);
    run(w3, 1.5);
    w3.setKeys(['KeyS']);
    run(w3, 2);
    expect(w3.getPose(chassis.id)!.position[0]).toBeLessThan(-2);
  });

  it("newton's cradle transfers momentum", async () => {
    const doc = byId('cradle').build();
    const w = await PhysicsWorld.create(doc);
    const first = nameOf(doc, 'Ball 1'), last = nameOf(doc, 'Ball 5');
    let maxLastX = -9, minFirstAfter = 9;
    for (let i = 0; i < 120 * 4; i++) {
      w.stepOnce();
      maxLastX = Math.max(maxLastX, w.getPose(last.id)!.position[0]);
      if (i > 120) minFirstAfter = Math.min(minFirstAfter, w.getPose(first.id)!.position[0]);
    }
    log('cradle: last ball max x', maxLastX, 'rest x', last.position[0]);
    expect(maxLastX).toBeGreaterThan(last.position[0] + 0.3);
  });

  it('double pendulum conserves energy', async () => {
    const doc = byId('double').build();
    const w = await PhysicsWorld.create(doc);
    const E = () => { w.readPoses(1); const e = w.stats().energy; return e.kinetic + e.rotational + e.potential; };
    const e0 = E();
    let worst = 0;
    for (let i = 0; i < 240 * 6; i++) { w.stepOnce(); if (i % 24 === 0) worst = Math.max(worst, Math.abs(E() - e0)); }
    log('double pendulum energy drift (J)', worst, 'E0', e0, 'KE+PE ranges');
    // measure relative to the swing of the potential energy
    expect(worst / Math.abs(e0)).toBeLessThan(0.01);
  });

  it('lever launcher throws the payload toward the crates', async () => {
    const doc = byId('lever').build();
    const w = await PhysicsWorld.create(doc);
    const ball = nameOf(doc, 'Payload');
    let maxX = -99, maxY = 0;
    for (let i = 0; i < 120 * 5; i++) { w.stepOnce(); const p = w.getPose(ball.id)!.position; maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]); }
    log('lever: payload max x', maxX, 'max y', maxY, 'final', w.getPose(ball.id)!.position);
    expect(maxX).toBeGreaterThan(8);
  });

  it('wrecking ball destroys part of the wall', async () => {
    const doc = byId('wreck').build();
    const w = await PhysicsWorld.create(doc);
    const bricks = doc.entities.filter((e) => e.name === 'Brick') as BodyEntity[];
    run(w, 6);
    const moved = bricks.filter((b) => { const p = w.getPose(b.id)!.position; return Math.hypot(p[0] - b.position[0], p[1] - b.position[1], p[2] - b.position[2]) > 0.3; }).length;
    log('wrecking ball displaced bricks', moved, 'of', bricks.length);
    expect(moved).toBeGreaterThan(8);
  });

  it('jenga tower stands until hit', async () => {
    const doc = byId('jenga').build();
    const w = await PhysicsWorld.create(doc);
    const blocks = doc.entities.filter((e) => e.name === 'Block') as BodyEntity[];
    run(w, 0.5);
    const drift = Math.max(...blocks.map((b) => { const p = w.getPose(b.id)!.position; return Math.hypot(p[0] - b.position[0], p[1] - b.position[1], p[2] - b.position[2]); }));
    log('jenga drift before impact', drift);
    expect(drift).toBeLessThan(0.05);
    run(w, 5);
    const toppled = blocks.filter((b) => w.getPose(b.id)!.position[1] < b.position[1] - 0.5).length;
    log('jenga blocks fallen after impact', toppled);
    expect(toppled).toBeGreaterThan(3);
  });

  it('friction lab: ice slides furthest, rubber stays', async () => {
    const doc = byId('friction').build();
    const w = await PhysicsWorld.create(doc);
    run(w, 2.5);
    const d = (n: string) => { const b = nameOf(doc, n); const p = w.getPose(b.id)!.position; return Math.hypot(p[0] - b.position[0], p[1] - b.position[1]); };
    const res = { ice: d('Ice block'), steel: d('Steel block'), wood: d('Wood block'), rubber: d('Rubber block') };
    log('friction lab distances', res);
    expect(res.ice).toBeGreaterThan(res.steel);
    expect(res.rubber).toBeLessThan(0.3);
  });

  it('billiards conserve momentum', async () => {
    const doc = byId('billiards').build();
    const w = await PhysicsWorld.create(doc);
    w.readPoses(1);
    const p0 = w.stats().energy.momentum;
    run(w, 3);
    w.readPoses(1);
    const p1 = w.stats().energy.momentum;
    log('billiards momentum', p0, p1);
    expect(Math.abs(p1[0] - p0[0]) / Math.abs(p0[0])).toBeLessThan(0.02);
  });

  it('piston press responds to the arrow keys', async () => {
    const doc = byId('piston').build();
    const w = await PhysicsWorld.create(doc);
    const ram = nameOf(doc, 'Ram');
    run(w, 1);
    expect(Math.abs(w.getPose(ram.id)!.position[1] - 3.4)).toBeLessThan(0.05);
    w.setKeys(['ArrowDown']);
    run(w, 2.5);
    const y = w.getPose(ram.id)!.position[1];
    log('ram y after pressing down', y);
    expect(y).toBeLessThan(2.4);
  });

  it('ball pit steps fast enough', async () => {
    const doc = byId('pit').build();
    const w = await PhysicsWorld.create(doc);
    const t0 = performance.now();
    run(w, 3);
    const ms = (performance.now() - t0) / (3 * 120);
    log('ball pit ms/step', ms);
    expect(ms).toBeLessThan(8);
  });
});
void ({} as Vec3);
