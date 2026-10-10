// -- ED-B: kind- and multi-selection-aware viewport context menu (ED-31) --
import type { App } from '../../app/app';
import type { Vec3 } from '../../core/math';
import {
  commandEnabled,
  commandLabel,
  getCommand,
  primaryShortcut,
  registerCommand,
  registerMenuEntry,
  runCommand,
  unregisterMenuEntry,
  formatShortcut,
  type MenuEntryDef,
  type MenuItem,
} from '../../app/registry';
import { MATERIAL_PRESETS } from '../../model/materials';
import type { BodyEntity, Entity, JointType } from '../../model/types';
import { isBody, isGroup, isJoint } from '../../model/types';
import { listAddEntries, type AddEntry } from '../addEntries';
import { getContextTarget } from '../contextTarget';

export { getContextTarget, setContextTarget } from '../contextTarget';

// ---- selection helpers -----------------------------------------------------------------------------------------------

const selected = (app: App): Entity[] =>
  app.store.selection.map((id) => app.store.get(id)).filter((e): e is Entity => !!e);
const selectedBodies = (app: App): BodyEntity[] => selected(app).filter(isBody);
const hasSelection = (app: App): boolean => app.store.selection.length > 0;

// ---- commands this menu needs ----------------------------------------------------------------------------------------

registerCommand({
  id: 'edit.toggleBodyType',
  label: 'Make static / dynamic',
  labelFor: (app) => {
    const b = selectedBodies(app);
    return b.length && b.every((x) => x.bodyType === 'static') ? 'Make dynamic' : 'Make static';
  },
  category: 'Edit',
  icon: 'weld',
  description: 'Static bodies stay fixed in place; dynamic ones move under forces',
  keywords: ['static', 'dynamic', 'fixed', 'weld', 'body type'],
  enabled: (app) => selectedBodies(app).length > 0,
  run: ({ app }) => {
    const bodies = selectedBodies(app);
    app.editor.setBodyType(
      bodies.map((b) => b.id),
      bodies.every((b) => b.bodyType === 'static') ? 'dynamic' : 'static',
    );
  },
});

registerCommand({
  id: 'edit.selectChildren',
  label: 'Select group members',
  category: 'Edit',
  icon: 'group',
  keywords: ['children', 'contents', 'group'],
  enabled: (app) => selected(app).some((e) => isGroup(e) && app.store.children(e.id).length > 0),
  run: ({ app }) => {
    const ids: string[] = [];
    for (const e of selected(app)) if (isGroup(e)) ids.push(...app.store.children(e.id).map((c) => c.id));
    if (ids.length) app.store.setSelection(ids);
  },
});

registerCommand({
  id: 'edit.selectJointBodies',
  label: 'Select connected bodies',
  category: 'Edit',
  icon: 'joint',
  keywords: ['joint', 'both', 'ends'],
  enabled: (app) => selected(app).some((e) => isJoint(e) && (e.bodyA || e.bodyB)),
  run: ({ app }) => {
    const ids = new Set<string>();
    for (const e of selected(app))
      if (isJoint(e)) {
        if (e.bodyA) ids.add(e.bodyA);
        if (e.bodyB) ids.add(e.bodyB);
      }
    if (ids.size) app.store.setSelection([...ids]);
  },
});

for (const p of MATERIAL_PRESETS)
  registerCommand({
    id: `edit.material.${p.id}`,
    label: `Material: ${p.label}`,
    category: 'Edit',
    icon: 'sphere',
    keywords: ['sphere', 'preset', 'density', p.label],
    enabled: (app) => selectedBodies(app).length > 0,
    run: ({ app }) => {
      const material = {
        preset: p.id,
        density: p.density,
        friction: p.friction,
        restitution: p.restitution,
        color: p.color,
        metalness: p.metalness,
        roughness: p.roughness,
        opacity: p.opacity,
      };
      // updateMany is one undo step for all selected bodies.
      app.store.updateMany(
        selectedBodies(app).map((b) => [b.id, { material }]),
        `Material: ${p.label}`,
      );
    },
  });

