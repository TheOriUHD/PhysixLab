/** VZ-42: the procedural car skins, built with three.js in Node (no WebGL needed). */
import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { buildCar } from '../src/model/templates';
import type { BodyEntity } from '../src/model/types';
import { skinRegistry } from '../src/render/skins/registry';
import '../src/render/skins';
import { sharedResourceCount, triangleCount } from '../src/render/skins/carKit';
import type { CarSkinHandles } from '../src/render/skins/car';
import type { SkinBodyPose, SkinFrame } from '../src/render/skins/types';

const doc = buildCar(false);
const bodies = doc.entities.filter((e): e is BodyEntity => e.kind === 'body');
const chassis = bodies.find((b) => b.name === 'Chassis')!;
const wheelDefs = bodies.filter((b) => b.tags.includes('car-wheel'));
const SIZE: [number, number, number] = [2.3, 0.35, 1.2];

/** Frame with the chassis at rest and the wheels at their authored positions; wheel 0 can be moved by `wheelDy`. */
function makeFrame(wheelDy = 0, keys: string[] = []): SkinFrame {
  const chassisPose: SkinBodyPose = {
    position: new Vector3(...chassis.position),
    quaternion: new Quaternion(),
    def: chassis,
  };
  const wheels: SkinBodyPose[] = wheelDefs.map((w, i) => ({
    position: new Vector3(w.position[0], w.position[1] + (i === 0 ? wheelDy : 0), w.position[2]),
    quaternion: new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2),
    def: w,
  }));
  return {
    dt: 1 / 60,
    position: chassisPose.position,
    quaternion: chassisPose.quaternion,
    keys: new Set(keys),
    simulating: true,
    bodiesWithTag: (t) => (t === 'car-wheel' ? wheels : t === 'car-body' ? [chassisPose] : []),
  };
}

const buildBody = () => skinRegistry.get('car.body')!.build(SIZE, chassis.skin!, chassis);

describe('car skins', () => {
  it('the car template uses them and hides the glass cabin', () => {
    expect(chassis.skin?.id).toBe('car.body');
    expect(wheelDefs).toHaveLength(4);
    expect(wheelDefs.every((w) => w.skin?.id === 'car.wheel')).toBe(true);
    expect(bodies.find((b) => b.name === 'Cabin')?.hidden).toBe(true);
    expect(skinRegistry.get('car.body')?.shapes).toEqual(['box']);
    expect(skinRegistry.get('car.wheel')?.shapes).toEqual(['cylinder']);
  });

  it('builds within the triangle budget and disposes cleanly', () => {
    const body = buildBody();
    const wheels = wheelDefs.map((w) => skinRegistry.get('car.wheel')!.build([0.72, 0.3, 0.72], w.skin!, w));
    body.update(makeFrame());
    const tris = triangleCount(body.root) + wheels.reduce((n, w) => n + triangleCount(w.root), 0);
    process.stderr.write(`car skin triangles: ${tris}\n`);
    expect(tris).toBeGreaterThan(3000);
    expect(tris).toBeLessThan(60000);
    expect(() => body.dispose()).not.toThrow();
    for (const w of wheels) expect(() => w.dispose()).not.toThrow();
    expect(sharedResourceCount()).toBe(0);
  });

  it('the strut follows the wheel: lower wheel = longer strut, raised wheel = shorter', () => {
    const skin = buildBody();
    const h = skin.root.userData.car as CarSkinHandles;
    skin.update(makeFrame(0));
    const rest = h.strutLength[0];
    expect(rest).toBeGreaterThan(0.25);
    skin.update(makeFrame(-0.1));
    expect(h.strutLength[0]).toBeCloseTo(rest + 0.1, 3);
    skin.update(makeFrame(0.1));
    expect(h.strutLength[0]).toBeCloseTo(rest - 0.1, 3);
    skin.update(makeFrame(0));
    expect(h.strutLength[1]).toBeCloseTo(rest, 3);
    skin.dispose();
  });

  it('the chassis pose is factored out: moving and turning the whole car keeps the struts', () => {
    const skin = buildBody();
    const h = skin.root.userData.car as CarSkinHandles;
    skin.update(makeFrame());
    const rest = h.strutLength[0];
    const f = makeFrame();
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.7);
    const origin = new Vector3(...chassis.position);
    f.quaternion.copy(q);
    f.position.add(new Vector3(5, 0, -3));
    for (const w of f.bodiesWithTag('car-wheel') as SkinBodyPose[]) {
      (w.position as Vector3).sub(origin).applyQuaternion(q).add(f.position);
      (w.quaternion as Quaternion).premultiply(q);
    }
    skin.update(f);
    expect(h.strutLength[0]).toBeCloseTo(rest, 3);
    skin.dispose();
  });

  it('tail-lights glow dim, brighten while KeyS is held and fade back', () => {
    const skin = buildBody();
    const h = skin.root.userData.car as CarSkinHandles;
    const idleFrame = makeFrame();
    skin.update(idleFrame);
    const idle = h.tail.emissiveIntensity;
    expect(idle).toBeGreaterThan(0.1);
    const brake = makeFrame(0, ['KeyS']);
    for (let i = 0; i < 30; i++) skin.update(brake);
    expect(h.tail.emissiveIntensity).toBeGreaterThan(idle * 4);
    for (let i = 0; i < 90; i++) skin.update(idleFrame);
    expect(h.tail.emissiveIntensity).toBeCloseTo(idle, 2);
    skin.dispose();
  });

  it('the paint follows the live chassis colour', () => {
    const skin = buildBody();
    const h = skin.root.userData.car as CarSkinHandles;
    const f = makeFrame();
    const edited: BodyEntity = { ...chassis, material: { ...chassis.material, color: '#2040ff' } };
    const live: SkinBodyPose[] = [{ position: f.position, quaternion: f.quaternion, def: edited }];
    skin.update({ ...f, bodiesWithTag: (t) => (t === 'car-body' ? live : f.bodiesWithTag(t)) });
    expect(h.paint.color.getHexString()).toBe('2040ff');
    skin.dispose();
  });
});
