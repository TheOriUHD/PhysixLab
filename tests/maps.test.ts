import { describe, expect, it } from 'vitest';
import { newReport } from '../src/model/errors';
import { getMap, listMaps } from '../src/model/content';
import { addWalls, topDownThumbnail } from '../src/model/mapKit';
import { Builder } from '../src/model/builder';
import { createBody, newDocument } from '../src/model/factory';
import { hasShape } from '../src/model/shapeRegistry';
import { parseDocument, serializeDocument } from '../src/model/serialize';
import { isBody, type BodyEntity, type SceneDocument } from '../src/model/types';
import { PhysicsWorld } from '../src/physics/world';
import { qfromAxisAngle, type Vec3 } from '../src/core/math';

const bodies = (doc: SceneDocument) => doc.entities.filter(isBody);
const named = (doc: SceneDocument, prefix: string) => bodies(doc).filter((b) => b.name.startsWith(prefix));
const svgOf = (url: string) => decodeURIComponent(url.slice(url.indexOf(',') + 1));

/** Step the world and report the largest |x|, |z| reached by the body, its final pose and the lowest y. */
async function shootAcross(doc: SceneDocument, ball: BodyEntity, seconds: number) {
  doc.entities.push(ball);
  const w = await PhysicsWorld.create(doc);
  let reachX = 0,
    reachZ = 0,
    lowest = Infinity;
  for (let i = 0, n = Math.round(seconds * w.settings.physicsHz); i < n; i++) {
    w.stepOnce();
    const p = w.getPose(ball.id)!.position;
    reachX = Math.max(reachX, Math.abs(p[0]));
    reachZ = Math.max(reachZ, Math.abs(p[2]));
    lowest = Math.min(lowest, p[1]);
  }
  return { w, final: w.getPose(ball.id)!.position, reachX, reachZ, lowest };
}

describe('every registered map', () => {
  for (const m of listMaps()) {
    describe(m.id, () => {
      it('has complete metadata and a camera that looks at the map', () => {
        expect(m.name.length).toBeGreaterThan(2);
        expect(m.description.length).toBeGreaterThan(20);
        expect(m.objective.length).toBeGreaterThan(10);
        expect(m.tags.length).toBeGreaterThan(0);
        const doc = m.build();
        expect(doc.name.length).toBeGreaterThan(0);
        const d = Math.hypot(...(m.camera.position.map((v, i) => v - m.camera.target[i]) as Vec3));
        expect(d, 'the camera is not sitting on its target').toBeGreaterThan(2);
      });

      it('loads without repairs, uses only registered shapes and saves back with the same entities', () => {
        const doc = m.build();
        for (const b of bodies(doc)) expect(hasShape(b.shape.type), `${b.name}: ${b.shape.type}`).toBe(true);
        const report = newReport();
        const loaded = parseDocument(serializeDocument(doc), report);
        expect(report.warnings).toEqual([]);
        expect(loaded.entities).toHaveLength(doc.entities.length);
      });

      it('simulates for two seconds without a non-finite number', async () => {
        const w = await PhysicsWorld.create(m.build());
        for (let i = 0; i < 2 * w.settings.physicsHz; i++) w.stepOnce();
        const { positions } = w.readSoft();
        expect(positions.every(Number.isFinite)).toBe(true);
        const stats = w.stats();
        expect(Number.isFinite(stats.energy.kinetic)).toBe(true);
        expect(Number.isFinite(stats.energy.potential)).toBe(true);
      });

      it('has a thumbnail that is a drawing of the map', async () => {
        expect(m.thumbnail, 'the Maps tab needs something to show').toBeDefined();
        const url = typeof m.thumbnail === 'function' ? await m.thumbnail() : (m.thumbnail as string);
        expect(url.startsWith('data:image/svg+xml')).toBe(true);
        const svg = svgOf(url);
        expect(svg).toContain('<svg');
        const drawn = (svg.match(/<polygon|<circle/g) ?? []).length;
        expect(drawn).toBe(bodies(m.build()).length);
      });
    });
  }
});

