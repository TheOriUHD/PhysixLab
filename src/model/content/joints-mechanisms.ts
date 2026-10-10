/**
 * Joint mechanisms (package JT-A): one worked example for each of the ten joint types added by the package.
 *
 *  - **Atwood machine** (pulley) — two masses on one rope over a wheel.
 *  - **Gear train** (gear) — a reversing three-gear reduction.
 *  - **Belt & chain drive** (belt) — a 2:1 belt reduction and a chain that slips under load.
 *  - **Rack and pinion** (rack) — a motor turns a pinion, the rack travels r·θ.
 *  - **Screw jack** (screw) — a spindle lifts a loaded platform by one pitch per turn.
 *  - **Crane hoists** (winch) — two hoists on one jib; the one with too small a load rating cannot lift.
 *  - **Ragdoll arms** (cone-twist) — shoulders that swing inside a cone.
 *  - **Spring-mounted platform** (6-DOF) — a platform that moves on one axis and tilts on two, all on springs.
 *  - **Cardan drive shaft** (universal) — two universal joints carry the spin around a bend.
 *  - **Soft diving board** (soft weld) — a board built of compliant welds that flexes and recovers.
 *
 * Everything is built from the ordinary primitives of the editor (bodies, hinges, sliders and the new joints), so any
 * scene can be taken apart. Coupling joints (gear, belt, rack, pulley, winch) join bodies that each already have
 * their own support — see "How to add a joint type" in docs/EXTENDING.md. `tests/jointExamples.test.ts` runs every
 * scene and checks its physics.
 */
import { qfromUnitVectors, qrotInv, type Quat, type Vec3 } from '../../core/math';
import { Builder, rotX, rotZ, type BodyOpts } from '../builder';
import { defaultDof, defaultParams, type JointParams } from '../jointParams';
import type { BodyEntity, ColliderPart, Entity, JointEntity, MotorSpec, SceneDocument } from '../types';
import { registerPrefab, registerTemplate } from './registry';

const CATEGORY = 'Mechanisms';
const Y: Vec3 = [0, 1, 0];
const Z: Vec3 = [0, 0, 1];

// ── shared helpers ────────────────────────────────────────────────────────────────────────────────────

const params = (over: Partial<JointParams>): JointParams => ({ ...defaultParams(), ...over });

const motor = (m: Partial<MotorSpec>): MotorSpec => ({
  mode: 'velocity',
  targetVelocity: 0,
  targetPosition: 0,
  stiffness: 0,
  damping: 300,
  maxForce: 2000,
  keyPos: '',
  keyNeg: '',
  slewRate: 1,
  brake: false,
  ...m,
});

const local = (body: BodyEntity, worldAxis: Vec3): Vec3 => qrotInv(body.rotation, worldAxis);

const part = (id: string, type: string, size: Vec3, position: Vec3, rotation: Quat, color?: string): ColliderPart => ({
  id,
  shape: { type, size },
  position,
  rotation,
  ...(color ? { material: { color } } : {}),
});

/**
 * A flat disc (gear, pulley, flywheel) whose axle is world +Z, with a bar across it and a bright pointer near the rim
 * so its rotation can be seen. Made of three colliders on one body.
 */
function disc(
  b: Builder,
  name: string,
  r: number,
  thick: number,
  at: Vec3,
  color: string,
  o: BodyOpts = {},
): BodyEntity {
  const cyl: Vec3 = [2 * r, thick, 2 * r];
  const id: Quat = [0, 0, 0, 1];
  const parts = [
    part('disc', 'cylinder', cyl, [0, 0, 0], id),
    part('bar', 'box', [1.7 * r, thick + 0.02, 0.1 * r + 0.02], [0, 0, 0], id, '#1f2937'),
    part('pointer', 'box', [0.28 * r, thick + 0.04, 0.2 * r + 0.02], [0.72 * r, 0, 0], id, '#fbbf24'),
  ];
  return b.body(name, 'cylinder', cyl, at, {
    rotation: rotX(90),
    material: { preset: 'steel', color },
    parts,
    ...o,
  });
}

/** A static support (post, bracket, base) in a muted metal. */
const frame = (b: Builder, name: string, size: Vec3, at: Vec3, color = '#4b5563'): BodyEntity =>
  b.body(name, 'box', size, at, { bodyType: 'static', material: { preset: 'steel', color }, tags: ['support'] });

