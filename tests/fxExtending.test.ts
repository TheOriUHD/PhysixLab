/**
 * The particle-effect example of docs/EXTENDING.md (`tests/examples/confetti-effect.ts`): it registers a type and a
 * command, the command emits that type through `app.fx.emit`, the particles obey the scene's gravity, and removing the
 * registrations leaves nothing behind. (That the guide shows exactly this file is checked by `tests/extending.test.ts`.)
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Group } from 'three';
import type { App } from '../src/app/app';
import { getCommand, runCommand, unregisterCommand } from '../src/app/registry';
import { registerAppBuiltins } from '../src/app/builtin';
import { Fx, particleTypes } from '../src/render/fx';
import { hasIcon } from '../src/ui/icons';

describe('example: a new particle effect with a command', () => {
  afterAll(() => {
    unregisterCommand('demo.confetti');
    particleTypes.unregister('demo.confetti');
  });

  it('registers a type and a command; the command emits the type through app.fx', async () => {
    registerAppBuiltins();
    await import('./examples/confetti-effect');
    const def = particleTypes.get('demo.confetti')!;
    expect(def.label).toBe('Confetti');
    expect(getCommand('demo.confetti')?.label).toBe('Confetti at the view centre');
    expect(hasIcon(getCommand('demo.confetti')!.icon!)).toBe(true);

    const fx = new Fx(new Group());
    const app = { fx, viewport: { controls: { target: { x: 2, y: 1, z: -3 } } } } as unknown as App;
    expect(runCommand('demo.confetti', app)).toBe(true);
    expect(fx.liveOfType('demo.confetti')).toBeGreaterThan(40);
    expect(fx.emittedByType()['demo.confetti']).toBeGreaterThan(40);
    // They start where the command put them (the view centre, 20 cm above the ground).
    const o = 0;
    expect(fx.normal.state[o]).toBeGreaterThan(1.5);
    expect(fx.normal.state[o]).toBeLessThan(2.5);
  });

  it('the confetti falls with the scene gravity and lies on the ground', () => {
    const fx = new Fx(new Group());
    fx.setEnvironment({ gravity: [0, -9.81, 0], floorY: 0 });
    fx.emit('demo.confetti', [0, 3, 0], { count: 30 });
    const cam = { position: { x: 0, y: 4, z: 10 } };
    for (let i = 0; i < 60 * 8; i++) fx.update(1 / 60, cam);
    // After 8 s the confetti (life ≤ 2.6 s) is gone; nothing is left hanging in the air.
    expect(fx.stats.live).toBe(0);
    fx.emit('demo.confetti', [0, 3, 0], { count: 30 });
    for (let i = 0; i < 60 * 2; i++) fx.update(1 / 60, cam);
    const pool = fx.normal;
    for (let i = 0; i < pool.count; i++) expect(pool.state[i * 19 + 1]).toBeGreaterThanOrEqual(-1e-6); // never below the ground
  });

  it('removing the registrations leaves nothing behind', () => {
    unregisterCommand('demo.confetti');
    particleTypes.unregister('demo.confetti');
    expect(getCommand('demo.confetti')).toBeUndefined();
    expect(particleTypes.get('demo.confetti')).toBeUndefined();
    const fx = new Fx(new Group());
    expect(fx.emit('demo.confetti', [0, 1, 0])).toBe(0);
  });
});
