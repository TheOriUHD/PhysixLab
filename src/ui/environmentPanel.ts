/**
 * World-panel sections for the scene's look (VZ-10..VZ-13): sky + sun + time of day, HDRI, tone mapping + exposure,
 * fog and the ground's appearance. Everything edits `SceneSettings.environment` / `.ground` through the store, so
 * it is undoable and saved with the scene.
 */
import type { App } from '../app/app';
import { makeBlobAsset } from '../model/assets';
import type {
  EnvironmentSettings,
  FogType,
  GroundSettings,
  GroundType,
  SkyPreset,
  ToneMappingName,
} from '../model/types';
import { ENV_PRESETS, ENV_PRESET_BY_ID, sunFromTime } from '../render/envPresets';
import { button, colorField, row, section, segmented, selectField, sliderField, toggleField } from './controls';
import { h } from './dom';

const SKY_LABELS: Record<string, string> = Object.fromEntries(ENV_PRESETS.map((p) => [p.id, p.label]));

const TONE_OPTIONS: { value: ToneMappingName; label: string }[] = [
  { value: 'aces', label: 'ACES Filmic' },
  { value: 'agx', label: 'AgX' },
  { value: 'neutral', label: 'Neutral (Khronos PBR)' },
  { value: 'linear', label: 'Linear (none)' },
];

const GROUND_TYPES: { value: GroundType; label: string }[] = [
  { value: 'grid', label: 'Grid' },
  { value: 'checker', label: 'Checker' },
  { value: 'plain', label: 'Plain' },
  { value: 'water', label: 'Water (look only)' },
  { value: 'none', label: 'None (void)' },
];

const MAX_HDRI_BYTES = 16 * 1024 * 1024;

