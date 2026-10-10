/**
 * Powered machines (package CP): one example scene or prefab for every family of drive and actuator — an engine on a
 * test stand, an electric rover, a two-joint servo arm, a stepper turntable, a lift table, a hydraulic crane. Each is
 * built from ordinary bodies and joints with the powered components attached, and each has a test in
 * `tests/powered.content.test.ts` that checks the thing it promises.
 */
import { DEG, type Vec3 } from '../../core/math';
import { Builder, rotX, rotZ } from '../builder';
import { makeComponent } from '../componentRegistry';
import type { BodyEntity, Entity, SceneDocument } from '../types';
import { registerPrefab, registerTemplate } from './registry';

// ── engine test stand ─────────────────────────────────────────────────────────────────────────────

function engineStand(): SceneDocument {
  const b = new Builder('Engine test stand');
  const frame = b.body('Stand', 'box', [2.6, 0.5, 1.2], [0, 0.25, 0], {
    bodyType: 'static',
    material: { preset: 'steel', color: '#3a4350' },
    components: [
      makeComponent('engine', { key: 'KeyW', idle: 900, revLimit: 6800, inertia: 0.25, response: 0.05, throttle: 0 }),
      // the clutch lets the engine rev freely while the flywheel is disconnected (hold C), then re-couples it
      makeComponent('clutch', { in: 'crank', out: 'clutch', maxTorque: 320, key: 'KeyC' }),
      makeComponent('gearbox', {
        in: 'clutch',
        out: 'load',
        ratios: '8',
        reverse: 8,
        gear: 1,
        upKey: '',
        downKey: '',
        neutralKey: 'KeyN',
        efficiency: 0.98,
      }),
    ],
  });
  // a 40 kg flywheel disc, 0.5 m radius, on a horizontal shaft (axis z): I = ½·m·r² = 5 kg·m²
  const fly = b.body('Flywheel', 'cylinder', [1, 0.2, 1], [0, 1.1, 0], {
    rotation: rotX(90),
    massOverride: 40,
    material: { preset: 'steel', color: '#c9a227', metalness: 0.7, roughness: 0.3 },
  });
  b.body('Notch', 'box', [0.12, 0.12, 0.26], [0.42, 1.1, 0], {
    massOverride: 0.5,
    material: { preset: 'plastic', color: '#d94a3b' },
  });
  b.joint('fixed', fly, b.doc.entities[b.doc.entities.length - 1] as BodyEntity, [0.42, 1.1, 0], [0, 0, 1], {
    name: 'Notch mount',
  });
  b.joint('hinge', frame, fly, [0, 1.1, 0], [0, 0, 1], {
    name: 'Flywheel shaft',
    components: [
      makeComponent('driveShaft', { shaft: 'load', inertia: 0.02 }),
      makeComponent('brake', { torque: 400, key: 'KeyS', response: 0.05 }),
    ],
  });
  // the stand's pillow block, so the shaft has something to turn in
  b.body('Bearing', 'box', [0.5, 0.7, 0.5], [0, 0.85, -0.4], { bodyType: 'static', material: 'concrete' });
  return b.done();
}

registerTemplate({
  id: 'engine-stand',
  name: 'Engine test stand',
  category: 'Powered parts',
  blurb:
    'An engine on a stand turns a flywheel through a clutch and an 8:1 gear: watch rpm, torque and power build with the throttle.',
  hint: 'Press Play. Hold W for throttle, C to disconnect the clutch (the engine then revs freely), S to brake, N for neutral. Select the stand to read the engine; double-click the torque curve to reshape it.',
  view: { position: [3.5, 2.2, 4.5], target: [0, 0.9, 0] },
  build: engineStand,
});

// ── electric rover ────────────────────────────────────────────────────────────────────────────────

/**
 * A differential-drive rover: two driven wheels, each on its own motor, and a slippery castor ball at the rear (three
 * points of support, so it never rocks on a diagonal pair of wheels).
 */
