// File: src/ui/extensions/tuning-fork.ts   (files in src/ui/extensions are loaded at start-up, nothing to edit)
import { registerCommand } from '../../src/app/registry';
import { registerSoundEvent, registerSoundMaterial, soundProfileFor } from '../../src/audio';

// A sound is a recipe, not a sample: ringing modes (frequency Hz, loudness, seconds to fall 60 dB), noise layers and
// grains. The engine renders each distinct `key` once into a buffer and plays it with a gain, a pan and a pitch.
registerSoundEvent({
  id: 'demo.tuningFork',
  label: 'Tuning fork',
  category: 'impacts', // which volume slider and voice budget it belongs to
  spatial: true, // positioned relative to the camera (false: heard at the same level everywhere, like the interface)
  key: (p) => `demo|fork|l${Math.round((p.level ?? 0.5) * 4)}`, // equal keys share one rendered buffer
  gain: (p) => 0.05 + 0.2 * (p.level ?? 0.5),
  recipe: (p) => ({
    duration: 2.6,
    modes: [
      { freq: 440, gain: 1, t60: 2.2 }, // the fundamental rings for seconds…
      { freq: 440 * 6.27, gain: 0.1 + 0.2 * (p.level ?? 0.5), t60: 0.12 }, // …the strike's overtone dies at once
    ],
    noise: [{ color: 'white', gain: 0.15, t60: 0.01, filter: { type: 'highpass', freq: 3000 } }], // the tick of the blow
  }),
});

// A material is a profile too: how an object of it rings when struck (mode ratios and loudness, ring time, brightness).
registerSoundMaterial('titanium', { ...soundProfileFor('steel'), pitch: 1100, ring: 2.2, hardness: 0.9 });

registerCommand({
  id: 'demo.tuningFork',
  label: 'Strike a tuning fork',
  category: 'Sound',
  icon: 'speaker',
  keywords: ['sound', 'audio', 'note', 'a440'],
  // `app.audio.playEvent(id, position, params)` is the whole API: a position (null = not positioned), `size`, `level`, …
  run: ({ app }) => {
    const t = app.viewport.controls.target;
    app.audio.playEvent('demo.tuningFork', [t.x, t.y, t.z], { level: 0.7 });
  },
});
