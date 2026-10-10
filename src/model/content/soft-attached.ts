/**
 * Soft bodies fastened to rigid ones (SF-1): a sail on a mast, a net between posts, a curtain on a rail and a cable
 * that hangs a weight. Everything is ordinary bodies, joints and cloth / cable recipes with attachments — the attach
 * tool writes exactly these records.
 */
import { Builder, idleMotor, rotX } from '../builder';
import { makeComponent } from '../componentRegistry';
import type { BodyEntity } from '../types';
import { registerTemplate } from './registry';
import { boxDensity, fasten, velocityMotor } from './soft-util';

const STEEL = { preset: 'steel', color: '#8d97a6' };
const WOOD = { preset: 'wood', color: '#a9794b' };

// ── Sail on a mast ──────────────────────────────────────────────────────────────────────────────────

/** Sail geometry: mast at x = 0, yard and boom out along +X, the sail laced between them. */
export const SAIL = { width: 2.4, height: 2.0, boomY: 1.0, yardY: 3.0, wind: 20, gap: 0.25 };

export function buildSailScene(): Builder {
  const b = new Builder('Sail on a mast');
  const mast = b.body('Mast', 'cylinder', [0.18, 3.6, 0.18], [0, 1.8, 0], { bodyType: 'static', material: WOOD });
  const spar = (name: string, y: number, wind: number): BodyEntity => {
    const len = SAIL.gap + SAIL.width + 0.1; // from the mast axis to just past the sail's free edge
    const body = b.body(name, 'box', [len, 0.07, 0.07], [len / 2, y, 0], {
      material: { preset: 'wood', density: 400, color: '#8f6439' },
      linearDamping: 0.3,
      angularDamping: 1.2,
      components: [
        // the wind: a steady push on the free end of the spar, across the boat
        makeComponent('constantForce', {
          force: [0, 0, wind],
          space: 'world',
          applyAt: 'point',
          point: [len / 2, 0, 0],
        }),
      ],
    });
    // The spar swings about the mast on a vertical hinge, stopped near 55° as a sheet would.
    b.joint('hinge', mast, body, [0, y, 0], [0, 1, 0], {
      name: `${name} hinge`,
      motor: idleMotor(),
      limit: { enabled: true, min: -0.95, max: 0.1 },
    });
    return body;
  };
  const yard = spar('Yard', SAIL.yardY, SAIL.wind / 2);
  const boom = spar('Boom', SAIL.boomY, SAIL.wind / 2);
  const sail = b.soft('Sail', 'cloth', [SAIL.gap + SAIL.width / 2, (SAIL.boomY + SAIL.yardY) / 2, 0], {
    rotation: rotX(90), // cloth lies in the XZ plane; stood up it spans X (width) and Y (height)
    size: [SAIL.width, 0, SAIL.height],
    resolution: 14,
    mass: 1.5,
    stiffness: 45,
    damping: 0.4,
    color: '#f4efe4',
    friction: 0.4,
  });
  const r = SAIL.width / 2 + 0.01;
  fasten(sail, yard, [SAIL.gap + SAIL.width / 2, SAIL.yardY, 0], r);
  fasten(sail, boom, [SAIL.gap + SAIL.width / 2, SAIL.boomY, 0], r);
  return b;
}

registerTemplate({
  id: 'sail-on-a-mast',
  name: 'Sail on a mast',
  category: 'Soft bodies',
  blurb: 'A cloth sail is laced to a yard and a boom that both swing round the mast on hinges.',
  hint: 'Press Play: the wind pushes the yard and boom out and the sail swings with them. Change the force on a spar or the sail stiffness.',
  view: { position: [4, 2.8, 7], target: [1.2, 1.9, 0] },
  build: () => buildSailScene().done(),
});

// ── Net between posts ───────────────────────────────────────────────────────────────────────────────

export const NET = { span: 2.6, y: 1.5, ballR: 0.25, ballKg: 6 };

export function buildNetScene(): Builder {
  const b = new Builder('Net between posts');
  const h = NET.span / 2;
  const posts: BodyEntity[] = [];
  for (const [i, [x, z]] of (
    [
      [-h, -h],
      [h, -h],
      [h, h],
      [-h, h],
    ] as const
  ).entries())
    posts.push(
      b.body(`Post ${i + 1}`, 'cylinder', [0.16, NET.y + 0.1, 0.16], [x, (NET.y + 0.1) / 2, z], {
        bodyType: 'static',
        material: STEEL,
      }),
    );
  const net = b.soft('Net', 'cloth', [0, NET.y, 0], {
    size: [NET.span, 0, NET.span],
    resolution: 17,
    mass: 1.2,
    stiffness: 60,
    damping: 0.35,
    color: '#e8d9a8',
    friction: 0.9,
  });
  const corners: [number, number][] = [
    [-h, -h],
    [h, -h],
    [h, h],
    [-h, h],
  ];
  corners.forEach(([x, z], i) => fasten(net, posts[i], [x, NET.y, z], 0.14));
  const volume = (4 / 3) * Math.PI * NET.ballR ** 3;
  b.body('Heavy ball', 'sphere', [NET.ballR * 2, NET.ballR * 2, NET.ballR * 2], [0.1, NET.y + 1.6, 0.05], {
    material: { preset: 'steel', density: NET.ballKg / volume, color: '#c0504d' },
    ccd: true,
  });
  return b;
}

