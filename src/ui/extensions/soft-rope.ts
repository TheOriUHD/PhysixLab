/**
 * SF-3 as a UI extension: the rope / chain tool. Two clicks (start, end), each on the ground, on a rigid body or — with
 * Shift — in space on a vertical plane. Rope and chain are strings of rigid links (`generateChain`); "soft cable" is a
 * deformable cable fastened to the bodies it touches. The whole thing is added as one undo step.
 */
import { Vector3 } from 'three';
import { registerCommand, registerTool } from '../../app/registry';
import type { App } from '../../app/app';
import type { Vec3 } from '../../core/math';
import { vdist } from '../../core/math';
import { massEstimate } from '../../model/compound';
import { createSoft } from '../../model/factory';
import { generateChain } from '../../model/ropeGen';
import type { BodyEntity, SoftAttachment } from '../../model/types';
import { cableBetween, cableEndAttachment, ropeLinkCount, worldToLocal } from './softPick';

const TOOL = 'softrope';
const LABEL_KEY = 'soft-rope-a';
const MIN_LENGTH = 0.3;

type Mode = 'rope' | 'chain' | 'cable';
const MODES: { id: Mode; label: string; blurb: string; keywords: string[] }[] = [
  {
    id: 'rope',
    label: 'Rope (rigid links, ball joints)',
    blurb: 'Capsule links joined by ball joints',
    keywords: ['string'],
  },
  {
    id: 'chain',
    label: 'Chain (rigid links, cone-twist joints)',
    blurb: 'Alternating links on cone-twist joints',
    keywords: ['links'],
  },
  {
    id: 'cable',
    label: 'Soft cable (deformable)',
    blurb: 'A deformable cable fastened to the bodies at its ends',
    keywords: ['soft', 'wire'],
  },
];
let mode: Mode = 'rope';

interface End {
  point: Vec3;
  body: BodyEntity | null;
}
let start: End | null = null;
let hooked: App | null = null;
let offMove: (() => void) | null = null;

function stop(app: App): void {
  offMove?.();
  offMove = null;
  if (start) {
    start = null;
    app.labels.remove(LABEL_KEY);
    app.clearMeasure();
    if (app.prefs.value.tool === TOOL) app.updateToolHint();
  }
}

function hook(app: App): void {
  if (hooked === app) return;
  hooked = app;
  app.prefs.on('change', () => {
    if (app.prefs.value.tool !== TOOL) stop(app);
  });
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || !start || app.prefs.value.tool !== TOOL) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      stop(app);
    },
    true,
  );
}

/** What the pointer is over: a body (hit point), the ground, or — Shift / no ground — a vertical plane in space. */
function resolveEnd(
  app: App,
  ev: { clientX: number; clientY: number; shiftKey: boolean },
  from: End | null,
): End | null {
  if (!ev.shiftKey) {
    const hit = app.pickEntity(ev, { joints: false });
    const body = hit ? app.store.body(hit.entityId) : undefined;
    if (hit && body) return { point: [hit.point.x, hit.point.y, hit.point.z], body };
    const g = app.picker.groundPoint(ev, 0);
    if (g && g.distanceTo(app.camera.position) < 400) return { point: [g.x, g.y, g.z], body: null };
  }
  const anchor = from ? new Vector3(...from.point) : app.viewport.controls.target.clone();
  const p = from ? app.picker.verticalPoint(ev, anchor) : app.picker.cameraPlanePoint(ev, anchor);
  return p ? { point: [p.x, p.y, p.z], body: null } : null;
}

const anchorOf = (app: App, end: End): Vec3 | undefined => {
  const pose = end.body ? app.sim.poseOf(end.body.id) : null;
  return pose ? worldToLocal(pose, end.point) : undefined;
};

function buildRopeOrChain(app: App, a: End, b: End): void {
  const links = ropeLinkCount(vdist(a.point, b.point));
  const dynamic = [a.body, b.body].filter((x): x is BodyEntity => !!x && x.bodyType === 'dynamic');
  const load = dynamic.length ? Math.max(...dynamic.map(massEstimate)) : 0;
  const res = generateChain({
    kind: mode === 'chain' ? 'chain' : 'rope',
    start: a.point,
    end: b.point,
    links,
    startBody: a.body?.id ?? null,
    endBody: b.body?.id ?? null,
    startAnchor: anchorOf(app, a),
    endAnchor: anchorOf(app, b),
    load,
    sag: Math.min(0.5, 0.05 * vdist(a.point, b.point)),
  });
  const label = mode === 'chain' ? 'Add chain' : 'Add rope';
  app.store.transact(label, () => {
    app.store.add(res.bodies, label, false);
    app.store.add(res.joints, label, false);
  });
  app.store.setSelection([res.bodies[0].id]);
  for (const w of res.warnings) app.toast(w, 'warn');
  app.toast(`${mode === 'chain' ? 'Chain' : 'Rope'} of ${res.bodies.length} links added`, 'success');
}