describe('map "Empty arena"', () => {
  const m = getMap('empty-arena')!;

  it('is registered as a free-play arena with the documented metadata', () => {
    expect(m).toBeDefined();
    expect(m.category).toBe('Arenas');
    expect(m.difficulty).toBe('sandbox');
    expect(m.tags).toEqual(expect.arrayContaining(['empty', 'walled']));
    expect(m.spawn.position[1]).toBeGreaterThan(0);
  });

  it('is four static walls around a floor that ends exactly at their inner faces — and nothing else', () => {
    const doc = m.build();
    const all = bodies(doc);
    expect(doc.entities).toHaveLength(4);
    expect(all.every((b) => b.bodyType === 'static')).toBe(true);
    expect(doc.settings.ground.halfSize).toBe(12);
    const w = (name: string) => named(doc, name)[0];
    expect(w('North wall').position[2] + w('North wall').shape.size[2] / 2).toBeCloseTo(-12, 9);
    expect(w('South wall').position[2] - w('South wall').shape.size[2] / 2).toBeCloseTo(12, 9);
    expect(w('West wall').position[0] + w('West wall').shape.size[0] / 2).toBeCloseTo(-12, 9);
    expect(w('East wall').position[0] - w('East wall').shape.size[0] / 2).toBeCloseTo(12, 9);
    // Walls overlap at the corners, so there is no gap a ball could squeeze through.
    expect(w('North wall').shape.size[0]).toBeGreaterThan(24);
    expect(w('West wall').shape.size[1]).toBe(3);
    // Spawn and camera are inside / looking into the arena.
    expect(Math.abs(m.spawn.position[0])).toBeLessThan(12);
    expect(Math.abs(m.spawn.position[2])).toBeLessThan(12);
    expect(Math.abs(m.camera.target[0]) + Math.abs(m.camera.target[2])).toBeLessThan(12);
  });

  const toward: [string, Vec3][] = [
    ['north', [0, 0, -1]],
    ['south', [0, 0, 1]],
    ['west', [-1, 0, 0]],
    ['east', [1, 0, 0]],
  ];
  for (const [side, dir] of toward) {
    it(`keeps a fast rubber ball and a heavy steel ball in when fired at the ${side} wall`, async () => {
      for (const [material, speed, d] of [
        ['rubber', 25, 0.6],
        ['steel', 30, 1.0],
      ] as const) {
        const ball = createBody({
          name: 'Shot',
          shape: { type: 'sphere', size: [d, d, d] },
          position: [0, d / 2 + 0.05, 0],
          material,
          velocity: [dir[0] * speed, 0, dir[2] * speed],
          ccd: true,
        });
        const { final, reachX, reachZ, lowest } = await shootAcross(m.build(), ball, 8);
        const reach = Math.max(reachX, reachZ);
        expect(reach, `${material}: the ball reached the wall`).toBeGreaterThan(12 - d - 0.2);
        expect(reach, `${material}: and never got through it`).toBeLessThan(12.001);
        expect(Math.abs(final[0]) < 12 && Math.abs(final[2]) < 12, `${material}: ends inside`).toBe(true);
        expect(lowest, `${material}: stays on the floor`).toBeGreaterThan(d / 2 - 0.05);
      }
    });
  }

  it('lets a dropped object come to rest on the floor', async () => {
    const ball = createBody({
      name: 'Drop',
      shape: { type: 'sphere', size: [0.5, 0.5, 0.5] },
      position: [3, 3, -2],
      material: 'steel',
    });
    const { final } = await shootAcross(m.build(), ball, 4);
    expect(final[1]).toBeCloseTo(0.25, 2);
  });
});

describe('map "Sandbox box"', () => {
  const m = getMap('sandbox-box')!;
  const sand = (doc: SceneDocument) => named(doc, 'Sand block');

  it('is registered as a free-play arena with the documented metadata', () => {
    expect(m).toBeDefined();
    expect(m.category).toBe('Arenas');
    expect(m.difficulty).toBe('sandbox');
    expect(m.tags).toEqual(expect.arrayContaining(['sandbox', 'blocks']));
  });

  it('is a 10 m box with 4 walls, a stepped mound of 104 blocks and two toys', () => {
    const doc = m.build();
    expect(doc.settings.ground.halfSize).toBe(5);
    expect(named(doc, 'North wall')).toHaveLength(1);
    expect(bodies(doc).filter((b) => b.name.endsWith(' wall'))).toHaveLength(4);
    expect(sand(doc)).toHaveLength(10 * 6 + 8 * 4 + 6 * 2);
    expect(named(doc, 'Beach ball')).toHaveLength(1);
    expect(named(doc, 'Toy crate')).toHaveLength(1);
    expect(doc.entities).toHaveLength(4 + 104 + 2);
    // Everything starts inside the box and clear of the walls (walls: inner faces at ±5).
    for (const b of bodies(doc).filter((x) => x.bodyType === 'dynamic')) {
      expect(Math.abs(b.position[0]) + b.shape.size[0] / 2, b.name).toBeLessThan(5);
      expect(Math.abs(b.position[2]) + b.shape.size[2] / 2, b.name).toBeLessThan(5);
    }
    // Blocks do not start overlapped (clearance of a few millimetres in a 0.25 m grid).
    const first = sand(doc)[0];
    expect(first.shape.size[0]).toBeLessThan(0.25);
  });

  it('settles: after 5 s the mound has not collapsed or exploded, every body is inside the box and at rest', async () => {
    const doc = m.build();
    const w = await PhysicsWorld.create(doc);
    for (let i = 0; i < 5 * w.settings.physicsHz; i++) w.stepOnce();
    const dynamic = bodies(doc).filter((b) => b.bodyType === 'dynamic');
    let maxSpeed = 0,
      maxY = 0;
    for (const b of dynamic) {
      const p = w.getPose(b.id)!;
      expect(Math.abs(p.position[0]) < 5 && Math.abs(p.position[2]) < 5, `${b.name} inside`).toBe(true);
      expect(p.position[1], `${b.name} above the floor`).toBeGreaterThan(b.shape.size[1] / 2 - 0.02);
      maxSpeed = Math.max(maxSpeed, Math.hypot(...p.linvel));
      if (b.name.startsWith('Sand')) maxY = Math.max(maxY, p.position[1]);
    }
    expect(maxSpeed, 'everything has come to rest').toBeLessThan(0.05);
    // The top layer's centre started at 0.625 m; a stable mound stays within a block's height of that.
    expect(maxY).toBeLessThan(0.75);
    expect(maxY).toBeGreaterThan(0.5);
  });

  it('keeps a hard shot at the wall inside the box', async () => {
    const ball = createBody({
      name: 'Shot',
      shape: { type: 'sphere', size: [0.4, 0.4, 0.4] },
      position: [0, 0.5, 3],
      material: 'steel',
      velocity: [14, 0, 0],
      ccd: true,
    });
    const { final, reachX } = await shootAcross(m.build(), ball, 6);
    expect(reachX).toBeGreaterThan(4.6);
    expect(reachX).toBeLessThan(5.001);
    expect(Math.abs(final[0])).toBeLessThan(5);
  });

  it('is a real heap: a heavy ball ploughed into the mound scatters it, and no block leaves the box', async () => {
    const doc = m.build();
    const before = new Map(sand(doc).map((b) => [b.id, b.position]));
    const ball = createBody({
      name: 'Wrecker',
      shape: { type: 'sphere', size: [0.5, 0.5, 0.5] },
      position: [0, 0.26, 3],
      material: 'steel',
      velocity: [0, 0, -14],
      ccd: true,
    });
    doc.entities.push(ball);
    const w = await PhysicsWorld.create(doc);
    for (let i = 0; i < 5 * w.settings.physicsHz; i++) w.stepOnce();
    let moved = 0,
      far = 0;
    for (const b of sand(doc)) {
      const p = w.getPose(b.id)!.position;
      const q = before.get(b.id)!;
      const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      if (d > 0.3) moved++;
      if (d > 1.5) far++;
      expect(p.every(Number.isFinite)).toBe(true);
      expect(Math.abs(p[0]) < 5 && Math.abs(p[2]) < 5, `${b.name} stays in the box`).toBe(true);
    }
    expect(moved, 'most of the mound was displaced').toBeGreaterThan(50);
    expect(far, 'and part of it was thrown across the box').toBeGreaterThan(5);
  });
});