/** A hinge to the world about `axis`, optionally driven. */
function axle(b: Builder, name: string, body: BodyEntity, axis: Vec3, m?: Partial<MotorSpec>): JointEntity {
  const j = b.joint('hinge', null, body, body.position, axis, { name });
  if (m) j.motor = motor(m);
  return j;
}

// ── 1 · Atwood machine (pulley) ────────────────────────────────────────────────────────────────────────

function atwood(): Builder {
  const b = new Builder('Atwood machine');
  const top = 7.2;
  frame(b, 'Mast', [0.3, top, 0.3], [0, top / 2, -0.7]);
  frame(b, 'Pulley arm', [0.2, 0.2, 0.8], [0, top, -0.35]);
  b.body('Pulley wheel', 'cylinder', [1.2, 0.2, 1.2], [0, top, 0], {
    bodyType: 'static',
    rotation: rotX(90),
    material: { preset: 'aluminum', color: '#d1d5db' },
    tags: ['support'],
  });
  const m1 = b.body('Light mass (2 kg)', 'box', [0.5, 0.5, 0.5], [-0.6, 3, 0], {
    massOverride: 2,
    material: { preset: 'aluminum', color: '#60a5fa' },
    tags: ['atwood'],
  });
  const m2 = b.body('Heavy mass (3 kg)', 'box', [0.6, 0.6, 0.6], [0.6, 3, 0], {
    massOverride: 3,
    material: { preset: 'steel', color: '#f97316' },
    tags: ['atwood'],
  });
  b.joint('pulley', m1, m2, [-0.6, 3.25, 0], Z, {
    name: 'Rope over the pulley',
    anchorA: [0, 0.25, 0],
    anchorB: [0, 0.3, 0],
    params: params({ pulleyA: [-0.6, top, 0], pulleyB: [0.6, top, 0], ratio: 1 }),
  });
  return b;
}

// ── 2 · Gear train (gear) ──────────────────────────────────────────────────────────────────────────────

function gearTrain(): Builder {
  const b = new Builder('Gear train');
  const rA = 0.4,
    rB = 0.8,
    rC = 1.2,
    gap = 0.03,
    y = 1.6;
  const xA = -2.2;
  const xB = xA + rA + rB + gap;
  const xC = xB + rB + rC + gap;
  const gears = [
    { name: 'Input gear (0.4 m)', r: rA, x: xA, color: '#f59e0b', mass: 2 },
    { name: 'Idler gear (0.8 m)', r: rB, x: xB, color: '#14b8a6', mass: 6 },
    { name: 'Output gear (1.2 m)', r: rC, x: xC, color: '#8b5cf6', mass: 12 },
  ].map((g, i) => {
    frame(b, `Axle post ${i + 1}`, [0.14, y, 0.14], [g.x, y / 2, -0.25]);
    const body = disc(b, g.name, g.r, 0.2, [g.x, y, 0], g.color, { massOverride: g.mass, tags: ['gear'] });
    axle(
      b,
      `Axle ${i + 1}`,
      body,
      Z,
      i === 0 ? { targetVelocity: 6, maxForce: 800, damping: 400 } : { mode: 'off', damping: 0 },
    );
    return { body, r: g.r };
  });
  for (let i = 0; i < 2; i++) {
    const a = gears[i];
    const c = gears[i + 1];
    b.joint('gear', a.body, c.body, a.body.position, Z, {
      name: `Gear mesh ${i + 1}: ${a.r} m ↔ ${c.r} m (reversing)`,
      anchorA: [0, 0, 0],
      anchorB: [0, 0, 0],
      params: params({
        ratio: a.r / c.r,
        reverse: true,
        radiusA: a.r,
        radiusB: c.r,
        axisB: local(c.body, Z),
      }),
    });
  }
  return b;
}

// ── 3 · Belt & chain drive (belt) ──────────────────────────────────────────────────────────────────────

