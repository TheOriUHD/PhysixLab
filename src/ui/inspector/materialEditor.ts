/**
 * The inspector's material editor (VZ-1..VZ-4): a searchable, grouped preset picker with colour swatches, a live
 * preview sphere, the PBR controls (colour, metalness, roughness, opacity, emissive, clearcoat, transmission / IOR,
 * sheen, anisotropy) and the texture controls (procedural patterns or your own images with UV scale / rotation /
 * offset, triplanar projection, bump and normal / roughness / emissive maps). Edits apply to the whole selection.
 */
import { MATERIAL_GROUPS, MATERIAL_PRESETS, materialFromPreset } from '../../model/materials';
import { makeTextureAsset } from '../../model/assets';
import { defaultTextureSpec, PATTERNS } from '../../model/sanitize/visual';
import type { BodyEntity, MaterialSpec, TextureSpec } from '../../model/types';
import { MaterialPreview } from '../../render/materialPreview';
import type { Field } from '../controls';
import { button, colorField, row, section, selectField, sliderField, toggleField } from '../controls';
import { h } from '../dom';
import type { InspectorContext } from './shared';

const PATTERN_LABELS: Record<string, string> = {
  checker: 'Checker',
  stripes: 'Stripes',
  hazard: 'Hazard',
  wood: 'Wood grain',
  brick: 'Brick',
  concrete: 'Concrete',
  marble: 'Marble',
  noise: 'Noise',
  grid: 'Grid',
  dots: 'Dots',
  carbon: 'Carbon weave',
};

type MapKey = 'imageId' | 'normalId' | 'roughnessId' | 'emissiveId';
const MAP_ROWS: { key: MapKey; label: string; hint: string }[] = [
  { key: 'imageId', label: 'Albedo', hint: 'Colour image (the surface colour)' },
  { key: 'normalId', label: 'Normal map', hint: 'Tangent-space normal map (OpenGL / glTF convention)' },
  { key: 'roughnessId', label: 'Rough. map', hint: 'Greyscale: the green channel multiplies Roughness' },
  { key: 'emissiveId', label: 'Emissive map', hint: 'Colour image that glows (scaled by Emissive intensity)' },
];

const MAX_IMAGE_SIDE = 2048;

/** Read an image file, downscaling big ones, into a data URL with its size. */
async function readImage(file: File): Promise<{ dataUrl: string; width: number; height: number }> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const hgt = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = hgt;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available');
  ctx.drawImage(bmp, 0, 0, w, hgt);
  bmp.close();
  const png = file.type === 'image/png' || file.type === 'image/webp';
  return { dataUrl: canvas.toDataURL(png ? 'image/png' : 'image/jpeg', 0.92), width: w, height: hgt };
}

let sharedPreview: MaterialPreview | undefined;