describe('map kit', () => {
  it('adds walls whose inner faces sit on the requested rectangle', () => {
    const b = new Builder('x');
    const walls = addWalls(b, { halfX: 4, halfZ: 6, height: 2, thickness: 0.5, material: 'steel' });
    expect(walls.map((w) => w.name)).toEqual(['North wall', 'South wall', 'West wall', 'East wall']);
    const [n, s, west, east] = walls;
    expect(n.position[2] + n.shape.size[2] / 2).toBeCloseTo(-6, 9);
    expect(s.position[2] - s.shape.size[2] / 2).toBeCloseTo(6, 9);
    expect(west.position[0] + west.shape.size[0] / 2).toBeCloseTo(-4, 9);
    expect(east.position[0] - east.shape.size[0] / 2).toBeCloseTo(4, 9);
    expect(walls.every((w) => w.bodyType === 'static' && w.position[1] === 1)).toBe(true);
  });

  it('draws the footprint of rotated bodies: a 2 × 1 box turned 90° is 1 × 2 in the sketch', () => {
    const doc = newDocument('t');
    doc.entities.push(
      createBody({
        shape: { type: 'box', size: [2, 1, 1] },
        position: [0, 0.5, 0],
        rotation: qfromAxisAngle([0, 1, 0], Math.PI / 2),
      }),
      // A second, far body so the frame is not tight around the first one.
      createBody({ shape: { type: 'box', size: [1, 1, 1] }, position: [6, 0.5, 6] }),
    );
    const svg = svgOf(topDownThumbnail(doc));
    const polys = [...svg.matchAll(/<polygon points="([^"]+)"/g)].map((m) =>
      m[1].split(' ').map((p) => p.split(',').map(Number)),
    );
    expect(polys).toHaveLength(2);
    const w = Math.max(...polys[0].map((p) => p[0])) - Math.min(...polys[0].map((p) => p[0]));
    const h = Math.max(...polys[0].map((p) => p[1])) - Math.min(...polys[0].map((p) => p[1]));
    expect(h / w).toBeCloseTo(2, 1);
  });

  it('draws spheres as circles, ordered low to high, and an empty scene as just the floor', () => {
    const doc = newDocument('t');
    doc.entities.push(
      createBody({ shape: { type: 'sphere', size: [1, 1, 1] }, position: [0, 3, 0], material: 'gold' }),
      createBody({ shape: { type: 'box', size: [1, 1, 1] }, position: [0, 0.5, 0], material: 'steel' }),
    );
    const svg = svgOf(topDownThumbnail(doc));
    expect(svg.indexOf('<polygon')).toBeLessThan(svg.indexOf('<circle'));
    expect(svg).toContain('r="');
    const empty = svgOf(topDownThumbnail(newDocument('e')));
    expect(empty).toContain('<rect');
    expect(empty).not.toContain('<polygon');
  });
});