function beltDrive(): Builder {
  const b = new Builder('Belt & chain drive');
  const y = 1.5;
  const row = (z: number, label: string, rA: number, rB: number, o: Partial<JointParams>, load: boolean): void => {
    const xA = -1.7;
    const xB = 1.7;
    const driver = disc(b, `${label} driver`, rA, 0.25, [xA, y, z], '#fb7185', { massOverride: 3, tags: ['belt'] });
    const driven = disc(b, `${label} driven`, rB, 0.25, [xB, y, z], '#38bdf8', { massOverride: 4, tags: ['belt'] });
    for (const x of [xA, xB]) frame(b, `${label} post`, [0.14, y, 0.14], [x, y / 2, z - 0.28]);
    axle(b, `${label} driver axle`, driver, Z, { targetVelocity: 5, maxForce: 900, damping: 500 });
    axle(
      b,
      `${label} driven axle`,
      driven,
      Z,
      // A constant braking torque on the driven shaft: a load the chain cannot always carry.
      load ? { targetVelocity: 0, maxForce: 60, damping: 10 } : { mode: 'off', damping: 0 },
    );
    b.joint('belt', driver, driven, driver.position, Z, {
      name: `${label} (${rA} m → ${rB} m)`,
      anchorA: [0, 0, 0],
      anchorB: [0, 0, 0],
      params: params({ radiusA: rA, radiusB: rB, reverse: false, axisB: local(driven, Z), ...o }),
    });
  };
  row(1.3, 'Belt', 0.35, 0.7, {}, false);
  row(-1.3, 'Chain', 0.5, 0.5, { chain: true, slipTorque: 8 }, true);
  return b;
}

// ── 4 · Rack and pinion (rack) ─────────────────────────────────────────────────────────────────────────

function rackPinion(): Builder {
  const b = new Builder('Rack and pinion');
  const r = 0.4;
  frame(b, 'Guide rail', [5.6, 0.3, 0.8], [0, 0.35, 0], '#374151');
  frame(b, 'Pinion post', [0.16, 2.2, 0.16], [0, 1.1, -0.45]);
  const pinion = disc(b, 'Pinion (r = 0.4 m)', r, 0.3, [0, 0.8 + r, 0], '#f59e0b', { massOverride: 3, tags: ['gear'] });
  const rack = b.body('Rack', 'box', [2.6, 0.2, 0.34], [0, 0.7, 0], {
    massOverride: 6,
    material: { preset: 'steel', color: '#94a3b8' },
    tags: ['rack'],
  });
  axle(b, 'Pinion axle', pinion, Z, { targetVelocity: 0.7, maxForce: 500, damping: 400 });
  b.joint('slider', null, rack, rack.position, [1, 0, 0], {
    name: 'Rack guide',
    limit: { enabled: true, min: -1, max: 1 },
  });
  b.joint('rack', pinion, rack, pinion.position, Z, {
    name: 'Rack ↔ pinion (r = 0.4 m)',
    anchorA: [0, 0, 0],
    anchorB: [0, 0, 0],
    params: params({ radiusA: r, reverse: false, axisB: local(rack, [1, 0, 0]) }),
  });
  for (const sx of [-1, 1])
    b.body('Stop block', 'box', [0.3, 0.5, 0.5], [sx * 2.7, 0.65, 0], {
      bodyType: 'static',
      material: { preset: 'rubber', color: '#ef4444' },
    });
  return b;
}

// ── 5 · Screw jack (screw) ─────────────────────────────────────────────────────────────────────────────

