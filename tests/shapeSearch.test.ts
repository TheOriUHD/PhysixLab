/**
 * Package SH, chunk 2 — SH-13: the shape palette’s search and grouping (`src/ui/shapeSearch.ts`) over the real
 * registry, the 1–9 shortcuts it must leave alone, and the thumbnail cache.
 */
import { describe, expect, it } from 'vitest';
import { builtinCommands } from '../src/app/builtin/commands';
import { listShapes } from '../src/model/shapeRegistry';
import { ThumbCache, type ThumbStorage } from '../src/render/thumbCache';
import { CATEGORY_ORDER, groupByCategory, searchShapes } from '../src/ui/shapeSearch';

const defs = listShapes();
const ids = (q: string) => searchShapes(defs, q).map((h) => h.def.id);

describe('shape search (SH-13)', () => {
  it('an empty query lists every shape in registry order (so the number keys still match the first nine)', () => {
    const all = searchShapes(defs, '');
    expect(all.map((h) => h.def.id)).toEqual(defs.map((d) => d.id));
    expect(all.slice(0, 9).map((h) => h.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(searchShapes(defs, '   ')).toHaveLength(defs.length);
  });

  it('finds shapes by name, id, category, keyword and description', () => {
    expect(ids('torus')[0]).toBe('torus');
    expect(ids('donut')).toContain('torus'); // keyword
    expect(ids('ball')[0]).toBe('sphere');
    expect(ids('girder')).toEqual(expect.arrayContaining(['i-beam', 'l-beam', 't-beam']));
    expect(ids('mechanical')).toEqual(expect.arrayContaining(['gear', 'wheel']));
    expect(ids('cog')[0]).toBe('gear');
    expect(ids('tyre')).toEqual(expect.arrayContaining(['wheel', 'torus']));
  });

  it('dice: every die answers to “dice”, and “d20” puts the d20 first', () => {
    expect(ids('dice')).toEqual(expect.arrayContaining(['d4', 'd6', 'd8', 'd10', 'd12', 'd20']));
    expect(ids('d20')[0]).toBe('d20');
    expect(ids('d6')[0]).toBe('d6');
    expect(ids('roll')).toEqual(expect.arrayContaining(['d6', 'd20']));
  });

  it('ramps: the curved ramps and the wedge answer to “ramp”', () => {
    expect(ids('ramp')).toEqual(expect.arrayContaining(['curved-ramp', 'quarter-pipe', 'wedge']));
    expect(ids('skate')).toEqual(expect.arrayContaining(['half-pipe', 'quarter-pipe']));
  });

  it('every word must match: “rounded box” finds the rounded box, “rounded zzz” nothing', () => {
    expect(ids('rounded box')[0]).toBe('rounded-box');
    expect(ids('rounded zzz')).toEqual([]);
    expect(ids('qwxzv')).toEqual([]);
  });

  it('is forgiving: case, partial words and a missing letter still find the shape', () => {
    expect(ids('TORUS')[0]).toBe('torus');
    expect(ids('tor')[0]).toBe('torus');
    expect(ids('elipsoid')).toContain('ellipsoid');
    expect(ids('dodeca')[0]).toBe('dodecahedron');
    expect(ids('stair')).toEqual(expect.arrayContaining(['stairs', 'spiral-stairs']));
  });

  it('exact names beat partial matches', () => {
    expect(ids('box')[0]).toBe('box');
    expect(ids('sphere')[0]).toBe('sphere');
    expect(ids('cone')[0]).toBe('cone');
    expect(ids('ring')[0]).toBe('ring');
  });

  it('groups by category in palette order, keeping the registry order inside each group', () => {
    const groups = groupByCategory(searchShapes(defs, ''));
    expect(groups.map((g) => g.category)).toEqual(CATEGORY_ORDER.filter((c) => defs.some((d) => d.category === c)));
    let total = 0;
    for (const g of groups) {
      total += g.hits.length;
      const idx = g.hits.map((h) => h.index);
      expect(idx).toEqual([...idx].sort((a, b) => a - b));
      expect(g.hits.every((h) => h.def.category === g.category)).toBe(true);
    }
    expect(total).toBe(defs.length);
    expect(groups.map((g) => g.label)).toEqual(['Basic', 'Structural', 'Mechanical', 'Solids', 'Special']);
  });

  it('categories: dice are Special, gear and wheel Mechanical, the regular solids Solids', () => {
    const cat = (id: string) => defs.find((d) => d.id === id)?.category;
    for (const d of ['d4', 'd6', 'd8', 'd10', 'd12', 'd20']) expect(cat(d)).toBe('special');
    expect(cat('gear')).toBe('mechanical');
    expect(cat('wheel')).toBe('mechanical');
    for (const s of ['tetrahedron', 'octahedron', 'dodecahedron', 'icosahedron', 'pyramid'])
      expect(cat(s)).toBe('solids');
  });

  it('every shape can be found by its own name', () => {
    for (const d of defs) expect(ids(d.label), d.id).toContain(d.id);
  });
});

class MemoryStorage implements ThumbStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

describe('thumbnail cache (SH-13)', () => {
  const URL = 'data:image/webp;base64,AAAA';

  it('returns what was stored, from memory and — in a new session — from storage', () => {
    const storage = new MemoryStorage();
    const a = new ThumbCache(storage);
    expect(a.get('box', 'f1')).toBeNull();
    a.set('box', 'f1', URL);
    expect(a.get('box', 'f1')).toBe(URL);
    const b = new ThumbCache(storage); // a later page load
    expect(b.get('box', 'f1')).toBe(URL);
  });

  it('a changed fingerprint (the shape or the thumbnail style changed) is a miss and drops the stale entry', () => {
    const storage = new MemoryStorage();
    new ThumbCache(storage).set('box', 'v1', URL);
    const next = new ThumbCache(storage);
    expect(next.get('box', 'v2')).toBeNull();
    expect(storage.data.size).toBe(0);
    const mem = new ThumbCache(null);
    mem.set('box', 'v1', URL);
    expect(mem.get('box', 'v2')).toBeNull();
  });

  it('survives corrupt entries, foreign data and a storage that throws', () => {
    const storage = new MemoryStorage();
    storage.setItem('physixlab.thumb.box', '{not json');
    storage.setItem('physixlab.thumb.sphere', JSON.stringify({ f: 'x', u: 'javascript:alert(1)' }));
    const c = new ThumbCache(storage);
    expect(c.get('box', 'x')).toBeNull();
    expect(c.get('sphere', 'x')).toBeNull();
    const full: ThumbStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => undefined,
    };
    const d = new ThumbCache(full);
    d.set('box', 'x', URL); // quota: stays in memory
    expect(d.get('box', 'x')).toBe(URL);
    expect(new ThumbCache(full).get('box', 'x')).toBeNull();
  });
});

describe('command palette (SH-13)', () => {
  it('“Add …” commands carry the shape’s search words, so Ctrl+K finds “dice”, “donut” and “cog”', () => {
    const cmds = new Map(builtinCommands().map((c) => [c.id, c]));
    expect(cmds.get('add.shape.d20')?.keywords).toContain('dice');
    expect(cmds.get('add.shape.torus')?.keywords).toContain('donut');
    expect(cmds.get('add.shape.gear')?.keywords).toContain('cog');
    // the first nine keep their number keys
    expect(cmds.get('add.shape.box')?.shortcut).toBe('1');
    expect(cmds.get('add.shape.torus')?.shortcut).toBe('9');
    expect(cmds.get('add.shape.d20')?.shortcut).toBeUndefined();
  });
});
