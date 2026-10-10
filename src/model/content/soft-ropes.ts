/**
 * Ropes and chains carrying loads (SF-3): a crane hook, a hanging lamp and a tug of war. The links come from the same
 * generator the rope tool uses (`generateChain`); the heavy ends are passed as the `load`, so its mass-ratio guard
 * makes the links as heavy as the joints need.
 */
import { Builder, idleMotor, rotX } from '../builder';
import { makeComponent } from '../componentRegistry';
import { generateChain } from '../ropeGen';
import type { BodyEntity } from '../types';
import { registerTemplate } from './registry';
import { boxDensity } from './soft-util';

const STEEL = { preset: 'steel', color: '#8d97a6' };

// ── Crane hook ──────────────────────────────────────────────────────────────────────────────────────

export const CRANE = { jibY: 6, hookX: 1.6, chain: 3.5, loadKg: 60, loadSize: [1, 0.8, 1] as [number, number, number] };

export function buildCraneScene(): Builder {
  const b = new Builder('Crane hook');
  b.body('Crane base', 'box', [1.6, 0.3, 1.6], [-2, 0.15, 0], { bodyType: 'static', material: 'concrete' });
  b.body('Crane tower', 'box', [0.5, CRANE.jibY, 0.5], [-2, CRANE.jibY / 2, 0], {
    bodyType: 'static',
    material: STEEL,
  });
  const jib = b.body('Crane jib', 'box', [5.2, 0.3, 0.4], [0.2, CRANE.jibY + 0.15, 0], {
    bodyType: 'static',
    material: { preset: 'steel', color: '#e0a526' },
  });
  const hookY = CRANE.jibY; // underside of the jib
  const loadY = hookY - CRANE.chain - CRANE.loadSize[1] / 2;
  const load = b.body('Hook and load', 'box', CRANE.loadSize, [CRANE.hookX, loadY, 0], {
    material: { preset: 'wood', density: boxDensity(CRANE.loadSize, CRANE.loadKg), color: '#b5834f' },
    angularDamping: 0.5,
  });
  const chain = generateChain({
    kind: 'chain',
    start: [CRANE.hookX, hookY, 0],
    end: [CRANE.hookX, hookY - CRANE.chain, 0],
    links: 14,
    mass: 3,
    startBody: jib.id,
    startAnchor: [CRANE.hookX - jib.position[0], -0.15, 0],
    endBody: load.id,
    endAnchor: [0, CRANE.loadSize[1] / 2, 0],
    load: CRANE.loadKg,
  });
  b.doc.entities.push(...chain.bodies, ...chain.joints);
  // a pallet of crates waiting to be loaded
  for (let i = 0; i < 3; i++)
    b.body(`Crate ${i + 1}`, 'box', [0.8, 0.6, 0.8], [3.2 + (i % 2) * 0.1, 0.3 + i * 0.6, 0.0], {
      material: { preset: 'wood', color: '#c99a5b' },
    });
  return b;
}

registerTemplate({
  id: 'crane-hook',
  name: 'Crane hook',
  category: 'Soft bodies',
  blurb:
    'A 14-link chain hangs a 60 kg load from a crane jib. The mass guard makes the links heavy enough not to stretch.',
  hint: 'Press Play: the load hangs still. Shove it with the mouse and it swings on the chain; select a link to see its mass.',
  view: { position: [4.5, 3.5, 9], target: [0.5, 3, 0] },
  build: () => buildCraneScene().done(),
});

// ── Hanging lamp ────────────────────────────────────────────────────────────────────────────────────

export const LAMP = { top: 4.2, rope: 2, radius: 0.22, kg: 3, swing: 0.2 };

export function buildLampScene(): Builder {
  const b = new Builder('Hanging lamp');
  b.body('Ceiling beam', 'box', [2.4, 0.2, 0.4], [0, LAMP.top + 0.1, 0], { bodyType: 'static', material: 'wood' });
  const a = LAMP.swing;
  const dir: [number, number, number] = [Math.sin(a), -Math.cos(a), 0];
  const start: [number, number, number] = [0, LAMP.top, 0];
  const end: [number, number, number] = [dir[0] * LAMP.rope, LAMP.top + dir[1] * LAMP.rope, 0];
  const lampC: [number, number, number] = [end[0] + dir[0] * LAMP.radius, end[1] + dir[1] * LAMP.radius, 0];
  const volume = (4 / 3) * Math.PI * LAMP.radius ** 3;
  const lamp = b.body('Lamp', 'sphere', [LAMP.radius * 2, LAMP.radius * 2, LAMP.radius * 2], lampC, {
    material: { preset: 'custom', density: LAMP.kg / volume, color: '#ffe9a8', roughness: 0.3, friction: 0.5 },
    angularDamping: 0.5,
  });
  const rope = generateChain({
    kind: 'rope',
    start,
    end,
    links: 8,
    mass: 0.4,
    startBody: null,
    endBody: lamp.id,
    endAnchor: [0, LAMP.radius, 0],
    load: LAMP.kg,
  });
  // the lamp hangs on the rope's axis: its anchor point is where the rope meets the sphere
  b.doc.entities.push(...rope.bodies, ...rope.joints);
  return b;
}

