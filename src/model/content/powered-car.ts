/**
 * The powertrain car (package CP): a real drive train from the engine to the road. Engine → clutch → gearbox →
 * differential → two driven rear wheels, with disc brakes on all four, steering on the front. Nothing is scripted:
 * the wheels turn because the engine's torque reaches them through the shaft graph, and slip when it is more than the
 * tyres can hold.
 *
 *   W throttle · S brake · A / D steer · R reverse · E / Q shift up / down (it also shifts itself) ·
 *   C clutch · L lock the differential
 */
import { Builder, idleMotor, rotX, rotY } from '../builder';
import { makeComponent } from '../componentRegistry';
import type { BodyEntity, Entity } from '../types';
import { registerPrefab, registerTemplate } from './registry';

const WHEEL_R = 0.36;
const WHEEL_W = 0.3;

/** The car, standing on the ground around the origin, nose toward +X. */
export function buildPowertrainCar(b: Builder, name = 'Powertrain car'): BodyEntity {
  const y = 0.62;
  const chassis = b.body(`${name} chassis`, 'box', [2.3, 0.35, 1.2], [0, y, 0], {
    material: { preset: 'steel', density: 1100, color: '#3b82d9', metalness: 0.6, roughness: 0.35 },
    massOverride: 1000,
    comOverride: [-0.25, -0.3, 0], // low and a little to the rear: weight on the driven wheels, no wheelies
    components: [
      makeComponent('engine', { key: 'KeyW', idle: 900, revLimit: 6800, inertia: 0.25, response: 0.06, throttle: 0 }),
      makeComponent('clutch', {
        in: 'crank',
        out: 'clutch',
        maxTorque: 380,
        key: 'KeyC',
        centrifugal: true,
        engageRpm: 1300,
        lockRpm: 2400,
      }),
      makeComponent('gearbox', {
        in: 'clutch',
        out: 'driveshaft',
        ratios: '3, 1.9, 1.3, 0.95',
        reverse: 3,
        mode: 'auto',
        gear: 1,
        upKey: 'KeyE',
        downKey: 'KeyQ',
        reverseKey: 'KeyR',
        upRpm: 4300,
        downRpm: 1900,
        shiftTime: 0.12,
      }),
      makeComponent('differential', {
        in: 'driveshaft',
        left: 'left',
        right: 'right',
        finalDrive: 4,
        lockKey: 'KeyL',
      }),
    ],
  });
  const wheelMat = { preset: 'rubber', density: 420, color: '#24262b', roughness: 0.9, friction: 1.5 };
  const corners = [
    { tag: 'front left', x: 0.85, z: -0.8, front: true },
    { tag: 'front right', x: 0.85, z: 0.8, front: true },
    { tag: 'rear left', x: -0.85, z: -0.8, front: false, shaft: 'left' },
    { tag: 'rear right', x: -0.85, z: 0.8, front: false, shaft: 'right' },
  ];
  const hubMat = { preset: 'steel', density: 8000 };
  for (const c of corners) {
    const brake = makeComponent('brake', { torque: 900, key: 'KeyS', parkKey: 'KeyP', parkTorque: 700 });
    let carrier: BodyEntity = chassis;
    if (c.front) {
      // steering: a vertical hinge whose position motor follows A / D
      const knuckle = b.body(`${name} ${c.tag} knuckle`, 'box', [0.14, 0.14, 0.14], [c.x, WHEEL_R, c.z], {
        ghost: true,
        hidden: true,
        material: hubMat,
      });
      b.joint('hinge', chassis, knuckle, [c.x, WHEEL_R, c.z], [0, 1, 0], {
        name: `${name} ${c.tag} steering`,
        limit: { enabled: true, min: -0.55, max: 0.55 },
        motor: {
          mode: 'position',
          targetVelocity: 0,
          targetPosition: 0.42,
          stiffness: 9000,
          damping: 900,
          maxForce: 6000,
          keyPos: 'KeyA',
          keyNeg: 'KeyD',
          slewRate: 2.4,
          brake: true,
        },
      });
      carrier = knuckle;
    }
    const wheel = b.body(
      `${name} ${c.tag} wheel`,
      'cylinder',
      [WHEEL_R * 2, WHEEL_W, WHEEL_R * 2],
      [c.x, WHEEL_R, c.z],
      {
        rotation: rotX(90),
        ccd: true,
        massOverride: 22,
        material: wheelMat,
      },
    );
    // The axle axis is −Z so that a positive shaft speed rolls the car toward +X.
    b.joint('hinge', carrier, wheel, [c.x, WHEEL_R, c.z], [0, 0, -1], {
      name: `${name} ${c.tag} axle`,
      motor: idleMotor(),
      components: c.shaft ? [makeComponent('driveShaft', { shaft: c.shaft }), brake] : [brake],
    });
  }
  return chassis;
}

function carEntities(): Entity[] {
  const b = new Builder('Powertrain car');
  b.doc.settings.solverIterations = 10;
  buildPowertrainCar(b);
  return b.doc.entities;
}

registerPrefab({
  id: 'powertrain-car',
  name: 'Powertrain car',
  icon: 'engine',
  category: 'Powered parts',
  blurb: 'Engine, clutch, gearbox, differential and brakes. W throttle, S brake, A / D steer, R reverse, E / Q shift.',
  build: carEntities,
});

registerTemplate({
  id: 'powertrain-car',
  name: 'Powertrain car',
  category: 'Vehicles',
  blurb:
    'A car with a real drive train: torque-curve engine, clutch, gearbox, open or locked differential, disc brakes.',
  hint: 'Press Play, then W to drive, S to brake, A / D to steer, R for reverse, E / Q to shift, L to lock the differential. Select the chassis to watch the engine in the inspector.',
  view: { position: [5.5, 3.2, 7], target: [0, 0.7, 0] },
  follow: 'Powertrain car chassis',
  build() {
    const b = new Builder('Powertrain car');
    b.doc.settings.solverIterations = 10;
    b.doc.settings.ground.halfSize = 160; // room to open it up
    buildPowertrainCar(b);
    // a slippery patch to show what an open differential does — and what locking it (L) is for
    b.body('Ice patch', 'box', [8, 0.1, 3.4], [40, 0.05, 0], { bodyType: 'static', material: 'ice' });
    for (let i = 0; i < 4; i++)
      b.body(`Cone ${i + 1}`, 'cone', [0.5, 0.8, 0.5], [12 + i * 4, 0.4, i % 2 ? 2.2 : -2.2], {
        material: { preset: 'plastic', color: '#ff7a1a' },
      });
    return b.done();
  },
});
