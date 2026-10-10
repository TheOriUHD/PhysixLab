// File: src/ui/extensions/confetti.ts   (files in src/ui/extensions are loaded at start-up, nothing to edit)
import { registerCommand } from '../../src/app/registry';
import { registerParticleType } from '../../src/render/fx';

// A particle type is data: sprite, lifetime, size / opacity / colour over life, speed, gravity, drag, wind, floor bounce.
registerParticleType({
  id: 'demo.confetti',
  label: 'Confetti',
  blend: 'normal',
  sprites: ['chip', 'shard2'],
  life: [1.6, 2.6],
  size: [0.04, 0.09],
  sizeOverLife: [
    [0, 1],
    [0.85, 1],
    [1, 0],
  ],
  alphaOverLife: [
    [0, 1],
    [0.8, 1],
    [1, 0],
  ],
  colorOverLife: [
    [0, '#ff5964'],
    [0.5, '#ffd23f'],
    [1, '#35a7ff'],
  ],
  speed: [3, 9],
  spread: 0.9, // half-angle of the emission cone, radians
  gravity: 0.6, // × the scene's gravity
  drag: 1.2,
  wind: 0.8, // how strongly the wind carries it (0 … 1)
  spin: [4, 16],
  orient: 'billboard',
  bounce: 0.3, // restitution on the ground; it then lies there until it fades
  settle: true,
  count: 60,
  radius: 0.1,
});

registerCommand({
  id: 'demo.confetti',
  label: 'Confetti at the view centre',
  category: 'View',
  icon: 'sparkle',
  keywords: ['party', 'particles', 'effect'],
  // `app.fx.emit(type, position, options)` is the whole API: count, scale, speed, direction, spread, colour tint …
  run: ({ app }) => {
    const t = app.viewport.controls.target;
    app.fx.emit('demo.confetti', [t.x, 0.2, t.z], { count: 80 });
  },
});
