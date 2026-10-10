/**
 * The command palette without a DOM: fuzzy matching (checked against brute force), ranking, the recent-items memory
 * and the items collected from the registries.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app/app';
import { registerAppBuiltins } from '../src/app/builtin';
import { PrefsStore } from '../src/app/prefs';
import { registerCommand } from '../src/app/registry/commands';
import { createBody } from '../src/model/factory';
import { SceneStore } from '../src/model/store';
import { registerUiBuiltins } from '../src/ui/builtin';
import { alignmentScore, fuzzyMatch } from '../src/ui/palette/fuzzy';
import { PaletteHistory, type KeyValueStore } from '../src/ui/palette/history';
import { buildPaletteItems } from '../src/ui/palette/items';
import { rankItems, type Searchable } from '../src/ui/palette/search';

/** Highest alignment score over every placement of the query in the text — the definition the DP must meet. */
function bruteForce(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let best: number | null = null;
  const walk = (i: number, from: number, picked: number[]) => {
    if (i === q.length) {
      const s = alignmentScore(query, text, picked);
      if (best === null || s > best) best = s;
      return;
    }
    for (let j = from; j < t.length; j++) if (t[j] === q[i]) walk(i + 1, j + 1, [...picked, j]);
  };
  walk(0, 0, []);
  return best;
}

