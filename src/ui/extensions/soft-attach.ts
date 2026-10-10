/**
 * SF-1 as a UI extension: the attach tool (click a soft body, then the rigid body or joint it is fastened to) and the
 * commands for tyres, releasing and soft copies. Attachments live in the document (`SoftEntity.attachments`); the
 * physics worker resolves them to particle sets when the soft body is built.
 */
import { Vector3 } from 'three';
import { registerCommand, registerTool } from '../../app/registry';
import type { App } from '../../app/app';
import type { Vec3 } from '../../core/math';
import { createSoft } from '../../model/factory';
import { softSurfacePoints } from '../../model/softMesh';
import { isBody, isSoft, type BodyEntity, type SoftEntity } from '../../model/types';
import { jointBodyOf, regionAttachment, rimAttachment, softCopyOf } from './softPick';

const TOOL = 'softattach';
const LABEL_KEY = 'soft-attach-a';

interface Pending {
  soft: string;
  hit: Vec3;
}
let pending: Pending | null = null;
let hooked: App | null = null;

function clearPending(app: App): void {
  if (!pending) return;
  pending = null;
  app.labels.remove(LABEL_KEY);
  if (app.prefs.value.tool === TOOL) app.updateToolHint();
}

/** Esc cancels the half-made attachment first (a second Esc leaves the tool); leaving the tool also drops it. */
function hook(app: App): void {
  if (hooked === app) return;
  hooked = app;
  app.prefs.on('change', () => {
    if (app.prefs.value.tool !== TOOL) clearPending(app);
  });
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || !pending || app.prefs.value.tool !== TOOL) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      clearPending(app);
    },
    true,
  );
}

const vec = (v: Vector3): Vec3 => [v.x, v.y, v.z];

function attachTo(app: App, e: PointerEvent, p: Pending, body: BodyEntity, joint?: string): void {
  const soft = app.store.soft(p.soft);
  if (!soft) {
    clearPending(app);
    return;
  }
  const att = regionAttachment(soft, p.hit, body, joint);
  app.store.updateMany([[soft.id, { attachments: [...soft.attachments, att] }]], 'Attach soft body');
  app.effects.ping(new Vector3(...p.hit), 0x5be3a1);
  clearPending(app);
  if (!e.shiftKey) app.setTool('select');
  app.toast(`${soft.name} fastened to ${body.name}${joint ? ' (released when its joint breaks)' : ''}`, 'success');
  app.updateToolHint();
}

function pointerDown(app: App, e: PointerEvent): void {
  hook(app);
  if (app.sim.active) {
    // Fastenings are authored against the document poses; live poses differ once bodies have moved or the soft body deformed.
    app.toast('Stop the simulation to fasten soft bodies (press Esc, or reset), then attach.', 'info');
    return;
  }
  const hit = app.pickEntity(e, { joints: true });
  if (!hit) return;
  const store = app.store;
  if (!pending) {
    const soft = store.soft(hit.entityId);
    if (!soft) {
      app.toast('Click a soft body first (cloth, cable, jelly, mesh or tyre)', 'warn');
      return;
    }
    pending = { soft: soft.id, hit: vec(hit.point) };
    app.effects.ping(hit.point, 0xffb347);
    app.labels.set(LABEL_KEY, hit.point, '●', 'accent');
    app.updateToolHint();
    return;
  }
  if (store.soft(hit.entityId)) {
    app.toast('Now click a rigid body (or a joint) to fasten it to', 'warn');
    return;
  }
  const joint = store.joint(hit.entityId);
  if (joint) {
    const id = jointBodyOf(joint, (b) => store.body(b)?.bodyType === 'dynamic');
    const body = store.body(id);
    if (!body) {
      app.toast('That joint has no body to fasten to', 'warn');
      return;
    }
    attachTo(app, e, pending, body, joint.id);
    return;
  }
  const body = store.body(hit.entityId);
  if (!body) {
    app.toast('Click a rigid body or a joint', 'warn');
    return;
  }
  attachTo(app, e, pending, body);
}

