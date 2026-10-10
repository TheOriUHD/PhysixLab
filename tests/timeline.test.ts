/**
 * Package TM: the snapshot ring, seeking/rewinding, deterministic input logs and replays, the determinism check,
 * trajectory tracks. Every assertion compares exact numbers from the real engine, not "it did not throw".
 */
import { describe, expect, it } from 'vitest';
import { makeComponent, registerComponent } from '../src/model/componentRegistry';
import { createSoft } from '../src/model/factory';
import type { BodyEntity, ComponentSpec } from '../src/model/types';
import { registerRuntime } from '../src/physics/components';
import type { ReplayPayload, TimelineReply } from '../src/physics/timelineTypes';
import { stateHash } from '../src/physics/world/hash';
import type { PhysicsWorld } from '../src/physics/world';
import { seekTo, startRewind } from '../src/physics/world/travel';
import { createBody, docOf, run } from './helpers';
import { PhysicsWorld as World } from '../src/physics/world';

const withComponents = (b: BodyEntity, ...c: ComponentSpec[]): BodyEntity => ({ ...b, components: c });

const send = (w: PhysicsWorld, data: unknown): TimelineReply[] =>
  w.custom('timeline', data).map((r) => r.data as TimelineReply);
const status = (w: PhysicsWorld) => send(w, { cmd: 'status' })[0] as Extract<TimelineReply, { kind: 'status' }>;

registerComponent({
  type: 'tmJitter',
  label: 'Jitter',
  icon: 'component',
  category: 'Tests',
  blurb: '',
  appliesTo: 'body',
  fields: [],
});
registerRuntime<{ n: number }>({
  type: 'tmJitter',
  create: () => ({ n: 0 }),
  prestep: (s, _dt, ctx) => {
    s.n++;
    if (s.n % 20 === 0) ctx.body?.applyImpulse([ctx.random() - 0.5, 0.2, ctx.random() - 0.5]);
  },
  saveState: (s) => s.n,
  loadState: (s, d) => void (s.n = d as number),
});
registerComponent({
  type: 'tmBad',
  label: 'Bad',
  icon: 'component',
  category: 'Tests',
  blurb: '',
  appliesTo: 'body',
  fields: [],
});
registerRuntime({
  type: 'tmBad',
  create: () => ({}),
  prestep: (_s, _dt, ctx) => {
    if (Math.random() < 0.5) ctx.body?.applyImpulse([0.3, 0, 0]); // unseeded randomness: the bug being detected
  },
});

/** A scene with a stack, a ball with a stateful random component and a jelly. */
function busyScene() {
  const boxes = Array.from({ length: 3 }, (_, i) =>
    createBody({ name: `b${i}`, shape: { type: 'box', size: [0.8, 0.5, 0.8] }, position: [0.1 * i, 0.3 + i * 0.6, 0] }),
  );
  const jittery = withComponents(
    createBody({ name: 'jit', shape: { type: 'sphere', size: [0.4, 0.4, 0.4] }, position: [3, 1, 0] }),
    makeComponent('tmJitter'),
  );
  return docOf([...boxes, jittery, createSoft('jelly', { position: [-3, 2, 0] })]);
}

/** Play a replay viewer to its end the way the page does: frame after frame. */
const playAll = (w: PhysicsWorld) => {
  for (let i = 0; i < 400 && w.advance(0.25, 1, 1000) > 0; i++);
};
const poses = (w: PhysicsWorld) => w.bodyIds.map((id) => w.getPose(id)!);

