import { describe, expect, it } from 'vitest';
import { Builder } from '../src/model/builder';
import { buildPowertrainCar } from '../src/model/content/powered-car';
import { getTemplate } from '../src/model/content';
import { buildCar } from '../src/model/templates';
import { findVehicle, vehicleDetectors, jointVehicleDetector, registerVehicleDetector } from '../src/app/drive/vehicle';
import { isBody } from '../src/model/types';
import type { Entity } from '../src/model/types';

const detect = (entities: readonly Entity[], selection: string[] = []) => findVehicle({ entities, selection });

describe('vehicle detection (joint-built vehicles and powered components)', () => {
  it('finds the Drivable car: chassis, four wheels, W S A D with human names', () => {
    const doc = buildCar(true);
    const { vehicle } = detect(doc.entities);
    expect(vehicle).not.toBeNull();
    const v = vehicle!;
    const chassis = doc.entities.find((e) => e.id === v.chassisId)!;
    expect(chassis.name).toBe('Chassis');
    expect(v.source).toBe('joints');
    expect(v.bodyIds.length).toBeGreaterThanOrEqual(10); // chassis, cabin, hubs, knuckles, wheels
    const wheels = v.drivenIds.map((id) => doc.entities.find((e) => e.id === id)!.name);
    expect(wheels.sort()).toEqual(['Rear left wheel', 'Rear right wheel']);
    expect(v.controls.map((c) => c.code).sort()).toEqual(['KeyA', 'KeyD', 'KeyS', 'KeyW']);
    const label = (code: string) => v.controls.find((c) => c.code === code)!.label;
    expect(label('KeyW')).toBe('Drive forward');
    expect(label('KeyS')).toBe('Drive reverse');
    expect(label('KeyA')).toBe('Steer left');
    expect(label('KeyD')).toBe('Steer right');
    expect(v.axes).toEqual(expect.arrayContaining(['drive', 'steer']));
    // start pose of every body is the document pose
    for (const id of v.bodyIds) {
      const e = doc.entities.find((x) => x.id === id);
      expect(isBody(e) && v.startPose(id)?.position).toEqual(isBody(e) ? e.position : null);
    }
  });

  it('the selected body’s assembly wins; a selected wheel still finds the car', () => {
    const doc = buildCar(true);
    const wheel = doc.entities.find((e) => e.name === 'Front left wheel')!;
    const { vehicle } = detect(doc.entities, [wheel.id]);
    expect(vehicle?.chassisId).toBe(doc.entities.find((e) => e.name === 'Chassis')!.id);
  });

  it('finds the powertrain car and its engine and gearbox owners for the HUD', () => {
    const b = new Builder('pt');
    const chassis = buildPowertrainCar(b);
    const { vehicle } = detect(b.doc.entities);
    expect(vehicle?.chassisId).toBe(chassis.id);
    const keys = vehicle!.controls.map((c) => c.code);
    for (const k of ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyR', 'KeyQ', 'KeyE', 'KeyC', 'KeyL', 'KeyP'])
      expect(keys).toContain(k);
    expect(vehicle!.controls.find((c) => c.code === 'KeyW')!.label).toMatch(/Throttle/);
    expect(vehicle!.componentOwners).toContain(chassis.id);
    expect(vehicle!.drivenIds.length).toBe(2);
  });

  it('reports a scene with no vehicle: nothing to drive, with an explanation', () => {
    const b = new Builder('plain');
    b.body('Ball', 'sphere', [1, 1, 1], [0, 2, 0]);
    b.body('Box', 'box', [1, 1, 1], [3, 2, 0]);
    const r = detect(b.doc.entities);
    expect(r.vehicle).toBeNull();
    expect(r.reason).toMatch(/No vehicle/);
    const sel = detect(buildCar(true).entities, ['nope']);
    expect(sel.vehicle).toBeNull();
    expect(sel.reason).toMatch(/not part of a vehicle/);
  });

  it('a car next to a ball: the car, even with nothing selected; a selected ball is not a vehicle', () => {
    const doc = buildCar(true);
    const b = new Builder('x');
    b.doc.entities = [...doc.entities];
    const ball = b.body('Ball', 'sphere', [1, 1, 1], [8, 2, 0]);
    expect(detect(b.doc.entities).vehicle?.name).toBe('Chassis');
    expect(detect(b.doc.entities, [ball.id]).vehicle).toBeNull();
  });

  it('with two vehicles and nothing selected the nearest one is driven', () => {
    const b = new Builder('two');
    const one = buildPowertrainCar(b, 'Near car');
    const far = new Builder('far');
    const farChassis = buildPowertrainCar(far, 'Far car');
    const moved = far.doc.entities.map((e) =>
      e.kind === 'body'
        ? { ...e, position: [e.position[0] + 60, e.position[1], e.position[2]] as [number, number, number] }
        : e,
    );
    const all = [...b.doc.entities, ...moved];
    expect(findVehicle({ entities: all, selection: [], near: [58, 1, 0] }).vehicle?.chassisId).toBe(farChassis.id);
    expect(findVehicle({ entities: all, selection: [], near: [1, 1, 0] }).vehicle?.chassisId).toBe(one.id);
  });

  it('the other powered example scenes with key bindings are drivable too', () => {
    let drivable = 0;
    for (const id of ['powertrain-car', 'car', 'powered-flight', 'powered-machines']) {
      const t = getTemplate(id);
      if (!t) continue;
      const doc = t.build();
      const r = findVehicle({ entities: doc.entities, selection: [] });
      if (r.vehicle) {
        drivable++;
        expect(r.vehicle.controls.length).toBeGreaterThan(0);
      }
    }
    expect(drivable).toBeGreaterThanOrEqual(2);
  });

  it('other packages plug in through the detector registry (a raycast vehicle later)', () => {
    expect(vehicleDetectors.list().map((d) => d.id)).toContain('joints');
    const off = registerVehicleDetector({
      id: 'test-raycast',
      order: 5,
      detect: () => [
        {
          source: 'test-raycast',
          name: 'Ray car',
          chassisId: 'x',
          bodyIds: ['x'],
          drivenIds: [],
          controls: [{ code: 'KeyW', label: 'Throttle' }],
          axes: [],
          componentOwners: [],
          startPose: () => null,
        },
      ],
    });
    try {
      expect(findVehicle({ entities: [], selection: [] }).vehicle?.source).toBe('test-raycast');
      expect(jointVehicleDetector.detect({ entities: [], selection: [] })).toEqual([]);
    } finally {
      off();
    }
    expect(findVehicle({ entities: [], selection: [] }).vehicle).toBeNull();
  });
});
