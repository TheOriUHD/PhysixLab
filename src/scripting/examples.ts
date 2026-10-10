/** DT-32: the examples gallery of the Scene script dialog. Every example is run by the tests. */
export interface ScriptExample {
  id: string;
  title: string;
  blurb: string;
  code: string;
}

export const SCRIPT_EXAMPLES: readonly ScriptExample[] = [
  {
    id: 'domino-spiral',
    title: 'Domino spiral',
    blurb: 'array() + trigonometry: dominoes placed along a spiral, pushed by a ball.',
    code: `name('Domino spiral');
const n = 60;
array(n, (i) => {
  const t = i / n;
  const a = t * 5 * Math.PI;
  const r = 1.2 + t * 3.2;
  body('Domino ' + (i + 1), 'box', [0.12, 0.7, 0.4], [Math.cos(a) * r, 0.35, Math.sin(a) * r], {
    rotation: rotY(-a / DEG),
    material: i % 2 ? 'wood' : 'ceramic',
  });
});
body('Pusher', 'sphere', [0.5, 0.5, 0.5], [1.9, 0.9, -0.6], {
  material: 'steel',
  linearVelocity: [0, 0, 2.5],
});
`,
  },
  {
    id: 'pendulum-chain',
    title: 'Pendulum chain',
    blurb: 'joint(): links connected by hinges, hung from the world.',
    code: `name('Pendulum chain');
const links = 7, len = 0.6;
let prev = null;
for (let i = 0; i < links; i++) {
  const y = 5 - i * len;
  const link = body('Link ' + (i + 1), 'box', [0.12, len * 0.92, 0.12], [i * 0.0, y - len / 2, 0], {
    material: 'steel',
  });
  joint('hinge', prev, link, [0, y, 0], [0, 0, 1], { name: 'Hinge ' + (i + 1) });
  prev = link;
}
// Kick the last link sideways.
body('Weight', 'sphere', [0.5, 0.5, 0.5], [0.9, 5 - links * len - 0.2, 0], { material: 'lead' });
`,
  },
  {
    id: 'brick-wall',
    title: 'Brick wall',
    blurb: 'grid() with an offset every second row, and a wrecking ball on a rope.',
    code: `name('Brick wall');
body('Floor pad', 'box', [10, 0.2, 4], [0, 0.1, 0], { bodyType: 'static', material: 'concrete' });
const w = 0.8, h = 0.4, d = 0.4;
grid(8, 8, w, h, (x, y, i, j) => {
  body('Brick ' + i + '-' + j, 'box', [w * 0.98, h * 0.98, d], [x - 3 + (j % 2 ? w / 2 : 0), 0.2 + h / 2 + y, 0], {
    material: 'ceramic',
  });
});
const ball = body('Wrecker', 'sphere', [1.0, 1.0, 1.0], [-6, 4, 0], { material: 'steel' });
tether('rope', null, [-4, 8, 0], ball, [-6, 4, 0], { name: 'Wrecker rope' });
`,
  },
  {
    id: 'newtons-cradle',
    title: "Newton's cradle",
    blurb: 'tether() ropes and a swung-out first ball.',
    code: `name("Newton's cradle");
const r = 0.25, top = 3.4, D = 2.2;
const mat = { preset: 'steel', restitution: 1, friction: 0, metalness: 1, roughness: 0.15 };
array(5, (i) => {
  const px = (i - 2) * (2 * r + 0.003);
  const a = i === 0 ? 38 * DEG : 0;
  const c = [px - Math.sin(a) * D, top - Math.cos(a) * D, 0];
  const ball = body('Ball ' + (i + 1), 'sphere', [2 * r, 2 * r, 2 * r], c, { material: mat, canSleep: false, ccd: true });
  tether('rope', null, [px, top, -0.6], ball, c, { name: 'String L' + i });
  tether('rope', null, [px, top, 0.6], ball, c, { name: 'String R' + i });
});
`,
  },
  {
    id: 'random-rain',
    title: 'Seeded rain of shapes',
    blurb: 'random() is seeded, so the same script always builds the same scene; Math.random is replaced too.',
    code: `name('Seeded rain');
seed(42);
const shapes = ['box', 'sphere', 'cylinder', 'capsule', 'cone'];
body('Basin floor', 'box', [8, 0.3, 8], [0, 0, 0], { bodyType: 'static', material: 'concrete' });
array(40, (i) => {
  const s = 0.3 + random() * 0.35;
  body('Shape ' + (i + 1), shapes[i % shapes.length], [s, s, s], [(random() - 0.5) * 5, 1 + i * 0.35, (random() - 0.5) * 5], {
    rotation: rotX(random() * 360),
    material: ['wood', 'rubber', 'steel', 'plastic'][i % 4],
  });
});
`,
  },
  {
    id: 'low-gravity-jelly',
    title: 'Moon gravity and jelly',
    blurb: 'settings() changes scene settings; soft() adds a soft body.',
    code: `name('Jelly on the Moon');
settings({ gravity: [0, -1.62, 0] });
body('Ground slab', 'box', [6, 0.3, 6], [0, 0, 0], { bodyType: 'static', material: 'concrete' });
soft('Jelly', 'jelly', [0, 2.5, 0]);
soft('Balloon', 'balloon', [1.6, 3, 0.4]);
`,
  },
];
