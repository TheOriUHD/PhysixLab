/**
 * The diagnostics report (DOM-free): one data structure that the Diagnostics panel, the error card and the "Copy
 * diagnostics" button all show, plus the functions that turn it into rows and into text.
 */
import type { CapReport } from './capabilities';
import type { LogEntry } from './errorLog';

export interface GpuInfo {
  /** `gl.getParameter(VERSION)`, e.g. "WebGL 2.0 (OpenGL ES 3.0 Chromium)". */
  version: string;
  shadingLanguage: string;
  vendor: string;
  renderer: string;
  /** From WEBGL_debug_renderer_info (the real card, when the browser reveals it). */
  unmaskedVendor?: string;
  unmaskedRenderer?: string;
  limits: Record<string, number | string>;
}

export interface WorkerInfo {
  /** A simulation is running in the worker right now (false in edit mode: the worker is idle). */
  active: boolean;
  /** Protocol version the worker announced / the one this page expects. */
  protocol: number | null;
  expectedProtocol: number;
  frameNo: number;
  simTime: number;
  stepMs: number;
  roundTripMs: number;
  applyMs: number;
  bodies: number;
  awake: number;
  contacts: number;
  particles: number;
  lastError: string | null;
}

export interface MemoryInfo {
  usedMB: number;
  totalMB: number;
  limitMB: number;
}

export interface SceneSummary {
  name: string;
  entities: number;
  bodies: number;
  joints: number;
  selected: number;
  mode: string;
}

export interface TimingInfo {
  fps: number;
  /** Frame interval average / max (ms). */
  intervalAvg: number;
  intervalMax: number;
  sections: { key: string; label: string; avg: number; max: number }[];
}

export interface ReportInput {
  app: { name: string; version: string; mode: string };
  time: string;
  userAgent: string;
  platform: string;
  language: string;
  cores: number | null;
  deviceMemoryGB: number | null;
  screen: { width: number; height: number; dpr: number };
  viewport: { width: number; height: number };
  online: boolean | null;
  gpu: GpuInfo | null;
  caps: CapReport;
  worker: WorkerInfo | null;
  memory: MemoryInfo | null;
  scene: SceneSummary | null;
  timings: TimingInfo | null;
  errors: LogEntry[];
}

export type Tone = 'ok' | 'warn' | 'bad';
export interface Row {
  label: string;
  value: string;
  tone?: Tone;
}
export interface Section {
  title: string;
  rows: Row[];
}

const ms = (v: number): string => `${v.toFixed(v < 10 ? 2 : 1)} ms`;
const mb = (v: number): string => `${v.toFixed(v < 100 ? 1 : 0)} MB`;

