/**
 * Scene settings added in format v2 (FB-11): seed, substeps, environment, bounds and units are stored,
 * sanitised and migrated; `substeps` is also honoured by the physics world.
 */
import { describe, expect, it } from 'vitest';
import { newDocument, defaultSettings } from '../src/model/factory';
import { SceneStore } from '../src/model/store';
import { parseDocument, sanitizeDocument, serializeDocument } from '../src/model/serialize';
import { createBody, createJoint, run, worldOf } from './helpers';

const sparse = (settings: unknown) => sanitizeDocument({ format: 'physicslab-scene', entities: [], settings }).settings;

describe('v2 scene settings', () => {
  it('have defaults that reproduce the v1 behaviour', () => {
    const s = defaultSettings();
    expect(s.seed).toBe(1);
    expect(s.substeps).toBe(1);
    expect(s.bounds.enabled).toBe(false);
    expect(s.environment).toMatchObject({
      sky: 'studio',
      timeOfDay: 12,
      fog: { enabled: false, color: '#9db4cc', density: 0.01 },
      exposure: 1,
    });
    expect(s.units).toEqual({ length: 'm', mass: 'kg', angle: 'deg' });
    expect(sparse(undefined)).toEqual(s);
    expect(sparse({})).toEqual(s);
  });

  it('round-trip through the serialiser unchanged', () => {
    const doc = newDocument('s');
    doc.settings = {
      ...doc.settings,
      seed: 424242,
      substeps: 6,
      environment: {
        ...doc.settings.environment,
        sky: 'sunset',
        timeOfDay: 18.5,
        fog: { ...doc.settings.environment.fog, enabled: true, color: '#aabbcc', density: 0.2 },
        exposure: 1.4,
      },
      bounds: { ...doc.settings.bounds, enabled: true, min: [-10, -5, -10], max: [10, 50, 10], policy: 'respawn' },
      units: { length: 'ft', mass: 'lb', angle: 'rad' },
    };
    expect(parseDocument(serializeDocument(doc)).settings).toEqual(doc.settings);
  });

  it('are sanitised: clamped, validated and never NaN', () => {
    const s = sparse({
      seed: -5,
      substeps: 99.7,
      environment: {
        sky: 'plasma',
        timeOfDay: 40,
        fog: { enabled: 'yes', color: 'red; drop table', density: 5 },
        exposure: 0,
      },
      bounds: { enabled: true, min: [5, 5, 5], max: [-5, 5, 'x'], policy: 'explode' },
      units: { length: 'parsec', mass: 'g', angle: 7 },
    });
    expect(s.seed).toBe(0);
    expect(s.substeps).toBe(16);
    expect(s.environment.sky).toBe('studio');
    expect(s.environment.timeOfDay).toBe(24);
    expect(s.environment.fog).toMatchObject({ enabled: false, color: '#9db4cc', density: 1 });
    expect(s.environment.exposure).toBe(0.1);
    // a corner that is not a finite 3-vector falls back to the default corner
    expect(s.bounds.min).toEqual([5, 5, 5]);
    expect(s.bounds.max).toEqual([100, 100, 100]);
    expect(s.bounds.policy).toBe('kill');
    expect(s.units).toEqual({ length: 'm', mass: 'g', angle: 'deg' });
    expect(sparse({ seed: 2 ** 40 }).seed).toBe(0xffffffff);
    expect(sparse({ seed: 12.9 }).seed).toBe(12);
    expect(sparse({ substeps: 0 }).substeps).toBe(1);
    expect(sparse({ bounds: { min: [3, 0, 0], max: [1, 0, 0] } }).bounds).toMatchObject({
      min: [1, 0, 0],
      max: [3, 1, 1],
    });
  });

  it('upgrade a v1 scene that has none of them', () => {
    const v1 = {
      format: 'physicslab-scene',
      version: 1,
      name: 'old',
      entities: [],
      settings: { gravity: [0, -1.6, 0], physicsHz: 60, solverIterations: 4, airDrag: 0.2 },
    };
    const s = sanitizeDocument(v1).settings;
    expect(s).toMatchObject({ gravity: [0, -1.6, 0], physicsHz: 60, solverIterations: 4, airDrag: 0.2 });
    expect(s.substeps).toBe(1);
    expect(s.seed).toBe(1);
  });

  it('are edited through the store, undoable, and reported as a settings change', () => {
    const store = new SceneStore();
    const keys: string[][] = [];
    store.on('change', (c) => c.type === 'settings' && keys.push([...c.keys]));
    store.updateSettings({ substeps: 4 }, 'Sub-steps');
    store.updateSettings({ seed: 99, units: { ...store.settings.units, length: 'cm' } });
    expect(store.settings.substeps).toBe(4);
    expect(keys).toEqual([['substeps'], ['seed', 'units']]);
    store.undo();
    expect(store.settings.seed).toBe(1);
    expect(store.settings.substeps).toBe(4);
    store.undo();
    expect(store.settings.substeps).toBe(1);
    store.redo();
    expect(store.settings.substeps).toBe(4);
    expect(store.toDocument().settings.substeps).toBe(4);
  });
});