function screwJack(): Builder {
  const b = new Builder('Screw jack');
  const pitch = 0.3;
  frame(b, 'Jack base', [1.8, 0.4, 1.8], [0, 0.2, 0], '#475569');
  frame(b, 'Jack head', [1.2, 0.25, 1.2], [0, 3.55, 0], '#475569');
  frame(b, 'Guide column L', [0.16, 3.3, 0.16], [-0.8, 1.85, 0]);
  frame(b, 'Guide column R', [0.16, 3.3, 0.16], [0.8, 1.85, 0]);
  // A real steel screw is heavy (about 1.1 t): its inertia also lets the thread's coupling row carry the load.
  const spindle = b.body('Lead screw', 'cylinder', [0.24, 2.9, 0.24], [0, 1.9, 0], {
    material: { preset: 'steel', color: '#cbd5e1' },
    parts: [
      part('shaft', 'cylinder', [0.24, 2.9, 0.24], [0, 0, 0], [0, 0, 0, 1]),
      ...[-1.1, -0.65, -0.2, 0.25, 0.7, 1.15].map((y, i) =>
        part(`thread${i}`, 'box', [0.34, 0.06, 0.09], [0, y, 0], [0, 0, 0, 1], '#475569'),
      ),
    ],
    tags: ['screw'],
  });
  // The 30 kg crate is a part of the platform body: a coupling row only sees the two bodies it joins, so a load that
  // merely rested on the platform would not be lifted (docs/LIMITATIONS.md).
  const plate: Vec3 = [1.3, 0.2, 1.3];
  const platform = b.body('Platform (nut + 30 kg crate)', 'box', plate, [0, 0.8, 0], {
    massOverride: 38,
    material: { preset: 'aluminum', color: '#34d399' },
    parts: [
      part('plate', 'box', plate, [0, 0, 0], [0, 0, 0, 1]),
      part('crate', 'box', [0.45, 0.45, 0.45], [0.43, 0.325, 0], [0, 0, 0, 1], '#b9854f'),
    ],
    // The guide columns keep the nut from turning with the screw; the threads do the rest.
    lockRotation: [true, true, true],
    tags: ['screw', 'load'],
  });
  axle(b, 'Spindle drive', spindle, Y, { targetVelocity: -4, maxForce: 300, damping: 250 });
  b.joint('screw', spindle, platform, platform.position, Y, {
    name: `Thread (pitch ${pitch} m)`,
    params: params({ pitch }),
  });
  return b;
}

// ── 6 · Crane hoists (winch) ───────────────────────────────────────────────────────────────────────────

function craneWinch(): Builder {
  const b = new Builder('Crane hoists');
  const top = 7;
  frame(b, 'Crane base', [2.4, 0.3, 2.4], [-3, 0.15, 0], '#374151');
  frame(b, 'Mast', [0.4, top - 0.3, 0.4], [-3, (top + 0.3) / 2, 0], '#f59e0b');
  frame(b, 'Jib', [7.4, 0.3, 0.45], [0.2, top + 0.15, 0], '#f59e0b');
  frame(b, 'Winch house', [0.9, 0.7, 0.7], [-2.2, top + 0.65, 0], '#374151');
  const hoist = (name: string, x: number, rating: number, color: string): void => {
    const sheave = b.body(`${name} sheave`, 'cylinder', [0.3, 0.2, 0.3], [x, top - 0.1, 0], {
      bodyType: 'static',
      rotation: rotX(90),
      material: { preset: 'steel', color: '#9ca3af' },
      tags: ['support'],
    });
    const crate = b.body(`${name} crate (25 kg)`, 'box', [0.8, 0.8, 0.8], [x, 0.4, 0], {
      massOverride: 25,
      material: { preset: 'wood', color },
      tags: ['load'],
    });
    const j = b.joint('winch', sheave, crate, sheave.position, Z, {
      name: `${name} (rating ${rating} N)`,
      anchorA: [0, 0, 0],
      anchorB: [0, 0.4, 0],
      params: params({ loadRating: rating, radiusA: 0.2 }),
    });
    j.motor = motor({ targetVelocity: 0.45, maxForce: 2000 });
  };
  hoist('Hoist', 2.6, 600, '#b9854f');
  hoist('Overloaded hoist', 0.4, 120, '#c2410c');
  return b;
}

// ── 7 · Ragdoll arms (cone-twist) ──────────────────────────────────────────────────────────────────────

/** Torso, head and the two shoulders' anchor points of the ragdoll. */
function ragdollTorso(b: Builder, x: number, z: number): void {
  const skin = '#f2c9a0';
  b.body('Stand', 'box', [1.2, 0.2, 0.9], [x, 0.1, z - 0.2], { bodyType: 'static', material: 'concrete' });
  b.body('Spine post', 'box', [0.2, 1.4, 0.2], [x, 0.8, z - 0.3], { bodyType: 'static', material: 'steel' });
  b.body('Torso', 'box', [1.0, 1.3, 0.45], [x, 2.1, z], {
    bodyType: 'static',
    material: { preset: 'plastic', color: '#3b5b92' },
  });
  b.body('Head', 'sphere', [0.5, 0.5, 0.5], [x, 3.0, z], {
    bodyType: 'static',
    material: { preset: 'plastic', color: skin },
  });
}

/** Velocity of a point `d` metres below the shoulder when the arm spins with `spin` about the shoulder (ω × r). */
const swingVel = (spin: Vec3, d: number): Vec3 => [d * spin[2], 0, -d * spin[0]];

