/**
 * The application side of the sound (FX-10 … FX-15): what the sound needs to know about a body, where engine sounds
 * come from (a motorised joint measured by the real engine, a component that publishes its speed), the keyed voice
 * set, the interface-sound gate, and contact events from the real engine turned into impact voices. The pieces that
 * need an `App` and a browser (the director, the engine's WebAudio graph) are covered by `e2e/tests/audio.mjs`.
 */
import { describe, expect, it } from 'vitest';
import { qfromAxisAngle } from '../src/core/math';
import { audioBodyInfo, characteristicSize, isTrampoline } from '../src/app/audio/bodyAudio';
import { LoopSet, type HandleLike } from '../src/app/audio/loopSet';
import {
  jointMotorLoad,
  motorInput,
  readSource,
  scanSources,
  stateRoles,
  SLIDER_RPM_PER_MS,
  type MotorReading,
} from '../src/app/audio/motorSources';
import { UiSoundGate } from '../src/app/audio/uiGate';
import { makeComponent, registerComponent } from '../src/model/componentRegistry';
import type { MotorSpec } from '../src/model/types';
import { J, JOINT_STRIDE, type ContactEvent } from '../src/physics/protocol';
import { motorParams, newMotorParams } from '../src/audio/motor';
import { planImpact } from '../src/audio/impact';
import { createBody, createJoint, run, worldOf } from './helpers';

const motor = (over: Partial<MotorSpec> = {}): MotorSpec => ({
  mode: 'velocity',
  targetVelocity: 8,
  targetPosition: 0,
  stiffness: 0,
  damping: 100,
  maxForce: 5000,
  keyPos: '',
  keyNeg: '',
  slewRate: 1,
  brake: false,
  ...over,
});

// -- bodies ------------------------------------------------------------------------------------------------------------

describe('what the sound knows about a body', () => {
  it('derives the material class, size, roundness and roles from the document', () => {
    const ball = audioBodyInfo(createBody({ shape: { type: 'sphere', size: [0.6, 0.6, 0.6] }, material: 'steel' }));
    expect(ball.cls).toBe('metal');
    expect(ball.size).toBeCloseTo(0.6);
    expect(ball.rounded).toBe(true);
    expect(ball.rolls).toBe(true);
    expect(ball.spec.kind).toBe('sphere');

    const slab = audioBodyInfo(
      createBody({ shape: { type: 'box', size: [4, 0.2, 2] }, material: 'concrete', bodyType: 'static' }),
    );
    expect(slab.cls).toBe('stone');
    expect(slab.size).toBe(4); // the longest side: a long slab rings low
    expect(slab.rounded).toBe(false);
    expect(slab.rolls).toBe(false); // static bodies make no rolling sound

    expect(audioBodyInfo(createBody({ material: 'glass', hidden: true })).rolls).toBe(false);
    expect(audioBodyInfo(createBody({ material: 'glass', ghost: true })).rolls).toBe(false);
    expect(audioBodyInfo(createBody({ shape: { type: 'cylinder', size: [1, 0.3, 1] } })).rounded).toBe(true);
    expect(audioBodyInfo(createBody({ tags: ['projectile'] })).projectile).toBe(true);
    expect(audioBodyInfo(createBody({ tags: ['fx-debris'] })).fragment).toBe(true);
  });

  it('keeps the characteristic size within a sane range', () => {
    expect(characteristicSize(createBody({ shape: { type: 'box', size: [0.001, 0.001, 0.001] } }))).toBe(0.02);
    expect(characteristicSize(createBody({ shape: { type: 'box', size: [500, 1, 1] } }))).toBe(30);
  });

  it('knows a trampoline by its tag or by a restitution of 1 or more', () => {
    expect(isTrampoline(createBody({ tags: ['Trampoline'] }))).toBe(true);
    expect(isTrampoline(createBody({ tags: ['bouncy'] }))).toBe(true);
    expect(isTrampoline(createBody({ material: { preset: 'rubber', restitution: 1.2 } }))).toBe(true);
    expect(isTrampoline(createBody({ material: 'rubber' }))).toBe(false); // 0.85: a rubber ball is a thud, not a boing
    expect(isTrampoline(createBody({}))).toBe(false);
  });
});

// -- motor sources -----------------------------------------------------------------------------------------------------