export function buildEnvironmentSections(app: App): { sections: HTMLElement[]; refresh: () => void } {
  const { store } = app;
  const upd: (() => void)[] = [];
  const env = (): EnvironmentSettings => store.settings.environment;
  const setEnv = (patch: Partial<EnvironmentSettings>, label: string) =>
    store.updateSettings({ environment: { ...env(), ...patch } }, label);
  const setSun = (patch: Partial<EnvironmentSettings['sun']>, label: string) =>
    setEnv({ sun: { ...env().sun, ...patch } }, label);
  const setFog = (patch: Partial<EnvironmentSettings['fog']>, label: string) =>
    setEnv({ fog: { ...env().fog, ...patch } }, label);
  const setHdri = (patch: Partial<EnvironmentSettings['hdri']>, label: string) =>
    setEnv({ hdri: { ...env().hdri, ...patch } }, label);
  const setGround = (patch: Partial<GroundSettings>, label: string) =>
    store.updateSettings({ ground: { ...store.settings.ground, ...patch } }, label);
  const grouped = (label: string) => ({ onStart: () => store.begin(label), onEnd: () => store.end() });

  // ---- sky ---------------------------------------------------------------------------------------
  const sky = selectField<SkyPreset>({
    options: [
      ...ENV_PRESETS.map((p) => ({ value: p.id, label: p.label })),
      { value: 'physical', label: 'Physical sky (time of day)' },
      { value: 'hdri', label: 'Your HDRI…' },
    ],
    onChange: (v) => {
      const p = ENV_PRESET_BY_ID.get(v);
      if (p) {
        setEnv(
          { sky: v, sun: { ...env().sun, azimuth: p.sunAzimuth, elevation: p.sunElevation } },
          `Environment: ${p.label}`,
        );
      } else if (v === 'hdri' && !env().hdri.assetId) {
        pickHdri(); // choosing "Your HDRI" with no file yet asks for one
        upd.forEach((u) => u()); // snap the select back until a file arrives
      } else {
        const t = sunFromTime(env().timeOfDay);
        setEnv(
          v === 'physical' ? { sky: v, sun: { ...env().sun, azimuth: t.azimuth, elevation: t.elevation } } : { sky: v },
          v === 'physical' ? 'Environment: physical sky' : 'Environment: HDRI',
        );
      }
    },
  });
  const time = sliderField({
    min: 0,
    max: 24,
    step: 0.05,
    digits: 2,
    unit: 'h',
    ...grouped('Time of day'),
    onChange: (v) => {
      const t = sunFromTime(v);
      setEnv({ timeOfDay: v, sun: { ...env().sun, azimuth: t.azimuth, elevation: t.elevation } }, 'Time of day');
    },
  });
  const azimuth = sliderField({
    min: 0,
    max: 360,
    step: 1,
    digits: 0,
    unit: '°',
    ...grouped('Sun azimuth'),
    onChange: (v) => setSun({ azimuth: v }, 'Sun azimuth'),
  });
  const elevation = sliderField({
    min: -20,
    max: 90,
    step: 1,
    digits: 0,
    unit: '°',
    ...grouped('Sun elevation'),
    onChange: (v) => setSun({ elevation: v }, 'Sun elevation'),
  });
  const sunI = sliderField({
    min: 0,
    max: 3,
    step: 0.05,
    digits: 2,
    unit: '×',
    ...grouped('Sun intensity'),
    onChange: (v) => setSun({ intensity: v }, 'Sun intensity'),
  });
  const turbidity = sliderField({
    min: 1,
    max: 20,
    step: 0.1,
    digits: 1,
    ...grouped('Turbidity'),
    onChange: (v) => setSun({ turbidity: v }, 'Sky turbidity'),
  });
  const rayleigh = sliderField({
    min: 0,
    max: 4,
    step: 0.05,
    digits: 2,
    ...grouped('Rayleigh'),
    onChange: (v) => setSun({ rayleigh: v }, 'Sky rayleigh'),
  });
  const cycle = toggleField({
    label: 'Animate day-night cycle',
    onChange: (v) => setEnv({ cycle: { ...env().cycle, enabled: v } }, v ? 'Start day cycle' : 'Stop day cycle'),
  });
  const cycleSpeed = sliderField({
    min: 0.05,
    max: 6,
    log: true,
    digits: 2,
    unit: 'h/s',
    ...grouped('Cycle speed'),
    onChange: (v) => setEnv({ cycle: { ...env().cycle, hoursPerSecond: v } }, 'Cycle speed'),
  });
  const physicalRows = [
    row('Turbidity', turbidity.el, 'Haze: 1–3 crisp blue sky, 10+ thick haze'),
    row('Rayleigh', rayleigh.el, 'Scattering of blue light: higher = bluer, stronger sunsets'),
  ];

  // ---- HDRI --------------------------------------------------------------------------------------
  const hdriName = h('span', { class: 'readout' }, 'none');
  const input = h('input', {
    type: 'file',
    accept: '.hdr,.exr,.jpg,.jpeg,.png,image/vnd.radiance,image/jpeg,image/png',
    style: { display: 'none' },
  });
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    input.value = '';
    if (f) void loadHdriFile(f);
  });
  function pickHdri() {
    input.click();
  }
  async function loadHdriFile(f: File): Promise<void> {
    if (f.size > MAX_HDRI_BYTES) {
      app.toast(
        `“${f.name}” is ${(f.size / 1048576).toFixed(1)} MB; HDRIs up to 16 MB can be stored in a scene.`,
        'warn',
      );
      return;
    }
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      store.begin('Use HDRI'); // the asset and the setting are one undo step
      try {
        const id = store.addAsset(makeBlobAsset(f.name, f.type || guessMime(f.name), bytes), 'Use HDRI');
        setEnv({ sky: 'hdri', hdri: { ...env().hdri, assetId: id } }, 'Use HDRI');
      } finally {
        store.end();
      }
      app.toast(`Using “${f.name}” as the environment`, 'success');
    } catch (e) {
      app.toast(e instanceof Error ? e.message : `Could not use “${f.name}” as an HDRI.`, 'error');
    }
  }
  const hdriBg = toggleField({
    label: 'Show as background',
    onChange: (v) => setHdri({ showBackground: v }, 'HDRI background'),
  });
  const hdriBlur = sliderField({
    min: 0,
    max: 1,
    step: 0.01,
    digits: 2,
    ...grouped('Background blur'),
    onChange: (v) => setHdri({ backgroundBlur: v }, 'HDRI blur'),
  });
  const hdriRot = sliderField({
    min: -180,
    max: 180,
    step: 1,
    digits: 0,
    unit: '°',
    ...grouped('HDRI rotation'),
    onChange: (v) => setHdri({ rotation: v }, 'HDRI rotation'),
  });
  const hdriInt = sliderField({
    min: 0,
    max: 4,
    step: 0.05,
    digits: 2,
    unit: '×',
    ...grouped('HDRI intensity'),
    onChange: (v) => setHdri({ intensity: v }, 'HDRI intensity'),
  });
  const hdriRows = [
    row('File', hdriName),
    h(
      'div',
      { class: 'row-actions' },
      button('Load HDRI…', pickHdri, {
        icon: 'upload',
        title: 'Radiance .hdr, OpenEXR .exr, or a .jpg / .png panorama (up to 16 MB)',
      }),
      button('Remove', () => setEnv({ sky: 'studio', hdri: { ...env().hdri, assetId: null } }, 'Remove HDRI'), {
        title: 'Back to the Studio environment',
      }),
    ),
    hdriBg.el,
    row('Blur', hdriBlur.el),
    row('Rotation', hdriRot.el),
    row('Light ×', hdriInt.el, 'Multiplier of the lighting the HDRI casts'),
    input,
  ];

  // ---- display -----------------------------------------------------------------------------------
  const tone = selectField<ToneMappingName>({
    options: TONE_OPTIONS,
    onChange: (v) => setEnv({ toneMapping: v }, 'Tone mapping'),
  });
  const exposure = sliderField({
    min: 0.1,
    max: 4,
    log: true,
    digits: 2,
    ...grouped('Exposure'),
    onChange: (v) => setEnv({ exposure: v }, 'Exposure'),
  });

  // ---- fog ---------------------------------------------------------------------------------------
  const fogOn = toggleField({ label: 'Fog', onChange: (v) => setFog({ enabled: v }, v ? 'Fog on' : 'Fog off') });
  const fogType = segmented<FogType>({
    options: [
      { value: 'linear', label: 'Linear', title: 'Fades in between a start and an end distance' },
      { value: 'exp', label: 'Exponential', title: 'Thickens with distance, like haze' },
      { value: 'height', label: 'Height', title: 'Pools near the ground and thins out with altitude' },
    ],
    onChange: (v) => setFog({ type: v }, 'Fog type'),
  });
  const fogColor = colorField({ ...grouped('Fog colour'), onChange: (v) => setFog({ color: v }, 'Fog colour') });
  const fogDensity = sliderField({
    min: 0.0005,
    max: 0.5,
    log: true,
    digits: 4,
    unit: '1/m',
    ...grouped('Fog density'),
    onChange: (v) => setFog({ density: v }, 'Fog density'),
  });
  const fogNear = sliderField({
    min: 0,
    max: 500,
    step: 1,
    digits: 0,
    unit: 'm',
    ...grouped('Fog start'),
    onChange: (v) => setFog({ near: v }, 'Fog start'),
  });
  const fogFar = sliderField({
    min: 5,
    max: 2000,
    log: true,
    digits: 0,
    unit: 'm',
    ...grouped('Fog end'),
    onChange: (v) => setFog({ far: v }, 'Fog end'),
  });
  const fogHeight = sliderField({
    min: -10,
    max: 100,
    step: 0.5,
    digits: 1,
    unit: 'm',
    ...grouped('Fog height'),
    onChange: (v) => setFog({ height: v }, 'Fog height'),
  });
  const fogFall = sliderField({
    min: 0.005,
    max: 2,
    log: true,
    digits: 3,
    unit: '1/m',
    ...grouped('Fog falloff'),
    onChange: (v) => setFog({ falloff: v }, 'Fog falloff'),
  });
  const fogDensityRow = row('Density', fogDensity.el);
  const fogNearRow = row('Start', fogNear.el);
  const fogFarRow = row('End', fogFar.el);
  const fogHeightRow = row('Height', fogHeight.el, 'World height where the fog has the density above');
  const fogFallRow = row('Falloff', fogFall.el, 'How quickly it thins out above that height');

  // ---- ground ------------------------------------------------------------------------------------
  const gType = selectField<GroundType>({
    options: GROUND_TYPES,
    onChange: (v) => setGround({ type: v }, 'Ground look'),
  });
  const gBlend = sliderField({
    min: 0,
    max: 1,
    step: 0.01,
    digits: 2,
    ...grouped('Horizon blend'),
    onChange: (v) => setGround({ horizonBlend: v }, 'Horizon blend'),
  });
  const note = h('p', { class: 'hint-text' });

  const vis = (el: HTMLElement, on: boolean) => (el.style.display = on ? '' : 'none');
  upd.push(() => {
    const e = env();
    sky.set(e.sky);
    time.set(e.timeOfDay);
    azimuth.set(e.sun.azimuth);
    elevation.set(e.sun.elevation);
    sunI.set(e.sun.intensity);
    turbidity.set(e.sun.turbidity);
    rayleigh.set(e.sun.rayleigh);
    cycle.set(e.cycle.enabled);
    cycleSpeed.set(e.cycle.hoursPerSecond);
    const asset = e.hdri.assetId ? store.getAsset(e.hdri.assetId) : undefined;
    hdriName.textContent = asset ? asset.name : 'none';
    hdriBg.set(e.hdri.showBackground);
    hdriBlur.set(e.hdri.backgroundBlur);
    hdriRot.set(e.hdri.rotation);
    hdriInt.set(e.hdri.intensity);
    tone.set(e.toneMapping);
    exposure.set(e.exposure);
    fogOn.set(e.fog.enabled);
    fogType.set(e.fog.type);
    fogColor.set(e.fog.color);
    fogDensity.set(e.fog.density);
    fogNear.set(e.fog.near);
    fogFar.set(e.fog.far);
    fogHeight.set(e.fog.height);
    fogFall.set(e.fog.falloff);
    const g = store.settings.ground;
    gType.set(g.type ?? 'grid');
    gBlend.set(g.horizonBlend ?? 0.5);

    for (const r of physicalRows) vis(r, e.sky === 'physical');
    for (const r of hdriRows) vis(r, e.sky === 'hdri');
    const lin = e.fog.type === 'linear';
    const hgt = e.fog.type === 'height';
    vis(fogDensityRow, !lin);
    vis(fogNearRow, lin);
    vis(fogFarRow, lin);
    vis(fogHeightRow, hgt);
    vis(fogFallRow, hgt);
    note.textContent =
      e.sky === 'physical'
        ? 'The sky is computed from the sun: drag Time of day or the sun angles, and watch the light, shadows and reflections follow.'
        : 'Presets set the sky, the image-based lighting and a sun; the sun angles can be changed freely. The Physical sky and the day-night cycle give the most natural light.';
  });

  const sections = [
    section(
      'Sky & sun',
      [
        row('Environment', sky.el),
        row('Time of day', time.el, 'Moves the sun along its daily arc (sets the sun angles)'),
        row('Sun azimuth', azimuth.el, 'Compass direction: 0° north, 90° east'),
        row('Sun height', elevation.el, 'Degrees above the horizon (below 0 = night)'),
        row('Sun light', sunI.el, 'Multiplier of the direct sunlight (and its shadows)'),
        ...physicalRows,
        ...hdriRows,
        cycle.el,
        row('Cycle speed', cycleSpeed.el, 'Hours of scene time per real second (display only; physics is unaffected)'),
        note,
      ],
      { id: 'world-sky' },
    ),
    section(
      'Display',
      [row('Tone mapping', tone.el, 'How scene brightness is compressed to the screen'), row('Exposure', exposure.el)],
      { id: 'world-display' },
    ),
    section(
      'Fog',
      [
        fogOn.el,
        rowEl(fogType.el),
        row('Colour', fogColor.el),
        fogDensityRow,
        fogNearRow,
        fogFarRow,
        fogHeightRow,
        fogFallRow,
      ],
      { id: 'world-fog', open: false },
    ),
    section(
      'Ground look',
      [
        row('Type', gType.el, 'Looks only: the ground still collides unless Ground plane is off'),
        row('Horizon blend', gBlend.el, 'Fade the distant ground into the horizon colour'),
      ],
      { id: 'world-groundlook', open: false },
    ),
  ];
  return { sections, refresh: () => upd.forEach((u) => u()) };
}

function rowEl(el: HTMLElement): HTMLElement {
  return h('div', { class: 'row stack' }, h('div', { class: 'row-control' }, el));
}

function guessMime(name: string): string {
  const n = name.toLowerCase();
  if (n.endsWith('.hdr')) return 'image/vnd.radiance';
  if (n.endsWith('.exr')) return 'image/x-exr';
  if (n.endsWith('.png')) return 'image/png';
  return 'image/jpeg';
}

export { SKY_LABELS };
