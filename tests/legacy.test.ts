import { describe, expect, it } from 'vitest';
import { migrateLegacyStorage } from '../src/app/storage/legacyStorage';
import { isFormat, legacyFormat } from '../src/model/legacy';
import { SCENE_FORMAT, migrateDocument } from '../src/model/migrations';
import { sniffJsonKind } from '../src/ui/qol/dropKinds';
import { parseManifest } from '../src/plugins/manifest';

class MemoryStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  keys() {
    return [...this.m.keys()].sort();
  }
}

describe('files and settings written under the old "PhysicsLab" name', () => {
  it('maps format markers to their pre-rename spelling', () => {
    expect(legacyFormat('physixlab-scene')).toBe('physicslab-scene');
    expect(isFormat('physicslab-replay', 'physixlab-replay')).toBe(true);
    expect(isFormat('physixlab-replay', 'physixlab-replay')).toBe(true);
    expect(isFormat('something-else', 'physixlab-replay')).toBe(false);
    expect(isFormat(undefined, 'physixlab-replay')).toBe(false);
  });

  it('opens an old scene file and re-stamps it with the new format', () => {
    const old = { format: 'physicslab-scene', version: 1, name: 'Old', settings: {}, entities: [], assets: {} };
    const doc = migrateDocument(old);
    expect(doc.format).toBe(SCENE_FORMAT);
    expect(doc.name).toBe('Old');
    expect(() => migrateDocument({ ...old, format: 'nope' })).toThrow(/Not a PhysixLab scene file/);
  });

  it('classifies old replay and prefab-pack files when dropped', () => {
    expect(sniffJsonKind(JSON.stringify({ format: 'physicslab-replay' }))).toBe('replay');
    expect(sniffJsonKind(JSON.stringify({ format: 'physicslab-prefabs' }))).toBe('prefabPack');
  });

  it('still reads plugins with the old manifest tag', () => {
    const src =
      '/* @physicslab-plugin\n{ "id": "old-one", "name": "Old", "version": "1.0.0", "permissions": ["ui"] }\n*/\n';
    expect(parseManifest(src).id).toBe('old-one');
    expect(parseManifest(src.replace('physicslab', 'physixlab')).id).toBe('old-one');
  });

  it('copies saved browser data to the new keys once, without clobbering newer data', () => {
    const s = new MemoryStorage();
    s.setItem('physicslab:autosave:v1', 'A');
    s.setItem('physicslab.guide.v1', 'G');
    s.setItem('physicslab:prefs:v1', 'old-prefs');
    s.setItem('physixlab:prefs:v1', 'new-prefs');
    s.setItem('unrelated', 'x');
    expect(migrateLegacyStorage(s)).toBe(3);
    expect(s.getItem('physixlab:autosave:v1')).toBe('A');
    expect(s.getItem('physixlab.guide.v1')).toBe('G');
    expect(s.getItem('physixlab:prefs:v1')).toBe('new-prefs');
    expect(s.keys()).toEqual(['physixlab.guide.v1', 'physixlab:autosave:v1', 'physixlab:prefs:v1', 'unrelated']);
    expect(migrateLegacyStorage(s)).toBe(0);
  });
});