const WORLD_JOINTS: { type: JointType; label: string }[] = [
  { type: 'hinge', label: 'Hinge' },
  { type: 'ball', label: 'Ball' },
  { type: 'fixed', label: 'Fixed' },
];
for (const j of WORLD_JOINTS)
  registerCommand({
    id: `edit.pinToWorld.${j.type}`,
    label: `Pin to world: ${j.label}`,
    category: 'Edit',
    icon: j.type === 'fixed' ? 'weld' : j.type,
    description: `Attach the selected body to the world at its centre with a ${j.label.toLowerCase()} joint`,
    keywords: ['joint', 'attach', 'weld', 'pin', j.type],
    enabled: (app) => {
      const sel = selected(app);
      return sel.length === 1 && isBody(sel[0]);
    },
    run: ({ app }) => {
      const b = selectedBodies(app)[0];
      if (!b) return;
      const pt: Vec3 = [b.position[0], b.position[1], b.position[2]];
      const joint = app.editor.addJoint(j.type, { body: b.id, point: pt }, { body: null, point: pt });
      if (joint) app.store.setSelection([joint.id]);
    },
  });

// ---- item builders ---------------------------------------------------------------------------------------------------

/** A menu row that runs a registered command (label / shortcut / state follow the command). */
function cmdItem(app: App, id: string, label?: string, icon?: string): MenuItem[] {
  const cmd = getCommand(id);
  if (!cmd) return [];
  const sc = primaryShortcut(cmd);
  return [
    {
      label: label ?? commandLabel(cmd, app),
      icon: icon ?? cmd.icon,
      kbd: sc ? formatShortcut(sc) : undefined,
      disabled: !commandEnabled(cmd, app),
      action: () => {
        runCommand(id, app, 'menu');
      },
    },
  ];
}

function materialSubmenu(app: App, label = 'Material'): MenuItem {
  const bodies = selectedBodies(app);
  const common = bodies.length && bodies.every((b) => b.material.preset === bodies[0].material.preset);
  return {
    label,
    icon: 'sphere',
    submenu: MATERIAL_PRESETS.map((p) => ({
      label: p.label,
      checked: common ? bodies[0].material.preset === p.id : false,
      action: () => {
        runCommand(`edit.material.${p.id}`, app, 'menu');
      },
    })),
    action: () => undefined,
  };
}

/** The categorised "Add" submenu: nested submenus for shapes by category, then the other kinds, at the click point. */
function addSubmenu(app: App): MenuItem {
  const at = getContextTarget() ?? [0, 0, 0];
  const row = (e: AddEntry): MenuItem => ({ label: e.label, icon: e.icon, action: () => e.add(app, at) });
  const entries = listAddEntries();
  const sections: MenuItem[] = [];
  const bySection = new Map<string, AddEntry[]>();
  for (const e of entries) (bySection.get(e.section) ?? bySection.set(e.section, []).get(e.section)!).push(e);
  for (const [section, list] of bySection) {
    if (section === 'Shapes') {
      const cats = new Map<string, AddEntry[]>();
      for (const e of list) (cats.get(e.group) ?? cats.set(e.group, []).get(e.group)!).push(e);
      sections.push({
        label: 'Shapes',
        icon: 'box',
        action: () => undefined,
        submenu: [...cats].map(([cat, items]) => ({
          label: cat,
          action: () => undefined,
          submenu: items.map(row),
        })),
      });
    } else
      sections.push({
        label: section,
        icon: list[0].icon,
        action: () => undefined,
        submenu: list.map(row),
      });
  }
  return { label: 'Add', icon: 'plus', action: () => undefined, submenu: sections };
}

function title(app: App): string {
  const sel = selected(app);
  if (sel.length > 1) return `${sel.length} objects`;
  const e = sel[0];
  if (!e) return '';
  const kind = { body: 'Body', soft: 'Soft body', group: 'Group', joint: 'Joint', light: 'Light', path: 'Path' }[
    e.kind
  ];
  return `${e.name} · ${kind}`;
}

