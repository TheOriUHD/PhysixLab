/** VZ-A: material presets, material sanitising, procedural patterns, environment settings, sun maths, height fog. */
import { describe, expect, it } from 'vitest';
import { isLight } from '../src/model/types';
import { createBody, createLight, newDocument } from '../src/model/factory';
import { MATERIAL_GROUPS, MATERIAL_PRESETS, materialFromPreset } from '../src/model/materials';
import { makeBlobAsset, makeTextureAsset } from '../src/model/assets';
import { parseDocument, sanitizeDocument, serializeDocument } from '../src/model/serialize';
import { SceneStore } from '../src/model/store';
import { ENV_PRESETS, sunDirection, sunFromTime } from '../src/render/envPresets';
import { heightFogParams } from '../src/render/fogChunks';
import { heightToNormal, renderPattern, valueNoise } from '../src/render/proceduralTextures';
import { PATTERNS } from '../src/model/sanitize/visual';

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('VZ-1 material presets', () => {
  it('has at least 35 presets with unique ids, real-world values and groups', () => {
    expect(MATERIAL_PRESETS.length).toBeGreaterThanOrEqual(35);
    expect(new Set(MATERIAL_PRESETS.map((p) => p.id)).size).toBe(MATERIAL_PRESETS.length);
    for (const p of MATERIAL_PRESETS) {
      expect(MATERIAL_GROUPS).toContain(p.group);
      expect(p.density).toBeGreaterThan(0);
      expect(p.friction).toBeGreaterThanOrEqual(0);
      expect(p.restitution).toBeLessThanOrEqual(1);
      expect(p.roughness).toBeGreaterThanOrEqual(0);
      expect(p.roughness).toBeLessThanOrEqual(1);
    }
    for (const id of [
      'brass',
      'copper',
      'titanium',
      'stainless',
      'castiron',
      'oak',
      'pine',
      'bamboo',
      'marble',
      'granite',
      'sandstone',
      'brick',
      'asphalt',
      'leather',
      'cloth',
      'cardboard',
      'clay',
      'carbon',
      'neoprene',
      'ptfe',
      'acrylic',
      'silicone',
      'bone',
      'chocolate',
      'bubblewrap',
    ])
      expect(
        MATERIAL_PRESETS.some((p) => p.id === id),
        id,
      ).toBe(true);
  });

  it('physical sanity: metals are dense and metallic, PTFE is slippery, rubber bounces', () => {
    const by = (id: string) => MATERIAL_PRESETS.find((p) => p.id === id)!;
    expect(by('copper').density).toBeCloseTo(8960, -2);
    expect(by('titanium').density).toBeCloseTo(4500, -2);
    expect(by('brass').metalness).toBe(1);
    expect(by('ptfe').friction).toBeLessThan(0.1);
    expect(by('rubber').restitution).toBeGreaterThan(0.7);
    expect(by('glass').density).toBeCloseTo(2500, -2);
  });

  it('materialFromPreset carries the PBR extras and a private copy of the texture', () => {
    const m = materialFromPreset('carbon');
    expect(m.clearcoat).toBe(1);
    expect(m.texture?.pattern).toBe('carbon');
    const m2 = materialFromPreset('carbon');
    expect(m2.texture).not.toBe(m.texture);
    expect(materialFromPreset('steel').texture).toBeUndefined();
  });
});