export function buildRover(b: Builder, name: string, at: Vec3): BodyEntity {
  const r = 0.3;
  const chassis = b.body(`${name} chassis`, 'box', [1.2, 0.2, 0.7], [at[0], at[1] + 0.35, at[2]], {
    massOverride: 30,
    comOverride: [-0.12, -0.05, 0], // a little behind the axle: it rests on the castor and never tips forward
    material: { preset: 'aluminum', color: '#e8a33d' },
  });
  for (const side of [-1, 1]) {
    const p: Vec3 = [at[0] + 0.25, at[1] + r, at[2] + side * 0.45];
    const wheel = b.body(`${name} wheel`, 'cylinder', [r * 2, 0.12, r * 2], p, {
      rotation: rotX(90),
      massOverride: 2,
      ccd: true,
      material: { preset: 'rubber', color: '#24262b', friction: 1.2 },
    });
    const left = side < 0;
    b.joint('hinge', chassis, wheel, p, [0, 0, -1], {
      name: `${name} ${left ? 'left' : 'right'} drive`,
      components: [
        makeComponent('motor', {
          stallTorque: 12,
          noLoadRpm: 150,
          currentLimit: 10,
          inertia: 0.002,
          ratio: 1,
          duty: 0,
          key: left ? 'KeyQ' : 'KeyE',
          keyReverse: left ? 'KeyA' : 'KeyD',
          axis: left ? 'left' : 'right',
          idle: 'brake',
        }),
      ],
    });
  }
  const ball = b.body(`${name} castor`, 'sphere', [0.24, 0.24, 0.24], [at[0] - 0.5, at[1] + 0.13, at[2]], {
    massOverride: 0.5,
    material: { preset: 'steel', friction: 0.05 },
  });
  b.joint('ball', chassis, ball, ball.position, [0, 1, 0], { name: `${name} castor mount` }); // a ball joint: the castor rolls
  return chassis;
}

registerTemplate({
  id: 'electric-rover',
  name: 'Electric rover',
  category: 'Powered parts',
  blurb: 'Two wheel motors with back-EMF droop and a supply limit, driven tank-style by keys or two analog axes.',
  hint: 'Press Play. Q / A drive the left wheel forward / back, E / D the right wheel: both forward to go straight, opposite to spin on the spot. Or open Controls and drag the left / right sliders.',
  view: { position: [3.2, 2.2, 4], target: [0, 0.3, 0] },
  follow: 'Rover chassis',
  build() {
    const b = new Builder('Electric rover');
    b.doc.settings.ground.halfSize = 80;
    buildRover(b, 'Rover', [0, 0, 0]);
    for (let i = 0; i < 4; i++)
      b.body(`Cone ${i + 1}`, 'cone', [0.4, 0.6, 0.4], [4 + i * 3, 0.3, i % 2 ? 1.2 : -1.2], {
        material: { preset: 'plastic', color: '#ff7a1a' },
      });
    return b.done();
  },
});

registerPrefab({
  id: 'electric-rover',
  name: 'Electric rover',
  icon: 'motor',
  category: 'Powered parts',
  blurb: 'A tank-drive rover: Q / A left motor, E / D right motor (or the left / right analog axes).',
  build: () => {
    const b = new Builder('Electric rover');
    buildRover(b, 'Rover', [0, 0, 0]);
    return b.doc.entities;
  },
});

// ── servo arm ─────────────────────────────────────────────────────────────────────────────────────

function servoArm(): Entity[] {
  const b = new Builder('Servo arm');
  const base = b.body('Arm base', 'box', [0.9, 0.3, 0.9], [0, 0.15, 0], { bodyType: 'static', material: 'concrete' });
  const y = 0.55;
  const l1 = b.body('Upper arm', 'box', [1.5, 0.16, 0.22], [0.75, y, 0], {
    massOverride: 3,
    material: { preset: 'aluminum', color: '#7fb4e8' },
  });
  const l2 = b.body('Forearm', 'box', [1.2, 0.14, 0.2], [1.5 + 0.6, y, 0], {
    massOverride: 2.5,
    material: { preset: 'aluminum', color: '#e8a33d' },
  });
  const tip = b.body('Gripper', 'sphere', [0.22, 0.22, 0.22], [2.7, y, 0], {
    massOverride: 1.5,
    material: { preset: 'steel' },
  });
  b.joint('hinge', base, l1, [0, y, 0], [0, 0, 1], {
    name: 'Shoulder servo',
    components: [
      makeComponent('servo', {
        target: 25,
        minAngle: -30,
        maxAngle: 85,
        maxTorque: 160,
        maxSpeed: 60,
        keyPlus: 'KeyW',
        keyMinus: 'KeyS',
        jogRate: 40,
      }),
    ],
  });
  b.joint('hinge', l1, l2, [1.5, y, 0], [0, 0, 1], {
    name: 'Elbow servo',
    components: [
      makeComponent('servo', {
        target: -35,
        minAngle: -120,
        maxAngle: 120,
        maxTorque: 70,
        maxSpeed: 90,
        kd: 0.1,
        keyPlus: 'KeyD',
        keyMinus: 'KeyA',
        jogRate: 60,
      }),
    ],
  });
  b.joint('fixed', l2, tip, [2.7, y, 0], [0, 0, 1], { name: 'Gripper mount' });
  return b.doc.entities;
}