/** One arm: shoulder (cone-twist), elbow and wrist (limited hinges). Returns the three joints. */
function ragdollArm(b: Builder, side: 'L' | 'R', x: number, z: number, spin: Vec3): JointEntity[] {
  const dir = side === 'L' ? -1 : 1;
  const col = side === 'L' ? '#4f7fcb' : '#cb4f6f';
  const skin = '#f2c9a0';
  const torso = b.doc.entities.find((e) => e.kind === 'body' && e.name === 'Torso') as BodyEntity;
  const sh: Vec3 = [x + dir * 0.62, 2.65, z];
  const lu = 0.85,
    lf = 0.8;
  const upper = b.body(`Upper arm ${side}`, 'box', [0.2, lu, 0.2], [sh[0], sh[1] - lu / 2, z], {
    material: { preset: 'plastic', color: col },
    // Flung about the shoulder: the centre gets v = ω × r (r = −lu/2 below the pivot) so the joint has nothing to cancel.
    angularVelocity: spin,
    velocity: swingVel(spin, lu / 2),
    linearDamping: 0.05,
    angularDamping: 0.3,
    canSleep: false,
    tags: ['ragdoll'],
  });
  const el: Vec3 = [sh[0], sh[1] - lu, z];
  const fore = b.body(`Forearm ${side}`, 'box', [0.17, lf, 0.17], [el[0], el[1] - lf / 2, z], {
    material: { preset: 'plastic', color: col },
    angularVelocity: spin,
    velocity: swingVel(spin, lu + lf / 2),
    linearDamping: 0.05,
    angularDamping: 0.3,
    canSleep: false,
    tags: ['ragdoll'],
  });
  const wr: Vec3 = [el[0], el[1] - lf, z];
  const hand = b.body(`Hand ${side}`, 'box', [0.2, 0.24, 0.1], [wr[0], wr[1] - 0.12, z], {
    material: { preset: 'plastic', color: skin },
    angularVelocity: spin,
    velocity: swingVel(spin, lu + lf + 0.12),
    linearDamping: 0.05,
    angularDamping: 0.3,
    canSleep: false,
    tags: ['ragdoll'],
  });
  const down: Vec3 = [0, -1, 0];
  const shoulder = b.joint('conetwist', torso, upper, sh, down, {
    name: `Shoulder ${side} (cone-twist)`,
    params: params({ swing: 0.7, twistMin: -0.4, twistMax: 0.4 }),
  });
  const elbow = b.joint('hinge', upper, fore, el, [1, 0, 0], {
    name: `Elbow ${side} (limited hinge)`,
    limit: { enabled: true, min: -2.2, max: 0 },
  });
  const wrist = b.joint('hinge', fore, hand, wr, [1, 0, 0], {
    name: `Wrist ${side} (limited hinge)`,
    limit: { enabled: true, min: -0.9, max: 0.9 },
  });
  return [shoulder, elbow, wrist];
}

function ragdollArms(): Builder {
  const b = new Builder('Ragdoll arms');
  ragdollTorso(b, 0, 0);
  // The left arm is flung sideways, the right arm forward: the cones stop both.
  ragdollArm(b, 'L', 0, 0, [0, 0, -2.6]);
  ragdollArm(b, 'R', 0, 0, [-2.6, 0, 0]);
  return b;
}

// ── 8 · Spring-mounted platform (6-DOF) ────────────────────────────────────────────────────────────────

function sixDofPlatform(): Builder {
  const b = new Builder('Spring-mounted platform');
  const pedestal = frame(b, 'Pedestal', [0.9, 1.0, 0.9], [0, 0.5, 0], '#374151');
  const plat = b.body('Platform (20 kg)', 'box', [2.6, 0.2, 2.6], [0, 1.7, 0], {
    massOverride: 20,
    material: { preset: 'aluminum', color: '#a7f3d0' },
    tags: ['suspended'],
  });
  // Joint frame: axis +Y makes the frame's x axis point up, y = −X world, z = +Z world.
  const dof = defaultDof();
  dof[0] = { ...dof[0], mode: 'limited', min: -0.4, max: 0.15, stiffness: 1200, damping: 120 }; // heave
  for (const i of [4, 5]) dof[i] = { ...dof[i], mode: 'limited', min: -0.35, max: 0.35, stiffness: 350, damping: 25 }; // tilt
  b.joint('sixdof', pedestal, plat, plat.position, Y, {
    name: '6-DOF mount (heave + tilt on springs)',
    params: params({ dof }),
  });
  const ballAt: [Vec3, string][] = [
    [[0.8, 3.2, 0.3], '#f97316'],
    [[-0.7, 4.8, -0.5], '#6366f1'],
    [[0.1, 6.4, 0.9], '#ec4899'],
  ];
  ballAt.forEach(([p, color], i) =>
    b.body(`Ball ${i + 1}`, 'sphere', [0.5, 0.5, 0.5], p, {
      massOverride: 2,
      material: { preset: 'rubber', color },
      tags: ['drop'],
    }),
  );
  return b;
}

