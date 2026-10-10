/** Dispatch of the live-edit protocol ops (`SimOp`) onto the world modules. */
import { pathCurveOf } from '../../model/path';
import type { SimOp } from '../protocol';
import { addBody } from './bodies';
import { removeEntities, setVelocity, teleport, updateBody } from './edits';
import { configureEvents } from './events';
import { raycast } from './queries';
import { restoreSnapshot, takeSnapshot } from './snapshot';
import { beginGrab, explode, impulse } from './forces';
import { addJoint, updateJoint } from './joints';
import { applySettings } from './settings';
import { addSoft, beginSoftGrab, releaseSoftGrab, removeSoft } from './soft';
import type { WorldState } from './state';

export function applyOp(s: WorldState, op: SimOp): void {
  switch (op.op) {
    case 'addBody':
      addBody(s, op.body, !!op.ephemeral);
      break;
    case 'addJoint':
      addJoint(s, op.joint);
      break;
    case 'remove':
      removeEntities(s, op.ids);
      break;
    case 'updateBody':
      updateBody(s, op.body);
      break;
    case 'updateJoint':
      updateJoint(s, op.joint);
      break;
    case 'settings':
      applySettings(s, op.settings);
      break;
    case 'teleport':
      teleport(s, op.id, op.position, op.rotation, op.keepVelocity);
      break;
    case 'setVelocity':
      setVelocity(s, op.id, op.linvel, op.angvel);
      break;
    case 'grab':
      beginGrab(s, op.id, op.point, op.target);
      break;
    case 'grabMove':
      if (s.grab) s.grab.target = op.target;
      if (s.softGrab) s.softGrab.target = op.target;
      break;
    case 'release':
      s.grab = null;
      releaseSoftGrab(s);
      break;
    case 'impulse':
      impulse(s, op.id, op.impulse, op.point);
      break;
    case 'explode':
      explode(s, op.center, op.strength, op.radius);
      break;
    case 'addSoft':
      addSoft(s, op.soft);
      break;
    case 'updateSoft':
      removeSoft(s, op.soft.id);
      addSoft(s, op.soft);
      break;
    case 'grabSoft':
      beginSoftGrab(s, op.id, op.index, op.target);
      break;
    case 'wakeAll':
      for (const r of s.order) r.rb.wakeUp();
      break;
    case 'setSeed':
      s.rng.seed(op.seed);
      break;
    case 'raycast':
      s.raycasts.push({ id: op.id, hit: raycast(s, op.origin, op.dir, op.maxDist, op.options) });
      break;
    case 'snapshot':
      s.snapshots.push({ id: op.id, snapshot: takeSnapshot(s) });
      break;
    case 'restore':
      restoreSnapshot(s, op.snapshot);
      break;
    case 'events':
      configureEvents(s, op.config);
      break;
    case 'setPath':
      s.paths.set(op.path.id, { def: op.path, curve: pathCurveOf(op.path) });
      break;
  }
}