registerTemplate({
  id: 'servo-arm',
  name: 'Servo arm',
  category: 'Powered parts',
  blurb: 'Two PID servos hold a heavy arm against gravity, with a speed cap and a torque limit.',
  hint: 'Press Play: the arm swings to the servos’ targets. Hold W / S to jog the shoulder, A / D the elbow. Lower the shoulder torque limit in the inspector and watch it sag.',
  view: { position: [1.5, 1.6, 5.5], target: [1.4, 0.7, 0] },
  build() {
    const b = new Builder('Servo arm');
    b.doc.entities = servoArm();
    return b.done();
  },
});
registerPrefab({
  id: 'servo-arm',
  name: 'Servo arm',
  icon: 'servo',
  category: 'Powered parts',
  blurb: 'A two-joint arm with PID servos: W / S shoulder, A / D elbow.',
  build: servoArm,
});

// ── stepper turntable ─────────────────────────────────────────────────────────────────────────────

function stepperDial(): Entity[] {
  const b = new Builder('Stepper turntable');
  const base = b.body('Dial base', 'box', [1.4, 0.3, 1.4], [0, 0.15, 0], { bodyType: 'static', material: 'concrete' });
  const table = b.body('Turntable', 'cylinder', [1.4, 0.1, 1.4], [0, 0.35, 0], {
    massOverride: 12,
    material: { preset: 'aluminum', color: '#9fb6c8' },
  });
  const pointer = b.body('Pointer', 'box', [0.62, 0.06, 0.1], [0.38, 0.43, 0], {
    massOverride: 0.5,
    material: { preset: 'plastic', color: '#d94a3b' },
  });
  b.joint('fixed', table, pointer, [0.1, 0.4, 0], [0, 1, 0], { name: 'Pointer mount' });
  b.joint('hinge', base, table, [0, 0.3, 0], [0, 1, 0], {
    name: 'Stepper',
    components: [
      makeComponent('stepper', {
        stepAngle: 7.5,
        holdTorque: 6,
        damping: 0.5,
        stepKey: 'KeyE',
        stepKeyReverse: 'KeyQ',
        repeatRate: 10,
        axis: '',
        pulseRate: 0,
      }),
    ],
  });
  return b.doc.entities;
}
registerTemplate({
  id: 'stepper-dial',
  name: 'Stepper turntable',
  category: 'Powered parts',
  blurb:
    'A stepper motor turns a table in 7.5° steps from key presses or a pulse train; it holds up to its holding torque.',
  hint: 'Press Play. Tap E for one step forward, Q for one step back; hold a key to repeat. Set “Constant pulses” in the inspector for a pulse train, or raise the pulse rate until the table loses steps.',
  view: { position: [0, 3, 3.2], target: [0, 0.3, 0] },
  build() {
    const b = new Builder('Stepper turntable');
    b.doc.entities = stepperDial();
    return b.done();
  },
});
registerPrefab({
  id: 'stepper-dial',
  name: 'Stepper turntable',
  icon: 'stepper',
  category: 'Powered parts',
  blurb: 'A turntable on a stepper motor: E / Q step forward / back.',
  build: stepperDial,
});

// ── lift table (linear actuator on an analog axis) ────────────────────────────────────────────────

function liftTable(): Entity[] {
  const b = new Builder('Lift table');
  const base = b.body('Lift base', 'box', [2.2, 0.2, 2.2], [0, 0.1, 0], { bodyType: 'static', material: 'concrete' });
  b.body('Lift guide', 'box', [0.16, 3.4, 0.16], [-1.0, 1.7, -1.0], { bodyType: 'static', material: 'steel' });
  const deck = b.body('Lift deck', 'box', [1.8, 0.14, 1.8], [0, 0.27, 0], {
    massOverride: 40,
    material: { preset: 'steel', color: '#3b82d9' },
  });
  b.body('Crate', 'box', [0.8, 0.8, 0.8], [0, 0.74, 0], { massOverride: 60, material: 'wood' });
  b.joint('slider', base, deck, [0, 0.2, 0], [0, 1, 0], {
    name: 'Lift actuator',
    components: [
      makeComponent('linearActuator', { target: 0, min: 0, max: 2.6, speed: 0.8, force: 3500, kp: 8, axis: 'lift' }),
    ],
  });
  return b.doc.entities;
}
registerTemplate({
  id: 'lift-table',
  name: 'Lift table',
  category: 'Powered parts',
  blurb: 'A linear actuator raises a loaded deck to wherever an analog axis says, within its force and speed limits.',
  hint: 'Press Play, open the Controls tab and drag the “lift” slider: −1 is the bottom of the travel, +1 the top (2.6 m). Add 400 kg to the crate and the actuator will stall at its force limit.',
  view: { position: [5.5, 3, 6], target: [0, 1.3, 0] },
  build() {
    const b = new Builder('Lift table');
    b.doc.entities = liftTable();
    return b.done();
  },
});
registerPrefab({
  id: 'lift-table',
  name: 'Lift table',
  icon: 'actuator',
  category: 'Powered parts',
  blurb: 'A deck raised by a linear actuator on the “lift” analog axis.',
  build: liftTable,
});