describe('snapshot ring and seeking', () => {
  it('seeks to any recorded step and reproduces the exact state (rigid, soft, component, RNG)', async () => {
    const w = await World.create(busyScene());
    w.recorder.adaptive = false;
    w.recorder.interval = 7;
    const at: Record<number, string> = {};
    for (let i = 0; i < 200; i++) {
      w.stepOnce();
      at[w.stepCount] = stateHash(w.state);
    }
    expect(w.recorder.ring.length).toBeGreaterThan(5);
    for (const target of [193, 150, 77, 33, 2, 100, 199]) {
      seekTo(w.state, target);
      expect(w.stepCount).toBe(target);
      expect(stateHash(w.state), `step ${target}`).toBe(at[target]);
    }
  });

  it('branches: stepping on after a seek discards the old future and stays deterministic', async () => {
    const w = await World.create(busyScene());
    run(w, 1);
    seekTo(w.state, 30);
    for (let i = 0; i < 60; i++) w.stepOnce();
    expect(w.stepCount).toBe(90);
    expect(w.recorder.head).toBe(90);
    expect(Math.max(...w.recorder.ring.map((e) => e.step))).toBeLessThanOrEqual(90);
    // an unbroken run of 90 steps gives the same state
    const straight = await World.create(busyScene());
    for (let i = 0; i < 90; i++) straight.stepOnce();
    expect(stateHash(w.state)).toBe(stateHash(straight.state));
  });

  it('re-applies logged ops when re-simulating the past', async () => {
    const doc = busyScene();
    const w = await World.create(doc);
    for (let i = 0; i < 40; i++) w.stepOnce();
    w.applyOp({ op: 'impulse', id: doc.entities[0].id, impulse: [4, 2, 0], point: [0, 0, 0] });
    for (let i = 0; i < 80; i++) w.stepOnce();
    const finalHash = stateHash(w.state);
    seekTo(w.state, 10);
    seekTo(w.state, 120); // forward again, through the impulse
    expect(stateHash(w.state)).toBe(finalHash);
  });

  it('keeps memory under budget by thinning, and the oldest step stays reachable', async () => {
    const w = await World.create(busyScene());
    w.recorder.adaptive = false;
    w.recorder.interval = 2;
    w.stepOnce();
    const one = w.recorder.ring[0].bytes;
    w.recorder.budgetBytes = one * 8;
    for (let i = 0; i < 600; i++) w.stepOnce();
    expect(w.recorder.bytes).toBeLessThanOrEqual(one * 8 + one);
    expect(w.recorder.ring.length).toBeLessThanOrEqual(10);
    expect(w.recorder.interval).toBeGreaterThan(2);
    expect(w.recorder.first).toBe(0);
    const h = stateHash(w.state);
    seekTo(w.state, 5);
    seekTo(w.state, w.recorder.head);
    expect(stateHash(w.state)).toBe(h);
  });

  it('rewind: reverse playback walks back in real time, then the timeline branches on resume', async () => {
    const w = await World.create(busyScene());
    w.recorder.adaptive = false;
    w.recorder.interval = 9;
    run(w, 2);
    const hz = w.settings.physicsHz;
    const start = w.stepCount;
    startRewind(w.state, 1);
    for (let i = 0; i < 30; i++) w.advance(1 / 60, 1); // half a second of reverse playback
    expect(w.stepCount).toBeLessThanOrEqual(start - hz / 2 + 1);
    expect(w.stepCount).toBeGreaterThanOrEqual(start - hz / 2 - 2);
    w.recorder.mode = 'live';
    const here = w.stepCount;
    w.stepOnce();
    expect(w.stepCount).toBe(here + 1);
    expect(w.recorder.head).toBe(here + 1);
  });
});

describe('play-through', () => {
  it('plays the recorded past forward with its inputs, without branching; a live edit then branches', async () => {
    const doc = busyScene();
    const w = await World.create(doc);
    for (let i = 0; i < 100; i++) {
      if (i === 40) w.applyOp({ op: 'impulse', id: doc.entities[0].id, impulse: [4, 2, 0], point: [0, 0, 0] });
      w.setKeys([]);
      w.stepOnce();
    }
    const h100 = stateHash(w.state);
    const ringBefore = w.recorder.ring.map((e) => e.step);
    seekTo(w.state, 10);
    send(w, { cmd: 'playThrough', on: true });
    w.applyOp({ op: 'events', config: { contacts: true } }); // only changes what is reported: not an edit
    for (let i = 0; i < 90; i++) {
      w.setKeys([]); // what the page supplies every tick: nothing changed
      w.stepOnce();
    }
    expect(w.stepCount).toBe(100);
    expect(stateHash(w.state)).toBe(h100);
    expect(w.recorder.ring.map((e) => e.step)).toEqual(ringBefore);
    expect(w.recorder.head).toBe(100);
    // back to 30, play through, then press a key at step 50: the future after 50 is replaced
    seekTo(w.state, 30);
    send(w, { cmd: 'playThrough', on: true });
    w.setKeys([]);
    for (let i = 0; i < 20; i++) w.stepOnce();
    w.setKeys(['w']);
    expect(w.recorder.playThrough).toBe(false);
    for (let i = 0; i < 10; i++) w.stepOnce();
    expect(w.recorder.head).toBe(60);
  });
});

