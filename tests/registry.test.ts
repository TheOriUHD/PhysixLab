import { describe, expect, it } from 'vitest';
import { Registry, type RegistryChange } from '../src/core/registry';

interface Def {
  id: string;
  order?: number;
  label?: string;
}

const make = (validate?: (d: Def) => void) =>
  new Registry<Def>({ kind: 'widget', order: (d) => d.order ?? 0, validate });

describe('Registry', () => {
  it('registers, finds and lists in registration order', () => {
    const r = make();
    r.register({ id: 'a' });
    r.register({ id: 'b' });
    r.register({ id: 'c' });
    expect(r.list().map((d) => d.id)).toEqual(['a', 'b', 'c']);
    expect(r.get('b')?.id).toBe('b');
    expect(r.has('c')).toBe(true);
    expect(r.has('zzz')).toBe(false);
    expect(r.get('zzz')).toBeUndefined();
    expect(r.size).toBe(3);
  });

  it('sorts by order and keeps registration order for ties', () => {
    const r = make();
    r.register({ id: 'late', order: 30 });
    r.register({ id: 'first-tie', order: 10 });
    r.register({ id: 'second-tie', order: 10 });
    r.register({ id: 'early', order: 5 });
    expect(r.list().map((d) => d.id)).toEqual(['early', 'first-tie', 'second-tie', 'late']);
  });

  it('refuses duplicate ids and malformed ids with a message that names the kind', () => {
    const r = make();
    r.register({ id: 'dup' });
    expect(() => r.register({ id: 'dup' })).toThrow(/widget "dup" is already registered/);
    for (const bad of ['', 'Upper', '1abc', 'has space', 'trailing.', '.lead', 'a..b', 'a/b'])
      expect(() => r.register({ id: bad }), `"${bad}"`).toThrow(/Invalid widget id/);
    for (const good of ['a', 'edit.undo', 'view.snapGrid', 'empty-arena', 'map_1', 'a1.b2-c3_d4'])
      expect(() => make().register({ id: good }), good).not.toThrow();
  });

  it('runs the validate hook before anything is stored', () => {
    const r = make((d) => {
      if (!d.label) throw new Error('widget needs a label');
    });
    expect(() => r.register({ id: 'x' })).toThrow('widget needs a label');
    expect(r.has('x')).toBe(false);
    expect(r.revision).toBe(0);
    r.register({ id: 'x', label: 'X' });
    expect(r.has('x')).toBe(true);
  });

  it('unregisters, by id and with the disposer, and the disposer only removes its own registration', () => {
    const r = make();
    const off = r.register({ id: 'a' });
    expect(r.unregister('a')).toBe(true);
    expect(r.unregister('a')).toBe(false);
    // Someone else takes the id after the first owner left: the first owner's disposer must not remove it.
    const replacement = { id: 'a', label: 'new owner' };
    r.register(replacement);
    off();
    expect(r.get('a')).toBe(replacement);
    const off2 = r.register({ id: 'b' });
    off2();
    off2();
    expect(r.has('b')).toBe(false);
  });

  it('emits change events and a revision that moves with the list', () => {
    const r = make();
    const seen: RegistryChange[] = [];
    const off = r.onChange((c) => seen.push(c));
    const rev0 = r.revision;
    const first = r.list();
    r.register({ id: 'a' });
    r.register({ id: 'b' });
    r.unregister('a');
    r.unregister('missing');
    expect(seen).toEqual([
      { type: 'register', id: 'a' },
      { type: 'register', id: 'b' },
      { type: 'unregister', id: 'a' },
    ]);
    expect(r.revision).toBe(rev0 + 3);
    expect(r.list()).not.toBe(first);
    off();
    r.register({ id: 'c' });
    expect(seen).toHaveLength(3);
  });

  it('caches the sorted list until something changes', () => {
    const r = make();
    r.register({ id: 'a' });
    expect(r.list()).toBe(r.list());
    const before = r.list();
    r.register({ id: 'b' });
    expect(r.list()).not.toBe(before);
    expect(before.map((d) => d.id)).toEqual(['a']);
  });

  it('lets a listener unsubscribe or register while it is being notified', () => {
    const r = make();
    const log: string[] = [];
    const off = r.onChange((c) => {
      log.push(c.id);
      off();
      if (c.id === 'a') r.register({ id: 'from-listener' });
    });
    r.register({ id: 'a' });
    expect(log).toEqual(['a']);
    expect(r.has('from-listener')).toBe(true);
  });
});
