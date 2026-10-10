// -- ED-B: the catalogue of "add at a point" entries shared by the context menu (Add ▸) and the Shift+A menu --
import { Vector3 } from 'three';
import type { Vec3 } from '../core/math';
import type { App } from '../app/app';
import { JOINT_ITEMS, LIGHT_ITEMS, SOFT_ITEMS } from '../app/addCatalog';
import { translateEntities } from '../model/builder';
import { listPrefabs } from '../model/content';
import { halfHeight } from '../model/shapes';
import { listShapes, makeShapeSpec, SHAPE_CATEGORY_LABELS } from '../model/shapeRegistry';
import { cloneEntities } from '../model/store';

export interface AddEntry {
  id: string;
  label: string;
  icon: string;
  blurb: string;
  /** Top-level section: Shapes, Soft bodies, Lights, Paths, Joints, Prefabs. */
  section: string;
  /** Sub-heading within a section (the shape category). */
  group: string;
  /** Add the object at a world surface point (the click on a body, or the ground). */
  add: (app: App, at: Vec3) => void;
}

const ping = (app: App, p: Vec3): void => app.effects.ping(new Vector3(p[0], 0, p[2]));

function snapped(app: App, p: Vec3): Vec3 {
  if (!app.prefs.value.snap) return p;
  const s = app.prefs.value.snapGrid;
  return [Math.round(p[0] / s) * s, p[1], Math.round(p[2] / s) * s];
}

/** All entries in menu order. Built on demand: shapes and prefabs can be registered at any time. */
export function listAddEntries(): AddEntry[] {
  const out: AddEntry[] = [];
  for (const def of listShapes())
    out.push({
      id: `shape.${def.id}`,
      label: def.label,
      icon: def.icon,
      blurb: def.blurb ?? '',
      section: 'Shapes',
      group: SHAPE_CATEGORY_LABELS[def.category] ?? def.category,
      add: (app, at) => {
        const p = snapped(app, at);
        const hh = halfHeight(makeShapeSpec(def.id));
        const body = app.editor.addShape(def.id, [p[0], p[1] + hh + 0.001, p[2]]);
        ping(app, body.position);
      },
    });
  for (const s of SOFT_ITEMS)
    out.push({
      id: `soft.${s.type}`,
      label: s.label,
      icon: s.icon,
      blurb: s.blurb,
      section: 'Soft bodies',
      group: '',
      add: (app, at) => {
        const p = snapped(app, at);
        const dy = s.type === 'jelly' ? 0.56 : s.type === 'balloon' ? 0.55 : 2.4;
        const sf = app.editor.addSoft(s.type, undefined, { position: [p[0], p[1] + dy, p[2]] });
        ping(app, sf.position);
      },
    });
  for (const l of LIGHT_ITEMS)
    out.push({
      id: `light.${l.type}`,
      label: `${l.label} light`,
      icon: l.icon,
      blurb: l.blurb,
      section: 'Lights',
      group: '',
      add: (app, at) => {
        const p = snapped(app, at);
        const light = app.editor.addLight(l.type, [p[0], p[1] + (l.type === 'directional' ? 6 : 3), p[2]]);
        ping(app, light.position);
      },
    });
  out.push({
    id: 'path',
    label: 'Path',
    icon: 'path',
    blurb: 'A spline through points — a track for movers and cameras',
    section: 'Paths',
    group: '',
    add: (app, at) => {
      const p = snapped(app, at);
      const path = app.editor.addPath([p[0], p[1] + 0.05, p[2]]);
      ping(app, path.position);
    },
  });
  for (const p of listPrefabs())
    out.push({
      id: `prefab.${p.id}`,
      label: p.name,
      icon: p.icon,
      blurb: p.blurb,
      section: 'Prefabs',
      group: p.category ?? '',
      add: (app, at) => {
        const q = snapped(app, at);
        const list = translateEntities(p.build(), [q[0], q[1], q[2]]);
        const copies = cloneEntities(
          list,
          list.map((e) => e.id),
          [0, 0, 0],
        ).map((e) => ({ ...e, name: app.store.uniqueName(e.name) }));
        app.store.add(copies, `Insert ${p.name}`);
        ping(app, q);
      },
    });
  return out;
}

/** Joint types the Add menu offers: choosing one starts the joint tool (then click two bodies). */
export const JOINT_ENTRIES = JOINT_ITEMS.map((j) => ({
  id: `joint.${j.type}`,
  label: `${j.label} joint`,
  icon: j.icon,
  blurb: `${j.blurb}. Then click two bodies in the scene.`,
  start: (app: App) => app.startJointTool(j.type),
}));