// ── 9 · Cardan drive shaft (universal) ─────────────────────────────────────────────────────────────────

function cardanShaft(): Builder {
  const b = new Builder('Cardan drive shaft');
  const steel = '#9ca3af';
  const yIn = 1.5,
    yOut = 1.95;
  const u1: Vec3 = [-1.2, yIn, 0];
  const u2: Vec3 = [0.5, yOut, 0];
  const bar = (name: string, from: Vec3, to: Vec3, r: number, color: string, extra: BodyOpts = {}): BodyEntity => {
    const d: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    return b.body(name, 'cylinder', [2 * r, len, 2 * r], [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, 0], {
      rotation: qfromUnitVectors(Y, [d[0] / len, d[1] / len, d[2] / len]),
      material: { preset: 'steel', color },
      ...extra,
    });
  };
  frame(b, 'Input bearing', [0.3, yIn - 0.2, 0.5], [-2.6, (yIn - 0.2) / 2, 0]);
  frame(b, 'Output bearing', [0.3, yOut - 0.2, 0.5], [2.9, (yOut - 0.2) / 2, 0]);
  const input = bar('Input shaft', [-2.8, yIn, 0], u1, 0.1, '#f59e0b', { massOverride: 2, tags: ['shaft'] });
  const mid = bar('Intermediate shaft', u1, u2, 0.09, steel, { massOverride: 2, tags: ['shaft'] });
  const output = bar('Output shaft', u2, [3.1, yOut, 0], 0.1, '#14b8a6', { massOverride: 2, tags: ['shaft'] });
  const flywheel = disc(b, 'Flywheel', 0.55, 0.16, [2.3, yOut, 0], '#8b5cf6', { massOverride: 5, tags: ['load'] });
  // The flywheel is a disc about world Z; stand it on the shaft instead (axle along X).
  flywheel.rotation = rotZ(90);
  b.joint('fixed', output, flywheel, flywheel.position, Z, { name: 'Flywheel hub' });
  axle(b, 'Input drive', input, [1, 0, 0], { targetVelocity: 6, maxForce: 300, damping: 200 });
  b.joint('universal', input, mid, u1, [1, 0, 0], { name: 'Universal joint 1' });
  b.joint('universal', mid, output, u2, [1, 0, 0], { name: 'Universal joint 2' });
  axle(b, 'Output bearing joint', output, [1, 0, 0]);
  return b;
}

// ── 10 · Soft diving board (soft weld) ─────────────────────────────────────────────────────────────────

/** The board's segments and welds. `x0` is the root (left end of the first segment). */
function divingBoard(b: Builder, x0: number, yTop: number, base: BodyEntity | null): BodyEntity[] {
  const n = 2,
    seg = 2.0,
    t = 0.12;
  const out: BodyEntity[] = [];
  let prev = base;
  for (let i = 0; i < n; i++) {
    const s = b.body(`Board segment ${i + 1}`, 'box', [seg, t, 1.0], [x0 + seg * (i + 0.5), yTop + t / 2, 0], {
      massOverride: 15,
      material: { preset: 'wood', color: i === n - 1 ? '#f97316' : '#d9a066' },
      linearDamping: 0.02,
      canSleep: false,
      tags: ['board'],
    });
    b.joint('softweld', prev, s, [x0 + seg * i, yTop + t / 2, 0], Z, {
      name: i === 0 ? 'Board root (soft weld)' : `Board flex ${i} (soft weld)`,
      params: params({ linStiffness: 300000, linDamping: 3000, angStiffness: 8000, angDamping: 600 }),
    });
    out.push(s);
    prev = s;
  }
  return out;
}

