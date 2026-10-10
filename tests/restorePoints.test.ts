import { describe, expect, it } from 'vitest';
import { MemoryBackend } from '../src/app/storage';
import { diffDocuments } from '../src/app/storage/docDiff';
import { RestorePoints, riskyOperation, setRiskyOperationHook } from '../src/app/storage/restorePoints';
import { createBody, newDocument } from '../src/model/factory';

const docWith = (n: number, name = 'S') => {
  const d = newDocument(name);
  d.entities = Array.from({ length: n }, (_, i) => createBody({ name: `b${i}`, position: [i, 1, 0] }));
  return d;
};

describe('restore points (DT-11)', () => {
  it('creates, lists newest first, loads, deletes; identical auto snapshots are skipped', async () => {
    const rp = new RestorePoints(new MemoryBackend());
    await rp.init();
    const d1 = docWith(2);
    const a = await rp.create(d1, 'first', 'auto', undefined, 1000);
    expect(a).not.toBeNull();
    expect(await rp.create(d1, 'dup', 'auto', undefined, 2000)).toBeNull();
    const m = await rp.create(d1, 'manual dup is kept', 'manual', 'data:image/png;base64,AA', 3000);
    expect(m?.kind).toBe('manual');
    const list = await rp.list();
    expect(list.map((p) => p.label)).toEqual(['manual dup is kept', 'first']);
    expect((await rp.load(a!.id))?.entities.length).toBe(2);
    expect(await rp.thumbnail(m!.id)).toBe('data:image/png;base64,AA');
    await rp.delete(a!.id);
    expect(await rp.load(a!.id)).toBeNull();
  });

  it('prunes by kind count and total size, never the manual or newest point first', async () => {
    const rp = new RestorePoints(new MemoryBackend());
    await rp.init();
    await rp.saveSettings({ maxAuto: 3, maxBefore: 2 });
    for (let i = 0; i < 6; i++) await rp.create(docWith(i + 1), `a${i}`, 'auto', undefined, 1000 + i);
    for (let i = 0; i < 4; i++) await rp.create(docWith(i + 10), `b${i}`, 'before', undefined, 2000 + i);
    await rp.create(docWith(30), 'keep', 'manual', undefined, 500);
    const list = await rp.list();
    expect(list.filter((p) => p.kind === 'auto').map((p) => p.label)).toEqual(['a5', 'a4', 'a3']);
    expect(list.filter((p) => p.kind === 'before').map((p) => p.label)).toEqual(['b3', 'b2']);
    expect(list.some((p) => p.label === 'keep')).toBe(true);
    // size cap: shrink to ~ one point; automatic ones go first, manual survives
    const sizes = list.map((p) => p.bytes);
    await rp.saveSettings({ maxBytes: Math.max(...sizes) + 1 });
    await rp.prune();
    const after = await rp.list();
    expect(after.length).toBeLessThan(list.length);
    expect(after.some((p) => p.label === 'keep') || after[0].at === list[0].at).toBe(true);
  });

  it('settings are sanitised and persisted', async () => {
    const st = new MemoryBackend();
    const rp = new RestorePoints(st);
    await rp.init();
    await rp.saveSettings({ autoMinutes: 9999, maxAuto: -3, enabled: false });
    expect(rp.settings).toMatchObject({ autoMinutes: 120, maxAuto: 1, enabled: false });
    const rp2 = new RestorePoints(st);
    await rp2.init();
    expect(rp2.settings.enabled).toBe(false);
    expect(await rp2.create(docWith(1), 'x', 'auto')).toBeNull(); // disabled: no automatic points
    expect(await rp2.create(docWith(1), 'x', 'manual')).not.toBeNull();
  });

  it('diff summary and the risky-operation hook', () => {
    const a = docWith(3);
    const b = structuredClone(a);
    b.entities.pop();
    b.entities.push(createBody({ name: 'new' }));
    b.entities[0] = { ...b.entities[0], name: 'b0-renamed' };
    const d = diffDocuments(a, b);
    expect(d.added).toEqual(['new']);
    expect(d.removed).toEqual(['b2']);
    expect(d.changed).toEqual(['b0-renamed']);
    expect(d.summary).toBe('+1 added, −1 removed, 1 changed');
    expect(diffDocuments(a, a).summary).toBe('identical');
    const seen: string[] = [];
    setRiskyOperationHook((l) => seen.push(l));
    riskyOperation('Before loading X');
    setRiskyOperationHook(null);
    riskyOperation('ignored');
    expect(seen).toEqual(['Before loading X']);
  });
});