export function materialSection(ctx: InspectorContext, sel: BodyEntity[]): HTMLElement[] {
  const { app } = ctx;
  const ids = sel.map((b) => b.id);
  const multi = sel.length > 1;
  const cur = (): BodyEntity[] => ids.map((id) => app.store.body(id)).filter((b): b is BodyEntity => !!b);
  const first = (): BodyEntity => cur()[0];
  const mixed = <T>(get: (m: MaterialSpec) => T) => {
    const l = cur();
    return l.some((b) => JSON.stringify(get(b.material)) !== JSON.stringify(get(l[0].material)));
  };
  const bind = <T>(f: Field<T>, get: (m: MaterialSpec) => T) => {
    ctx.updaters.push(() => {
      if (cur().length) f.set(get(first().material), multi && mixed(get));
    });
    return f.el;
  };
  const matEdit = (label: string, patch: (m: MaterialSpec) => Partial<MaterialSpec>) =>
    ctx.edit<BodyEntity>(ids, label, (b) => ({ material: { ...b.material, preset: 'custom', ...patch(b.material) } }));
  /** Set an optional field; `undefined` removes it. */
  const matSet = <K extends keyof MaterialSpec>(label: string, key: K, v: MaterialSpec[K] | undefined) =>
    ctx.edit<BodyEntity>(ids, label, (b) => {
      const m: MaterialSpec = { ...b.material, preset: 'custom' };
      if (v === undefined) delete m[key];
      else m[key] = v;
      return { material: m };
    });
  const texEdit = (label: string, fn: (t: TextureSpec) => Partial<TextureSpec>) =>
    ctx.edit<BodyEntity>(ids, label, (b) => {
      const t = b.material.texture ?? defaultTextureSpec('checker');
      return { material: { ...b.material, preset: 'custom', texture: { ...t, ...fn(t) } } };
    });
  const slider = (
    label: string,
    min: number,
    max: number,
    get: (m: MaterialSpec) => number,
    set: (v: number) => void,
    o: { step?: number; digits?: number; log?: boolean; unit?: string } = {},
  ) => {
    const f = sliderField({
      min,
      max,
      step: o.step ?? 0.01,
      digits: o.digits ?? 2,
      log: o.log,
      unit: o.unit,
      ...ctx.grouped(`Edit ${label}`),
      onChange: set,
    });
    return bind(f, get);
  };

  // ---- preview + picker ---------------------------------------------------------------------
  const preview = (sharedPreview ??= new MaterialPreview());
  const current = h('div', { class: 'material-current' });
  const search = h('input', {
    class: 'plain',
    type: 'search',
    placeholder: 'Search materials…',
    spellcheck: false,
    'aria-label': 'Search materials',
  });
  search.addEventListener('keydown', (e) => e.stopPropagation());
  const list = h('div', { class: 'material-list', role: 'listbox', 'aria-label': 'Material presets' });
  const swatches: { btn: HTMLButtonElement; id: string; label: string; group: string }[] = [];
  const groups: { head: HTMLElement; wrap: HTMLElement; name: string }[] = [];
  for (const g of MATERIAL_GROUPS) {
    const wrap = h('div', { class: 'material-swatches' });
    const head = h('div', { class: 'material-group' }, g);
    for (const p of MATERIAL_PRESETS.filter((x) => x.group === g)) {
      const dot = h('span', { class: 'material-dot', style: { background: p.color } });
      if (p.metalness > 0.5) dot.classList.add('metal');
      if (p.opacity < 0.9 || (p.transmission ?? 0) > 0) dot.classList.add('clear');
      const btn = h(
        'button',
        {
          class: 'material-swatch',
          type: 'button',
          title: `${p.label} — ${p.density} kg/m³, μ ${p.friction}, e ${p.restitution}`,
          role: 'option',
        },
        dot,
        h('span', null, p.label),
      );
      btn.addEventListener('click', () => {
        const spec = materialFromPreset(p.id);
        ctx.edit<BodyEntity>(ids, `Material: ${p.label}`, () => ({ material: spec }));
      });
      wrap.append(btn);
      swatches.push({ btn, id: p.id, label: p.label, group: g });
    }
    list.append(head, wrap);
    groups.push({ head, wrap, name: g });
  }
  const filter = () => {
    const q = search.value.trim().toLowerCase();
    for (const s of swatches)
      s.btn.style.display = !q || s.label.toLowerCase().includes(q) || s.group.toLowerCase().includes(q) ? '' : 'none';
    for (const g of groups) {
      const any = [...g.wrap.children].some((c) => (c as HTMLElement).style.display !== 'none');
      g.head.style.display = g.wrap.style.display = any ? '' : 'none';
    }
  };
  search.addEventListener('input', filter);
  ctx.updaters.push(() => {
    if (!cur().length) return;
    const m = first().material;
    const name = MATERIAL_PRESETS.find((p) => p.id === m.preset)?.label ?? 'Custom';
    current.textContent = multi && mixed((x) => x.preset) ? 'Mixed materials' : name;
    for (const s of swatches) s.btn.classList.toggle('on', !multi && s.id === m.preset);
    if (preview.available) preview.update(m);
  });

  // ---- surface -------------------------------------------------------------------------------
  const color = colorField({
    ...ctx.grouped('Edit colour'),
    onChange: (v) => matEdit('Edit colour', () => ({ color: v })),
  });
  const emissive = colorField({
    ...ctx.grouped('Edit emissive colour'),
    onChange: (v) =>
      matEdit('Edit emissive colour', (m) => ({ emissive: v, emissiveIntensity: m.emissiveIntensity ?? 1 })),
  });
  const surface = [
    row(
      'Colour',
      bind(color, (m) => m.color),
    ),
    row(
      'Metalness',
      slider(
        'metalness',
        0,
        1,
        (m) => m.metalness,
        (v) => matEdit('Edit metalness', () => ({ metalness: v })),
      ),
    ),
    row(
      'Roughness',
      slider(
        'roughness',
        0,
        1,
        (m) => m.roughness,
        (v) => matEdit('Edit roughness', () => ({ roughness: v })),
      ),
    ),
    row(
      'Opacity',
      slider(
        'opacity',
        0.05,
        1,
        (m) => m.opacity,
        (v) => matEdit('Edit opacity', () => ({ opacity: v })),
      ),
      'Ignored while Transmission is on',
    ),
    row(
      'Emissive',
      bind(emissive, (m) => m.emissive ?? '#000000'),
    ),
    row(
      'Glow',
      slider(
        'glow',
        0,
        20,
        (m) => m.emissiveIntensity ?? 0,
        (v) => matEdit('Edit glow', (m) => ({ emissiveIntensity: v, emissive: m.emissive ?? '#ffffff' })),
        { step: 0.05 },
      ),
      'Emissive intensity (values above 1 bloom when post-processing is on)',
    ),
  ];
  const sheenColor = colorField({
    ...ctx.grouped('Edit sheen colour'),
    onChange: (v) => matEdit('Edit sheen colour', () => ({ sheenColor: v })),
  });
  const advanced = [
    row(
      'Clearcoat',
      slider(
        'clearcoat',
        0,
        1,
        (m) => m.clearcoat ?? 0,
        (v) => matEdit('Edit clearcoat', () => ({ clearcoat: v })),
      ),
      'A glossy lacquer layer (car paint, ceramic)',
    ),
    row(
      'Coat rough.',
      slider(
        'coat roughness',
        0,
        1,
        (m) => m.clearcoatRoughness ?? 0.1,
        (v) => matEdit('Edit coat roughness', () => ({ clearcoatRoughness: v })),
      ),
    ),
    row(
      'Transmission',
      slider(
        'transmission',
        0,
        1,
        (m) => m.transmission ?? 0,
        (v) => matEdit('Edit transmission', () => ({ transmission: v })),
      ),
      'See-through glass with refraction (costs an extra render pass; off in the Low tier)',
    ),
    row(
      'IOR',
      slider(
        'IOR',
        1,
        2.333,
        (m) => m.ior ?? 1.5,
        (v) => matEdit('Edit IOR', () => ({ ior: v })),
        { step: 0.01 },
      ),
      'Index of refraction: water 1.33, glass 1.5, diamond 2.42',
    ),
    row(
      'Thickness',
      slider(
        'thickness',
        0,
        4,
        (m) => m.thickness ?? 0,
        (v) => matEdit('Edit thickness', () => ({ thickness: v })),
      ),
      'Volume thickness for refraction (metres)',
    ),
    row(
      'Sheen',
      slider(
        'sheen',
        0,
        1,
        (m) => m.sheen ?? 0,
        (v) => matEdit('Edit sheen', () => ({ sheen: v })),
      ),
      'Soft fabric-like rim light',
    ),
    row(
      'Sheen colour',
      bind(sheenColor, (m) => m.sheenColor ?? '#ffffff'),
    ),
    row(
      'Anisotropy',
      slider(
        'anisotropy',
        0,
        1,
        (m) => m.anisotropy ?? 0,
        (v) => matEdit('Edit anisotropy', () => ({ anisotropy: v })),
      ),
      'Stretched highlights of brushed metal',
    ),
  ];

  // ---- texture -------------------------------------------------------------------------------
  const patternSel = selectField<string>({
    options: [
      { value: 'none', label: 'None' },
      ...PATTERNS.map((p) => ({ value: p, label: PATTERN_LABELS[p] })),
      { value: 'image', label: 'Image…' },
    ],
    onChange: (v) => {
      if (v === 'none') matSet('Remove texture', 'texture', undefined);
      else if (v === 'image') {
        texEdit('Texture: image', () => ({ pattern: 'image' }));
        // an image texture without an image is dropped on save: nothing to show until one is chosen
      } else texEdit(`Texture: ${PATTERN_LABELS[v]}`, () => ({ pattern: v as TextureSpec['pattern'] }));
    },
  });
  const c2 = colorField({
    ...ctx.grouped('Edit pattern colour'),
    onChange: (v) => texEdit('Edit pattern colour', () => ({ color2: v })),
  });
  const tex =
    <T>(get: (t: TextureSpec) => T, d: T) =>
    (m: MaterialSpec): T =>
      m.texture ? get(m.texture) : d;
  const tsl = (
    label: string,
    min: number,
    max: number,
    get: (t: TextureSpec) => number,
    set: (t: TextureSpec, v: number) => Partial<TextureSpec>,
    d: number,
    o: { step?: number; log?: boolean; digits?: number; unit?: string } = {},
  ) => slider(label, min, max, tex(get, d), (v) => texEdit(`Edit ${label}`, (t) => set(t, v)), o);
  const triplanar = toggleField({
    label: 'Triplanar mapping',
    onChange: (v) => texEdit('Triplanar mapping', () => ({ triplanar: v })),
  });
  const mapStatus: Record<MapKey, HTMLElement> = {
    imageId: h('span'),
    normalId: h('span'),
    roughnessId: h('span'),
    emissiveId: h('span'),
  };
  const fileIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', style: { display: 'none' } });
  let pendingKey: MapKey = 'imageId';
  fileIn.addEventListener('change', () => {
    const f = fileIn.files?.[0];
    fileIn.value = '';
    if (!f) return;
    const key = pendingKey;
    void (async () => {
      try {
        const img = await readImage(f);
        app.store.begin('Texture image'); // the asset and the material edit are one undo step
        try {
          const id = app.store.addAsset(makeTextureAsset(f.name, img.dataUrl, img.width, img.height), 'Texture image');
          texEdit('Texture image', (t) => ({ [key]: id, pattern: key === 'imageId' ? 'image' : t.pattern }));
        } finally {
          app.store.end();
        }
      } catch (e) {
        app.toast(e instanceof Error ? e.message : `Could not use “${f.name}” as a texture.`, 'error');
      }
    })();
  });
  const clears = {} as Record<MapKey, HTMLButtonElement>;
  const mapRows = MAP_ROWS.map((r) => {
    const choose = button(
      'Choose…',
      () => {
        pendingKey = r.key;
        fileIn.click();
      },
      { title: r.hint },
    );
    const clear = button('Clear', () =>
      texEdit(`Clear ${r.label}`, (t) => {
        const next: Partial<TextureSpec> = { [r.key]: undefined };
        // clearing the albedo image of an image texture leaves a pattern-less texture: fall back to a pattern
        if (r.key === 'imageId' && t.pattern === 'image') next.pattern = 'checker';
        return next;
      }),
    );
    clears[r.key] = clear;
    return row(r.label, h('div', { class: 'row-actions' }, mapStatus[r.key], choose, clear), r.hint);
  });
  ctx.updaters.push(() => {
    if (!cur().length) return;
    const t = first().material.texture;
    for (const r of MAP_ROWS) {
      const id = t?.[r.key];
      mapStatus[r.key].textContent = id ? (app.store.getAsset(id)?.name ?? 'missing') : '—';
      clears[r.key].disabled = !id;
    }
  });
  const isImage = (m: MaterialSpec) => m.texture?.pattern === 'image';
  const patternOnly: HTMLElement[] = [
    row(
      'Pattern colour',
      bind(
        c2,
        tex((t) => t.color2, '#ffffff'),
      ),
    ),
    row(
      'Bump',
      tsl(
        'bump',
        0,
        2,
        (t) => t.bump,
        (_t, v) => ({ bump: v }),
        0,
        { step: 0.01 },
      ),
      'Relief derived from the pattern (normal map)',
    ),
  ];
  const imageOnly: HTMLElement[] = [
    ...mapRows,
    row(
      'Normal strength',
      tsl(
        'normal strength',
        0,
        3,
        (t) => t.normalStrength,
        (_t, v) => ({ normalStrength: v }),
        1,
      ),
    ),
  ];
  const uv: HTMLElement[] = [
    row(
      'Scale U',
      tsl(
        'scale U',
        0.05,
        50,
        (t) => t.scale[0],
        (t, v) => ({ scale: [v, t.scale[1]] }),
        1,
        { log: true },
      ),
      'Repeats across the surface (per metre when triplanar)',
    ),
    row(
      'Scale V',
      tsl(
        'scale V',
        0.05,
        50,
        (t) => t.scale[1],
        (t, v) => ({ scale: [t.scale[0], v] }),
        1,
        { log: true },
      ),
    ),
    row(
      'Rotation',
      tsl(
        'rotation',
        -180,
        180,
        (t) => t.rotation,
        (_t, v) => ({ rotation: v }),
        0,
        { step: 1, digits: 0, unit: '°' },
      ),
    ),
    row(
      'Offset U',
      tsl(
        'offset U',
        -1,
        1,
        (t) => t.offset[0],
        (t, v) => ({ offset: [v, t.offset[1]] }),
        0,
      ),
    ),
    row(
      'Offset V',
      tsl(
        'offset V',
        -1,
        1,
        (t) => t.offset[1],
        (t, v) => ({ offset: [t.offset[0], v] }),
        0,
      ),
    ),
    bind(
      triplanar,
      tex((t) => t.triplanar, false),
    ),
    h(
      'p',
      { class: 'hint-text' },
      'Triplanar projects the colour texture along the three axes (no stretching on any shape); normal maps then fall back to off.',
    ),
  ];
  const vis = (els: HTMLElement[], on: boolean) => els.forEach((e) => (e.style.display = on ? '' : 'none'));
  ctx.updaters.push(() => {
    if (!cur().length) return;
    const m = first().material;
    patternSel.set(
      m.texture ? (m.texture.pattern === 'image' ? 'image' : m.texture.pattern) : 'none',
      multi && mixed((x) => x.texture?.pattern),
    );
    vis(uv, !!m.texture);
    vis(patternOnly, !!m.texture && !isImage(m));
    vis(imageOnly, isImage(m));
  });

  return [
    section(
      'Material',
      [
        h(
          'div',
          { class: 'material-head' },
          preview.available ? preview.canvas : null,
          h('div', { class: 'material-head-text' }, h('div', { class: 'row-label' }, 'Preset'), current),
        ),
        search,
        list,
        ...surface,
      ],
      { id: 'material' },
    ),
    section('Surface layers', advanced, { id: 'material-advanced', open: false }),
    section(
      'Texture',
      [
        row(
          'Pattern',
          bind(patternSel, (m) => (m.texture ? m.texture.pattern : 'none')),
        ),
        ...patternOnly,
        ...imageOnly,
        ...uv,
        fileIn,
      ],
      { id: 'material-texture', open: false },
    ),
  ];
}
