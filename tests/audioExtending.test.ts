/**
 * The sound example of docs/EXTENDING.md (`tests/examples/tuning-fork-sound.ts`): it registers a sound event, a material
 * profile and a command; the event renders to a 440 Hz ring, the material changes what a struck object sounds like, the
 * command plays the event through `app.audio`. (That the guide shows exactly this file is checked by
 * `tests/extending.test.ts`.)
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app/app';
import { registerAppBuiltins } from '../src/app/builtin';
import { getCommand, runCommand, unregisterCommand } from '../src/app/registry';
import { dominantFrequency, renderRecipe, ringTime } from '../src/audio/dsp';
import { soundEvent } from '../src/audio/events';
import { planImpact } from '../src/audio/impact';
import { hashString } from '../src/audio/mapping';
import { soundProfileFor } from '../src/audio/materials';
import { hasIcon } from '../src/ui/icons';

describe('example: a new sound event and a new material', () => {
  afterAll(() => unregisterCommand('demo.tuningFork'));

  it('registers an event that renders to the pitch it asks for and rings for seconds', async () => {
    registerAppBuiltins();
    await import('./examples/tuning-fork-sound');
    const def = soundEvent('demo.tuningFork')!;
    expect(def.label).toBe('Tuning fork');
    expect(def.category).toBe('impacts');
    const sr = 44100;
    const buf = renderRecipe(def.recipe({ level: 0.7 }), sr, hashString(def.key({ level: 0.7 })));
    expect(dominantFrequency(buf, sr, 100, 4000, 32768)).toBeCloseTo(440, -1);
    expect(ringTime(buf, sr)).toBeGreaterThan(1.2); // a fork rings: 40 dB down takes 2/3 of 2.2 s
    expect(def.key({ level: 0.1 })).not.toBe(def.key({ level: 0.9 }));
    expect(def.gain({ level: 1 })).toBeGreaterThan(def.gain({ level: 0 }));
  });

  it('the new material is heard in collisions: a titanium ball sounds its own pitch', () => {
    expect(soundProfileFor('titanium').pitch).toBe(1100);
    const v = planImpact({
      speed: 6,
      impulse: 300,
      matA: 'titanium',
      matB: 'ground',
      sizeA: 0.5,
      sizeB: 99,
      massA: 10,
      massB: 0,
    })[0];
    const steel = planImpact({
      speed: 6,
      impulse: 300,
      matA: 'steel',
      matB: 'ground',
      sizeA: 0.5,
      sizeB: 99,
      massA: 10,
      massB: 0,
    })[0];
    expect(v.spec.preset).toBe('titanium');
    expect(v.spec.pitch).toBeGreaterThan(steel.spec.pitch); // higher than steel
  });

  it('the command plays the event at the view centre through app.audio', () => {
    expect(getCommand('demo.tuningFork')?.label).toBe('Strike a tuning fork');
    expect(hasIcon(getCommand('demo.tuningFork')!.icon!)).toBe(true);
    const played: { id: string; at: unknown; params: unknown }[] = [];
    const app = {
      audio: { playEvent: (id: string, at: unknown, params: unknown) => played.push({ id, at, params }) },
      viewport: { controls: { target: { x: 2, y: 1, z: -3 } } },
    } as unknown as App;
    expect(runCommand('demo.tuningFork', app)).toBe(true);
    expect(played).toEqual([{ id: 'demo.tuningFork', at: [2, 1, -3], params: { level: 0.7 } }]);
  });
});
