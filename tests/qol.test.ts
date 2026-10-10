/** UI-41 / UI-42 pure logic: recents, favourites, thumbnails, drop classification, clipboard sniffing, presentation maths. */
import { describe, expect, it } from 'vitest';
import { newDocument } from '../src/model/factory';
import { serializeDocument } from '../src/model/serialize';
import { sniffSceneText } from '../src/ui/qol/clipboardScene';
import {
  classifyByName,
  describeDrag,
  sniffJsonKind,
  unsupportedMessage,
  type DropKind,
} from '../src/ui/qol/dropKinds';
import { FAV_LIMIT, FavouritesStore } from '../src/ui/qol/favourites';
import { ago, RECENT_LIMITS, RecentsStore, sanitizeRecents } from '../src/ui/qol/recents';
import { memoryStorage } from '../src/ui/qol/storage';
import { THUMB_LIMITS, ThumbStore } from '../src/ui/qol/thumbs';
import {
  CAMERA_PRESETS,
  captionOpacity,
  captureFileName,
  effectiveScale,
  fitDistance,
  fovForMm,
  presetPose,
  sanitizePresent,
  turntableStep,
  DEFAULT_PRESENT,
  DOF_PRESETS,
  matchDofPreset,
} from '../src/ui/present/model';

const png = (n: number) => `data:image/png;base64,${'A'.repeat(n)}`;

describe('recent scenes', () => {
  it('lists the newest first and moves a re-opened scene to the top', () => {
    const r = new RecentsStore(memoryStorage());
    r.record({ kind: 'template', id: 'car' }, 'Car', 5, undefined, 100);
    r.record({ kind: 'map', id: 'arena' }, 'Arena', 9, undefined, 200);
    r.record({ kind: 'template', id: 'car' }, 'Car', 5, undefined, 300);
    expect(r.list().map((e) => e.key)).toEqual(['template:car', 'map:arena']);
    expect(r.list()[0].at).toBe(300);
  });

  it('caps the list length', () => {
    const r = new RecentsStore(memoryStorage());
    for (let i = 0; i < RECENT_LIMITS.entries + 7; i++)
      r.record({ kind: 'template', id: `t${i}` }, `T${i}`, 1, undefined, i);
    const list = r.list();
    expect(list).toHaveLength(RECENT_LIMITS.entries);
    expect(list[0].key).toBe(`template:t${RECENT_LIMITS.entries + 6}`);
  });

  it('keeps JSON only for file / paste scenes, only for the newest few, within the character budget', () => {
    const r = new RecentsStore(memoryStorage());
    for (let i = 0; i < 7; i++) r.record({ kind: 'file' }, `f${i}`, 1, `{"entities":[],"i":${i}}`, i);
    const withData = r.list().filter((e) => e.hasData);
    expect(withData).toHaveLength(RECENT_LIMITS.dataEntries);
    expect(withData.map((e) => e.name)).toEqual(['f6', 'f5', 'f4', 'f3']);
    expect(r.dataOf('file:f6')).toContain('"i":6');
    expect(r.dataOf('file:f0')).toBeNull();
    // a template never stores JSON, and a scene over the per-entry cap is listed but not kept
    r.record({ kind: 'template', id: 'car' }, 'Car', 1, '{"entities":[]}');
    expect(r.list()[0].hasData).toBe(false);
    r.record({ kind: 'file' }, 'huge', 1, 'x'.repeat(RECENT_LIMITS.perEntryChars + 1));
    expect(r.list()[0]).toMatchObject({ name: 'huge', hasData: false });
    expect(r.dataOf('file:huge')).toBeNull();
  });

  it('stays within the total budget', () => {
    const r = new RecentsStore(memoryStorage());
    const big = 'x'.repeat(RECENT_LIMITS.perEntryChars - 10);
    for (let i = 0; i < 4; i++) r.record({ kind: 'file' }, `big${i}`, 1, big, i);
    const kept = r.list().filter((e) => e.hasData).length;
    expect(kept * big.length).toBeLessThanOrEqual(RECENT_LIMITS.dataChars);
    expect(kept).toBe(Math.floor(RECENT_LIMITS.dataChars / big.length));
  });

  it('removes and clears', () => {
    const r = new RecentsStore(memoryStorage());
    r.record({ kind: 'template', id: 'a' }, 'A', 1);
    r.record({ kind: 'template', id: 'b' }, 'B', 1);
    r.remove('template:a');
    expect(r.list().map((e) => e.key)).toEqual(['template:b']);
    r.clear();
    expect(r.list()).toEqual([]);
  });

  it('survives damaged storage', () => {
    const s = memoryStorage();
    s.setItem('physicslab:qol:recents:v1', '{not json');
    expect(new RecentsStore(s).list()).toEqual([]);
    s.setItem(
      'physicslab:qol:recents:v1',
      JSON.stringify([{ key: 1 }, null, { key: 'a', name: 'n', source: { kind: 'evil' } }]),
    );
    expect(new RecentsStore(s).list()).toEqual([]);
    expect(sanitizeRecents('nope')).toEqual([]);
  });

  it('formats relative times', () => {
    expect(ago(1000, 1000 + 10_000)).toBe('just now');
    expect(ago(0, 5 * 60_000)).toBe('5 min ago');
    expect(ago(0, 3 * 3_600_000)).toBe('3 h ago');
    expect(ago(0, 2 * 86_400_000)).toBe('2 d ago');
  });
});

