/**
 * Soft vehicles (SF-4, SF-6): a car on pneumatic soft tyres, a car whose chassis is a jelly, and a cloth thrown over a
 * driving car. Rigid parts are ordinary bodies and hinge joints with motors; the soft parts are fastened to them with
 * attachments (`rim` for tyres, `region` for the jelly chassis).
 */
import { Builder, rotX } from '../builder';
import type { Vec3 } from '../../core/math';
import type { BodyEntity } from '../types';
import { registerTemplate } from './registry';
import { boxDensity, fasten, velocityMotor } from './soft-util';

// ── Soft-tyre car ───────────────────────────────────────────────────────────────────────────────────

export const TYRE_CAR = {
  /** Tyre outer diameter, width and sidewall height (the tyre recipe's `size`). */
  tyre: [0.6, 0.22, 0.15] as Vec3,
  chassisKg: 70,
  speed: 4, // rad/s of every hub
};

export function buildTyreCar(): Builder {
  const b = new Builder('Soft-tyre car');
  const R = TYRE_CAR.tyre[0] / 2;
  const chassisSize: Vec3 = [2.0, 0.3, 1.0];
  const chassis = b.body('Chassis', 'box', chassisSize, [0, R + 0.15, 0], {
    material: { preset: 'steel', density: boxDensity(chassisSize, TYRE_CAR.chassisKg), color: '#3b82d9' },
  });
  for (const [tag, x, z] of [
    ['front left', 0.75, -1],
    ['front right', 0.75, 1],
    ['rear left', -0.75, -1],
    ['rear right', -0.75, 1],
  ] as const) {
    const hz = z * (chassisSize[2] / 2 + TYRE_CAR.tyre[1] / 2 + 0.12);
    const hub = b.body(`${tag} hub`, 'cylinder', [0.2, TYRE_CAR.tyre[1], 0.2], [x, R, hz], {
      rotation: rotX(90),
      material: { preset: 'steel', density: 2500, color: '#c9ced6' },
      ccd: false,
    });
    // The axle axis is −Z so that a positive motor speed rolls the car toward +X.
    b.joint('hinge', chassis, hub, [x, R, hz], [0, 0, -1], {
      name: `${tag} axle`,
      motor: velocityMotor(TYRE_CAR.speed, 30, 40),
    });
    const tyre = b.soft(`${tag} tyre`, 'tyre', [x, R, hz], {
      rotation: rotX(90),
      size: TYRE_CAR.tyre,
      stiffness: 150, // 400 drives fine but pumps energy into the car once it rolls; 150 holds the car and rolls true
      volumeFactor: 1.3,
      mass: 4,
      friction: 1.4,
    });
    tyre.attachments.push({
      id: `${tyre.id}-rim`,
      body: hub.id,
      kind: 'rim',
      center: [0, 0, 0],
      radius: 0.1,
      offset: [0, 0, 0],
    });
  }
  return b;
}

registerTemplate({
  id: 'soft-tyre-car',
  name: 'Soft-tyre car',
  category: 'Soft bodies',
  blurb:
    'A rigid chassis on four pneumatic soft tyres fastened to motor-driven hubs: the air in the tyres carries the car.',
  hint: 'Press Play: the car drives off on its inflated tyres. Select a tyre and lower its volume factor to let air out.',
  view: { position: [4.5, 2, 6], target: [1.5, 0.5, 0] },
  follow: 'Chassis',
  build: () => buildTyreCar().done(),
});

// ── Jelly car ───────────────────────────────────────────────────────────────────────────────────────

export const JELLY_CAR = { size: [2.0, 0.5, 1.0] as Vec3, kg: 30, speed: 6, stiffness: 25 };

