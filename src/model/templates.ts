/**
 * Example scenes. They are built from exactly the same primitives, joints and motors the
 * user has in the editor — nothing here is scripted behaviour — so every one of them can be
 * taken apart, modified and extended.
 */
import { DEG, qfromAxisAngle, qfromEuler, type Vec3 } from '../core/math';
import { Builder, idleMotor, noKeys, rotX, rotY, rotZ } from './builder';
import type { TemplateInfo } from './content/registry';
import type { BodyEntity, SceneDocument } from './types';

// ---- scenes -------------------------------------------------------------------------------------

function dominoRun(): SceneDocument {
  const b = new Builder('Domino run');
  const n = 46;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const x = -2 + t * 14;
    const z = Math.sin(t * Math.PI * 2) * 2.2;
    // Face along the path tangent.
    const heading = Math.atan2(Math.cos(t * Math.PI * 2) * 2.2 * Math.PI * 2, 14);
    b.body(`Domino ${i + 1}`, 'box', [0.12, 0.7, 0.4], [x, 0.35, z], {
      rotation: qfromEuler([0, -heading, 0]),
      material: i % 2 ? 'wood' : 'ceramic',
    });
  }
  b.body('Starter ramp', 'wedge', [1.4, 1.2, 2.4], [-3.7, 0.6, 0], {
    bodyType: 'static',
    rotation: rotY(-90),
    material: 'concrete',
  });
  b.body('Starter ball', 'sphere', [0.5, 0.5, 0.5], [-4.6, 1.5, 0], { material: 'steel' });
  return b.done();
}

function newtonsCradle(): SceneDocument {
  const b = new Builder("Newton's cradle");
  const r = 0.25,
    top = 3.4,
    D = 2.2,
    zOff = 0.7;
  b.body('Frame bar A', 'box', [3.4, 0.12, 0.12], [0, top, zOff], { bodyType: 'static', material: 'steel' });
  b.body('Frame bar B', 'box', [3.4, 0.12, 0.12], [0, top, -zOff], { bodyType: 'static', material: 'steel' });
  for (const sx of [-1.7, 1.7])
    for (const sz of [-zOff, zOff]) {
      b.body('Post', 'box', [0.12, top, 0.12], [sx, top / 2, sz], { bodyType: 'static', material: 'steel' });
    }
  const ballMat = { preset: 'steel', restitution: 1, friction: 0, metalness: 1, roughness: 0.15 };
  for (let i = 0; i < 5; i++) {
    const px = (i - 2) * (2 * r + 0.003);
    // The first ball is pulled back by 38° about its pivot line.
    const a = i === 0 ? 38 * DEG : 0;
    const c: Vec3 = [px - Math.sin(a) * D, top - Math.cos(a) * D, 0];
    const ball = b.body(`Ball ${i + 1}`, 'sphere', [2 * r, 2 * r, 2 * r], c, {
      material: ballMat,
      linearDamping: 0,
      angularDamping: 0,
      ccd: true,
      canSleep: false,
    });
    for (const sz of [-zOff, zOff]) b.tether('rope', null, [px, top, sz], ball, c, { name: `String ${i + 1}` });
  }
  return b.done();
}

