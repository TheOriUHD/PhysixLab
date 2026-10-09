/// <reference lib="webworker" />
/**
 * Physics worker: owns the Rapier world so heavy simulation never blocks rendering or UI.
 * The main thread drives it with `tick` messages and receives transferable pose buffers.
 */
import { PhysicsWorld, initRapier } from './world';
import type { FromWorker, ToWorker } from './protocol';

let sim: PhysicsWorld | null = null;
let announcedLayout = -1;
let chain: Promise<void> = Promise.resolve();
const ctx = self as unknown as DedicatedWorkerGlobalScope;

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  ctx.postMessage(msg, transfer);
}

async function handle(m: ToWorker): Promise<void> {
  switch (m.type) {
    case 'build': {
      await initRapier();
      sim?.dispose();
      sim = new PhysicsWorld(m.doc);
      announcedLayout = -1;
      post({ type: 'built', info: sim.builtInfo() });
      break;
    }
    case 'ops': {
      if (!sim) return;
      for (const op of m.ops) sim.applyOp(op);
      break;
    }
    case 'tick': {
      if (!sim) return;
      sim.setKeys(m.keys);
      let alpha = 1;
      if (m.stepCount > 0) sim.stepManual(m.stepCount);
      else if (m.running) {
        sim.advance(m.dt, m.timeScale);
        alpha = sim.alpha;
      }
      const poses = sim.readPoses(alpha);
      const joints = sim.readJoints();
      const soft = sim.readSoft(); // after readPoses: adds soft-body energy to the totals
      const contacts = m.wantContacts ? sim.readContacts() : undefined;
      const layoutChanged = sim.layoutVersion !== announcedLayout;
      announcedLayout = sim.layoutVersion;
      const transfer: Transferable[] = [poses.buffer, joints.buffer, soft.positions.buffer];
      if (contacts) transfer.push(contacts.buffer);
      post(
        {
          type: 'frame',
          poses,
          joints,
          softLayout: soft.layout,
          softPositions: soft.positions,
          contacts,
          bodyIds: layoutChanged ? sim.bodyIds : undefined,
          jointIds: layoutChanged ? sim.jointIds : undefined,
          stats: sim.stats(),
          events: sim.drainEvents(),
          info: layoutChanged ? sim.builtInfo() : undefined,
        },
        transfer,
      );
      break;
    }
    case 'dispose': {
      sim?.dispose();
      sim = null;
      break;
    }
  }
}

ctx.onmessage = (e: MessageEvent<ToWorker>) => {
  chain = chain
    .then(() => handle(e.data))
    .catch((err: unknown) => {
      post({ type: 'error', message: String((err as { stack?: unknown } | null)?.stack ?? err) });
    });
};

post({ type: 'ready' });
