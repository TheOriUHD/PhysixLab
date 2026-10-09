/**
 * Prefabs — ready-made assemblies the user can drop into any scene. They are ordinary
 * bodies + joints (no special runtime behaviour), generated around the origin on the ground.
 */
import { DEG, type Vec3 } from '../core/math';
import { Builder, rotX, rotZ } from './builder';
import { buildCar } from './templates';
import type { Entity } from './types';

export interface PrefabInfo {
  id: string;
  name: string;
  icon: string;
  blurb: string;
  build(): Entity[];
}

const free = { linearDamping: 0.0, angularDamping: 0.0, canSleep: false };

function chain(): Entity[] {
  const b = new Builder('Chain');
  const top = 5, n = 9, ll = 0.5, ang = 40 * DEG;
  b.body('Chain beam', 'box', [2.4, 0.2, 0.3], [0, top + 0.1, 0], { bodyType: 'static', material: 'steel' });
  const dir: Vec3 = [Math.sin(ang), -Math.cos(ang), 0];
  const at = (s: number): Vec3 => [dir[0] * s, top + dir[1] * s, 0];
  let prev = null as ReturnType<Builder['body']> | null;
  for (let i = 0; i < n; i++) {
    const l = b.body(`Link ${i + 1}`, 'capsule', [0.14, ll, 0.14], at((i + 0.5) * ll), { material: 'steel', rotation: rotZ(-40) });
    b.joint('ball', prev, l, at(i * ll), [0, 0, 1], { name: i === 0 ? 'Hook' : 'Chain joint' });
    prev = l;
  }
  const w = b.body('Weight', 'sphere', [0.7, 0.7, 0.7], at(n * ll + 0.35), { material: 'lead' });
  b.joint('ball', prev, w, at(n * ll), [0, 0, 1], { name: 'Weight mount' });
  return b.doc.entities;
}

function pendulum(): Entity[] {
  const b = new Builder('Pendulum');
  const len = 2.2, top = 3.6, th = 55 * DEG;
  b.body('Post', 'box', [0.2, top, 0.2], [0, top / 2, -0.35], { bodyType: 'static', material: 'steel' });
  b.body('Arm mount', 'box', [0.2, 0.2, 0.7], [0, top, 0], { bodyType: 'static', material: 'steel', ghost: true });
  const arm = b.body('Rod', 'box', [0.08, len, 0.08], [Math.sin(th) * len / 2, top - Math.cos(th) * len / 2, 0], { rotation: rotZ(th / DEG), material: 'aluminum', ...free });
  const bob = b.body('Bob', 'sphere', [0.55, 0.55, 0.55], [Math.sin(th) * len, top - Math.cos(th) * len, 0], { material: 'gold', ...free });
  b.joint('hinge', null, arm, [0, top, 0], [0, 0, 1], { name: 'Pivot' });
  b.joint('fixed', arm, bob, bob.position, [0, 0, 1], { name: 'Bob mount' });
  return b.doc.entities;
}

function seesaw(): Entity[] {
  const b = new Builder('Seesaw');
  b.body('Fulcrum', 'prism', [0.7, 0.8, 0.7], [0, 0.4, 0], { bodyType: 'static', material: 'concrete' });
  const plank = b.body('Plank', 'box', [5, 0.14, 0.9], [0, 0.88, 0], { material: 'wood' });
  b.joint('hinge', null, plank, [0, 0.88, 0], [0, 0, 1], { name: 'Seesaw pivot' });
  b.body('Weight A', 'box', [0.5, 0.5, 0.5], [-1.9, 1.2, 0], { material: 'steel' });
  b.body('Weight B', 'box', [0.4, 0.4, 0.4], [1.9, 1.15, 0], { material: 'steel' });
  return b.doc.entities;
}

function door(): Entity[] {
  const b = new Builder('Hinged door');
  b.body('Frame post', 'box', [0.2, 2.4, 0.2], [0, 1.2, 0], { bodyType: 'static', material: 'steel' });
  b.body('Frame lintel', 'box', [1.6, 0.2, 0.2], [0.7, 2.5, 0], { bodyType: 'static', material: 'steel' });
  const d = b.body('Door', 'box', [1.2, 2.2, 0.1], [0.7, 1.15, 0], { material: 'wood' });
  b.joint('hinge', null, d, [0.1, 1.15, 0], [0, 1, 0], { name: 'Door hinge', limit: { enabled: true, min: -1.6, max: 1.6 } });
  b.body('Ball', 'sphere', [0.5, 0.5, 0.5], [0.5, 0.25, 1.8], { material: 'rubber', velocity: [0, 0, -4] });
  return b.doc.entities;
}

function cart(): Entity[] {
  const b = new Builder('Cart');
  const body = b.body('Cart bed', 'box', [1.8, 0.2, 1.0], [0, 0.55, 0], { material: 'wood' });
  for (const [x, z] of [[-0.6, -0.62], [0.6, -0.62], [-0.6, 0.62], [0.6, 0.62]]) {
    const w = b.body('Wheel', 'cylinder', [0.5, 0.12, 0.5], [x, 0.25, z], { rotation: rotX(90), material: 'rubber', ccd: true });
    b.joint('hinge', body, w, [x, 0.25, z], [0, 0, 1], { name: 'Axle' });
  }
  return b.doc.entities;
}