function doublePendulum(): SceneDocument {
  const b = new Builder('Double pendulum (chaos)');
  b.doc.settings.physicsHz = 240;
  const pivot: Vec3 = [0, 5.2, 0];
  const len = 1.6,
    th1 = 1.9,
    th2 = 1.2;
  const free = { linearDamping: 0, angularDamping: 0, canSleep: false };
  b.body('Support post', 'box', [0.24, pivot[1] + 0.12, 0.24], [pivot[0], (pivot[1] + 0.12) / 2, 0.42], {
    bodyType: 'static',
    material: 'steel',
  });
  b.body('Support base', 'box', [1.4, 0.2, 1.2], [pivot[0], 0.1, 0.2], { bodyType: 'static', material: 'concrete' });
  const e1: Vec3 = [pivot[0] + Math.sin(th1) * len, pivot[1] - Math.cos(th1) * len, 0];
  const e2: Vec3 = [e1[0] + Math.sin(th2) * len, e1[1] - Math.cos(th2) * len, 0];
  const arm1 = b.body('Arm 1', 'box', [0.12, len, 0.12], [(pivot[0] + e1[0]) / 2, (pivot[1] + e1[1]) / 2, 0.12], {
    rotation: rotZ(th1 / DEG),
    material: 'aluminum',
    ...free,
  });
  const arm2 = b.body('Arm 2', 'box', [0.12, len, 0.12], [(e1[0] + e2[0]) / 2, (e1[1] + e2[1]) / 2, -0.12], {
    rotation: rotZ(th2 / DEG),
    material: 'aluminum',
    ...free,
  });
  const bob = b.body('Bob', 'sphere', [0.5, 0.5, 0.5], [e2[0], e2[1], -0.12], {
    material: { preset: 'aluminum', color: '#f0b429', metalness: 1, roughness: 0.25 },
    ...free,
  });
  b.joint('hinge', null, arm1, pivot, [0, 0, 1], { name: 'Shoulder' });
  b.joint('hinge', arm1, arm2, e1, [0, 0, 1], { name: 'Elbow' });
  b.joint('fixed', arm2, bob, bob.position, [0, 0, 1], { name: 'Bob mount' });
  return b.done();
}