function softDivingBoard(): Builder {
  const b = new Builder('Soft diving board');
  const tower = b.body('Tower', 'box', [1.6, 2.0, 1.6], [-2.2, 1.0, 0], {
    bodyType: 'static',
    material: { preset: 'concrete', color: '#9ca3af' },
    tags: ['support'],
  });
  divingBoard(b, -1.8, 2.0, tower);
  b.body('Landing mat', 'box', [6.0, 0.3, 3.0], [4.4, 0.15, 0], {
    bodyType: 'static',
    material: { preset: 'foam', color: '#38bdf8' },
  });
  b.body('Diver (8 kg)', 'sphere', [0.55, 0.55, 0.55], [1.6, 5.2, 0], {
    massOverride: 8,
    material: { preset: 'rubber', color: '#ef4444' },
    tags: ['diver'],
  });
  return b;
}

// ── prefabs ──────────────────────────────────────────────────────────────────────────────────────────

function gearPairPrefab(): Entity[] {
  const b = new Builder('Gear pair');
  const rA = 0.4,
    rB = 0.8,
    y = 1.4;
  const a = disc(b, 'Gear A (driver)', rA, 0.2, [-rA - 0.015, y, 0], '#f59e0b', { massOverride: 2, tags: ['gear'] });
  const c = disc(b, 'Gear B (driven)', rB, 0.2, [rB + 0.015, y, 0], '#14b8a6', { massOverride: 6, tags: ['gear'] });
  for (const g of [a, c]) frame(b, 'Axle post', [0.14, y, 0.14], [g.position[0], y / 2, -0.25]);
  axle(b, 'Axle A (motor)', a, Z, { targetVelocity: 4, maxForce: 500, damping: 300 });
  axle(b, 'Axle B', c, Z);
  b.joint('gear', a, c, a.position, Z, {
    name: 'Gear mesh (2 : 1, reversing)',
    anchorA: [0, 0, 0],
    anchorB: [0, 0, 0],
    params: params({ ratio: rA / rB, reverse: true, radiusA: rA, radiusB: rB, axisB: local(c, Z) }),
  });
  return b.doc.entities;
}

function ragdollArmPrefab(): Entity[] {
  const b = new Builder('Ragdoll arm');
  ragdollTorso(b, 0, 0);
  ragdollArm(b, 'R', 0, 0, [-2.6, 0, 0]);
  return b.doc.entities;
}

function boardPrefab(): Entity[] {
  const b = new Builder('Soft diving board');
  const tower = b.body('Tower', 'box', [1.6, 2.0, 1.6], [-2.2, 1.0, 0], {
    bodyType: 'static',
    material: { preset: 'concrete', color: '#9ca3af' },
  });
  divingBoard(b, -1.8, 2.0, tower);
  return b.doc.entities;
}

// ── registration ─────────────────────────────────────────────────────────────────────────────────────

const done = (fn: () => Builder) => (): SceneDocument => fn().done();