function buildCable(app: App, a: End, b: End): void {
  // The pinned (world) end goes first: particle 0 is at the cable's −X end, which `pin: one-end | ends` fixes.
  let s = a,
    e = b;
  if (a.body && !b.body) {
    s = b;
    e = a;
  }
  const geo = cableBetween(s.point, e.point);
  const pin = !s.body && !e.body ? 'ends' : !s.body || !e.body ? 'one-end' : 'none';
  const attachments: SoftAttachment[] = [];
  const poseOf = (end: End) => (end.body ? app.sim.poseOf(end.body.id) : null);
  const ps = poseOf(s),
    pe = poseOf(e);
  if (s.body && ps) attachments.push(cableEndAttachment(geo, true, s.point, { id: s.body.id, ...ps }));
  if (e.body && pe) attachments.push(cableEndAttachment(geo, false, e.point, { id: e.body.id, ...pe }));
  const cable = createSoft('cable', {
    ...geo,
    name: app.store.uniqueName('Cable'),
    pin,
    attachments,
  });
  app.store.add([cable], 'Add soft cable');
  app.toast(
    `Soft cable added${attachments.length ? ` and fastened to ${attachments.length} ${attachments.length === 1 ? 'body' : 'bodies'}` : ''}`,
    'success',
  );
}

function pointerDown(app: App, e: PointerEvent): void {
  hook(app);
  const end = resolveEnd(app, e, start);
  if (!end) return;
  if (!start) {
    start = end;
    app.effects.ping(new Vector3(...end.point), 0xffb347);
    app.labels.set(LABEL_KEY, new Vector3(...end.point), '●', 'accent');
    const move = (ev: PointerEvent): void => {
      if (!start) return;
      const p = resolveEnd(app, ev, start);
      if (p) app.setMeasureLine(new Vector3(...start.point), new Vector3(...p.point));
    };
    const dom = app.viewport.dom;
    dom.addEventListener('pointermove', move);
    offMove = () => dom.removeEventListener('pointermove', move);
    app.updateToolHint();
    return;
  }
  const a = start;
  if (vdist(a.point, end.point) < MIN_LENGTH) {
    app.toast(`Pick a second point at least ${MIN_LENGTH} m away`, 'warn');
    return;
  }
  stop(app);
  if (mode === 'cable') buildCable(app, a, end);
  else buildRopeOrChain(app, a, end);
  app.effects.ping(new Vector3(...end.point), 0x5be3a1);
  if (!e.shiftKey) app.setTool('select');
}

registerTool({
  id: TOOL,
  group: 'soft',
  order: 64,
  label: 'Rope / chain tool',
  title: 'Draw a rope, chain or soft cable between two points — ground, rigid bodies or (Shift) in space',
  icon: 'rope',
  keywords: ['rope', 'chain', 'cable', 'string', 'hang', 'crane'],
  activate: (app) => {
    hook(app);
    stop(app);
    app.setTool(TOOL);
  },
  isActive: (app) => app.prefs.value.tool === TOOL,
  pointerDown: (app, e) => pointerDown(app, e),
  hint: () => {
    const name = MODES.find((m) => m.id === mode)?.label.split(' (')[0] ?? mode;
    return start
      ? `<b>${name}</b> — click the end point (ground, a body, or <kbd>Shift</kbd>-click in space) · <kbd>Esc</kbd> cancels`
      : `<b>${name}</b> — click the start point: the ground, a rigid body, or <kbd>Shift</kbd>-click in space. Switch type with the palette (<kbd>Ctrl</kbd>+<kbd>K</kbd> › rope)`;
  },
});

for (const m of MODES) {
  registerCommand({
    id: `rope.mode.${m.id}`,
    label: `Rope tool: ${m.label}`,
    category: 'Soft bodies',
    icon: m.id === 'cable' ? 'cable' : 'rope',
    description: m.blurb,
    keywords: ['rope', 'chain', 'cable', ...m.keywords],
    checked: () => mode === m.id,
    run: ({ app }) => {
      mode = m.id;
      stop(app);
      app.setTool(TOOL);
      app.updateToolHint();
    },
  });
}