function motorWheel(): Entity[] {
  const b = new Builder('Motor wheel');
  b.body('Stand', 'box', [0.3, 1.6, 0.8], [0, 0.8, -0.6], { bodyType: 'static', material: 'steel' });
  const w = b.body('Wheel', 'cylinder', [1.6, 0.25, 1.6], [0, 1.6, 0], { rotation: rotX(90), material: 'wood' });
  b.joint('hinge', null, w, [0, 1.6, 0], [0, 0, 1], {
    name: 'Motor axle',
    motor: { mode: 'velocity', targetVelocity: 5, targetPosition: 0, stiffness: 0, damping: 400, maxForce: 1200, keyPos: 'KeyE', keyNeg: 'KeyQ', slewRate: 1, brake: true },
  });
  b.body('Paddle', 'box', [0.12, 0.7, 0.4], [0.8, 1.6, 0], { material: 'steel' });
  return b.doc.entities;
}

function brickWall(): Entity[] {
  const b = new Builder('Brick wall');
  const bl = 0.7, bh = 0.35, bt = 0.35;
  for (let row = 0; row < 8; row++) for (let col = 0; col < 7; col++) {
    const off = row % 2 ? bl / 2 : 0;
    b.body('Brick', 'box', [bl - 0.006, bh - 0.004, bt], [(col - 3) * bl + off, bh / 2 + row * bh, 0], { material: 'concrete' });
  }
  return b.doc.entities;
}

function dominoRow(): Entity[] {
  const b = new Builder('Dominoes');
  for (let i = 0; i < 14; i++) b.body('Domino', 'box', [0.14, 0.8, 0.45], [i * 0.38 - 2.5, 0.4, 0], { material: i % 2 ? 'wood' : 'ceramic' });
  b.body('Ball', 'sphere', [0.5, 0.5, 0.5], [-3.6, 0.9, 0], { material: 'steel', velocity: [2.5, 0, 0] });
  return b.doc.entities;
}

function tower(): Entity[] {
  const b = new Builder('Tower');
  for (let i = 0; i < 9; i++) b.body('Block', 'box', [0.8, 0.5, 0.8], [0, 0.25 + i * 0.5, 0], { material: i % 2 ? 'wood' : 'plastic' });
  return b.doc.entities;
}

function springBouncer(): Entity[] {
  const b = new Builder('Spring bouncer');
  b.body('Frame', 'box', [2.2, 0.2, 1.2], [0, 4.2, 0], { bodyType: 'static', material: 'steel' });
  const m = b.body('Mass', 'box', [0.6, 0.4, 0.6], [0, 1.9, 0], { material: { preset: 'steel', density: 400 } });
  b.tether('spring', null, [0, 4.1, 0], m, [0, 2.1, 0], { name: 'Coil spring', spring: { restLength: 1.5, stiffness: 600, damping: 12, breakForce: 0 } });
  b.joint('slider', null, m, m.position, [0, 1, 0], { name: 'Guide rail', limit: { enabled: true, min: -1.6, max: 1.6 } });
  return b.doc.entities;
}

function piston(): Entity[] {
  const b = new Builder('Piston');
  b.body('Cylinder housing', 'box', [0.9, 0.5, 0.9], [0, 0.25, 0], { bodyType: 'static', material: 'steel' });
  const ram = b.body('Ram', 'cylinder', [0.5, 1.2, 0.5], [0, 1.1, 0], { material: 'aluminum', gravityScale: 0 });
  b.joint('slider', null, ram, ram.position, [0, 1, 0], {
    name: 'Piston slider', limit: { enabled: true, min: -0.1, max: 1.6 },
    motor: { mode: 'velocity', targetVelocity: 2, targetPosition: 0, stiffness: 0, damping: 30000, maxForce: 80000, keyPos: 'ArrowUp', keyNeg: 'ArrowDown', slewRate: 1, brake: true },
  });
  b.body('Crate', 'box', [0.7, 0.7, 0.7], [1.0, 0.35, 0], { material: 'wood' });
  return b.doc.entities;
}

export const PREFABS: PrefabInfo[] = [
  { id: 'car', name: 'Drivable car', icon: 'car', blurb: 'Suspension, steering, rear-wheel drive. W/S/A/D.', build: () => buildCar(false).entities },
  { id: 'cart', name: 'Wheeled cart', icon: 'box', blurb: 'Bed with four free-spinning wheels.', build: cart },
  { id: 'motor', name: 'Motor wheel', icon: 'rotate', blurb: 'Keyed velocity motor (E / Q).', build: motorWheel },
  { id: 'piston', name: 'Piston', icon: 'slider', blurb: 'Slider with a keyed motor (↑ / ↓).', build: piston },
  { id: 'pendulum', name: 'Pendulum', icon: 'hinge', blurb: 'Hinged rod and bob.', build: pendulum },
  { id: 'chain', name: 'Hanging chain', icon: 'rope', blurb: 'Nine ball-jointed links and a weight.', build: chain },
  { id: 'seesaw', name: 'Seesaw', icon: 'wedge', blurb: 'Plank on a pivot with two weights.', build: seesaw },
  { id: 'door', name: 'Hinged door', icon: 'hinge', blurb: 'Limited hinge and a ball to knock it.', build: door },
  { id: 'spring', name: 'Spring bouncer', icon: 'spring', blurb: 'Mass on a spring and a guide rail.', build: springBouncer },
  { id: 'wall', name: 'Brick wall', icon: 'layers', blurb: '56 staggered bricks.', build: brickWall },
  { id: 'dominoes', name: 'Domino row', icon: 'box', blurb: 'Fourteen dominoes and a ball.', build: dominoRow },
  { id: 'tower', name: 'Block tower', icon: 'layers', blurb: 'Nine stacked blocks.', build: tower },
];
