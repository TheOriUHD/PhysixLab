import { describe, expect, it } from 'vitest';
import { callbackIds, UiError, validateTree } from '../src/plugins/declarative';
import { ManifestError, MAX_PLUGIN_CHARS, parseManifest } from '../src/plugins/manifest';
import { MemoryPluginStore } from '../src/plugins/store';
import gravity from '../src/plugins/examples/gravity-presets.plugin.mjs?raw';
import domino from '../src/plugins/examples/domino-tools.plugin.mjs?raw';

const wrap = (json: string) => `/* @physicslab-plugin\n${json}\n*/\nplugin.toast('x');`;
const ok = {
  id: 'my-plugin',
  name: 'My plugin',
  version: '1.2.3',
  description: 'd',
  permissions: ['ui', 'scene.read'],
};

describe('DT-31 manifest', () => {
  it('parses the shipped example plugins', () => {
    expect(parseManifest(gravity)).toMatchObject({
      id: 'gravity-presets',
      permissions: ['ui', 'scene.read', 'scene.write'],
    });
    expect(parseManifest(domino).permissions).toContain('view');
  });
  it('accepts a valid manifest and de-duplicates permissions', () => {
    const m = parseManifest(wrap(JSON.stringify({ ...ok, permissions: ['ui', 'ui'] })));
    expect(m.permissions).toEqual(['ui']);
  });
  it('rejects network / storage / DOM permissions and malformed manifests', () => {
    for (const p of ['network', 'storage', 'dom', 'fetch'])
      expect(() => parseManifest(wrap(JSON.stringify({ ...ok, permissions: [p] })))).toThrow(/Unknown permission/);
    expect(() => parseManifest('plugin.toast(1)')).toThrow(ManifestError);
    expect(() => parseManifest(wrap('{ nope'))).toThrow(/valid JSON/);
    expect(() => parseManifest(wrap(JSON.stringify({ ...ok, id: 'Bad Id' })))).toThrow(/manifest.id/);
    expect(() => parseManifest(wrap(JSON.stringify({ ...ok, version: 'one' })))).toThrow(/version/);
    expect(() => parseManifest('')).toThrow(/empty/);
    expect(() => parseManifest(wrap(JSON.stringify(ok)) + 'x'.repeat(MAX_PLUGIN_CHARS))).toThrow(/larger/);
  });
});

describe('DT-31 declarative UI', () => {
  it('normalises a tree and collects callbacks', () => {
    const t = validateTree({
      type: 'column',
      children: [
        { type: 'heading', text: 'Hi' },
        { type: 'button', label: 'Go', onClick: { __cb: 4 } },
        { type: 'number', label: 'n', value: 3, onChange: { __cb: 5 } },
        'plain text',
        null,
      ],
    });
    expect(callbackIds(t)).toEqual([4, 5]);
    expect(JSON.stringify(t)).toContain('plain text');
  });
  it('rejects unknown types, huge or deep trees; strings stay strings', () => {
    expect(() => validateTree({ type: 'script', src: 'x' })).toThrow(UiError);
    expect(() => validateTree(42)).toThrow(UiError);
    let deep: unknown = { type: 'text', text: 'x' };
    for (let i = 0; i < 12; i++) deep = { type: 'column', children: [deep] };
    expect(() => validateTree(deep)).toThrow(/nested/);
    expect(() =>
      validateTree({ type: 'column', children: Array.from({ length: 500 }, () => ({ type: 'divider' })) }),
    ).toThrow(/at most/);
    const t = validateTree({ type: 'text', text: '<img src=x onerror=alert(1)>'.repeat(100) });
    expect((t as { text: string }).text.length).toBeLessThanOrEqual(500);
  });
  it('a callback that is not a function id becomes 0 (inert)', () => {
    const t = validateTree({ type: 'button', label: 'x', onClick: 'alert(1)' });
    expect(callbackIds(t)).toEqual([]);
  });
});

describe('DT-31 store', () => {
  it('round-trips records', () => {
    const s = new MemoryPluginStore();
    s.save([
      {
        manifest: parseManifest(gravity),
        source: gravity,
        enabled: true,
        granted: ['ui'],
        origin: 'example',
        installedAt: 1,
      },
    ]);
    expect(s.load()[0].manifest.id).toBe('gravity-presets');
  });
});