registerTemplate({
  id: 'net-between-posts',
  name: 'Net between posts',
  category: 'Soft bodies',
  blurb: 'A net laced to four posts catches a heavy ball dropped on it.',
  hint: 'Press Play: the ball sags the net and bounces in it. Raise the net stiffness, or drag the ball with the mouse.',
  view: { position: [4.2, 3.2, 5.2], target: [0, 1, 0] },
  build: () => buildNetScene().done(),
});

// ── Curtain on a rail ───────────────────────────────────────────────────────────────────────────────

export const CURTAIN = { width: 3.0, drop: 1.6, y: 2.6, rings: 5 };

export function buildCurtainScene(): Builder {
  const b = new Builder('Curtain on a rail');
  const x0 = -CURTAIN.width / 2;
  b.body('Rail', 'box', [CURTAIN.width + 1.4, 0.05, 0.05], [0.5, CURTAIN.y + 0.06, 0], {
    bodyType: 'static',
    material: STEEL,
  });
  const curtain = b.soft('Curtain', 'cloth', [0, CURTAIN.y - CURTAIN.drop / 2, 0], {
    rotation: rotX(90),
    size: [CURTAIN.width, 0, CURTAIN.drop],
    resolution: 17,
    mass: 1.8,
    stiffness: 40,
    damping: 0.4,
    color: '#a23b4e',
    friction: 0.5,
  });
  const gap = CURTAIN.width / (CURTAIN.rings - 1);
  for (let i = 0; i < CURTAIN.rings; i++) {
    const x = x0 + i * gap;
    const ring = b.body(`Ring ${i + 1}`, 'box', [0.1, 0.1, 0.1], [x, CURTAIN.y, 0], {
      material: { preset: 'steel', density: boxDensity([0.1, 0.1, 0.1], 0.4), color: '#d4af37' },
      linearDamping: 0.6,
    });
    // each ring rides the rail on a slider; the end ring is driven (pulled toward +X), the others are free
    const last = i === CURTAIN.rings - 1;
    const rail = b.doc.entities.find((e) => e.kind === 'body' && e.name === 'Rail') as BodyEntity;
    b.joint('slider', rail, ring, [x, CURTAIN.y, 0], [1, 0, 0], {
      name: `Ring ${i + 1} on rail`,
      motor: last ? velocityMotor(0.4, 300, 120) : idleMotor(),
    });
    // a short stretch of the curtain's top row is fastened to each ring
    fasten(curtain, ring, [x, CURTAIN.y, 0], gap * 0.55);
  }
  return b;
}

registerTemplate({
  id: 'curtain-on-a-rail',
  name: 'Curtain on a rail',
  category: 'Soft bodies',
  blurb:
    'A cloth curtain hangs from five rings that slide on a rail; a motor pulls the end ring and the cloth drags the rest.',
  hint: 'Press Play: the right ring is pulled along the rail and drags the whole curtain with it. Grab a ring with the mouse to draw it back.',
  view: { position: [0, 2.2, 6.5], target: [0, 1.8, 0] },
  build: () => buildCurtainScene().done(),
});

// ── Cable hanging a weight ──────────────────────────────────────────────────────────────────────────

export const HANGING = { length: 3, top: 5.2, kg: 5, box: 0.4 };

export function buildHangingWeightScene(): Builder {
  const b = new Builder('Cable hanging a weight');
  b.body('Gantry', 'box', [1.2, 0.12, 0.3], [0, HANGING.top + 0.06, 0], { bodyType: 'static', material: STEEL });
  b.body('Gantry post', 'box', [0.16, HANGING.top, 0.16], [-0.7, HANGING.top / 2, 0], {
    bodyType: 'static',
    material: STEEL,
  });
  const size: [number, number, number] = [HANGING.box, HANGING.box, HANGING.box];
  const bottom = HANGING.top - HANGING.length - HANGING.box / 2;
  const weight = b.body('Weight', 'box', size, [0, bottom, 0], {
    material: { preset: 'steel', density: boxDensity(size, HANGING.kg), color: '#4a6fa5' },
    angularDamping: 1,
    linearDamping: 0.8,
  });
  const cable = b.soft('Cable', 'cable', [0, HANGING.top, 0], {
    rotation: [0, 0, -Math.SQRT1_2, Math.SQRT1_2], // local +X pointing straight down: first particle on top
    size: [HANGING.length, 0, 0],
    resolution: 24,
    mass: 0.6,
    stiffness: 90,
    damping: 0.8,
    pin: 'one-end',
    color: '#d7a86e',
  });
  // The lower end is tied to the weight's top face
  fasten(cable, weight, [0, HANGING.top - HANGING.length, 0], 0.05);
  return b;
}

registerTemplate({
  id: 'cable-hanging-a-weight',
  name: 'Cable hanging a weight',
  category: 'Soft bodies',
  blurb: 'A 5 kg block hangs from a soft cable pinned to a gantry: the cable carries m·g.',
  hint: 'Press Play: the block settles within a few centimetres of the cable length. Nudge it with the mouse and it swings as a pendulum.',
  view: { position: [3, 3, 6], target: [0, 2.6, 0] },
  build: () => buildHangingWeightScene().done(),
});