/** Small seeded generator (mulberry32) so the property tests are reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('fuzzy matching', () => {
  it('matches subsequences case-insensitively and rejects everything else', () => {
    expect(fuzzyMatch('grav', 'Gravity: Moon')).not.toBeNull();
    expect(fuzzyMatch('GRAV', 'gravity')).not.toBeNull();
    expect(fuzzyMatch('gvt', 'Gravity')).not.toBeNull();
    expect(fuzzyMatch('xyz', 'Gravity')).toBeNull();
    expect(fuzzyMatch('ytivarg', 'Gravity')).toBeNull(); // order matters
    expect(fuzzyMatch('aa', 'a')).toBeNull(); // not enough characters
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, ranges: [] });
  });

  it('reports the matched stretches for highlighting, merged when adjacent', () => {
    expect(fuzzyMatch('grav', 'Gravity')!.ranges).toEqual([[0, 4]]);
    // Word starts beat the first occurrences: "sg" in "Snap grid size" is S(0) and g(5), not s(2)…
    const m = fuzzyMatch('sg', 'Snap grid size')!;
    expect(m.ranges).toEqual([
      [0, 1],
      [5, 6],
    ]);
    expect(fuzzyMatch('undo', 'Undo Move')!.ranges).toEqual([[0, 4]]);
    expect(fuzzyMatch('um', 'Undo Move')!.ranges).toEqual([
      [0, 1],
      [5, 6],
    ]);
  });

  it('prefers prefixes, word starts and runs over scattered letters', () => {
    const score = (q: string, t: string) => fuzzyMatch(q, t)!.score;
    expect(score('ro', 'Rotate')).toBeGreaterThan(score('ro', 'Group'));
    expect(score('mo', 'Move')).toBeGreaterThan(score('mo', 'Scattered motion'));
    expect(score('ca', 'Camera')).toBeGreaterThan(score('ca', 'Face a motor'));
    expect(score('fs', 'Frame selection')).toBeGreaterThan(score('fs', 'Life is short'));
    expect(score('vec', 'Velocity vectors')).toBeGreaterThan(score('vec', 'Overlay: velocity effects'));
    // A longer text with the same match scores a little lower.
    expect(score('undo', 'Undo')).toBeGreaterThan(score('undo', 'Undo Add Crate'));
  });

  it('finds the optimal alignment: the dynamic programme equals brute force on random strings', () => {
    const r = rng(7);
    const alphabet = 'abcab AB-_x';
    const make = (n: number) => Array.from({ length: n }, () => alphabet[Math.floor(r() * alphabet.length)]).join('');
    let compared = 0;
    for (let i = 0; i < 1500; i++) {
      const text = make(1 + Math.floor(r() * 12));
      const query = make(1 + Math.floor(r() * 4)).replace(/ /g, 'a');
      const want = bruteForce(query, text);
      const got = fuzzyMatch(query, text);
      if (want === null) expect(got, `${query} in ${text}`).toBeNull();
      else {
        expect(got, `${query} in ${text}`).not.toBeNull();
        // The programme's score is the alignment's score — and its ranges are a real placement of the query.
        expect(got!.score).toBeCloseTo(want, 9);
        const placed = got!.ranges.flatMap(([a, b]) => text.slice(a, b).toLowerCase().split(''));
        expect(placed.join('')).toBe(query.toLowerCase());
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(300);
  });
});

describe('ranking', () => {
  const item = (id: string, label: string, over: Partial<Searchable> = {}): Searchable => ({
    id,
    label,
    keywords: [],
    group: 'Test',
    ...over,
  });
  const items = [
    item('a', 'Gravity: Earth'),
    item('b', 'Graphics quality: Low'),
    item('c', 'Add Sphere', { keywords: ['ball', 'round'] }),
    item('d', 'Velocity vectors', {
      keywords: ['arrows'],
      group: 'View',
      detail: 'Arrows showing how fast each body moves',
    }),
    item('e', 'Undo'),
  ];
  const ids = (q: string, recent: string[] = []) => rankItems(items, q, recent).map((r) => r.item.id);

  it('keeps everything in order for an empty query, recent items first (newest first)', () => {
    expect(ids('')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(ids('', ['d', 'b'])).toEqual(['d', 'b', 'a', 'c', 'e']);
    const r = rankItems(items, '', ['d']);
    expect(r[0].recent).toBe(true);
    expect(r[1].recent).toBe(false);
  });

  it('ranks the better match first and drops what does not match', () => {
    expect(ids('grav')[0]).toBe('a');
    expect(ids('gra')).toEqual(['a', 'b']);
    expect(ids('zzz')).toEqual([]);
    expect(ids('undo')).toEqual(['e']);
  });

  it('finds an item through its keywords, group or description, but ranks a label hit above them', () => {
    expect(ids('ball')).toEqual(['c']);
    expect(ids('arrows')).toEqual(['d']);
    expect(ids('fast each')).toEqual(['d']);
    const withLabelHit = [item('x', 'Ball pit'), item('y', 'Add Sphere', { keywords: ['ball'] })];
    expect(rankItems(withLabelHit, 'ball', []).map((r) => r.item.id)).toEqual(['x', 'y']);
  });

  it('does not let scattered letters match long descriptions — only the word itself counts there', () => {
    const wordy = [
      item('g', 'Group selection', {
        detail: 'Fold the selection into a group that moves as one; with nothing selected, add an empty group',
      }),
      item('h', 'Billiards', { detail: 'Near-elastic collisions in zero gravity — momentum is conserved.' }),
    ];
    // g…r…a…v…i…t…y can be picked out of the first sentence letter by letter, but it is not about gravity.
    expect(rankItems(wordy, 'gravity', []).map((r) => r.item.id)).toEqual(['h']);
    expect(rankItems(wordy, 'grav', []).map((r) => r.item.id)).toEqual(['h']);
    // Labels keep the forgiving match.
    expect(rankItems(wordy, 'gsel', []).map((r) => r.item.id)).toEqual(['g']);
    // A word at the start of a word in a keyword beats the same letters inside one.
    const kw = [item('x', 'Alpha', { keywords: ['xball'] }), item('y', 'Beta', { keywords: ['ball'] })];
    expect(rankItems(kw, 'ball', []).map((r) => r.item.id)).toEqual(['y', 'x']);
  });

  it('requires every word of the query to match', () => {
    expect(ids('gravity earth')).toEqual(['a']);
    expect(ids('gravity moon')).toEqual([]);
    expect(ids('  grav   earth ')).toEqual(['a']);
  });

  it('highlights only label matches, merged across words', () => {
    const r = rankItems(items, 'gra ear', [])[0];
    expect(r.item.id).toBe('a');
    expect(r.ranges).toEqual([
      [0, 3],
      [9, 12],
    ]);
    const viaKeyword = rankItems(items, 'ball', [])[0];
    expect(viaKeyword.ranges).toEqual([]);
  });

  it('lets a recent item win a near-tie but not beat a clearly better match', () => {
    const tie = [item('p', 'Graphics quality: Low'), item('q', 'Graphics quality: High')];
    expect(rankItems(tie, 'graphics', ['q']).map((r) => r.item.id)).toEqual(['q', 'p']);
    expect(rankItems(tie, 'graphics', []).map((r) => r.item.id)).toEqual(['p', 'q']);
    // A recent item that matches only through a keyword does not beat a label match.
    const clear = [item('p', 'Gravity'), item('q', 'Something else', { keywords: ['gravity'] })];
    expect(rankItems(clear, 'gravity', ['q'])[0].item.id).toBe('p');
  });

  it('caps the result list', () => {
    const many = Array.from({ length: 300 }, (_, i) => item(`i${i}`, `Item ${i}`));
    expect(rankItems(many, 'item', [])).toHaveLength(80);
  });
});

describe('recent items memory', () => {
  const fake = (): KeyValueStore & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  };

  it('keeps the newest first, without duplicates, up to the limit', () => {
    const h = new PaletteHistory(fake(), 3);
    expect(h.list()).toEqual([]);
    for (const id of ['a', 'b', 'c']) h.record(id);
    expect(h.list()).toEqual(['c', 'b', 'a']);
    h.record('a');
    expect(h.list()).toEqual(['a', 'c', 'b']);
    h.record('d');
    expect(h.list()).toEqual(['d', 'a', 'c']);
  });

  it('survives a reload (a second instance over the same storage) and damaged or missing storage', () => {
    const s = fake();
    new PaletteHistory(s).record('x');
    expect(new PaletteHistory(s).list()).toEqual(['x']);
    s.setItem('physicslab:palette-recent:v1', '{"not":"a list"}');
    expect(new PaletteHistory(s).list()).toEqual([]);
    s.setItem('physicslab:palette-recent:v1', 'garbage');
    expect(new PaletteHistory(s).list()).toEqual([]);
    s.setItem('physicslab:palette-recent:v1', JSON.stringify(['ok', 3, null, 'fine']));
    expect(new PaletteHistory(s).list()).toEqual(['ok', 'fine']);
    expect(new PaletteHistory(null).list()).toEqual([]);
    expect(() => new PaletteHistory(null).record('y')).not.toThrow();
    const throwing: KeyValueStore = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(new PaletteHistory(throwing).list()).toEqual([]);
    expect(() => new PaletteHistory(throwing).record('z')).not.toThrow();
  });
});

describe('palette items come from the registries', () => {
  beforeAll(() => {
    registerAppBuiltins();
    registerUiBuiltins();
  });

  const app = () => {
    const store = new SceneStore();
    return {
      app: {
        store,
        prefs: new PrefsStore(),
        sim: { active: false, mode: 'edit' },
        persistence: { library: () => [] },
      } as unknown as App,
      store,
    };
  };

  it('offers commands, settings, examples, prefabs and maps — and nothing that cannot run now', () => {
    const { app: a, store } = app();
    const items = buildPaletteItems(a);
    const kinds = new Set(items.map((i) => i.kind));
    for (const k of ['command', 'setting', 'example', 'prefab', 'map']) expect(kinds.has(k as 'command'), k).toBe(true);
    const label = (id: string) => items.find((i) => i.id === id)?.label;
    expect(label('cmd:edit.undo'), 'Undo is disabled without history').toBeUndefined();
    expect(label('cmd:sim.reset'), 'Reset needs a simulation').toBeUndefined();
    expect(label('cmd:edit.delete'), 'Delete needs a selection').toBeUndefined();
    expect(label('cmd:sim.toggle')).toBe('Simulate');
    expect(label('example:car')).toBe('Drivable car');
    expect(label('prefab:pendulum')).toBe('Pendulum');
    expect(label('map:empty-arena')).toBe('Empty arena');
    expect(
      items.find((i) => i.id === 'cmd:app.palette'),
      'the palette does not list itself',
    ).toBeUndefined();
    const b = createBody({ name: 'Crate', shape: { type: 'box' } });
    store.add([b], 'Add Crate');
    store.setSelection([b.id]);
    const after = buildPaletteItems(a);
    expect(after.find((i) => i.id === 'cmd:edit.undo')?.label).toBe('Undo Add Crate');
    expect(after.find((i) => i.id === 'cmd:edit.delete')).toBeDefined();
  });

  it('shows settings with their state and the shortcut of commands in display form', () => {
    const { app: a } = app();
    const items = buildPaletteItems(a);
    const grav = items.filter((i) => i.id.startsWith('cmd:world.gravity.'));
    expect(grav).toHaveLength(5);
    expect(grav.every((g) => g.kind === 'setting' && g.group === 'Settings')).toBe(true);
    expect(grav.find((g) => g.id.endsWith('.earth'))?.state).toBe('On');
    expect(grav.find((g) => g.id.endsWith('.moon'))?.state).toBe('Off');
    expect(items.find((i) => i.id === 'cmd:sim.toggle')?.shortcut).toBe('Space');
    expect(items.find((i) => i.id === 'cmd:view.snap')?.shortcut).toBe('G');
  });

  it('typing "gravity" finds the gravity presets first', () => {
    const { app: a } = app();
    const ranked = rankItems(buildPaletteItems(a), 'gravity', []);
    expect(ranked.slice(0, 5).every((r) => r.item.id.startsWith('cmd:world.gravity.'))).toBe(true);
    expect(ranked[0].ranges.length).toBeGreaterThan(0);
  });

  it('typing a scene, prefab, map or setting name finds that', () => {
    const { app: a } = app();
    const items = buildPaletteItems(a);
    expect(rankItems(items, 'cradle', [])[0].item.id).toBe('example:cradle');
    expect(rankItems(items, 'pendulum', [])[0].item.kind).toBe('prefab');
    expect(rankItems(items, 'sandbox', [])[0].item.id).toBe('map:sandbox-box');
    expect(rankItems(items, 'velocity vec', [])[0].item.id).toBe('cmd:view.overlay.velocity');
    expect(
      rankItems(items, 'snap grid', [])
        .slice(0, 2)
        .map((r) => r.item.id)
        .sort(),
    ).toEqual(['cmd:view.snap', 'cmd:view.snapGrid']);
  });

  it('a command registered later is found, with its keywords', () => {
    const { app: a } = app();
    const off = registerCommand({
      id: 'test.palette',
      label: 'Revert everything',
      category: 'Test',
      keywords: ['undo all'],
      run: () => undefined,
    });
    const found = rankItems(buildPaletteItems(a), 'undo all', []);
    expect(found[0].item.id).toBe('cmd:test.palette');
    off();
    expect(buildPaletteItems(a).some((i) => i.id === 'cmd:test.palette')).toBe(false);
  });
});
