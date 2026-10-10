/**
 * The `timeline` custom channel (package TM): seeking, rewinding, recording replays, loading replay files, the
 * determinism check and trajectory tracks for ghosts. Every command answers on the same channel with a
 * `TimelineReply`. Registered by importing this module (done by `PhysicsWorld`).
 */
import { registerCustomChannel } from './custom';
import type { DeterminismReport, ReplayPayload, TimelineCmd, TimelineReply, TimelineStatus } from './timelineTypes';
import { HASH_EVERY } from './world/recorder';
import { stateHash } from './world/hash';
import { restoreSnapshot } from './world/snapshot';
import { stashedRuns, clearStashedRuns } from './world/track';
import { seekTo, startRewind, stopRewind } from './world/travel';
import type { PhysicsWorld } from './world/physicsWorld';

export function timelineStatus(world: PhysicsWorld): TimelineStatus {
  const s = world.state;
  const r = s.recorder;
  const rec = r.recording;
  const rp = r.replay;
  return {
    kind: 'status',
    step: s.stepCount,
    simTime: s.simTime,
    hz: s.settings.physicsHz,
    first: r.first,
    head: Math.max(r.head, s.stepCount),
    snapshots: r.ring.map((e) => e.step),
    interval: r.interval,
    bytes: r.bytes,
    budgetBytes: r.budgetBytes,
    enabled: r.enabled,
    mode: r.mode,
    recording: rec ? { startStep: rec.startStep, entries: rec.entries.length, fromStart: rec.base === null } : null,
    replay: rp
      ? {
          startStep: rp.startStep,
          endStep: rp.endStep,
          checkpoints: rp.hashes.size,
          checked: rp.checked,
          firstBad: rp.firstBad,
        }
      : null,
    track: {
      count: r.track.count,
      every: r.track.every,
      duration: (Math.max(0, r.track.count - 1) * r.track.every) / s.settings.physicsHz,
    },
    watch: r.watch ? { checked: r.watch.checked, total: r.watch.hashes.size, firstBad: r.watch.firstBad } : null,
  };
}

/** Run two clones of the current state side by side and compare their hashes every `every` steps. */
export function determinismCheck(world: PhysicsWorld, steps: number, every: number): DeterminismReport {
  const t0 = performance.now();
  const a = world.clone();
  const b = world.clone();
  let checkpoints = 0;
  let first: DeterminismReport['firstDivergence'] = null;
  const expect = new Map<number, string>();
  try {
    for (let i = 1; i <= steps; i++) {
      a.stepOnce();
      b.stepOnce();
      if (i % every === 0) {
        checkpoints++;
        const ha = stateHash(a.state);
        const hb = stateHash(b.state);
        expect.set(a.stepCount, ha);
        if (ha !== hb && !first) first = { step: a.stepCount, a: ha, b: hb };
      }
    }
  } finally {
    a.dispose();
    b.dispose();
  }
  // From now on the real run is compared with what the clones did, for as long as nothing is edited.
  world.recorder.watch = first ? null : { hashes: expect, checked: 0, firstBad: null };
  return {
    kind: 'determinism',
    ok: !first,
    steps,
    every,
    checkpoints,
    firstDivergence: first,
    ms: performance.now() - t0,
  };
}

function loadReplay(world: PhysicsWorld, p: ReplayPayload): void {
  const s = world.state;
  if (p.base) restoreSnapshot(s, p.base);
  else if (s.stepCount !== 0)
    throw new Error('This replay starts from a freshly built scene, but the world has already run.');
  s.recorder.beginReplay(s, p.entries, p.endStep, p.hashes);
  s.acc = 0;
}

registerCustomChannel('timeline', (data, { world, reply }) => {
  const cmd = data as TimelineCmd;
  const send = (m: TimelineReply) => reply('timeline', m);
  const s = world.state;
  const r = s.recorder;
  try {
    switch (cmd.cmd) {
      case 'status':
        send(timelineStatus(world));
        break;
      case 'seek':
        if (r.mode === 'rewind') stopRewind(s);
        seekTo(s, cmd.step);
        send(timelineStatus(world));
        break;
      case 'rewind':
        if (cmd.on) startRewind(s, cmd.rate ?? 1);
        else stopRewind(s);
        break;
      case 'config':
        if (cmd.budgetMB !== undefined) r.budgetBytes = Math.max(8, Math.min(1024, cmd.budgetMB)) * 1024 * 1024;
        if (cmd.enabled !== undefined) r.enabled = cmd.enabled;
        send(timelineStatus(world));
        break;
      case 'record':
        if (cmd.on) r.startRecording(s);
        else r.recording = null;
        send(timelineStatus(world));
        break;
      case 'recordGet': {
        const rec = r.recording;
        if (!rec) {
          send({ kind: 'error', message: 'Nothing is being recorded.' });
          break;
        }
        const payload: ReplayPayload = {
          base: rec.base,
          startStep: rec.startStep,
          endStep: s.stepCount,
          entries: rec.entries,
          hashes: rec.hashes,
          hz: s.settings.physicsHz,
        };
        send({ kind: 'recording', payload });
        if (cmd.stop) r.recording = null;
        break;
      }
      case 'replayLoad':
        loadReplay(world, cmd.payload);
        send(timelineStatus(world));
        break;
      case 'replayExit':
        r.endReplay();
        send(timelineStatus(world));
        break;
      case 'determinism':
        send(determinismCheck(world, Math.max(2, Math.min(3000, cmd.steps ?? 240)), Math.max(1, cmd.every ?? 10)));
        break;
      case 'trackGet': {
        const track = cmd.run === 'live' ? r.track.export('Current run') : (stashedRuns()[cmd.run] ?? null);
        send({ kind: 'track', run: cmd.run, track });
        break;
      }
      case 'runs':
        send({
          kind: 'runs',
          runs: stashedRuns().map((t) => ({
            name: t.name,
            duration: t.duration,
            count: t.count,
            bodies: t.ids.length,
          })),
        });
        break;
      case 'clearRuns':
        clearStashedRuns();
        send({ kind: 'runs', runs: [] });
        break;
    }
  } catch (e) {
    send({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
  }
});

export { HASH_EVERY };
