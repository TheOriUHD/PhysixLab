import { describe, expect, it } from 'vitest';
import {
  allGroups,
  defaultLayout,
  dockFloat,
  layoutFromPreset,
  locate,
  moveTab,
  parseLayout,
  raiseFloat,
  reconcile,
  setActive,
  type PanelRef,
} from '../src/ui/dock/layout';
import { BUILTIN_PRESETS } from '../src/ui/dock/presets';

const P: PanelRef[] = [
  { id: 'add', region: 'left', order: 1 },
  { id: 'scenes', region: 'left', order: 2 },
  { id: 'inspector', region: 'right', order: 1 },
  { id: 'outliner', region: 'right', order: 2 },
  { id: 'energy', region: 'bottom', order: 1 },
];

describe('dock layout model', () => {
  it('puts every panel in its home region, one group per region', () => {
    const l = defaultLayout(P);
    expect(l.regions.left[0]?.tabs).toEqual(['add', 'scenes']);
    expect(l.regions.right[0]?.tabs).toEqual(['inspector', 'outliner']);
    expect(l.regions.bottom[0]?.tabs).toEqual(['energy']);
    expect(l.floats).toEqual([]);
  });

  it('moves a tab to another region, splits, floats and docks back', () => {
    let l = defaultLayout(P);
    l = moveTab(l, 'outliner', { type: 'region', region: 'left' });
    expect(locate(l, 'outliner')?.region).toBe('left');
    expect(locate(l, 'outliner')?.group.active).toBe('outliner');
    const gid = (locate(l, 'inspector') ?? fail()).group.id;
    l = moveTab(l, 'scenes', { type: 'split', groupId: gid, side: 'after' });
    expect(l.regions.right.map((g) => g.tabs)).toEqual([['inspector'], ['scenes']]);
    l = moveTab(l, 'inspector', { type: 'float', x: 40, y: 50 });
    expect(l.floats).toHaveLength(1);
    expect(l.floats[0]).toMatchObject({ tabs: ['inspector'], x: 40, y: 50 });
    expect(l.regions.right.map((g) => g.tabs)).toEqual([['scenes']]);
    l = dockFloat(l, l.floats[0].id, P);
    expect(l.floats).toEqual([]);
    expect(locate(l, 'inspector')?.region).toBe('right');
  });

  it('reorders within a group and never loses or duplicates a panel', () => {
    let l = defaultLayout(P);
    const g = l.regions.left[0];
    l = moveTab(l, 'scenes', { type: 'tabs', groupId: g.id, index: 0 });
    expect(l.regions.left[0]?.tabs).toEqual(['scenes', 'add']);
    const ids = allGroups(l)
      .flatMap((x) => x.tabs)
      .sort();
    expect(ids).toEqual(P.map((p) => p.id).sort());
  });

  it('removes emptied groups and repairs foreign layouts', () => {
    let l = defaultLayout(P);
    l = moveTab(l, 'energy', { type: 'region', region: 'right' });
    expect(l.regions.bottom).toEqual([]);
    const broken = parseLayout({
      version: 1,
      regions: { left: [{ id: 'g9', tabs: ['gone', 'add', 'add'], active: 'nope', weight: -3 }], right: 'x' },
      floats: [{ id: 'g3', tabs: ['scenes'], active: 'scenes', x: 'a', w: 5, h: 5 }],
    });
    const fixed = reconcile(broken ?? fail(), P);
    expect(fixed.regions.left[0]?.tabs).toEqual(['add']);
    expect(fixed.regions.left[0]?.weight).toBeGreaterThan(0);
    expect(fixed.floats[0]?.w).toBeGreaterThanOrEqual(220);
    expect(
      allGroups(fixed)
        .flatMap((x) => x.tabs)
        .sort(),
    ).toEqual(P.map((p) => p.id).sort());
    expect(parseLayout({ version: 2 })).toBeNull();
  });

  it('raises floats and activates tabs', () => {
    let l = moveTab(defaultLayout(P), 'add', { type: 'float', x: 0, y: 0 });
    l = moveTab(l, 'energy', { type: 'float', x: 10, y: 10 });
    const [a, b] = l.floats;
    expect(b.z).toBeGreaterThan(a.z);
    l = raiseFloat(l, a.id);
    expect(l.floats[0].z).toBeGreaterThan(l.floats[1].z);
    l = setActive(l, 'outliner');
    expect(locate(l, 'outliner')?.group.active).toBe('outliner');
  });

  it('builds the built-in presets even when their panels are missing', () => {
    for (const p of BUILTIN_PRESETS) {
      const l = layoutFromPreset(p.spec, P);
      expect(
        allGroups(l)
          .flatMap((x) => x.tabs)
          .sort(),
      ).toEqual(P.map((x) => x.id).sort());
    }
    const build = layoutFromPreset(BUILTIN_PRESETS[0].spec, P);
    expect(build.regions.right.map((g) => g.tabs)).toEqual([['inspector'], ['outliner']]);
  });
});

function fail(): never {
  throw new Error('unexpected');
}