// ── hydraulic crane ───────────────────────────────────────────────────────────────────────────────

function hydraulicCrane(): Entity[] {
  const b = new Builder('Hydraulic crane');
  const base = b.body('Crane base', 'box', [3.2, 0.5, 1.4], [0, 0.25, 0], { bodyType: 'static', material: 'concrete' });
  const pivot: Vec3 = [0, 1.0, 0];
  // (the pivot sits on a short pedestal; the boom swings clear of it)
  b.body('Crane pedestal', 'box', [0.4, 0.3, 0.5], [0, 0.65, 0], { bodyType: 'static', material: 'concrete' });
  const ang = 40;
  const d: Vec3 = [Math.cos(ang * DEG), Math.sin(ang * DEG), 0];
  const nrm: Vec3 = [-Math.sin(ang * DEG), Math.cos(ang * DEG), 0];
  const boomLen = 3.6;
  const at = (s: number, off = 0): Vec3 => [pivot[0] + d[0] * s + nrm[0] * off, pivot[1] + d[1] * s + nrm[1] * off, 0];
  const boom = b.body('Boom', 'box', [boomLen, 0.22, 0.4], at(boomLen / 2), {
    rotation: rotZ(ang),
    massOverride: 40,
    material: { preset: 'steel', color: '#e8a33d' },
  });
  const load = b.body('Payload', 'box', [0.5, 0.5, 0.5], at(boomLen + 0.1, -0.1), {
    massOverride: 40,
    rotation: rotZ(ang),
    material: 'lead',
  });
  b.joint('fixed', boom, load, at(boomLen, 0), [0, 0, 1], { name: 'Payload hook' });
  b.joint('hinge', base, boom, pivot, [0, 0, 1], { name: 'Boom pivot' });
  // the cylinder: barrel pinned to the base, rod pinned under the boom, a slider between them
  // the foot sits in front of the pivot, under the boom: the cylinder stands almost upright, a long lever arm to the pivot
  const foot: Vec3 = [1.35, 0.5, 0];
  const head = at(1.4, -0.12);
  const len = Math.hypot(head[0] - foot[0], head[1] - foot[1]);
  const u: Vec3 = [(head[0] - foot[0]) / len, (head[1] - foot[1]) / len, 0];
  const along = (s: number): Vec3 => [foot[0] + u[0] * s, foot[1] + u[1] * s, 0];
  const tilt = Math.atan2(u[1], u[0]) / DEG;
  const barrel = b.body('Cylinder barrel', 'box', [len * 0.5, 0.16, 0.16], along(len * 0.25), {
    rotation: rotZ(tilt),
    ghost: true,
    massOverride: 60, // heavy on purpose: a light link in a loop with a heavy load makes the solver converge slowly

    material: { preset: 'steel', color: '#5b6b7b' },
  });
  const rod = b.body('Cylinder rod', 'box', [len * 0.5, 0.09, 0.09], along(len * 0.75), {
    rotation: rotZ(tilt),
    ghost: true,
    massOverride: 40,

    material: { preset: 'aluminum', color: '#d6e4f2' },
  });
  b.joint('hinge', base, barrel, foot, [0, 0, 1], { name: 'Cylinder foot' });
  b.joint('hinge', rod, boom, head, [0, 0, 1], { name: 'Cylinder head' });
  b.joint('slider', barrel, rod, along(len * 0.5), u, {
    name: 'Hydraulic cylinder',
    components: [
      makeComponent('hydraulicCylinder', {
        pressure: 90,
        bore: 63,
        rod: 36,
        flow: 25,
        min: -0.5,
        max: 0.5,
        key: 'KeyW',
        keyReverse: 'KeyS',
        idle: 'hold',
        relief: 180,
      }),
    ],
  });
  return b.doc.entities;
}
registerTemplate({
  id: 'hydraulic-crane',
  name: 'Hydraulic crane',
  category: 'Powered parts',
  blurb:
    'A boom raised by a double-acting hydraulic cylinder: force = pressure × area, speed = flow ÷ area, holds the load when the valve is centred.',
  hint: 'Press Play. Hold W to extend the cylinder and raise the boom, S to lower it; release and the oil holds the 40 kg payload. Lower the pump pressure in the inspector until it can no longer lift.',
  view: { position: [2.5, 3, 9], target: [1.5, 2, 0] },
  build() {
    const b = new Builder('Hydraulic crane');
    b.doc.settings.solverIterations = 12;
    b.doc.entities = hydraulicCrane();
    return b.done();
  },
});
registerPrefab({
  id: 'hydraulic-crane',
  name: 'Hydraulic crane',
  icon: 'hydraulic',
  category: 'Powered parts',
  blurb: 'A boom on a hydraulic cylinder: W / S raise and lower, the valve holds the load.',
  build: hydraulicCrane,
});