describe('favourites', () => {
  it('toggles per kind and persists', () => {
    const s = memoryStorage();
    const f = new FavouritesStore(s);
    expect(f.toggle('template', 'car')).toBe(true);
    expect(f.has('template', 'car')).toBe(true);
    expect(f.has('map', 'car')).toBe(false);
    expect(new FavouritesStore(s).list('template')).toEqual(['car']); // a fresh store reads it back
    expect(f.toggle('template', 'car')).toBe(false);
    expect(f.has('template', 'car')).toBe(false);
  });

  it('notifies listeners and rejects malformed ids', () => {
    const f = new FavouritesStore(memoryStorage());
    const seen: string[] = [];
    f.onChange((k) => seen.push(k));
    f.toggle('shape', 'box');
    expect(seen).toEqual(['shape']);
    expect(f.toggle('shape', '../evil')).toBe(false);
    expect(f.list('shape')).toEqual(['box']);
  });

  it('caps a list and ignores damaged data', () => {
    const s = memoryStorage();
    const f = new FavouritesStore(s);
    for (let i = 0; i < FAV_LIMIT + 5; i++) f.toggle('prefab', `p${i}`);
    expect(f.list('prefab')).toHaveLength(FAV_LIMIT);
    s.setItem('physicslab:qol:favourites:v1', '[1,2');
    expect(f.list('prefab')).toEqual([]);
    s.setItem('physicslab:qol:favourites:v1', JSON.stringify({ map: ['ok', 7, 'Bad Id', 'ok'] }));
    expect(f.list('map')).toEqual(['ok']);
  });
});

describe('thumbnail cache', () => {
  it('stores, replaces and removes', () => {
    const t = new ThumbStore(memoryStorage());
    expect(t.set('template:car', png(10))).toBe(true);
    expect(t.get('template:car')).toBe(png(10));
    t.set('template:car', png(20));
    expect(t.get('template:car')).toBe(png(20));
    t.remove('template:car');
    expect(t.get('template:car')).toBeNull();
  });

  it('refuses non-images and oversize entries, and evicts the oldest within the caps', () => {
    const t = new ThumbStore(memoryStorage());
    expect(t.set('a', 'javascript:alert(1)')).toBe(false);
    expect(t.set('big', png(THUMB_LIMITS.perEntryChars))).toBe(false);
    const size = 10_000;
    const fit = Math.floor(THUMB_LIMITS.totalChars / (size + 22));
    for (let i = 0; i < fit + 5; i++) t.set(`k${i}`, png(size), i);
    expect(t.get('k0')).toBeNull(); // oldest evicted
    expect(t.get(`k${fit + 4}`)).not.toBeNull(); // newest kept
  });
});

