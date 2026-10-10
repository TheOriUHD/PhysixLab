/**
 * ED-11: the mirror commands as free functions of `(app, …)` — mirror copy and flip of the selection about a plane,
 * each one undo step. The registrations (commands, menu entries, dialog) are in `src/ui/extensions/ed-mirror.ts`.
 */
import type { Vec3 } from '../../core/math';
import { topLevel } from '../../model/groups';
import {
  AXIS_NAMES,
  mirrorCopy,
  mirrorFlip,
  mirrorMeshAsset,
  type Axis,
  type MirrorOptions,
  type MirrorPlane,
} from '../../model/edit/mirror';
import { fitsEntityBudget } from '../../model/edit/entityBudget';
import type { Entity } from '../../model/types';
import { isPosed } from '../../model/types';
import type { App } from '../app';
import { getSymmetry } from './symmetryHost';

/** Selected objects that can be mirrored (everything with a pose), without members whose group is selected too. */
export function mirrorRoots(app: App): string[] {
  const store = app.store;
  const posed = store.selection.filter((id) => isPosed(store.get(id)));
  return topLevel((id) => store.get(id), posed);
}

function meshOptions(app: App): MirrorOptions {
  return {
    mirrorMesh: (meshId, axis) => {
      const a = app.store.getAsset(meshId);
      if (!a || a.kind !== 'mesh') return undefined;
      return app.store.addAsset(mirrorMeshAsset(a, axis), 'Mirror mesh');
    },
  };
}

/** Why a mirror command cannot run right now, or null. */
export function mirrorBlocked(app: App): string | null {
  if (app.sim.active) return 'Stop the simulation to mirror objects.';
  if (!mirrorRoots(app).length) return 'Select the objects to mirror first.';
  return null;
}

export const planeLabel = (pl: MirrorPlane): string => {
  const axis = pl.normal.findIndex((v) => Math.abs(Math.abs(v) - 1) < 1e-9);
  if (axis >= 0) {
    const off = pl.point[axis];
    return `${AXIS_NAMES[axis as Axis]}${Math.abs(off) > 1e-9 ? ` = ${+off.toFixed(3)}` : ''}`;
  }
  const f = (v: Vec3) => v.map((x) => +x.toFixed(2)).join(', ');
  return `plane through (${f(pl.point)}) with normal (${f(pl.normal)})`;
};

/** Copy the selection as its mirror image about `plane`. Returns the new top-level ids. */
export function mirrorCopySelection(app: App, plane: MirrorPlane): string[] {
  const why = mirrorBlocked(app);
  if (why) {
    app.toast(why, 'warn');
    return [];
  }
  const store = app.store;
  const ids = mirrorRoots(app);
  const res = mirrorCopy(store.all(), ids, plane, meshOptions(app));
  if (!res.entities.length) return [];
  const over = fitsEntityBudget(store, res.entities.length, 'This mirror copy');
  if (over) {
    app.toast(over, 'warn');
    return [];
  }
  const sym = getSymmetry(app);
  const copies: Entity[] = res.entities.map((c) => (isPosed(c) ? { ...c, name: store.uniqueName(c.name) } : c));
  store.transact(`Mirror copy about ${planeLabel(plane)}`, () => {
    // The copies are the other halves: symmetry mode must not mirror them again.
    sym.suspended(() => store.add(copies, `Mirror copy about ${planeLabel(plane)}`, false));
  });
  if (sym.enabled && sym.isSymmetryPlane(plane)) sym.addPairs(res.idMap, res.axes);
  const roots = topLevel(
    (id) => store.get(id),
    copies.map((c) => c.id),
  );
  store.setSelection(roots);
  const notes: string[] = [];
  if (res.skippedJoints) notes.push(`${res.skippedJoints} joint(s) to unselected objects were not copied`);
  if (res.approximate)
    notes.push(`${res.approximate} object(s) of unknown symmetry were mirrored about their local X axis`);
  app.toast(
    `Mirrored ${roots.length} object(s) about ${planeLabel(plane)}${notes.length ? ` — ${notes.join('; ')}` : ''}`,
    notes.length ? 'warn' : 'success',
  );
  return roots;
}

/** Replace the selection by its mirror image about `plane` (in place). */
export function flipSelection(app: App, plane: MirrorPlane): number {
  const why = mirrorBlocked(app);
  if (why) {
    app.toast(why, 'warn');
    return 0;
  }
  const store = app.store;
  const ids = mirrorRoots(app);
  const label = `Flip about ${planeLabel(plane)}`;
  let moved = 0;
  let skipped = 0;
  store.transact(label, () => {
    const res = mirrorFlip(store.all(), ids, plane, meshOptions(app));
    skipped = res.skippedLocked;
    moved = res.axes.size;
    if (res.patches.length) store.updateMany(res.patches, label);
  });
  if (!moved) app.toast('Everything selected is locked.', 'warn');
  else
    app.toast(
      `Flipped ${moved} object(s) about ${planeLabel(plane)}${skipped ? ` (${skipped} locked left alone)` : ''}`,
      'success',
    );
  return moved;
}