describe('where engine sounds come from (FX-13)', () => {
  it('reads which published numbers are the speed and the load, from the component state labels', () => {
    // The layouts the powered components publish: speed first (rpm, °/s), a percentage for the throttle / drive.
    const engine = stateRoles('engine', [
      { label: 'Speed', unit: 'rpm' },
      { label: 'Torque', unit: 'N·m' },
      { label: 'Throttle', unit: '%' },
      { label: 'Power', unit: 'kW' },
    ]);
    expect(engine).toMatchObject({ speed: 0, load: 2, rpmScale: 1, kind: 'combustion' });
    const prop = stateRoles('propeller', [
      { label: 'Speed', unit: 'rpm' },
      { label: 'Thrust', unit: 'N' },
    ]);
    expect(prop).toMatchObject({ speed: 0, load: -1, kind: 'rotor' });
    const servo = stateRoles('servo', [
      { label: 'Angle', unit: '°' },
      { label: 'Speed', unit: '°/s' },
    ]);
    expect(servo).toMatchObject({ speed: 1, kind: 'electric' });
    expect(servo?.rpmScale).toBeCloseTo(1 / 6); // 360 °/s is one turn a second: 60 rpm
    const jet = stateRoles('jet', [
      { label: 'Thrust', unit: 'N' },
      { label: 'Engine speed', unit: '%' },
    ]);
    expect(jet).toMatchObject({ speed: -1, load: 1, kind: 'jet' });
    // Nothing that turns, nothing to hear.
    expect(stateRoles('sineMover', [{ label: 'Offset', unit: 'm' }])).toBeNull();
    expect(stateRoles('constantForce', undefined)).toBeNull();
    expect(stateRoles('thruster', [{ label: 'Fuel', unit: 'kg' }])).toBeNull();
  });

  it('finds a motorised hinge or slider, and a component that publishes its speed, in the document', () => {
    registerComponent({
      type: 'audiotest_motor',
      label: 'Test motor',
      icon: 'wave',
      category: 'Test',
      blurb: 'Publishes a speed',
      appliesTo: 'any',
      fields: [],
      state: [
        { label: 'Speed', unit: 'rpm' },
        { label: 'Torque', unit: 'N·m' },
        { label: 'Drive', unit: '%' },
      ],
    });
    const a = createBody({ name: 'A', bodyType: 'static' });
    const b = createBody({ name: 'B', components: [makeComponent('audiotest_motor')] });
    const hinge = createJoint({
      type: 'hinge',
      bodyA: a.id,
      bodyB: b.id,
      anchorA: [0, 0, 0],
      anchorB: [0, 0, 0],
      motor: motor(),
    });
    const slider = createJoint({
      type: 'slider',
      bodyA: a.id,
      bodyB: b.id,
      anchorA: [0, 0, 0],
      anchorB: [0, 0, 0],
      motor: motor({ mode: 'position' }),
    });
    const idle = createJoint({
      type: 'hinge',
      bodyA: a.id,
      bodyB: b.id,
      anchorA: [0, 0, 0],
      anchorB: [0, 0, 0],
      motor: motor({ mode: 'off' }),
    });
    const weld = createJoint({ type: 'fixed', bodyA: a.id, bodyB: b.id, anchorA: [0, 0, 0], anchorB: [0, 0, 0] });
    const unpowered = createJoint({
      type: 'hinge',
      bodyA: a.id,
      bodyB: b.id,
      anchorA: [0, 0, 0],
      anchorB: [0, 0, 0],
      motor: motor({ maxForce: 0 }),
    });
    const off = createBody({ name: 'Off', components: [{ ...makeComponent('audiotest_motor'), enabled: false }] });
    const hiddenOne = createBody({ name: 'Hidden', hidden: true, components: [makeComponent('audiotest_motor')] });
    const sources = scanSources([a, b, hinge, slider, idle, weld, unpowered, off, hiddenOne]);
    expect(sources.map((s) => s.key)).toEqual([`c:${b.components[0].id}`, `j:${hinge.id}`, `j:${slider.id}`]);
    expect(sources[0]).toMatchObject({ kind: 'electric', bodyId: b.id, component: { speed: 0, load: 2, rpmScale: 1 } });
    expect(sources[1]).toMatchObject({ kind: 'electric', bodyId: a.id, joint: { id: hinge.id, type: 'hinge' } });
    expect(sources[2].joint?.type).toBe('slider');
  });

  it('computes the motor input the way the world does: held keys, or 1 when none is bound', () => {
    expect(motorInput(motor(), new Set())).toBe(1);
    const keyed = motor({ keyPos: 'KeyD', keyNeg: 'KeyA' });
    expect(motorInput(keyed, new Set())).toBe(0);
    expect(motorInput(keyed, new Set(['KeyD']))).toBe(1);
    expect(motorInput(keyed, new Set(['KeyA']))).toBe(-1);
    expect(motorInput(keyed, new Set(['KeyA', 'KeyD']))).toBe(0);
  });

  it('loads a velocity motor by the gap between asked-for and reached speed; an undriven motor is silent', () => {
    const m = motor({ targetVelocity: 10 });
    expect(jointMotorLoad(m, 10, 1)).toBeCloseTo(0.2, 6); // free-running: the floor
    expect(jointMotorLoad(m, 5, 1)).toBeCloseTo(0.5, 6);
    expect(jointMotorLoad(m, 0, 1)).toBe(1); // stalled
    expect(jointMotorLoad(m, -10, 1)).toBeCloseTo(0.2, 6); // direction does not matter
    expect(jointMotorLoad(m, 4, 0)).toBe(0); // no key held
    expect(jointMotorLoad(motor({ mode: 'off' }), 5, 1)).toBe(0);
    expect(jointMotorLoad(motor({ mode: 'position' }), 0, 1)).toBe(0); // a servo at rest is silent
    expect(jointMotorLoad(motor({ mode: 'position' }), 1.5, 1)).toBeGreaterThan(0.5);
  });

  it('reads the speed and load from a component state and from a joint measurement', () => {
    const out: MotorReading = { rpm: 0, load: 0 };
    const engine = {
      key: 'c:1',
      kind: 'combustion' as const,
      bodyId: 'b',
      component: { id: '1', speed: 0, rpmScale: 1, load: 2 },
    };
    expect(readSource(engine, NaN, [3000, 120, 80, 40], new Set(), out)).toBe(out);
    expect(out.rpm).toBe(3000);
    expect(out.load).toBeCloseTo(0.8);
    // No published load: lean on the speed against the rated speed.
    const noLoad = { ...engine, component: { ...engine.component, load: -1 } };
    readSource(noLoad, NaN, [3500], new Set(), out);
    expect(out.load).toBeCloseTo((3500 / 7000) * 0.8);
    // Servo speed in °/s becomes rpm; the sign is dropped.
    const servo = {
      key: 'c:2',
      kind: 'electric' as const,
      bodyId: 'b',
      component: { id: '2', speed: 0, rpmScale: 1 / 6, load: -1 },
    };
    readSource(servo, NaN, [-360], new Set(), out);
    expect(out.rpm).toBeCloseTo(60);
    // A jet has no speed: its load is the thrust fraction.
    const jet = {
      key: 'c:3',
      kind: 'jet' as const,
      bodyId: 'b',
      component: { id: '3', speed: -1, rpmScale: 1, load: 1 },
    };
    readSource(jet, NaN, [900, 70], new Set(), out);
    expect(out.rpm).toBe(0);
    expect(out.load).toBeCloseTo(0.7);
    // A state that has not arrived yet, or is too short: no sound rather than garbage.
    expect(readSource(engine, NaN, null, new Set(), out)).toBeNull();
    expect(
      readSource({ ...engine, component: { ...engine.component, speed: 3 } }, NaN, [1], new Set(), out),
    ).toBeNull();
    // A state that lacks only the load: the speed still sounds, with the load estimated from it.
    expect(readSource(engine, NaN, [1], new Set(), out)).toBe(out);
    // A joint: a hinge's rad/s are rpm, a slider's m/s are scaled; not simulated (NaN): nothing.
    const hinge = {
      key: 'j:1',
      kind: 'electric' as const,
      bodyId: 'b',
      joint: { id: '1', type: 'hinge' as const, motor: motor() },
    };
    readSource(hinge, 2 * Math.PI, null, new Set(), out);
    expect(out.rpm).toBeCloseTo(60);
    expect(readSource(hinge, NaN, null, new Set(), out)).toBeNull();
    const slider = {
      key: 'j:2',
      kind: 'electric' as const,
      bodyId: 'b',
      joint: { id: '2', type: 'slider' as const, motor: motor() },
    };
    readSource(slider, -0.5, null, new Set(), out);
    expect(out.rpm).toBeCloseTo(0.5 * SLIDER_RPM_PER_MS);
  });

  it('a motorised hinge measured by the real engine gives the rpm of its target speed, and a stalled one a heavy load', async () => {
    const wheel = createBody({
      shape: { type: 'cylinder', size: [1, 0.2, 1] },
      position: [0, 3, 0],
      rotation: qfromAxisAngle([1, 0, 0], Math.PI / 2),
      linearDamping: 0,
      angularDamping: 0,
    });
    const hinge = createJoint({
      type: 'hinge',
      bodyA: null,
      bodyB: wheel.id,
      anchorA: [0, 3, 0],
      axis: [0, 0, 1],
      motor: motor(),
    });
    const sources = scanSources([wheel, hinge]);
    expect(sources).toHaveLength(1);

    const reading = async (entities: Parameters<typeof worldOf>[0], seconds: number) => {
      const w = await worldOf(entities);
      run(w, seconds);
      const joints = w.readJoints();
      const i = w.jointIds.indexOf(hinge.id);
      const speed = joints[i * JOINT_STRIDE + J.speed];
      const out: MotorReading = { rpm: 0, load: 0 };
      readSource(sources[0], speed, null, new Set(), out);
      return { speed, ...out };
    };

    const free = await reading([wheel, hinge], 2);
    expect(free.speed).toBeGreaterThan(7.5);
    expect(free.rpm).toBeGreaterThan(71);
    expect(free.rpm).toBeLessThan(81); // 8 rad/s = 76.4 rpm
    expect(free.load).toBeLessThan(0.3);

    // Held against a limit it cannot turn: the load is heavy and the engine's whine would be silent (no motion).
    const stalled = await reading([wheel, { ...hinge, limit: { enabled: true, min: -0.2, max: 0.2 } }], 2);
    expect(stalled.rpm).toBeLessThan(5);
    expect(stalled.load).toBeGreaterThan(0.9);
    expect(motorParams('electric', stalled.rpm, stalled.load, newMotorParams()).gain).toBeLessThan(0.05);

    // The pitch of the voice follows the real speed: a faster target is a higher whine.
    const fast = await reading([wheel, { ...hinge, motor: motor({ targetVelocity: 24 }) }], 2);
    expect(fast.rpm).toBeGreaterThan(2.5 * free.rpm);
    expect(motorParams('electric', fast.rpm, fast.load, newMotorParams()).f1).toBeGreaterThan(
      motorParams('electric', free.rpm, free.load, newMotorParams()).f1 * 1.5,
    );
  });
});

