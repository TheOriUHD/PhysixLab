/**
 * The "Randomness" section of the World panel (TM-6): the scene seed and a Reseed button. Everything stochastic in the
 * simulation (component jitter, spawner variation, noise, gusts, fracture) draws from the world's generator, which
 * this seed starts: the same seed gives the same run, a new seed gives a different one. Changing the seed while the
 * simulation runs restarts the generator at once.
 */
import type { App } from '../../app/app';
import { button, numberField, row, section } from '../controls';
import { h } from '../dom';

export function buildSeedSection(app: App): { el: HTMLElement; refresh: () => void } {
  const { store } = app;
  const seed = numberField({
    step: 1,
    min: 0,
    max: 4294967295,
    digits: 0,
    onChange: (v) => store.updateSettings({ seed: Math.floor(v) }, 'Scene seed'),
  });
  const reseed = button(
    'Reseed',
    () => {
      const next = Math.floor(Math.random() * 4294967296); // the one place a seed is chosen at random: by the user's request
      store.updateSettings({ seed: next }, 'Reseed');
    },
    { icon: 'sparkle', title: 'Pick a new random seed: the next run plays out differently' },
  );
  const el = section(
    'Randomness',
    [
      row('Seed', [seed.el, reseed], 'Starts the random number generator of the scene'),
      h(
        'p',
        { class: 'hint-text' },
        'The same seed and the same inputs always give the same run, so runs can be replayed and compared. Reseed to see a different outcome.',
      ),
    ],
    { id: 'world-seed' },
  );
  return { el, refresh: () => seed.set(store.settings.seed) };
}