describe('dropped files', () => {
  it('classifies by name and type', () => {
    const cases: [string, string, DropKind][] = [
      ['a.physicslab.json', 'application/json', 'json'],
      ['x.png', 'image/png', 'image'],
      ['x.JPG', '', 'image'],
      ['m.obj', '', 'mesh'],
      ['m.glb', 'model/gltf-binary', 'mesh'],
      ['s.wav', 'audio/wav', 'audio'],
      ['run.plreplay', '', 'replay'],
      ['notes.txt', 'text/plain', 'unknown'],
    ];
    for (const [name, mime, kind] of cases) expect(classifyByName(name, mime), name).toBe(kind);
  });

  it('looks inside JSON: scene, replay, prefab pack', () => {
    const doc = serializeDocument(newDocument('Dropped'));
    expect(sniffJsonKind(doc)).toBe('scene');
    expect(sniffJsonKind('{"format":"physicslab-replay","frames":[]}')).toBe('replay');
    expect(sniffJsonKind('{"prefabs":[]}')).toBe('prefabPack');
    expect(sniffJsonKind('{"hello":1}')).toBe('unknown');
    expect(sniffJsonKind('[1,2]')).toBe('unknown');
    expect(sniffJsonKind('{broken')).toBe('unknown');
  });

  it('never promises an import that has no handler', () => {
    const sceneOnly = new Set<DropKind>(['scene']);
    expect(describeDrag([{ kind: 'file', type: 'application/json' }], sceneOnly)).toMatchObject({ ok: true });
    const img = describeDrag([{ kind: 'file', type: 'image/png' }], sceneOnly);
    expect(img.ok).toBe(false);
    expect(img.title).toMatch(/can’t be imported yet/);
    // once another package registers an image importer the same drag is accepted
    expect(describeDrag([{ kind: 'file', type: 'image/png' }], new Set<DropKind>(['scene', 'image'])).ok).toBe(true);
    expect(describeDrag([], sceneOnly).ok).toBe(true);
  });

  it('has honest messages for the kinds nobody imports', () => {
    expect(unsupportedMessage('replay', 'r.json')).toMatch(/Replays aren't supported yet/);
    expect(unsupportedMessage('image', 'p.png')).toMatch(/Images aren't supported yet/);
    expect(unsupportedMessage('mesh', 'm.obj')).toMatch(/Mesh files aren't supported yet/);
    expect(unsupportedMessage('unknown', 'x.bin')).toMatch(/not a PhysicsLab scene/);
  });
});

describe('clipboard sniffing', () => {
  it('recognises a scene and reads its name and size', () => {
    const doc = newDocument('From the clipboard');
    const sniff = sniffSceneText(serializeDocument(doc));
    expect(sniff).toEqual({ name: 'From the clipboard', entities: 0 });
  });

  it('ignores everything else, cheaply', () => {
    for (const t of [
      '',
      'hello world',
      '{"a":1}',
      '[{"entities":[]}]',
      '{"entities": nope',
      '{"entities":5, "padding":"xxxxxxxxxxxx"}',
    ])
      expect(sniffSceneText(t), t).toBeNull();
  });
});

describe('presentation maths', () => {
  it('puts the camera at the preset direction and the fitted distance', () => {
    const front = CAMERA_PRESETS.find((p) => p.id === 'front')!;
    const dist = fitDistance(2, 48);
    const pose = presetPose(front, [1, 2, 3], dist);
    expect(Math.hypot(pose.position[0] - 1, pose.position[1] - 2, pose.position[2] - 3)).toBeCloseTo(dist, 9);
    expect(pose.position[2]).toBeGreaterThan(3); // front = +Z side
    expect(pose.position[0]).toBeCloseTo(1, 9);
    const top = presetPose(
      CAMERA_PRESETS.find((p) => p.id === 'top')!,
      [0, 0, 0],
      10,
    );
    expect(top.position[1]).toBeGreaterThan(9.99);
    const back = presetPose(
      CAMERA_PRESETS.find((p) => p.id === 'back')!,
      [0, 0, 0],
      10,
    );
    expect(back.position[2]).toBeLessThan(0);
  });

  it('fits a sphere in view: the sphere subtends less than the field of view', () => {
    const r = 3,
      fov = 50;
    const d = fitDistance(r, fov);
    expect((2 * Math.atan(r / d) * 180) / Math.PI).toBeLessThan(fov);
  });

  it('turns the camera about the vertical axis through the target, keeping the radius and height', () => {
    const target: [number, number, number] = [1, 0, 1];
    const p: [number, number, number] = [4, 5, 1]; // 3 m from the target along +x
    const q = turntableStep(p, target, 90, 1); // a quarter turn
    expect(q.x).toBeCloseTo(1, 9);
    expect(q.z).toBeCloseTo(4, 9);
    expect(Math.hypot(q.x - 1, q.z - 1)).toBeCloseTo(3, 9);
    const full = turntableStep(p, target, 360, 1);
    expect(full.x).toBeCloseTo(4, 9);
    expect(full.z).toBeCloseTo(1, 9);
  });

  it('maps focal length to field of view (24 mm sensor height)', () => {
    expect(fovForMm(24)).toBeCloseTo(53.13, 1);
    expect(fovForMm(85)).toBeLessThan(fovForMm(35));
  });

  it('reduces a capture that would not fit the GPU, and says so', () => {
    expect(effectiveScale(1600, 900, 2, 8192)).toMatchObject({ scale: 2, width: 3200, height: 1800, reduced: false });
    const big = effectiveScale(3000, 2000, 4, 8192);
    expect(big.reduced).toBe(true);
    expect(big.width).toBeLessThanOrEqual(8192);
    expect(big.width * big.height).toBeLessThanOrEqual(36_000_000);
    const edge = effectiveScale(2500, 800, 4, 8192);
    expect(edge.width).toBeLessThanOrEqual(8192);
    expect(effectiveScale(100, 100, 4, 8192).width).toBe(400);
  });

  it('fades a caption in, holds, fades out; 0 hold keeps it on', () => {
    expect(captionOpacity(0, 3, 1)).toBe(0);
    expect(captionOpacity(0.5, 3, 1)).toBeCloseTo(0.5, 9);
    expect(captionOpacity(2, 3, 1)).toBe(1);
    expect(captionOpacity(4.5, 3, 1)).toBeCloseTo(0.5, 9);
    expect(captionOpacity(9, 3, 1)).toBe(0);
    expect(captionOpacity(100, 0, 1)).toBe(1);
  });

  it('validates stored options', () => {
    expect(sanitizePresent(null)).toEqual(DEFAULT_PRESENT);
    const o = sanitizePresent({
      title: 5,
      captionPos: 'sideways',
      captionSize: 9999,
      captureScale: 3,
      fov: 'x',
      captionOn: 'yes',
      turntableSpeed: -500,
    });
    expect(o).toMatchObject({
      title: '',
      captionPos: 'bottom-left',
      captionSize: 120,
      captureScale: 2,
      fov: 48,
      captionOn: false,
      turntableSpeed: -90,
    });
    expect(sanitizePresent({ captureScale: 4, captionPos: 'top' })).toMatchObject({
      captureScale: 4,
      captionPos: 'top',
    });
  });

  it('recognises the depth-of-field presets from the stored settings', () => {
    for (const d of DOF_PRESETS)
      expect(matchDofPreset({ on: d.on, aperture: d.aperture, maxBlur: d.maxBlur })).toBe(d.id);
    expect(matchDofPreset({ on: true, aperture: 0.5, maxBlur: 9 })).toBeNull(); // tuned by hand
    expect(matchDofPreset({ on: false, aperture: 0.9, maxBlur: 30 })).toBe('off');
    expect(new Set(DOF_PRESETS.map((d) => d.id)).size).toBe(DOF_PRESETS.length);
  });

  it('names capture files from the scene', () => {
    expect(captureFileName('My scene / v2', 2, 3200, 1800)).toBe('My_scene_v2-2x-3200x1800.png');
    expect(captureFileName('', 1, 10, 10)).toBe('scene-1x-10x10.png');
  });
});