// ---- registrations -----------------------------------------------------------------------------------------------------

// The built-in object rows only make sense with a selection; re-register them with a `when` predicate.
for (const old of ['frame', 'duplicate', 'hide', 'lock', 'delete']) unregisterMenuEntry(`menu.context.${old}`);
const objectRows: MenuEntryDef[] = [
  {
    id: 'menu.context.frame',
    group: 'object',
    order: 100,
    command: 'view.frameSelection',
    label: 'Frame',
    icon: 'frame',
  },
  { id: 'menu.context.duplicate', group: 'object', order: 110, command: 'edit.duplicate', icon: 'copy' },
  { id: 'menu.context.hide', group: 'object', order: 120, command: 'edit.hide', label: 'Hide / show', icon: 'eye' },
  { id: 'menu.context.lock', group: 'object', order: 130, command: 'edit.lock', label: 'Lock / unlock', icon: 'lock' },
  { id: 'menu.context.delete', group: 'delete', order: 200, command: 'edit.delete', icon: 'trash' },
].map((e) => ({ ...e, menu: 'context', when: hasSelection }));
for (const e of objectRows) registerMenuEntry(e);

registerMenuEntry({
  id: 'menu.context.title',
  menu: 'context',
  group: 'title',
  order: 10,
  when: hasSelection,
  items: (app) => [{ heading: title(app) }],
});

// Empty space.
registerMenuEntry({
  id: 'menu.context.empty',
  menu: 'context',
  group: 'empty',
  order: 40,
  when: (app) => !hasSelection(app),
  items: (app) => {
    const at = getContextTarget();
    const paste = getCommand('edit.paste');
    const items: MenuItem[] = [{ heading: 'Scene' }, addSubmenu(app)];
    if (paste) {
      const sc = primaryShortcut(paste);
      items.push({
        label: commandLabel(paste, app),
        kbd: sc ? formatShortcut(sc) : undefined,
        disabled: !commandEnabled(paste, app),
        // At the clicked point when we know it (the editor centres the clipboard there).
        action: () => app.editor.paste(at ? [at[0], at[1], at[2]] : undefined),
      });
    }
    items.push(...cmdItem(app, 'edit.selectAll'), ...cmdItem(app, 'view.frameAll', 'Frame all', 'frame'));
    return items;
  },
});

// Kind-specific rows (single selection) and multi-selection rows.
registerMenuEntry({
  id: 'menu.context.kind',
  menu: 'context',
  group: 'kind',
  order: 150,
  when: hasSelection,
  items: (app) => {
    const sel = selected(app);
    const items: MenuItem[] = [];
    if (sel.length === 1) {
      const e = sel[0];
      if (isBody(e)) {
        items.push(...cmdItem(app, 'edit.toggleBodyType'), materialSubmenu(app));
        items.push({
          label: 'Pin to world',
          icon: 'joint',
          action: () => undefined,
          submenu: WORLD_JOINTS.flatMap((j) =>
            cmdItem(app, `edit.pinToWorld.${j.type}`, j.label, j.type === 'fixed' ? 'weld' : j.type),
          ),
        });
      } else if (isGroup(e)) {
        items.push(...cmdItem(app, 'edit.ungroup'), ...cmdItem(app, 'edit.selectChildren'));
      } else if (isJoint(e)) {
        items.push(...cmdItem(app, 'edit.selectJointBodies'));
      }
    } else if (sel.length > 1) {
      items.push(...cmdItem(app, 'edit.group', 'Group', 'group'));
      if (sel.some(isGroup)) items.push(...cmdItem(app, 'edit.ungroup'));
      if (sel.some(isBody))
        items.push(...cmdItem(app, 'edit.toggleBodyType'), materialSubmenu(app, 'Material (all bodies)'));
    }
    return items;
  },
});