/** The rows of the Diagnostics panel, grouped. */
export function diagSections(r: ReportInput): Section[] {
  const out: Section[] = [];
  out.push({
    title: 'Application',
    rows: [
      { label: 'Version', value: `${r.app.name} ${r.app.version} (${r.app.mode})` },
      { label: 'Mode', value: r.app.mode === 'production' ? 'Release build' : 'Development build' },
    ],
  });
  out.push({
    title: 'Browser and device',
    rows: [
      { label: 'Browser', value: browserName(r.userAgent) },
      { label: 'Platform', value: r.platform || 'unknown' },
      { label: 'Language', value: r.language || 'unknown' },
      { label: 'CPU threads', value: r.cores === null ? 'unknown' : String(r.cores) },
      { label: 'Device memory', value: r.deviceMemoryGB === null ? 'not reported' : `${r.deviceMemoryGB} GB` },
      { label: 'Screen', value: `${r.screen.width} × ${r.screen.height} @ ${r.screen.dpr}×` },
      { label: 'Window', value: `${r.viewport.width} × ${r.viewport.height}` },
      { label: 'Online', value: r.online === null ? 'unknown' : r.online ? 'yes' : 'no' },
    ],
  });
  if (r.gpu) {
    const g = r.gpu;
    const software = /swiftshader|llvmpipe|software|basic render/i.test(`${g.unmaskedRenderer ?? ''} ${g.renderer}`);
    out.push({
      title: 'Graphics',
      rows: [
        { label: 'API', value: g.version },
        { label: 'GPU', value: g.unmaskedRenderer ?? g.renderer, tone: software ? 'warn' : undefined },
        { label: 'Vendor', value: g.unmaskedVendor ?? g.vendor },
        ...(software
          ? [{ label: 'Note', value: 'software rendering: slow. Turn on hardware acceleration.', tone: 'warn' as Tone }]
          : []),
        { label: 'Shading language', value: g.shadingLanguage },
        ...Object.entries(g.limits).map(([label, value]) => ({ label, value: String(value) })),
      ],
    });
  } else
    out.push({
      title: 'Graphics',
      rows: [{ label: 'WebGL', value: 'not available', tone: 'bad' }],
    });
  if (r.worker) {
    const w = r.worker;
    const mismatch = w.protocol !== null && w.protocol !== w.expectedProtocol;
    out.push({
      title: 'Physics worker',
      rows: [
        {
          label: 'Status',
          value: w.lastError
            ? 'error'
            : w.protocol === null
              ? 'starting…'
              : w.active
                ? 'simulating'
                : 'idle (edit mode)',
          tone: w.lastError ? 'bad' : w.active ? 'ok' : undefined,
        },
        {
          label: 'Protocol',
          value: w.protocol === null ? '—' : `v${w.protocol} (page expects v${w.expectedProtocol})`,
          tone: mismatch ? 'bad' : undefined,
        },
        { label: 'Frames received', value: String(w.frameNo) },
        { label: 'Simulated time', value: `${w.simTime.toFixed(2)} s` },
        { label: 'Step time (worker)', value: w.stepMs > 0 ? ms(w.stepMs) : '—' },
        { label: 'Round trip', value: w.roundTripMs > 0 ? ms(w.roundTripMs) : '—' },
        { label: 'Unpack on main thread', value: w.applyMs > 0 ? ms(w.applyMs) : '—' },
        { label: 'Bodies / awake', value: `${w.bodies} / ${w.awake}` },
        { label: 'Contacts', value: String(w.contacts) },
        { label: 'Soft-body particles', value: String(w.particles) },
        ...(w.lastError ? [{ label: 'Last error', value: w.lastError, tone: 'bad' as Tone }] : []),
      ],
    });
  }
  if (r.timings) {
    const t = r.timings;
    out.push({
      title: 'Frame timing',
      rows: [
        {
          label: 'Frame rate',
          value: `${Math.round(t.fps)} fps`,
          tone: t.fps < 25 ? 'bad' : t.fps < 50 ? 'warn' : undefined,
        },
        {
          label: 'Frame interval',
          value: t.intervalAvg > 0 ? `${ms(t.intervalAvg)} avg, ${ms(t.intervalMax)} max` : '—',
        },
        ...t.sections.map((s) => ({ label: s.label, value: `${ms(s.avg)} avg, ${ms(s.max)} max` })),
      ],
    });
  }
  out.push({
    title: 'Memory',
    rows: r.memory
      ? [
          { label: 'JS heap used', value: mb(r.memory.usedMB) },
          { label: 'JS heap allocated', value: mb(r.memory.totalMB) },
          { label: 'JS heap limit', value: mb(r.memory.limitMB) },
        ]
      : [{ label: 'JS heap', value: 'not reported by this browser' }],
  });
  if (r.scene)
    out.push({
      title: 'Scene',
      rows: [
        { label: 'Name', value: r.scene.name },
        { label: 'Objects', value: String(r.scene.entities) },
        { label: 'Bodies / joints', value: `${r.scene.bodies} / ${r.scene.joints}` },
        { label: 'Selected', value: String(r.scene.selected) },
        { label: 'Mode', value: r.scene.mode },
      ],
    });
  out.push({
    title: 'Capabilities',
    rows: r.caps.items.map((i) => ({
      label: i.label,
      value: i.summary,
      tone: i.status === 'ok' ? 'ok' : i.status === 'warn' ? 'warn' : 'bad',
    })),
  });
  return out;
}

/** "Chrome 124 on Linux"-style summary of a user-agent string (best effort; the full string is in the report too). */
export function browserName(ua: string): string {
  const pick = (re: RegExp, name: string): string | null => {
    const m = re.exec(ua);
    return m ? `${name} ${m[1]}` : null;
  };
  return (
    pick(/Edg\/([\d.]+)/, 'Edge') ??
    pick(/OPR\/([\d.]+)/, 'Opera') ??
    pick(/Firefox\/([\d.]+)/, 'Firefox') ??
    pick(/(?:Chrome|HeadlessChrome|Chromium)\/([\d.]+)/, 'Chrome/Chromium') ??
    pick(/Version\/([\d.]+).*Safari/, 'Safari') ??
    (ua ? ua.slice(0, 60) : 'unknown')
  );
}

/** The text copied by "Copy diagnostics": pretty JSON, easy to paste into a bug report and to read. */
export function formatReport(r: ReportInput): string {
  const doc = {
    report: 'PhysixLab diagnostics',
    time: r.time,
    app: r.app,
    browser: { userAgent: r.userAgent, platform: r.platform, language: r.language, online: r.online },
    device: { cores: r.cores, deviceMemoryGB: r.deviceMemoryGB, screen: r.screen, viewport: r.viewport },
    gpu: r.gpu,
    capabilities: r.caps.items.map((i) => ({ id: i.id, status: i.status, summary: i.summary })),
    worker: r.worker,
    memory: r.memory,
    scene: r.scene,
    timings: r.timings,
    recentErrors: r.errors.map((e) => ({
      atMs: Math.round(e.t),
      kind: e.kind,
      message: e.message,
      source: e.source,
      count: e.count,
      stack: e.stack?.split('\n').slice(0, 8).join('\n'),
    })),
  };
  return JSON.stringify(doc, null, 2);
}