// -- the keyed voice set -----------------------------------------------------------------------------------------------

class Handle implements HandleLike {
  dead = false;
  killed: number[] = [];
  constructor(public priority: number) {}
  kill(fade: number): void {
    this.dead = true;
    this.killed.push(fade);
  }
}

describe('LoopSet', () => {
  it('opens a voice for a key once, keeps it while it is mentioned and fades it when it is not', () => {
    const opened: Handle[] = [];
    const set = new LoopSet<Handle>((p) => {
      const h = new Handle(p);
      opened.push(h);
      return h;
    });
    set.begin();
    const a = set.touch('a', 1);
    set.touch('b', 2);
    set.finish(0.1);
    expect(opened).toHaveLength(2);
    expect(set.size).toBe(2);
    // Next pass mentions only "a" (the same voice, with its new priority).
    set.begin();
    expect(set.touch('a', 5)).toBe(a);
    expect(a?.priority).toBe(5);
    set.finish(0.2);
    expect(opened).toHaveLength(2);
    expect(set.size).toBe(1);
    expect(opened[1].killed).toEqual([0.2]);
    expect(a?.killed).toEqual([]);
  });

  it('opens a voice again when the engine took its place, and reports a voice it could not get', () => {
    let refuse = false;
    const set = new LoopSet<Handle>((p) => (refuse ? null : new Handle(p)));
    set.begin();
    const first = set.touch('x', 1);
    set.finish(0.1);
    (first as Handle).dead = true; // stolen
    set.begin();
    const second = set.touch('x', 1);
    expect(second).not.toBe(first);
    expect(second?.dead).toBe(false);
    set.finish(0.1);
    refuse = true;
    set.begin();
    expect(set.touch('y', 1)).toBeNull();
    expect(set.size).toBe(1);
    set.finish(0.1);
    set.closeAll(0.3);
    expect(set.size).toBe(0);
    expect(second?.killed).toEqual([0.1]); // x was not mentioned in the last pass: faded once, by finish()
  });

  it('lets a call pick how a voice is opened (one set, several kinds of voice)', () => {
    const set = new LoopSet<Handle>();
    set.begin();
    expect(set.touch('k', 1)).toBeNull(); // the default opener makes nothing
    const h = set.touch('k', 1, (p) => new Handle(p * 10));
    expect(h?.priority).toBe(1); // touch sets the priority it was given
    set.finish(0.1);
    expect(set.size).toBe(1);
  });
});