describe('substeps in the physics world', () => {
  const noDamp = { linearDamping: 0, angularDamping: 0, canSleep: false };

  it('divide the fixed step: n engine steps of dt/n per step, fixed-step bookkeeping unchanged', async () => {
    const ball = createBody({ shape: { type: 'sphere', size: [0.4, 0.4, 0.4] }, position: [0, 20, 0], ...noDamp });
    const w = await worldOf([ball], { physicsHz: 60, substeps: 4 });
    expect(w.world.integrationParameters.dt).toBeCloseTo(1 / 240, 9);
    let engineSteps = 0;
    const orig = w.world.step.bind(w.world);
    w.world.step = (...a: Parameters<typeof orig>) => {
      engineSteps++;
      return orig(...a);
    };
    w.stepOnce();
    expect(engineSteps).toBe(4);
    expect(w.stepCount).toBe(1);
    expect(w.simTime).toBeCloseTo(1 / 60, 9);
    expect(w.fixedDt).toBeCloseTo(1 / 60, 9);
    // the wall-clock accumulator still consumes whole fixed steps
    expect(w.advance(1 / 60, 1)).toBe(1);
    expect(engineSteps).toBe(8);
  });

  it('give the same trajectory as the equivalent faster fixed rate', async () => {
    const make = () =>
      createBody({
        shape: { type: 'box', size: [1, 1, 1] },
        position: [0, 3, 0],
        rotation: [0.2, 0.1, 0.3, 0.92],
        ...noDamp,
      });
    const a = make();
    const b = { ...a };
    const coarse = await worldOf([a], { physicsHz: 60, substeps: 4 });
    const fine = await worldOf([b], { physicsHz: 240, substeps: 1 });
    run(coarse, 2);
    run(fine, 2);
    const pa = coarse.getPose(a.id)!;
    const pb = fine.getPose(b.id)!;
    for (let i = 0; i < 3; i++) expect(pa.position[i]).toBeCloseTo(pb.position[i], 6);
    for (let i = 0; i < 4; i++) expect(pa.rotation[i]).toBeCloseTo(pb.rotation[i], 6);
  });

  it('make a stiff spring oscillate at its analytic period at a coarse fixed rate', async () => {
    const periodError = async (substeps: number) => {
      const m = createBody({
        shape: { type: 'box', size: [0.5, 0.5, 0.5] },
        position: [2, 5, 0],
        material: { preset: 'custom', density: 80 },
        ...noDamp,
        gravityScale: 0,
      });
      const sp = createJoint({
        type: 'spring',
        bodyA: null,
        bodyB: m.id,
        anchorA: [0, 5, 0],
        anchorB: [0, 0, 0],
        spring: { restLength: 1, stiffness: 40000, damping: 0, breakForce: 0 },
      });
      const w = await worldOf([m, sp], { gravity: [0, 0, 0], physicsHz: 60, substeps });
      const mass = w.builtInfo().mass[m.id];
      const xs: number[] = [];
      for (let i = 0; i < 600; i++) {
        w.stepOnce();
        xs.push(w.getPose(m.id)!.position[0]);
      }
      const t: number[] = [];
      for (let i = 1; i < xs.length; i++) if (xs[i - 1] - 1 > 0 && xs[i] - 1 <= 0) t.push(i);
      const period = (t[t.length - 1] - t[0]) / (t.length - 1) / 60;
      const expected = 2 * Math.PI * Math.sqrt(mass / 40000);
      return Math.abs(period - expected) / expected;
    };
    const coarse = await periodError(1);
    const fine = await periodError(8);
    expect(coarse).toBeGreaterThan(0.02); // 60 Hz alone is visibly off (ω·dt ≈ 1)
    expect(fine).toBeLessThan(0.005);
    expect(fine).toBeLessThan(coarse / 5);
  });

  it('can be changed on a live world', async () => {
    const ball = createBody({ shape: { type: 'sphere', size: [0.4, 0.4, 0.4] }, position: [0, 20, 0], ...noDamp });
    const w = await worldOf([ball], { physicsHz: 120 });
    expect(w.world.integrationParameters.dt).toBeCloseTo(1 / 120, 9);
    w.applySettings({ ...w.settings, substeps: 3 });
    expect(w.world.integrationParameters.dt).toBeCloseTo(1 / 360, 9);
    w.applySettings({ ...w.settings, physicsHz: 60 });
    expect(w.world.integrationParameters.dt).toBeCloseTo(1 / 180, 9);
  });
});