export function buildJellyCar(): Builder {
  const b = new Builder('Jelly car');
  const [L, H, W] = JELLY_CAR.size;
  const wheelR = 0.3;
  const wheelY = wheelR;
  const jelly = b.soft('Jelly chassis', 'mesh', [0, wheelY + 0.15, 0], {
    shape: { type: 'box', size: JELLY_CAR.size },
    size: JELLY_CAR.size,
    cell: 0.25,
    mass: JELLY_CAR.kg,
    stiffness: JELLY_CAR.stiffness,
    damping: 0.4,
    color: '#ff6fae',
    friction: 0.8,
  });
  void H;
  for (const [axleTag, sx] of [
    ['front', 1],
    ['rear', -1],
  ] as const) {
    const x = sx * (L / 2 - 0.35);
    // One rigid axle bar passes through the jelly's lower part and sticks out on both sides…
    const axle = b.body(`${axleTag} axle`, 'box', [0.14, 0.14, W + 0.3], [x, wheelY, 0], {
      material: { preset: 'steel', density: 2500, color: '#c9ced6' },
    });
    // …the jelly is fastened to it at two places, one under each side of the body
    // (ahead of and behind the axle line, so the jelly also holds the axle against the drive torque)
    for (const sz of [-1, 1])
      for (const dx of [-0.3, 0.3]) fasten(jelly, axle, [x + dx, wheelY, sz * (W / 2 - 0.2)], 0.22);
    for (const [sideTag, sz] of [
      ['left', -1],
      ['right', 1],
    ] as const) {
      const wz = sz * (W / 2 + 0.15 + 0.09);
      const wheel = b.body(`${axleTag} ${sideTag} wheel`, 'cylinder', [wheelR * 2, 0.14, wheelR * 2], [x, wheelY, wz], {
        rotation: rotX(90),
        ccd: true,
        massOverride: 3,
        material: { preset: 'rubber', color: '#24262b', friction: 1.4 },
      });
      b.joint('hinge', axle, wheel, [x, wheelY, wz], [0, 0, -1], {
        name: `${axleTag} ${sideTag} hub`,
        motor: velocityMotor(JELLY_CAR.speed, 10, 12),
      });
    }
  }
  return b;
}

registerTemplate({
  id: 'jelly-car',
  name: 'Jelly car',
  category: 'Soft bodies',
  blurb:
    'A jelly block is the chassis: two rigid axles are buried in its lower part and carry the motor-driven wheels.',
  hint: 'Press Play: the jelly body wobbles as the car drives. Make the jelly stiffer in the inspector for a firmer ride.',
  view: { position: [4.5, 2, 6], target: [1.5, 0.6, 0] },
  build: () => buildJellyCar().done(),
});

// ── Cloth over a moving car ─────────────────────────────────────────────────────────────────────────

export const CLOTH_CAR = { speed: 8 };

export function buildClothOverCar(): Builder {
  const b = new Builder('Cloth over a moving car');
  const chassisSize: Vec3 = [2.0, 0.5, 1.1];
  const chassis = b.body('Car', 'box', chassisSize, [0, 0.6, 0], {
    material: { preset: 'steel', density: boxDensity(chassisSize, 120), color: '#3b82d9' },
  });
  const cabin: Vec3 = [1.0, 0.4, 0.95];
  const roof = b.body('Car cabin', 'box', cabin, [-0.2, 1.05, 0], { material: { preset: 'steel', color: '#2d6bb5' } });
  b.joint('fixed', chassis, roof, [-0.2, 0.85, 0], [0, 1, 0], { name: 'Cabin weld' });
  for (const [x, z] of [
    [0.7, -1],
    [0.7, 1],
    [-0.7, -1],
    [-0.7, 1],
  ] as const) {
    const wz = z * 0.72;
    const wheel: BodyEntity = b.body('Car wheel', 'cylinder', [0.6, 0.2, 0.6], [x, 0.3, wz], {
      rotation: rotX(90),
      ccd: true,
      massOverride: 6,
      material: { preset: 'rubber', color: '#24262b', friction: 1.4 },
    });
    b.joint('hinge', chassis, wheel, [x, 0.3, wz], [0, 0, -1], {
      name: 'Car axle',
      motor: velocityMotor(CLOTH_CAR.speed, 40, 120),
    });
  }
  b.soft('Cloth', 'cloth', [0.2, 1.7, 0], {
    size: [2.8, 0, 2.2],
    resolution: 20,
    mass: 1.6,
    stiffness: 40,
    damping: 0.4,
    friction: 1.2,
    color: '#e8c15a',
  });
  return b;
}

registerTemplate({
  id: 'cloth-over-a-moving-car',
  name: 'Cloth over a moving car',
  category: 'Soft bodies',
  blurb: 'A cloth drapes over a car that drives off; friction drags it along until it slides off the back.',
  hint: 'Press Play: the cloth falls onto the car, then the car pulls away. Raise the cloth friction to make it cling.',
  view: { position: [5, 3, 7], target: [1.5, 0.8, 0] },
  follow: 'Car',
  build: () => buildClothOverCar().done(),
});