// -- interface sounds ---------------------------------------------------------------------------------------------------

describe('UiSoundGate (FX-14: subtle interface sounds)', () => {
  it('never repeats a sound faster than its minimum interval', () => {
    const g = new UiSoundGate();
    expect(g.request('select', 0)).toBe(true);
    expect(g.request('select', 0.03)).toBe(false);
    expect(g.request('select', 0.071)).toBe(true);
    expect(g.request('error', 1)).toBe(true);
    expect(g.request('error', 1.2)).toBe(false); // a second error right away is the same complaint
    expect(g.request('error', 1.45)).toBe(true);
  });

  it('lets a stronger sound hide the weaker one that arrives with it', () => {
    const g = new UiSoundGate();
    expect(g.request('place', 0)).toBe(true);
    expect(g.request('select', 0.001)).toBe(false); // placing selects the new object: one sound is enough
    expect(g.request('select', 0.3)).toBe(true); // …but a later selection is its own event
    expect(g.request('delete', 1)).toBe(true);
    expect(g.request('select', 1.01)).toBe(false);
    expect(g.request('error', 2)).toBe(true);
    expect(g.request('delete', 2.1)).toBe(false);
    g.clear();
    expect(g.request('delete', 2.1)).toBe(true);
  });
});

// -- real contacts to impact voices ------------------------------------------------------------------------------------------