registerTemplate({
  id: 'jt-atwood',
  name: 'Atwood machine',
  category: CATEGORY,
  blurb: 'Two masses on one rope over a pulley: the heavier one sinks at a = (m₂ − m₁)g / (m₁ + m₂).',
  hint: 'Press Play. 2 kg and 3 kg give a ≈ 1.96 m/s²; select the rope to read its tension and edit the masses.',
  view: { position: [4.6, 4.4, 8.4], target: [0, 4.2, 0] },
  build: done(atwood),
});
registerTemplate({
  id: 'jt-gear-train',
  name: 'Gear train',
  category: CATEGORY,
  blurb: 'Three meshing gears: each pair reverses direction, the output turns at one third of the input speed.',
  hint: 'Press Play. The yellow pointers show the speed ratio; change a gear joint’s ratio or the motor speed.',
  view: { position: [1, 3.2, 8.5], target: [0.3, 1.5, 0] },
  build: done(gearTrain),
});
registerTemplate({
  id: 'jt-belt-drive',
  name: 'Belt & chain drive',
  category: CATEGORY,
  blurb:
    'A belt halves the speed (radii 0.35 : 0.7); the chain behind it slips once the load needs more than its slip torque.',
  hint: 'Press Play and compare the pointers: the belt keeps its ratio, the loaded chain falls behind.',
  view: { position: [0, 3.6, 9], target: [0, 1.5, 0] },
  build: done(beltDrive),
});
registerTemplate({
  id: 'jt-rack-pinion',
  name: 'Rack and pinion',
  category: CATEGORY,
  blurb: 'A motor turns the pinion and the rack travels r·θ — here 0.4 m per radian — until it meets the stop.',
  hint: 'Press Play. Edit the pinion radius on the rack joint to change the travel per turn.',
  view: { position: [1.8, 2.2, 5], target: [0, 0.95, 0] },
  build: done(rackPinion),
});
registerTemplate({
  id: 'jt-screw-jack',
  name: 'Screw jack',
  category: CATEGORY,
  blurb: 'A motor turns the lead screw and the platform climbs one pitch (0.3 m) per turn, lifting a 30 kg crate.',
  hint: 'Press Play. Change the thread pitch on the screw joint; a negative pitch reverses the thread.',
  view: { position: [4.2, 3.2, 6], target: [0, 1.8, 0] },
  build: done(screwJack),
});
registerTemplate({
  id: 'jt-crane-winch',
  name: 'Crane hoists',
  category: CATEGORY,
  blurb:
    'Two winches on one jib: the 600 N hoist lifts its 25 kg crate, the 120 N hoist is overloaded and pays rope out.',
  hint: 'Press Play. Raise the second hoist’s load rating above 245 N and it will lift too.',
  view: { position: [1.6, 4.4, 15.5], target: [-0.2, 3.6, 0] },
  build: done(craneWinch),
});
registerTemplate({
  id: 'jt-ragdoll-arms',
  name: 'Ragdoll arms',
  category: CATEGORY,
  blurb:
    'The shoulders are cone-twist joints: both arms are flung out and stopped by the swing cone, the elbows and wrists are limited hinges.',
  hint: 'Press Play. Select a shoulder to change the cone angle and the twist range.',
  view: { position: [2.2, 2.4, 6.2], target: [0, 1.7, 0] },
  build: done(ragdollArms),
});
registerTemplate({
  id: 'jt-sixdof-platform',
  name: 'Spring-mounted platform',
  category: CATEGORY,
  blurb: 'One 6-DOF joint: heave and two tilts are free on springs inside limits, the other three axes are locked.',
  hint: 'Press Play and watch the balls land. Select the joint to set each axis to free, limited or locked.',
  view: { position: [5.5, 3.8, 7], target: [0, 2, 0] },
  build: done(sixDofPlatform),
});
registerTemplate({
  id: 'jt-cardan-shaft',
  name: 'Cardan drive shaft',
  category: CATEGORY,
  blurb: 'Two universal joints carry the spin of the input shaft round a jog to the flywheel on the output shaft.',
  hint: 'Press Play. Move the second universal joint up or down to change the bend.',
  view: { position: [0.3, 2.6, 7.2], target: [0.2, 1.8, 0] },
  build: done(cardanShaft),
});
registerTemplate({
  id: 'jt-soft-diving-board',
  name: 'Soft diving board',
  category: CATEGORY,
  blurb:
    'Two wooden planks joined to the tower and to each other by soft welds bend under their own weight and under the diver, then spring back.',
  hint: 'Press Play. Select a weld to make the board stiffer or floppier.',
  view: { position: [3.4, 3.2, 11.5], target: [0.8, 1.8, 0] },
  build: done(softDivingBoard),
});

registerPrefab({
  id: 'jt-gear-pair',
  name: 'Gear pair',
  icon: 'gear',
  blurb: 'A motor-driven 0.4 m gear meshing with a 0.8 m gear (2 : 1, reversing).',
  category: 'Mechanisms',
  build: gearPairPrefab,
});
registerPrefab({
  id: 'jt-ragdoll-arm',
  name: 'Ragdoll arm',
  icon: 'conetwist',
  blurb: 'A torso with one arm: cone-twist shoulder, limited elbow and wrist hinges.',
  category: 'Mechanisms',
  build: ragdollArmPrefab,
});
registerPrefab({
  id: 'jt-soft-board',
  name: 'Soft diving board',
  icon: 'softweld',
  blurb: 'A cantilever board of two wooden planks on soft welds.',
  category: 'Mechanisms',
  build: boardPrefab,
});