describe('VZ-2/3 material fields survive save and load, and are sanitised', () => {
  it('round-trips PBR extras and texture settings', () => {
    const doc = newDocument('t');
    const b = createBody({});
    b.material = {
      ...materialFromPreset('marble'),
      emissive: '#ff0000',
      emissiveIntensity: 2,
      transmission: 0.5,
      anisotropy: 0.3,
      texture: {
        pattern: 'brick',
        color2: '#cccccc',
        scale: [2, 3],
        rotation: 45,
        offset: [0.1, 0.2],
        triplanar: true,
        bump: 0.7,
        normalStrength: 1,
      },
    };
    doc.entities.push(b);
    const back = parseDocument(serializeDocument(doc));
    expect(back.entities[0]).toMatchObject({ kind: 'body' });
    const m = (back.entities[0] as typeof b).material;
    expect(m.emissive).toBe('#ff0000');
    expect(m.transmission).toBe(0.5);
    expect(m.texture).toEqual(b.material.texture);
  });

  it('clamps garbage and drops an image texture without an image', () => {
    const doc = newDocument('t');
    const b = createBody({});
    (b.material as unknown as Record<string, unknown>).clearcoat = 9;
    (b.material as unknown as Record<string, unknown>).ior = 'x';
    (b.material as unknown as Record<string, unknown>).texture = { pattern: 'image' };
    doc.entities.push(b);
    const m = (sanitizeDocument(JSON.parse(JSON.stringify(doc))).entities[0] as typeof b).material;
    expect(m.clearcoat).toBe(1);
    expect(m.ior).toBeUndefined();
    expect(m.texture).toBeUndefined();
  });

  it('texture assets are referenced by materials: kept while used, dangling ids dropped', () => {
    const store = new SceneStore();
    const id = store.addAsset(makeTextureAsset('t.png', PNG, 1, 1));
    const b = createBody({});
    b.material = {
      ...b.material,
      texture: {
        pattern: 'image',
        color2: '#fff',
        scale: [1, 1],
        rotation: 0,
        offset: [0, 0],
        triplanar: false,
        bump: 0,
        normalStrength: 1,
        imageId: id,
      },
    };
    store.add([b]);
    expect(store.assetRefCount(id)).toBe(1);
    expect(store.unusedAssets()).toEqual([]);
    const doc = JSON.parse(serializeDocument(store.toDocument())) as { assets: Record<string, unknown> };
    expect(Object.keys(doc.assets)).toContain(id);
    // remove the asset: the body falls back to no texture
    store.removeAsset(id);
    expect(store.body(b.id)?.material.texture).toBeUndefined();
  });
});

describe('VZ-2 procedural patterns', () => {
  it('every pattern renders, is tileable (noise lattice wraps) and has contrast', () => {
    for (const p of PATTERNS) {
      const buf = renderPattern(p, '#000000', '#ffffff', 128);
      let lo = 255;
      let hi = 0;
      for (let i = 0; i < 128 * 128; i++) {
        lo = Math.min(lo, buf.color[i * 4]);
        hi = Math.max(hi, buf.color[i * 4]);
      }
      expect(hi - lo, p).toBeGreaterThan(20);
    }
    expect(valueNoise(0, 0.3, 8, 1)).toBeCloseTo(valueNoise(1, 0.3, 8, 1), 6);
  });

  it('six- and three-digit hex colours are read correctly', () => {
    const a = renderPattern('checker', '#ff8000', '#ff8000', 8);
    expect([a.color[0], a.color[1], a.color[2]]).toEqual([255, 128, 0]);
    const b = renderPattern('checker', '#f80', '#f80', 8);
    expect([b.color[0], b.color[1], b.color[2]]).toEqual([255, 136, 0]);
  });

  it('heightToNormal makes a flat surface point straight out and a ramp lean', () => {
    const flat = heightToNormal(new Float32Array(16).fill(0.5), 4, 2);
    expect([flat[0], flat[1], flat[2]]).toEqual([128, 128, 255]);
    const ramp = new Float32Array(64);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) ramp[y * 8 + x] = x < 4 ? x / 4 : (8 - x) / 4;
    const n = heightToNormal(ramp, 8, 2);
    expect(n[(2 * 8 + 1) * 4]).toBeLessThan(120); // rising to +x tilts the normal toward −x
    expect(n[(2 * 8 + 6) * 4]).toBeGreaterThan(136);
  });
});