registerTool({
  id: TOOL,
  group: 'soft',
  order: 62,
  label: 'Attach soft body',
  title: 'Fasten cloth, cable or jelly to a rigid body — click the soft body, then the body or joint',
  icon: 'softweld',
  keywords: ['fasten', 'pin', 'sail', 'curtain', 'net', 'cloth', 'cable', 'tie'],
  enabled: () => true,
  activate: (app) => {
    hook(app);
    clearPending(app);
    app.setTool(TOOL);
  },
  isActive: (app) => app.prefs.value.tool === TOOL,
  pointerDown: (app, e) => pointerDown(app, e),
  hint: () =>
    pending
      ? 'Now click the <b>rigid body</b> to fasten it to — or a <b>joint</b>, so it lets go when the joint breaks · <kbd>Shift</kbd> keeps the tool · <kbd>Esc</kbd> cancels'
      : '<b>Attach</b> — click the point of the cloth, cable or jelly you want to fasten',
});

// ── commands ──

const selectedSofts = (app: App): SoftEntity[] => app.store.selection.map((id) => app.store.soft(id)).filter(isSoft);

/** The selected tyre and the one body fastened to it, or null. */
function tyreAndBody(app: App): { tyre: SoftEntity; body: BodyEntity } | null {
  const sel = app.store.selection.map((id) => app.store.get(id));
  if (sel.length !== 2) return null;
  const tyre = sel.find((e) => isSoft(e) && e.type === 'tyre');
  const body = sel.find(isBody);
  return tyre && isSoft(tyre) && body ? { tyre, body } : null;
}

registerCommand({
  id: 'soft.fastenTyre',
  label: 'Fasten tyre to the selected body (rim)',
  category: 'Soft bodies',
  icon: 'softweld',
  description: 'Select a tyre and a rigid hub or axle body: the tyre rim is fastened to the body at the tyre centre',
  keywords: ['wheel', 'rim', 'hub', 'tyre', 'tire', 'attach'],
  enabled: (app) => tyreAndBody(app) !== null,
  run: ({ app }) => {
    const pair = tyreAndBody(app);
    if (!pair) return;
    const { tyre, body } = pair;
    const att = rimAttachment(tyre, body);
    app.store.updateMany(
      [[tyre.id, { attachments: [...tyre.attachments.filter((a) => a.kind !== 'rim'), att] }]],
      'Fasten tyre',
    );
    app.toast(`${tyre.name} rim fastened to ${body.name}`, 'success');
  },
});

registerCommand({
  id: 'soft.releaseAttachments',
  label: 'Release soft body fastenings',
  category: 'Soft bodies',
  icon: 'softweld',
  description: 'Unfasten the selected soft bodies from every rigid body (removes their attachments)',
  keywords: ['detach', 'unpin', 'free', 'attachments'],
  enabled: (app) => selectedSofts(app).some((s) => s.attachments.length > 0),
  run: ({ app }) => {
    const softs = selectedSofts(app).filter((s) => s.attachments.length > 0);
    for (const s of softs) app.sim.client.op({ op: 'releaseSoft', id: s.id });
    app.store.updateMany(
      softs.map((s) => [s.id, { attachments: [] }] as [string, Partial<SoftEntity>]),
      'Release soft fastenings',
    );
    app.toast(`Released ${softs.length} soft ${softs.length === 1 ? 'body' : 'bodies'}`, 'success');
  },
});

const copyable = (app: App): BodyEntity[] =>
  app.store.selectedBodies().filter((b) => softSurfacePoints(b.shape) !== null);

registerCommand({
  id: 'soft.makeSoftCopy',
  label: 'Make a soft (jelly) copy of the selected body',
  category: 'Soft bodies',
  icon: 'jelly',
  description: 'A volumetric jelly with the same shape, size and pose as the selected rigid body (the original stays)',
  keywords: ['jelly', 'squishy', 'deformable', 'volumetric', 'mesh'],
  enabled: (app) => !app.sim.active && copyable(app).length > 0,
  run: ({ app }) => {
    const bodies = copyable(app);
    const made = bodies.map((b) => createSoft('mesh', softCopyOf(b, app.store.uniqueName(`Soft ${b.name}`))));
    app.store.add(made, 'Make soft copy');
    app.toast(
      `Created ${made.length} soft ${made.length === 1 ? 'copy' : 'copies'} — move the original away`,
      'success',
    );
  },
});
