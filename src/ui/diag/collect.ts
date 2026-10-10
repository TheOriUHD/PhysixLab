/** Gathers a `ReportInput` from the live browser and app (the DOM-side half of the diagnostics). */
import type { App } from '../../app/app';
import { SECTIONS, profiler } from '../../core/profiler';
import { PROTOCOL_VERSION } from '../../physics/protocol';
import pkg from '../../../package.json';
import { checkCapabilities, probeEnvironment, type CapReport } from './capabilities';
import type { ErrorLog } from './errorLog';
import type { GpuInfo, MemoryInfo, ReportInput, SceneSummary, TimingInfo, WorkerInfo } from './report';

const LIMITS: [string, string][] = [
  ['Max texture size', 'MAX_TEXTURE_SIZE'],
  ['Max cube-map size', 'MAX_CUBE_MAP_TEXTURE_SIZE'],
  ['Max renderbuffer size', 'MAX_RENDERBUFFER_SIZE'],
  ['Max 3D texture size', 'MAX_3D_TEXTURE_SIZE'],
  ['Max texture units', 'MAX_TEXTURE_IMAGE_UNITS'],
  ['Max vertex attributes', 'MAX_VERTEX_ATTRIBS'],
  ['Max varying vectors', 'MAX_VARYING_VECTORS'],
  ['Max vertex uniform vectors', 'MAX_VERTEX_UNIFORM_VECTORS'],
  ['Max fragment uniform vectors', 'MAX_FRAGMENT_UNIFORM_VECTORS'],
  ['Max draw buffers', 'MAX_DRAW_BUFFERS'],
  ['Max MSAA samples', 'MAX_SAMPLES'],
];

/** Read the identifying strings and limits of a WebGL context. */
export function probeGl(gl: WebGL2RenderingContext | WebGLRenderingContext): GpuInfo {
  const str = (p: number): string => {
    try {
      return String(gl.getParameter(p) ?? '');
    } catch {
      return '';
    }
  };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info') as {
    UNMASKED_VENDOR_WEBGL: number;
    UNMASKED_RENDERER_WEBGL: number;
  } | null;
  const limits: Record<string, number | string> = {};
  const g = gl as unknown as Record<string, number>;
  for (const [label, name] of LIMITS) {
    const key = g[name];
    if (key === undefined) continue;
    try {
      const v = gl.getParameter(key) as number | null;
      if (typeof v === 'number') limits[label] = v;
    } catch {
      /* not supported on this context */
    }
  }
  try {
    const dims = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | null;
    if (dims) limits['Max viewport'] = `${dims[0]} × ${dims[1]}`;
  } catch {
    /* ignore */
  }
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic') as { MAX_TEXTURE_MAX_ANISOTROPY_EXT: number } | null;
  if (aniso) limits['Max anisotropy'] = Number(gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT));
  return {
    version: str(gl.VERSION),
    shadingLanguage: str(gl.SHADING_LANGUAGE_VERSION),
    vendor: str(gl.VENDOR),
    renderer: str(gl.RENDERER),
    unmaskedVendor: dbg ? str(dbg.UNMASKED_VENDOR_WEBGL) : undefined,
    unmaskedRenderer: dbg ? str(dbg.UNMASKED_RENDERER_WEBGL) : undefined,
    limits,
  };
}

/** GPU info from the app's own context (the one that really draws), or a throw-away context before the app exists. */
export function gpuInfo(app: App | null): GpuInfo | null {
  try {
    const live = app?.viewport?.renderer?.getContext();
    if (live) return probeGl(live);
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return null;
    const info = probeGl(gl);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return info;
  } catch {
    return null;
  }
}

export function memoryInfo(): MemoryInfo | null {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } })
    .memory;
  if (!m) return null;
  const MB = 1024 * 1024;
  return { usedMB: m.usedJSHeapSize / MB, totalMB: m.totalJSHeapSize / MB, limitMB: m.jsHeapSizeLimit / MB };
}

export function workerInfo(app: App): WorkerInfo {
  const c = app.sim.client;
  const s = c.stats;
  return {
    active: c.active,
    protocol: c.workerProtocol,
    expectedProtocol: PROTOCOL_VERSION,
    frameNo: c.frameNo,
    simTime: s?.simTime ?? 0,
    stepMs: s?.stepMs ?? 0,
    roundTripMs: c.roundTripMs,
    applyMs: c.applyMs,
    bodies: s?.bodies ?? 0,
    awake: s?.awake ?? 0,
    contacts: s?.contacts ?? 0,
    particles: s?.particles ?? 0,
    lastError: c.lastError,
  };
}

export function sceneSummary(app: App): SceneSummary {
  const st = app.store;
  return {
    name: st.name,
    entities: st.size,
    bodies: st.bodies().length,
    joints: st.joints().length,
    selected: st.selection.length,
    mode: app.sim.mode,
  };
}

export function timingInfo(app: App | null): TimingInfo | null {
  if (!profiler.count) return null;
  const iv = profiler.intervalStats();
  return {
    fps: app?.framesPerSecond ?? (iv.avg > 0 ? 1000 / iv.avg : 0),
    intervalAvg: iv.avg,
    intervalMax: iv.max,
    sections: SECTIONS.map((s) => {
      const st = profiler.stats(s.id);
      return { key: s.key, label: s.label, avg: st.avg, max: st.max };
    }),
  };
}

let capsCache: CapReport | null = null;
/** The start-up capability report (probed once). */
export function capabilityReport(): CapReport {
  return (capsCache ??= checkCapabilities(probeEnvironment()));
}

/** Everything the diagnostics show, as of now. `app` may be null (boot failure). */
export function collectReport(app: App | null, log: ErrorLog): ReportInput {
  const nav = navigator as Navigator & { deviceMemory?: number };
  let mode = 'unknown';
  try {
    mode = import.meta.env.MODE;
  } catch {
    /* not a Vite build */
  }
  return {
    app: { name: 'PhysicsLab', version: pkg.version, mode },
    time: new Date().toISOString(),
    userAgent: nav.userAgent,
    platform: nav.platform,
    language: nav.language,
    cores: nav.hardwareConcurrency ?? null,
    deviceMemoryGB: nav.deviceMemory ?? null,
    screen: { width: screen.width, height: screen.height, dpr: window.devicePixelRatio || 1 },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    online: typeof nav.onLine === 'boolean' ? nav.onLine : null,
    gpu: gpuInfo(app),
    caps: capabilityReport(),
    worker: app ? workerInfo(app) : null,
    memory: memoryInfo(),
    scene: app ? sceneSummary(app) : null,
    timings: timingInfo(app),
    errors: log.recent(),
  };
}
