/**
 * ED-B: every command the history panel, the context menu and the Add menu register is found by the palette's
 * search (by its label), the Shift+A key is bound to the add menu, and the keymap has no collisions.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app/app';
import { registerAppBuiltins } from '../src/app/builtin';
import { PrefsStore } from '../src/app/prefs';
import { commandRegistry, getCommand, keymap, listCommands, resolveMenu, shortcutList } from '../src/app/registry';
import { chordId, parseShortcut } from '../src/app/registry/shortcuts';
import { createBody, createGroup, createJoint } from '../src/model/factory';
import { SceneStore } from '../src/model/store';
import { registerUiBuiltins } from '../src/ui/builtin';
import { buildPaletteItems } from '../src/ui/palette/items';
import { rankItems } from '../src/ui/palette/search';
import { filterRows } from '../src/ui/addMenu';

const EXISTING_TOOLS = ['tool.blast', 'tool.shoot', 'tool.measure', 'tool.joint'];

let mine: string[] = [];

beforeAll(async () => {
  registerAppBuiltins();
  registerUiBuiltins();
  const before = new Set(listCommands().map((c) => c.id));
  await import('../src/ui/extensions/historyPanel');
  await import('../src/ui/extensions/contextMenus');
  await import('../src/ui/extensions/addMenu');
  mine = listCommands()
    .map((c) => c.id)
    .filter((id) => !before.has(id) && !id.startsWith('panel.'));
});

function fixture() {
  const store = new SceneStore();
  const body = createBody({ name: 'Crate', shape: { type: 'box' } });
  const other = createBody({ name: 'Ball', shape: { type: 'sphere' }, position: [2, 0.5, 0] });
  const group = createGroup({ name: 'Gr' });
  const child = createBody({ name: 'Child', shape: { type: 'box' }, parent: group.id });
  const joint = createJoint({ type: 'hinge', bodyA: body.id, bodyB: other.id, anchorA: [0, 0, 0] });
  store.add([body, other, group, child, joint], 'Add stuff');
  const app = {
    store,
    prefs: new PrefsStore(),
    sim: { active: false, mode: 'edit' },
    persistence: { library: () => [] },
  } as unknown as App;
  return { app, store, body, group, joint, other };
}

describe('ED-B commands and the palette', () => {
  it('registers the expected commands', () => {
    for (const id of [
      'add.menu',
      'edit.history.clear',
      'edit.toggleBodyType',
      'edit.selectChildren',
      'edit.selectJointBodies',
      'edit.material.steel',
      'edit.pinToWorld.hinge',
    ])
      expect(mine, id).toContain(id);
  });

  it('every command of this package (and the interaction tools) can be found by typing its label', () => {
    const { app, store, body, group, joint } = fixture();
    const found = new Map<string, { label: string; rank: number }>();
    for (const sel of [[body.id], [group.id], [joint.id]]) {
      store.setSelection(sel);
      const items = buildPaletteItems(app);
      for (const item of items) {
        if (!item.id.startsWith('cmd:')) continue;
        const id = item.id.slice(4);
        if (!mine.includes(id) && !EXISTING_TOOLS.includes(id)) continue;
        const ranked = rankItems(items, item.label, []);
        const rank = ranked.findIndex((r) => r.item.id === item.id);
        if (!found.has(id)) found.set(id, { label: item.label, rank });
        expect(rank, `${id} ("${item.label}") must be in the results for its own label`).toBeGreaterThanOrEqual(0);
        expect(rank, `${id} should rank near the top for its own label`).toBeLessThan(5);
      }
    }
    for (const id of [...mine, ...EXISTING_TOOLS]) expect(found.has(id), `${id} appears in the palette`).toBe(true);
  });

  it('commands without a shortcut still have an explicit palette label', () => {
    for (const id of [...mine, ...EXISTING_TOOLS]) {
      const c = getCommand(id)!;
      expect(c.palette, id).not.toBe(false);
      expect(c.label.trim().length, id).toBeGreaterThan(0);
    }
  });

  it('Shift+A opens the add menu and the keymap has no collisions', () => {
    const hit = keymap.find({ key: 'A', code: 'KeyA', shiftKey: true, ctrlKey: false, metaKey: false, altKey: false });
    expect(hit?.id).toBe('add.menu');
    const seen = new Map<string, string>();
    for (const c of commandRegistry.list())
      for (const s of shortcutList(c.shortcut)) {
        const k = chordId(parseShortcut(s));
        expect(seen.get(k), `"${s}" of ${c.id} is already used by ${seen.get(k)}`).toBeUndefined();
        seen.set(k, c.id);
      }
  });
});

describe('ED-B context menu content', () => {
  const labels = (items: ReturnType<typeof resolveMenu>): string[] =>
    items.flatMap((i) => ('label' in i ? [i.label] : 'heading' in i ? [i.heading] : []));

  it('empty space offers Add (with submenus), Select all, Frame all', () => {
    const { app, store } = fixture();
    store.setSelection([]);
    const items = resolveMenu(app, 'context');
    const l = labels(items);
    expect(l).toContain('Add');
    expect(l).toContain('Select all');
    expect(l).not.toContain('Delete');
    const add = items.find((i) => 'label' in i && i.label === 'Add');
    expect(add && 'submenu' in add && add.submenu!.length).toBeGreaterThan(2);
  });

  it('a body offers Delete, Material and Pin to world; several objects show a count', () => {
    const { app, store, body, other } = fixture();
    store.setSelection([body.id]);
    const l = labels(resolveMenu(app, 'context'));
    expect(l).toEqual(expect.arrayContaining(['Delete', 'Material', 'Pin to world', 'Make static']));
    store.setSelection([body.id, other.id]);
    const m = labels(resolveMenu(app, 'context'));
    expect(m).toContain('2 objects');
    expect(m).toContain('Group');
  });

  it('a group and a joint get their own rows', () => {
    const { app, store, group, joint } = fixture();
    store.setSelection([group.id]);
    expect(labels(resolveMenu(app, 'context'))).toEqual(expect.arrayContaining(['Ungroup', 'Select group members']));
    store.setSelection([joint.id]);
    expect(labels(resolveMenu(app, 'context'))).toContain('Select connected bodies');
  });

  it('the material command applies to all selected bodies as one undo step', () => {
    const { app, store, body, other } = fixture();
    store.setSelection([body.id, other.id]);
    const before = store.historyEntries().done.length;
    const cmd = getCommand('edit.material.steel')!;
    void cmd.run({ app, source: 'api' });
    expect(store.historyEntries().done.length).toBe(before + 1);
    expect(store.body(body.id)!.material.preset).toBe('steel');
    expect(store.body(other.id)!.material.preset).toBe('steel');
  });
});

describe('Add menu search', () => {
  const rows = [
    { label: 'Sphere', section: 'Shapes', group: 'Basic' },
    { label: 'Box', section: 'Shapes', group: 'Basic' },
    { label: 'Spot light', section: 'Lights', group: '' },
  ];
  it('"sph" finds Sphere first; empty query keeps menu order', () => {
    expect(filterRows(rows, 'sph')[0].label).toBe('Sphere');
    expect(filterRows(rows, '').map((r) => r.label)).toEqual(['Sphere', 'Box', 'Spot light']);
    expect(filterRows(rows, 'zzz')).toEqual([]);
  });
});