describe('VZ-10..13 environment settings', () => {
  it('has the ten requested presets plus physical and hdri skies', () => {
    expect(ENV_PRESETS.map((p) => p.id).sort()).toEqual(
      ['blueprint', 'day', 'desert', 'lab', 'night', 'overcast', 'snow', 'space', 'studio', 'sunset'].sort(),
    );
  });

  it('sun maths: east at 6h, south and high at noon, below the horizon at midnight', () => {
    const six = sunDirection(sunFromTime(6).azimuth, sunFromTime(6).elevation);
    expect(six.x).toBeGreaterThan(0.99);
    const noon = sunFromTime(12);
    expect(noon.azimuth).toBeCloseTo(180, 5);
    expect(noon.elevation).toBeGreaterThan(60);
    expect(sunDirection(noon.azimuth, noon.elevation).z).toBeGreaterThan(0); // south = +Z
    expect(sunFromTime(0).elevation).toBeLessThan(0);
  });

  it('environment, fog and ground settings round-trip and are clamped', () => {
    const doc = newDocument('t');
    doc.settings.environment = {
      ...doc.settings.environment,
      sky: 'physical',
      toneMapping: 'agx',
      sun: { azimuth: 123, elevation: 33, intensity: 1.5, turbidity: 9, rayleigh: 2 },
      cycle: { enabled: true, hoursPerSecond: 2 },
      fog: {
        enabled: true,
        color: '#aabbcc',
        density: 0.05,
        type: 'height',
        near: 10,
        far: 90,
        height: 3,
        falloff: 0.4,
      },
    };
    doc.settings.ground = { ...doc.settings.ground, type: 'water', horizonBlend: 0.8 };
    const back = parseDocument(serializeDocument(doc));
    expect(back.settings.environment).toEqual(doc.settings.environment);
    expect(back.settings.ground.type).toBe('water');
    const bad = sanitizeDocument({
      format: 'physicslab-scene',
      entities: [],
      settings: {
        environment: {
          sky: 'x',
          toneMapping: 'y',
          sun: { elevation: 500, turbidity: -4 },
          fog: { type: 'z', falloff: 0 },
        },
        ground: { type: 'lava', horizonBlend: 7 },
      },
    });
    expect(bad.settings.environment.sky).toBe('studio');
    expect(bad.settings.environment.toneMapping).toBe('aces');
    expect(bad.settings.environment.sun.elevation).toBe(90);
    expect(bad.settings.environment.sun.turbidity).toBe(1);
    expect(bad.settings.environment.fog.type).toBe('exp');
    expect(bad.settings.ground.type).toBe('grid');
    expect(bad.settings.ground.horizonBlend).toBe(1);
  });

  it('the scene HDRI is an asset reference: kept on save, dropped (with the sky) when missing', () => {
    const store = new SceneStore();
    const id = store.addAsset(makeBlobAsset('sky.hdr', 'image/vnd.radiance', new Uint8Array([1, 2, 3])));
    store.updateSettings({
      environment: {
        ...store.settings.environment,
        sky: 'hdri',
        hdri: { ...store.settings.environment.hdri, assetId: id },
      },
    });
    const saved = JSON.parse(serializeDocument(store.toDocument())) as { assets: Record<string, unknown> };
    expect(Object.keys(saved.assets)).toContain(id);
    saved.assets = {};
    const loaded = sanitizeDocument(saved);
    expect(loaded.settings.environment.hdri.assetId).toBeNull();
    expect(loaded.settings.environment.sky).toBe('studio');
  });

  it('height fog parameters encode density at height 0 and a negative far (the shader flag)', () => {
    const p = heightFogParams(0.02, 0, 0.2);
    expect(p.near).toBeCloseTo(0.02, 8);
    expect(p.far).toBeCloseTo(-0.2, 8);
    expect(heightFogParams(0.02, 5, 0.2).near).toBeCloseTo(0.02 * Math.exp(1), 6);
  });
});

describe('VZ-12 light flicker / pulse', () => {
  it('is stored on the light, sanitised, and absent for steady lights', () => {
    const doc = newDocument('t');
    const l = createLight('point');
    l.flicker = { mode: 'pulse', amount: 0.5, speed: 3 };
    const steady = createLight('spot');
    doc.entities.push(l, steady);
    const back = parseDocument(serializeDocument(doc));
    const lights = back.entities.filter(isLight);
    expect(lights[0].flicker).toEqual({ mode: 'pulse', amount: 0.5, speed: 3 });
    expect(lights[1].flicker).toBeUndefined();
    (l as unknown as Record<string, unknown>).flicker = { mode: 'strobe', amount: 9, speed: -1 };
    const bad = sanitizeDocument(JSON.parse(JSON.stringify(doc)));
    expect((bad.entities[0] as typeof l).flicker).toBeUndefined();
    l.flicker = { mode: 'flicker', amount: 9, speed: 0 };
    const clamped = sanitizeDocument(JSON.parse(JSON.stringify(doc)));
    expect((clamped.entities[0] as typeof l).flicker).toEqual({ mode: 'flicker', amount: 1, speed: 0.05 });
  });
});