registerTemplate({
  id: 'hanging-lamp',
  name: 'Hanging lamp',
  category: 'Soft bodies',
  blurb: 'A lamp on a rope swings as a pendulum, with the period 2π·√(L/g).',
  hint: 'Press Play: the lamp swings from one side to the other. Shorten the rope to make it faster.',
  view: { position: [0, 2.6, 7], target: [0, 2.6, 0] },
  build: () => buildLampScene().done(),
});

// ── Tug of war ──────────────────────────────────────────────────────────────────────────────────────

export const TUG = { half: 3, cartKg: 60, weak: 400, strong: 650, ropeY: 0.65 };

/** A flat cart on four free wheels with a tow post on the side facing the rope; returns the post (the rope's anchor). */
function buildCart(b: Builder, name: string, x: number, color: string, force: number, towards: 1 | -1): BodyEntity {
  const size: [number, number, number] = [1.6, 0.18, 1.0];
  const wheelR = 0.18;
  const chassis = b.body(name, 'box', size, [x, wheelR + 0.1, 0], {
    material: { preset: 'steel', density: boxDensity(size, TUG.cartKg), color },
    components: [makeComponent('constantForce', { force: [force, 0, 0], space: 'world' })],
  });
  for (const dx of [-0.55, 0.55])
    for (const dz of [-0.55, 0.55]) {
      const wheel = b.body(`${name} wheel`, 'cylinder', [wheelR * 2, 0.12, wheelR * 2], [x + dx, wheelR, dz], {
        rotation: rotX(90),
        material: { preset: 'rubber', density: 600, color: '#24262b', friction: 0.9 },
      });
      b.joint('hinge', chassis, wheel, [x + dx, wheelR, dz], [0, 0, 1], { name: `${name} axle`, motor: idleMotor() });
    }
  const postH = TUG.ropeY + 0.04 - (wheelR + 0.1 + 0.09);
  const post = b.body(
    `${name} tow post`,
    'box',
    [0.12, postH, 0.12],
    [x + towards * 0.62, wheelR + 0.19 + postH / 2, 0],
    {
      material: { preset: 'steel', density: 800, color },
    },
  );
  b.joint('fixed', chassis, post, [x + towards * 0.62, wheelR + 0.19, 0], [0, 1, 0], { name: `${name} tow post weld` });
  return post;
}

export function buildTugScene(): Builder {
  const b = new Builder('Tug of war');
  b.doc.settings.solverIterations = 10;
  const left = buildCart(b, 'Cart A', -TUG.half, '#3b82d9', -TUG.weak, 1);
  const right = buildCart(b, 'Cart B', TUG.half, '#d9543b', TUG.strong, -1);
  const y = TUG.ropeY;
  const x0 = left.position[0] + 0.06,
    x1 = right.position[0] - 0.06;
  const rope = generateChain({
    kind: 'rope',
    start: [x0, y, 0],
    end: [x1, y, 0],
    links: 12,
    mass: 1.2,
    thickness: 0.07,
    startBody: left.id,
    startAnchor: [0.06, y - left.position[1], 0],
    endBody: right.id,
    endAnchor: [-0.06, y - right.position[1], 0],
    load: 24, // the rope's own weight sags it between the carts: keep the links light enough to stay off the ground
  });
  b.doc.entities.push(...rope.bodies, ...rope.joints);
  // the flag at the middle of the rope
  const mid = rope.bodies[Math.floor(rope.bodies.length / 2)];
  mid.material = { ...mid.material, color: '#ffffff' };
  // a line on the ground to see who gives way
  b.body('Centre line', 'box', [0.06, 0.02, 1.8], [0, 0.01, 0], {
    bodyType: 'static',
    ghost: true,
    material: { preset: 'plastic', color: '#ffffff' },
  });
  return b;
}

registerTemplate({
  id: 'tug-of-war',
  name: 'Tug of war',
  category: 'Soft bodies',
  blurb:
    'Two carts pull a rope in opposite directions, one with 400 N and one with 650 N: the stronger side drags the other over the line.',
  hint: 'Press Play and watch the white flag. Change a cart’s constant force to even the match.',
  view: { position: [0, 3.2, 10], target: [0, 0.4, 0] },
  build: () => buildTugScene().done(),
});