/** Drop a ball of `preset` from `height` metres and return its first contact event (from the real engine) and its mass. */
async function drop(preset: string, diameter: number, height: number) {
  const body = createBody({
    shape: { type: 'sphere', size: [diameter, diameter, diameter] },
    position: [0, height + diameter / 2, 0],
    material: preset,
    linearDamping: 0,
    angularDamping: 0,
    canSleep: false,
  });
  const w = await worldOf([body]);
  w.configureEvents({ contacts: true, pairInterval: 100, minImpulse: 0 });
  const events: ContactEvent[] = [];
  for (let i = 0; i < Math.round((Math.sqrt((2 * height) / 9.81) + 0.5) * w.settings.physicsHz); i++) {
    w.stepOnce();
    if (i % 2 === 1) for (const e of w.drainEvents()) if (e.kind === 'contact') events.push(e);
  }
  expect(events.length).toBeGreaterThan(0);
  return { ev: events[0], mass: w.builtInfo().mass[body.id], size: diameter };
}

const voicesFor = (d: Awaited<ReturnType<typeof drop>>) =>
  planImpact({
    speed: d.ev.speed,
    impulse: d.ev.impulse,
    matA: d.ev.matA,
    matB: 'ground',
    sizeA: d.size,
    sizeB: 99,
    massA: d.mass,
    massB: 0,
  });

describe('contacts from the real engine become impact voices (FX-11)', () => {
  it('a ball dropped from higher is louder and brighter than the same ball dropped from lower', async () => {
    const gains: number[] = [];
    const levels: number[] = [];
    for (const h of [0.15, 0.6, 2.4, 9.6]) {
      const v = voicesFor(await drop('steel', 0.3, h));
      expect(v.map((x) => x.role)).toEqual(['a', 'ground']);
      gains.push(v[0].gain);
      levels.push(v[0].spec.level);
    }
    for (let i = 1; i < gains.length; i++) {
      expect(gains[i]).toBeGreaterThan(gains[i - 1]);
      expect(levels[i]).toBeGreaterThanOrEqual(levels[i - 1]);
    }
    expect(gains[3]).toBeGreaterThan(5 * gains[0]);
    expect(levels[3]).toBeGreaterThan(levels[0]);
  });

  it('every material rings with its own voice, and a bigger ball of the same material is lower and louder', async () => {
    for (const preset of ['steel', 'wood', 'glass', 'rubber', 'concrete', 'plastic']) {
      const v = voicesFor(await drop(preset, 0.4, 1.5));
      expect(v[0].spec.preset, preset).toBe(preset);
      expect(v[1].spec.preset).toBe('ground');
    }
    const small = voicesFor(await drop('steel', 0.1, 1.5))[0];
    const large = voicesFor(await drop('steel', 0.8, 1.5))[0];
    expect(large.spec.pitch).toBeLessThan(small.spec.pitch); // a bigger ball pitches lower
    expect(large.gain).toBeGreaterThan(small.gain); // and, being much heavier, hits harder
  });

  it('a feather-light touch makes no sound and a heavy hard drop shatters glass', async () => {
    expect(voicesFor(await drop('foam', 0.1, 0.02))).toEqual([]);
    const smash = voicesFor(await drop('glass', 0.5, 20))[0];
    expect(smash.spec.shatter).toBe(true);
    expect(voicesFor(await drop('glass', 0.5, 0.3))[0].spec.shatter).toBe(false);
  });
});