describe('replays', () => {
  it('records inputs and replays them exactly, verifying the checkpoints', async () => {
    const doc = busyScene();
    const live = await World.create(doc);
    send(live, { cmd: 'record', on: true });
    for (let i = 0; i < 200; i++) {
      if (i === 25) live.applyOp({ op: 'impulse', id: doc.entities[1].id, impulse: [3, 3, 1], point: [0, 0, 0] });
      if (i === 60) live.setAxes({ steer: 0.5 });
      live.stepOnce();
    }
    const payload = (send(live, { cmd: 'recordGet', stop: true })[0] as Extract<TimelineReply, { kind: 'recording' }>)
      .payload;
    expect(payload.base).toBeNull();
    expect(payload.endStep).toBe(200);
    expect(payload.hashes.length).toBe(3);
    const expected = stateHash(live.state);

    const viewer = await World.create(doc);
    const wire = structuredClone<ReplayPayload>(payload);
    send(viewer, { cmd: 'replayLoad', payload: wire });
    viewer.applyOp({ op: 'impulse', id: doc.entities[0].id, impulse: [99, 0, 0], point: [0, 0, 0] }); // ignored
    playAll(viewer); // asks for far more than the replay holds
    expect(viewer.stepCount).toBe(200);
    expect(stateHash(viewer.state)).toBe(expected);
    const st = status(viewer);
    expect(st.replay!.checked).toBe(3);
    expect(st.replay!.firstBad).toBeNull();
  });

  it('a replay that does not match is reported with its first bad checkpoint', async () => {
    const doc = busyScene();
    const live = await World.create(doc);
    send(live, { cmd: 'record', on: true });
    for (let i = 0; i < 130; i++) live.stepOnce();
    const payload = (send(live, { cmd: 'recordGet' })[0] as Extract<TimelineReply, { kind: 'recording' }>).payload;
    payload.hashes[1] = [payload.hashes[1][0], 'deadbeefdeadbeef'];
    const viewer = await World.create(doc);
    send(viewer, { cmd: 'replayLoad', payload });
    playAll(viewer);
    expect(status(viewer).replay!.firstBad?.step).toBe(payload.hashes[1][0]);
  });

  it('a recording that starts mid-run carries its base state', async () => {
    const doc = busyScene();
    const live = await World.create(doc);
    run(live, 0.5);
    send(live, { cmd: 'record', on: true });
    for (let i = 0; i < 70; i++) live.stepOnce();
    const payload = (send(live, { cmd: 'recordGet' })[0] as Extract<TimelineReply, { kind: 'recording' }>).payload;
    expect(payload.base).not.toBeNull();
    const viewer = await World.create(doc);
    send(viewer, { cmd: 'replayLoad', payload: structuredClone(payload) });
    playAll(viewer);
    expect(viewer.stepCount).toBe(payload.endStep);
    expect(stateHash(viewer.state)).toBe(stateHash(live.state));
  });
});

describe('determinism check', () => {
  it('passes for a deterministic scene and the real run keeps matching the clones', async () => {
    const w = await World.create(busyScene());
    run(w, 0.5);
    const rep = send(w, { cmd: 'determinism', steps: 120, every: 20 })[0] as Extract<
      TimelineReply,
      { kind: 'determinism' }
    >;
    expect(rep.ok).toBe(true);
    expect(rep.checkpoints).toBe(6);
    for (let i = 0; i < 120; i++) w.stepOnce();
    const st = status(w);
    expect(st.watch).toMatchObject({ checked: 6, total: 6, firstBad: null });
  });

  it('flags a scene that is not deterministic, with the first divergence', async () => {
    const body = withComponents(
      createBody({ shape: { type: 'sphere', size: [0.4, 0.4, 0.4] }, position: [0, 5, 0] }),
      makeComponent('tmBad'),
    );
    const w = await World.create(docOf([body]));
    run(w, 0.2);
    const rep = send(w, { cmd: 'determinism', steps: 60, every: 5 })[0] as Extract<
      TimelineReply,
      { kind: 'determinism' }
    >;
    expect(rep.ok).toBe(false);
    expect(rep.firstDivergence!.step).toBeGreaterThan(0);
  });
});

describe('seeded randomness and tracks', () => {
  it('same seed → same result, different seed → different result', async () => {
    const make = async (seed: number) => {
      const d = busyScene();
      d.settings = { ...d.settings, seed };
      const w = await World.create(d);
      run(w, 2);
      return stateHash(w.state);
    };
    expect(await make(7)).toBe(await make(7));
    expect(await make(7)).not.toBe(await make(8));
  });

  it('reseeding mid-run changes the future but a snapshot still restores the old stream', async () => {
    const w = await World.create(busyScene());
    run(w, 0.5);
    const snap = w.snapshot();
    run(w, 1);
    const a = stateHash(w.state);
    w.restore(snap);
    run(w, 1);
    expect(stateHash(w.state)).toBe(a);
    w.restore(snap);
    w.applyOp({ op: 'setSeed', seed: 12345 });
    run(w, 1);
    expect(stateHash(w.state)).not.toBe(a);
  });

  it('samples a trajectory track, truncates it on branch and stashes it when the world goes away', async () => {
    const w = await World.create(busyScene());
    run(w, 1);
    const live = (send(w, { cmd: 'trackGet', run: 'live' })[0] as Extract<TimelineReply, { kind: 'track' }>).track!;
    expect(live.ids.length).toBe(4);
    expect(live.count).toBe(Math.floor((w.stepCount - live.first) / live.every) + 1);
    expect(live.data.length).toBe(live.count * live.ids.length * 7);
    seekTo(w.state, 30);
    w.stepOnce(); // branch
    const cut = (send(w, { cmd: 'trackGet', run: 'live' })[0] as Extract<TimelineReply, { kind: 'track' }>).track!;
    expect(cut.count).toBeLessThan(live.count);
    run(w, 1);
    w.dispose();
    const w2 = await World.create(busyScene());
    const runs = (send(w2, { cmd: 'runs' })[0] as Extract<TimelineReply, { kind: 'runs' }>).runs;
    expect(runs.length).toBeGreaterThan(0);
    expect(poses(w2).length).toBe(4);
  });
});