export function buildCar(withTrack = true): SceneDocument {
  const b = new Builder('Drivable car');
  b.doc.settings.solverIterations = 10;
  const y = 0.62; // chassis centre height
  const chassis = b.body('Chassis', 'box', [2.3, 0.35, 1.2], [0, y, 0], {
    material: { preset: 'steel', density: 1100, color: '#d94a3b', metalness: 0.6, roughness: 0.35 },
  });
  const cabin = b.body('Cabin', 'box', [1.1, 0.4, 1.0], [-0.15, y + 0.375, 0], {
    material: { preset: 'glass', density: 120, opacity: 0.55, color: '#8fd3ff' },
  });
  b.joint('fixed', chassis, cabin, cabin.position, [0, 1, 0], { name: 'Cabin mount' });

  const wr = 0.36,
    ww = 0.3;
  const corners = [
    { name: 'Front left', x: 0.85, z: -0.8, front: true },
    { name: 'Front right', x: 0.85, z: 0.8, front: true },
    { name: 'Rear left', x: -0.85, z: -0.8, front: false },
    { name: 'Rear right', x: -0.85, z: 0.8, front: false },
  ];
  // Hubs are heavy on purpose: very large mass ratios across a joint chain slow the solver down.
  const hubMat = { preset: 'steel', density: 8000 };
  for (const c of corners) {
    const hub = b.body(`${c.name} hub`, 'box', [0.16, 0.16, 0.16], [c.x, wr, c.z], {
      ghost: true,
      hidden: true,
      material: hubMat,
    });
    // Suspension: a vertical slider whose position motor acts as a spring-damper.
    b.joint('slider', chassis, hub, [c.x, wr, c.z], [0, 1, 0], {
      name: `${c.name} suspension`,
      limit: { enabled: true, min: -0.16, max: 0.16 },
      motor: {
        mode: 'position',
        targetVelocity: 0,
        targetPosition: 0,
        stiffness: 52000,
        damping: 5200,
        maxForce: 60000,
        ...noKeys,
        slewRate: 1,
        brake: true,
      },
    });
    let carrier = hub;
    if (c.front) {
      const knuckle = b.body(`${c.name} knuckle`, 'box', [0.14, 0.14, 0.14], [c.x, wr, c.z], {
        ghost: true,
        hidden: true,
        material: hubMat,
      });
      b.joint('hinge', hub, knuckle, [c.x, wr, c.z], [0, 1, 0], {
        name: `${c.name} steering`,
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
    const wheel = b.body(`${c.name} wheel`, 'cylinder', [wr * 2, ww, wr * 2], [c.x, wr, c.z], {
      rotation: rotX(90),
      ccd: true,
      material: { preset: 'rubber', density: 420, color: '#24262b', roughness: 0.9, friction: 1.1 },
    });
    // Axle axis is −Z so that a positive motor speed rolls the car toward +X.
    b.joint('hinge', carrier, wheel, [c.x, wr, c.z], [0, 0, -1], {
      name: `${c.name} axle`,
      motor: c.front
        ? idleMotor()
        : {
            mode: 'velocity',
            targetVelocity: 38,
            targetPosition: 0,
            stiffness: 0,
            damping: 420,
            maxForce: 1400,
            keyPos: 'KeyW',
            keyNeg: 'KeyS',
            slewRate: 1,
            brake: false,
          },
    });
  }

  if (!withTrack) return b.done();
  // Test track: a ramp, a landing pad, a slalom and a wall of crates to smash.
  b.body('Ramp', 'wedge', [4, 1.2, 4], [10, 0.6, 0], { bodyType: 'static', rotation: rotY(90), material: 'concrete' });
  b.body('Landing pad', 'box', [8, 0.3, 6], [22, 0.15, 0], { bodyType: 'static', material: 'concrete' });
  for (let i = 0; i < 5; i++) {
    b.body(`Cone ${i + 1}`, 'cone', [0.5, 0.8, 0.5], [-6 - i * 4, 0.4, i % 2 ? 1.6 : -1.6], {
      material: { preset: 'plastic', color: '#ff7a1a' },
    });
  }
  for (let row = 0; row < 4; row++)
    for (let col = 0; col < 3; col++) {
      b.body('Crate', 'box', [0.6, 0.6, 0.6], [-30, 0.3 + row * 0.6, -0.7 + col * 0.7], { material: 'wood' });
    }
  return b.done();
}

function leverLauncher(): SceneDocument {
  const b = new Builder('Lever launcher');
  const phi = 16 * DEG,
    hl = 3,
    hy = 0.95;
  b.body('Support', 'box', [0.4, 0.8, 0.9], [0, 0.4, 0], { bodyType: 'static', material: 'concrete' });
  const arm = b.body('Lever arm', 'box', [6, 0.14, 0.7], [0, hy, 0], { material: 'wood', rotation: rotZ(-16) });
  b.joint('hinge', null, arm, [0, hy, 0], [0, 0, 1], { name: 'Fulcrum pin' });
  const left: Vec3 = [-hl * Math.cos(phi), hy + hl * Math.sin(phi), 0];
  const right: Vec3 = [hl * Math.cos(phi), hy - hl * Math.sin(phi), 0];
  b.body('Counterweight', 'box', [0.9, 0.9, 0.9], [left[0] + 0.4, left[1] + 3.4, 0], { material: 'lead' });
  b.body('Payload', 'sphere', [0.5, 0.5, 0.5], [right[0] - 0.5, right[1] + 0.42, 0], { material: 'rubber' });
  for (let r = 0; r < 5; r++)
    for (let c = 0; c < 2; c++) {
      b.body('Crate', 'box', [0.6, 0.6, 0.6], [14, 0.3 + r * 0.6, -0.35 + c * 0.7], { material: 'wood' });
    }
  return b.done();
}

function ropeBridge(): SceneDocument {
  const b = new Builder('Rope bridge');
  const planks = 14,
    pw = 0.55,
    span = planks * pw;
  const y = 3.2;
  const x0 = -span / 2;
  b.body('Cliff left', 'box', [4, 3.2, 4], [x0 - 2, 1.6, 0], { bodyType: 'static', material: 'concrete' });
  b.body('Cliff right', 'box', [4, 3.2, 4], [-x0 + 2, 1.6, 0], { bodyType: 'static', material: 'concrete' });
  let prev: BodyEntity | null = null;
  for (let i = 0; i < planks; i++) {
    const plank = b.body(`Plank ${i + 1}`, 'box', [pw - 0.04, 0.12, 1.6], [x0 + (i + 0.5) * pw, y - 0.06, 0], {
      material: 'wood',
    });
    for (const sz of [-0.7, 0.7]) {
      b.joint('hinge', prev, plank, [x0 + i * pw, y - 0.06, sz], [0, 0, 1], {
        name: i === 0 ? 'Anchor' : 'Plank link',
      });
    }
    prev = plank;
  }
  for (const sz of [-0.7, 0.7])
    b.joint('hinge', prev, null, [x0 + planks * pw, y - 0.06, sz], [0, 0, 1], { name: 'Anchor' });
  for (let i = 0; i < 6; i++) {
    b.body(`Ball ${i + 1}`, 'sphere', [0.5, 0.5, 0.5], [x0 + 1.5 + i * 1.1, y + 2.5 + i * 0.9, ((i % 3) - 1) * 0.4], {
      material: i % 2 ? 'steel' : 'rubber',
    });
  }
  b.body('Heavy crate', 'box', [1, 1, 1], [0, y + 6, 0], { material: 'lead' });
  return b.done();
}

function wreckingBall(): SceneDocument {
  const b = new Builder('Wrecking ball');
  const jibY = 7.5,
    hook: Vec3 = [-1.5, jibY - 0.2, 0];
  b.body('Crane mast', 'box', [0.5, jibY + 0.2, 0.5], [-6, (jibY + 0.2) / 2, 0], {
    bodyType: 'static',
    material: 'steel',
  });
  b.body('Crane jib', 'box', [4.9, 0.4, 0.4], [-3.75, jibY, 0], { bodyType: 'static', material: 'steel' });
  const links = 8,
    ll = 0.55,
    alpha = 62 * DEG;
  // Chain direction from the hook, pulled back (toward −x) so it swings through the wall.
  const dir: Vec3 = [-Math.sin(alpha), -Math.cos(alpha), 0];
  const at = (s: number): Vec3 => [hook[0] + dir[0] * s, hook[1] + dir[1] * s, 0];
  let prev: BodyEntity | null = null;
  for (let i = 0; i < links; i++) {
    const link = b.body(`Link ${i + 1}`, 'capsule', [0.16, ll, 0.16], at((i + 0.5) * ll), {
      material: 'steel',
      rotation: rotZ(-62),
      angularDamping: 0.15,
    });
    b.joint('ball', prev, link, at(i * ll), [0, 0, 1], { name: i === 0 ? 'Hook' : 'Chain joint' });
    prev = link;
  }
  const ballR = 0.55;
  const ball = b.body('Wrecking ball', 'sphere', [ballR * 2, ballR * 2, ballR * 2], at(links * ll + ballR), {
    material: { preset: 'steel', density: 9000, color: '#2d2f36', metalness: 0.8 },
    ccd: true,
  });
  b.joint('ball', prev, ball, at(links * ll), [0, 0, 1], { name: 'Ball mount' });
  const bl = 0.7,
    bh = 0.35,
    bt = 0.4;
  for (let row = 0; row < 14; row++)
    for (let col = 0; col < 7; col++) {
      const off = row % 2 ? bl / 2 : 0;
      b.body('Brick', 'box', [bt, bh - 0.004, bl - 0.004], [0.45, bh / 2 + row * bh, (col - 3) * bl + off], {
        material: 'concrete',
      });
    }
  return b.done();
}

function jenga(): SceneDocument {
  const b = new Builder('Jenga tower');
  const lx = 1.5,
    ly = 0.3,
    lz = 0.5;
  for (let layer = 0; layer < 15; layer++) {
    for (let k = 0; k < 3; k++) {
      const off = (k - 1) * (lz + 0.005);
      const even = layer % 2 === 0;
      b.body('Block', 'box', [lx, ly, lz - 0.004], even ? [0, 0.15 + layer * ly, off] : [off, 0.15 + layer * ly, 0], {
        rotation: even ? [0, 0, 0, 1] : rotY(90),
        material: 'wood',
      });
    }
  }
  b.body('Wrecker', 'sphere', [0.8, 0.8, 0.8], [-9, 2.1, 0.2], {
    material: 'steel',
    velocity: [12, 3.2, 0],
    ccd: true,
  });
  return b.done();
}

function frictionLab(): SceneDocument {
  const b = new Builder('Friction lab');
  const angle = 28;
  const mats: [string, string][] = [
    ['Ice', 'ice'],
    ['Steel', 'steel'],
    ['Wood', 'wood'],
    ['Rubber', 'rubber'],
  ];
  const len = 14,
    w = 1.6,
    cy0 = 4.0;
  mats.forEach(([name, mat], i) => {
    const z = (i - 1.5) * (w + 0.5);
    b.body(`Slope (${name})`, 'box', [len, 0.3, w], [0, cy0, z], {
      bodyType: 'static',
      rotation: rotZ(angle),
      material: { preset: 'custom', friction: 0.3, restitution: 0, color: '#444c58' },
    });
    // Start near the high (+x) end, resting on the slope surface.
    const s = len / 2 - 1.4,
      n = 0.15 + 0.45 + 0.01,
      a = angle * DEG;
    b.body(
      `${name} block`,
      'box',
      [0.9, 0.9, 0.9],
      [s * Math.cos(a) - n * Math.sin(a), cy0 + s * Math.sin(a) + n * Math.cos(a), z],
      {
        rotation: rotZ(angle),
        material: mat,
      },
    );
  });
  return b.done();
}

function billiards(): SceneDocument {
  const b = new Builder('Billiards (zero-g)');
  b.doc.settings.gravity = [0, 0, 0];
  const mat = { preset: 'ceramic', restitution: 0.98, friction: 0.05 };
  const r = 0.28,
    still = { linearDamping: 0, angularDamping: 0, canSleep: false };
  b.body('Cue ball', 'sphere', [2 * r, 2 * r, 2 * r], [-5, 3, 0.05], {
    material: { ...mat, color: '#ffffff' },
    velocity: [9, 0, 0],
    ...still,
  });
  const colors = [
    '#e63946',
    '#f4a261',
    '#e9c46a',
    '#2a9d8f',
    '#457b9d',
    '#8d5fd3',
    '#ff6b9a',
    '#1d3557',
    '#06d6a0',
    '#ffd166',
  ];
  let n = 0;
  for (let row = 0; row < 4; row++)
    for (let i = 0; i <= row; i++) {
      b.body(`Ball ${n + 1}`, 'sphere', [2 * r, 2 * r, 2 * r], [row * 0.5, 3, (i - row / 2) * 0.58], {
        material: { ...mat, color: colors[n % colors.length] },
        ...still,
      });
      n++;
    }
  return b.done();
}

function ballPit(): SceneDocument {
  const b = new Builder('Ball pit (stress test)');
  const R = 4.2,
    h = 2.4,
    segs = 20;
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const w = (2 * Math.PI * R) / segs + 0.04;
    b.body('Wall', 'box', [w, h, 0.3], [Math.cos(a) * R, h / 2, Math.sin(a) * R], {
      bodyType: 'static',
      rotation: qfromAxisAngle([0, 1, 0], -a + Math.PI / 2),
      material: 'concrete',
    });
  }
  const palette = ['#ff5964', '#35a7ff', '#ffd23f', '#6bf178', '#c77dff', '#ff9f1c'];
  let c = 0;
  for (let layer = 0; layer < 6; layer++) {
    for (let i = 0; i < 50; i++) {
      const rad = 0.2 + 0.1 * ((i * 7 + layer) % 3);
      const a = i * 2.399963; // golden angle spreads the balls evenly
      const rr = Math.sqrt((i + 0.5) / 50) * (R - 0.8);
      b.body(
        'Ball',
        'sphere',
        [rad * 2, rad * 2, rad * 2],
        [Math.cos(a) * rr, 3 + layer * 0.75 + (i % 5) * 0.05, Math.sin(a) * rr],
        {
          material: { preset: 'rubber', color: palette[c++ % palette.length], restitution: 0.55 },
        },
      );
    }
  }
  return b.done();
}

function pistonPress(): SceneDocument {
  const b = new Builder('Piston press');
  b.body('Base', 'box', [4, 0.4, 3], [0, 0.2, 0], { bodyType: 'static', material: 'steel' });
  b.body('Column L', 'box', [0.3, 4, 0.3], [-1.6, 2.4, 0], { bodyType: 'static', material: 'steel' });
  b.body('Column R', 'box', [0.3, 4, 0.3], [1.6, 2.4, 0], { bodyType: 'static', material: 'steel' });
  b.body('Crossbeam', 'box', [3.5, 0.3, 0.5], [0, 4.55, 0], { bodyType: 'static', material: 'steel' });
  const ram = b.body('Ram', 'box', [1.6, 0.5, 1.2], [0, 3.4, 0], {
    material: { preset: 'steel', color: '#c23b3b' },
    gravityScale: 0,
  });
  b.joint('slider', null, ram, ram.position, [0, 1, 0], {
    name: 'Press piston',
    limit: { enabled: true, min: -2.8, max: 0.6 },
    motor: {
      mode: 'velocity',
      targetVelocity: 1.6,
      targetPosition: 0,
      stiffness: 0,
      damping: 60000,
      maxForce: 300000,
      keyPos: 'ArrowUp',
      keyNeg: 'ArrowDown',
      slewRate: 1,
      brake: true,
    },
  });
  b.body('Crate', 'box', [0.9, 0.9, 0.9], [0, 0.85, 0], { material: 'wood' });
  b.body('Ball', 'sphere', [0.6, 0.6, 0.6], [0.8, 0.7, 0.3], { material: 'rubber' });
  return b.done();
}

function springsLab(): SceneDocument {
  const b = new Builder('Springs & dampers');
  const top = 6.4;
  b.body('Beam', 'box', [9, 0.3, 1], [0, top, 0], { bodyType: 'static', material: 'steel' });
  const rest = 1.4,
    stretch = 1.1;
  const cases = [
    { k: 300, c: 0, label: 'Undamped', color: '#ff6b8b' },
    { k: 300, c: 20, label: 'Underdamped', color: '#ffb347' },
    { k: 300, c: 170, label: 'Critically damped', color: '#5be3a1' },
    { k: 1200, c: 60, label: 'Stiff', color: '#4fd1ff' },
  ];
  cases.forEach((p, i) => {
    const x = -3.6 + i * 2.4;
    const attachTop: Vec3 = [x, top - 0.15, 0];
    const wy = attachTop[1] - (rest + stretch) - 0.15; // weight centre; its top is 0.15 above
    const weight = b.body(p.label, 'box', [0.4, 0.3, 0.4], [x, wy, 0], {
      material: { preset: 'steel', density: 500, color: p.color },
    });
    b.tether('spring', null, attachTop, weight, [x, wy + 0.15, 0], {
      name: p.label,
      spring: { restLength: rest, stiffness: p.k, damping: p.c, breakForce: 0 },
    });
  });
  return b.done();
}

function jellyPlayground(): SceneDocument {
  const b = new Builder('Jelly playground');
  b.body('Platform', 'box', [7, 0.5, 4], [0, 0.25, 0], { bodyType: 'static', material: 'concrete' });
  b.body('Ramp', 'wedge', [3, 1.2, 4], [4.6, 0.6, 0], {
    bodyType: 'static',
    rotation: rotY(-90),
    material: 'concrete',
  });
  const kinds: [string, number, string, number][] = [
    ['Stiff jelly', 45, '#5be3a1', -2.3],
    ['Medium jelly', 14, '#ffb347', 0],
    ['Soft jelly', 7, '#ff6fae', 2.3],
  ];
  for (const [name, k, color, x] of kinds) {
    b.soft(name, 'jelly', [x, 3.2, 0], {
      stiffness: k,
      color,
      damping: 0.12,
      mass: 20,
      size: [0.9, 0.9, 0.9],
      resolution: 5,
    });
  }
  b.soft('Balloon', 'balloon', [-3.4, 4.6, 1.2], { color: '#4fc3f7', size: [1, 1, 1], mass: 1.5, stiffness: 25 });
  b.soft('Balloon 2', 'balloon', [3.4, 5.2, -1.1], {
    color: '#c792ff',
    size: [0.9, 0.9, 0.9],
    mass: 1.2,
    stiffness: 25,
  });
  b.body('Rubber ball', 'sphere', [0.4, 0.4, 0.4], [-0.05, 7.5, 0.05], { material: 'rubber' });
  b.body('Foam ball', 'sphere', [0.7, 0.7, 0.7], [2.3, 9, 0], { material: 'foam' });
  return b.done();
}

function clothDrape(): SceneDocument {
  const b = new Builder('Cloth drape & hammock');
  b.body('Pedestal', 'cylinder', [1.5, 0.5, 1.5], [-3, 0.25, 0], { bodyType: 'static', material: 'concrete' });
  b.body('Sphere', 'sphere', [1.6, 1.6, 1.6], [-3, 1.3, 0], { bodyType: 'static', material: 'ceramic' });
  b.soft('Cloth', 'cloth', [-3, 3.4, 0], {
    size: [3, 0, 3],
    resolution: 22,
    stiffness: 45,
    damping: 0.4,
    color: '#e8553d',
  });
  // Hammock: four pinned corners, loaded with balls.
  for (const [x, z] of [
    [2, -1.1],
    [5.2, -1.1],
    [2, 1.1],
    [5.2, 1.1],
  ])
    b.body('Post', 'cylinder', [0.18, 3, 0.18], [x, 1.5, z], { bodyType: 'static', material: 'steel' });
  b.soft('Hammock', 'cloth', [3.6, 2.9, 0], {
    size: [3.2, 0, 2.2],
    resolution: 16,
    pin: 'corners4',
    stiffness: 30,
    damping: 0.5,
    color: '#3d8bff',
  });
  b.body('Ball', 'sphere', [0.6, 0.6, 0.6], [3.2, 4.5, 0], { material: 'foam' });
  b.body('Heavy ball', 'sphere', [0.4, 0.4, 0.4], [4.2, 6, 0.2], { material: 'wood' });
  return b.done();
}

function tearingBanner(): SceneDocument {
  const b = new Builder('Tearing banner');
  b.body('Post L', 'box', [0.25, 4.4, 0.25], [-2.1, 2.2, 0], { bodyType: 'static', material: 'steel' });
  b.body('Post R', 'box', [0.25, 4.4, 0.25], [2.1, 2.2, 0], { bodyType: 'static', material: 'steel' });
  b.body('Cross bar', 'box', [4.5, 0.18, 0.18], [0, 4.4, 0], { bodyType: 'static', material: 'steel' });
  // Cloth plane rotated to stand vertically; its first row (local −z edge) hangs from the bar.
  b.soft('Banner', 'cloth', [0, 2.1, 0], {
    size: [3.8, 0, 4.6],
    resolution: 22,
    pin: 'edge',
    stiffness: 60,
    damping: 0.25,
    tearStrain: 0.35,
    color: '#ff9d4d',
    rotation: qfromAxisAngle([1, 0, 0], Math.PI / 2),
  });
  b.body('Wrecking ball', 'sphere', [0.8, 0.8, 0.8], [0, 2.4, 9], {
    material: { preset: 'steel', density: 700 },
    velocity: [0, 1.2, -11],
    ccd: true,
  });
  b.body('Crate', 'box', [0.7, 0.7, 0.7], [0.4, 0.35, -2.5], { material: 'wood' });
  return b.done();
}

/** The example scenes that ship with the app, in Scenes-tab order (registered in `content/builtin.ts`). */
export const BUILTIN_TEMPLATES: readonly TemplateInfo[] = [
  {
    id: 'jelly',
    name: 'Jelly playground',
    category: 'Soft bodies',
    blurb: 'Jelly cubes of three stiffnesses, balloons and balls — deformable bodies from a lattice solver.',
    hint: 'Press Play, then drag a jelly cube with the mouse. Change a cube’s stiffness in the inspector.',
    view: { position: [0, 4.5, 11], target: [0, 2, 0] },
    build: jellyPlayground,
  },
  {
    id: 'cloth',
    name: 'Cloth drape & hammock',
    category: 'Soft bodies',
    blurb: 'A cloth settles over a sphere; a four-corner hammock catches falling balls.',
    hint: 'Press Play. Grab the cloth by a corner and shake it.',
    view: { position: [0.5, 5, 11], target: [0.5, 2, 0] },
    build: clothDrape,
  },
  {
    id: 'banner',
    name: 'Tearing banner',
    category: 'Soft bodies',
    blurb: 'A banner with a tear strain: rip it with the wrecking ball, or fire your own projectiles.',
    hint: 'Press Play and watch the tear. Select the banner and change its tear strain; use the Fire tool (T) for more shots.',
    view: { position: [-5, 3.5, 10], target: [0, 2.4, 0] },
    build: tearingBanner,
  },
  {
    id: 'car',
    name: 'Drivable car',
    category: 'Vehicles',
    blurb: 'Independent spring-damper suspension, steered front wheels and rear-wheel drive — all joints and motors.',
    hint: 'Press Play, then drive with W / S (throttle, reverse) and A / D (steer). Select a joint to tune its motor.',
    view: { position: [6.5, 3.2, 7.5], target: [1, 0.5, 0] },
    follow: 'Chassis',
    build: () => buildCar(true),
  },
  {
    id: 'wreck',
    name: 'Wrecking ball',
    category: 'Playground',
    blurb: 'A chain of ball-jointed links swings a dense ball into a brick wall.',
    hint: 'Press Play and watch the wall go. You can drag objects with the mouse while it runs.',
    view: { position: [-3, 5, 13], target: [-1, 3, 0] },
    build: wreckingBall,
  },
  {
    id: 'lever',
    name: 'Lever launcher',
    category: 'Mechanisms',
    blurb: 'A counterweight drops onto a hinged lever and fires a ball at a crate tower.',
    hint: 'Press Play. Try a different counterweight material, or slide the fulcrum.',
    build: leverLauncher,
  },
  {
    id: 'piston',
    name: 'Piston press',
    category: 'Mechanisms',
    blurb: 'A motorised slider crushes whatever is underneath it.',
    hint: 'Press Play, then hold the Down arrow to lower the ram and Up to raise it.',
    build: pistonPress,
  },
  {
    id: 'double',
    name: 'Double pendulum',
    category: 'Physics labs',
    blurb: 'Two hinged arms — deterministic, yet chaotic. Tiny changes give wildly different motion.',
    hint: 'Turn on Trails (View menu) and press Play. Nudge an angle slightly and compare the paths.',
    build: doublePendulum,
  },
  {
    id: 'cradle',
    name: "Newton's cradle",
    category: 'Physics labs',
    blurb: 'Five elastic spheres on ropes exchange momentum through contacts.',
    hint: 'Press Play and open the Energy panel to watch kinetic and potential energy trade places.',
    build: newtonsCradle,
  },
  {
    id: 'springs',
    name: 'Springs & dampers',
    category: 'Physics labs',
    blurb: 'Four masses on springs: undamped, under-, critically damped and stiff.',
    hint: 'Press Play and compare how quickly each mass settles. Select a spring to edit k and c.',
    build: springsLab,
  },
  {
    id: 'friction',
    name: 'Friction lab',
    category: 'Physics labs',
    blurb: 'Ice, steel, wood and rubber blocks released on identical slopes.',
    hint: 'Press Play. Select a block and change its friction to find the critical angle (tan θ = μ).',
    build: frictionLab,
  },
  {
    id: 'billiards',
    name: 'Billiards (zero-g)',
    category: 'Physics labs',
    blurb: 'Near-elastic collisions in zero gravity — momentum is conserved.',
    hint: 'Turn on Trails (View menu) and open the Energy panel, then press Play.',
    build: billiards,
  },
  {
    id: 'domino',
    name: 'Domino run',
    category: 'Playground',
    blurb: '46 dominoes along an S-curve, triggered by a ball rolling down a ramp.',
    hint: 'Press Play. Use the slow-motion control for a closer look.',
    build: dominoRun,
  },
  {
    id: 'jenga',
    name: 'Jenga tower',
    category: 'Structures',
    blurb: '45 blocks stacked on friction alone — with something heavy on its way.',
    hint: 'Press Play. Try grabbing a block mid-tower and pulling it out.',
    build: jenga,
  },
  {
    id: 'bridge',
    name: 'Rope bridge',
    category: 'Structures',
    blurb: 'Planks on hinge joints sag under their own weight and under load.',
    hint: 'Press Play and watch it settle; the balls and the heavy crate test it.',
    build: ropeBridge,
  },
  {
    id: 'pit',
    name: 'Ball pit',
    category: 'Playground',
    blurb: '300 balls in a ring — a performance stress test for the simulation.',
    hint: 'Press Play and check the status bar for step time. Try the Blast tool.',
    build: ballPit,
  },
];
