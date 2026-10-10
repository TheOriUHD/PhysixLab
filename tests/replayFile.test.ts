/** Replay files: a recorded run survives the file / link format, and damaged or hostile files are rejected. */
import { describe, expect, it } from 'vitest';
import {
  ReplayFormatError,
  decodeReplay,
  encodeReplay,
  parseReplay,
  replayFromHash,
  replayShareLink,
  replayToJson,
  type ReplayFile,
} from '../src/app/replayFile';
import { createSoft } from '../src/model/factory';
import type { ReplayPayload, TimelineReply } from '../src/physics/timelineTypes';
import { PhysicsWorld } from '../src/physics/world';
import { stateHash } from '../src/physics/world/hash';
import { createBody, docOf } from './helpers';

const send = (w: PhysicsWorld, data: unknown) => w.custom('timeline', data).map((r) => r.data as TimelineReply);

async function recorded(midRun: boolean): Promise<{ file: ReplayFile; final: string }> {
  const ball = createBody({ name: 'ball', shape: { type: 'sphere', size: [0.5, 0.5, 0.5] }, position: [0, 4, 0] });
  const doc = docOf([ball, createSoft('jelly', { position: [3, 2, 0] })]);
  const w = await PhysicsWorld.create(doc);
  if (midRun) for (let i = 0; i < 30; i++) w.stepOnce();
  send(w, { cmd: 'record', on: true });
  for (let i = 0; i < 130; i++) {
    if (i === 20)
      w.applyOp({ op: 'addBody', body: createBody({ name: 'late', position: [1, 6, 0] }), ephemeral: true });
    if (i === 40) w.applyOp({ op: 'impulse', id: ball.id, impulse: [2, 1, 0], point: [0, 0, 0] });
    w.stepOnce();
  }
  const reply = send(w, { cmd: 'recordGet' })[0] as Extract<TimelineReply, { kind: 'recording' }>;
  return {
    file: {
      name: 'test run',
      createdAt: 1,
      scene: doc,
      replay: reply.payload,
      bookmarks: [{ step: 50, name: 'drop' }],
    },
    final: stateHash(w.state),
  };
}

async function play(file: ReplayFile): Promise<{ w: PhysicsWorld; ok: boolean }> {
  const w = await PhysicsWorld.create(file.scene);
  send(w, { cmd: 'replayLoad', payload: file.replay });
  for (let i = 0; i < 400 && w.advance(0.25, 1, 1000) > 0; i++);
  const st = send(w, { cmd: 'status' })[0] as Extract<TimelineReply, { kind: 'status' }>;
  return { w, ok: st.replay!.firstBad === null && st.replay!.checked === st.replay!.checkpoints };
}

describe('replay files', () => {
  for (const midRun of [false, true]) {
    it(`round-trips through the deflated file and plays back identically (${midRun ? 'mid-run base' : 'from the start'})`, async () => {
      const { file, final } = await recorded(midRun);
      const bytes = await encodeReplay(file);
      expect(bytes.length).toBeGreaterThan(50);
      const back = await decodeReplay(bytes);
      expect(back.name).toBe('test run');
      expect(back.bookmarks).toEqual([{ step: 50, name: 'drop' }]);
      expect(back.replay.endStep).toBe(file.replay.endStep);
      expect(back.replay.base === null).toBe(!midRun);
      const { w, ok } = await play(back);
      expect(w.stepCount).toBe(file.replay.endStep);
      expect(ok).toBe(true);
      expect(stateHash(w.state)).toBe(final);
    });
  }

  it('a share link carries a small replay', async () => {
    const { file, final } = await recorded(false);
    const link = await replayShareLink(file, 'https://example.test/app/');
    expect(link.startsWith('https://example.test/app/#replay=')).toBe(true);
    const back = (await replayFromHash(new URL(link).hash))!;
    const { w, ok } = await play(back);
    expect(ok).toBe(true);
    expect(stateHash(w.state)).toBe(final);
    expect(await replayFromHash('#scene=abc')).toBeNull();
  });

  it('rejects files that are not replays, damaged logs and links', async () => {
    expect(() => parseReplay('not json')).toThrow(ReplayFormatError);
    expect(() => parseReplay('{"format":"other"}')).toThrow(/not a PhysixLab replay/);
    const { file } = await recorded(false);
    const json = JSON.parse(replayToJson(file)) as { version: number; replay: { entries: unknown[]; endStep: number } };
    expect(() => parseReplay(JSON.stringify({ ...json, version: 99 }))).toThrow(/newer version/);
    expect(() =>
      parseReplay(JSON.stringify({ ...json, replay: { ...json.replay, entries: [{ step: 1, kind: 'rm -rf' }] } })),
    ).toThrow(/unknown kind/);
    expect(() =>
      parseReplay(
        JSON.stringify({ ...json, replay: { ...json.replay, entries: [{ step: 1e9, kind: 'keys', keys: [] }] } }),
      ),
    ).toThrow(/step number/);
    await expect(replayFromHash('#replay=AAAA')).rejects.toThrow(/damaged/);
  });

  it('sanitises entities hidden in logged ops', async () => {
    const { file } = await recorded(false);
    const json = JSON.parse(replayToJson(file)) as {
      replay: { entries: { kind: string; op?: { op: string; body?: { mass?: unknown; position?: unknown } } }[] };
    };
    const add = json.replay.entries.find((e) => e.op?.op === 'addBody')!;
    add.op!.body!.position = ['x', null, 1e30];
    const back = parseReplay(JSON.stringify(json));
    const op = back.replay.entries.find((e) => e.kind === 'op' && e.op.op === 'addBody')!;
    const pos = (op as { op: { body: { position: number[] } } }).op.body.position;
    expect(pos.every((v) => Number.isFinite(v) && Math.abs(v) <= 1_000_000)).toBe(true);
  });

  it('plays the payload type through structuredClone like the worker boundary does', async () => {
    const { file } = await recorded(true);
    const wire: ReplayPayload = structuredClone(file.replay);
    expect(wire.base!.rapier).toBeInstanceOf(Uint8Array);
  });
});
