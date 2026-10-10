// -- DT-2: the Record dialog, the recording indicator and the glue to the capture session (lazy-loaded) --
import type { App } from '../app/app';
import { downloadBlob } from '../app/capture/download';
import {
  CaptureCancelled,
  CaptureSession,
  CaptureUnavailable,
  detectVideoSupport,
  type CaptureProgress,
  type CaptureResult,
} from '../app/capture/session';
import {
  DEFAULT_CAPTURE,
  GIF_LIMITS,
  VIDEO_LIMITS,
  validateOptions,
  type CaptureFormat,
  type CaptureOptions,
} from '../app/capture/scheduler';
import { h } from './dom';
import { icon } from './icons';
import { openModal } from './modal';

const STORE_KEY = 'physixlab:capture:v1';

export interface ActiveCapture {
  stop(): void;
  cancel(): void;
  done: Promise<void>;
}

/** What a command asks the dialog to preselect. */
export type CapturePreset = 'video' | 'gif' | 'turntable';

declare global {
  interface Window {
    /** Set only while `__downloadHook` is on (e2e): a summary of the last finished capture. */
    __lastCapture?: {
      format: CaptureFormat;
      frames: number;
      width: number;
      height: number;
      size: number;
      hashes: string[];
      stoppedEarly: boolean;
    };
  }
}

function loadOptions(): CaptureOptions {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<CaptureOptions>;
      const o = { ...DEFAULT_CAPTURE };
      if (p.format === 'webm' || p.format === 'mp4' || p.format === 'gif') o.format = p.format;
      for (const k of ['width', 'fps', 'duration'] as const)
        if (typeof p[k] === 'number' && Number.isFinite(p[k])) o[k] = p[k];
      for (const k of ['deterministic', 'turntable', 'pauseSim', 'restart'] as const)
        if (typeof p[k] === 'boolean') o[k] = p[k];
      if (p.turntableTarget === 'scene' || p.turntableTarget === 'selection') o.turntableTarget = p.turntableTarget;
      return o;
    }
  } catch {
    /* storage unavailable: defaults */
  }
  return { ...DEFAULT_CAPTURE };
}

function saveOptions(o: CaptureOptions): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(o));
  } catch {
    /* ignore */
  }
}

const WIDTHS = [320, 480, 640, 960, 1280, 1920, 3840];
const GIF_FPS = [5, 8, 10, 12, 15, 20, 25, 30];
const VIDEO_FPS = [24, 30, 50, 60];

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function option(value: string | number, label: string): HTMLOptionElement {
  const o = document.createElement('option');
  o.value = String(value);
  o.textContent = label;
  return o;
}

export function openCaptureDialog(app: App, preset: CapturePreset, onStarted: (c: ActiveCapture) => void): void {
  const support = detectVideoSupport();
  const opts = loadOptions();
  // Preset from the command that opened the dialog.
  if (preset === 'gif') {
    opts.format = 'gif';
    opts.turntable = false;
    opts.deterministic = true;
  } else if (preset === 'turntable') {
    opts.turntable = true;
    if (opts.format !== 'gif' && !support[opts.format]) opts.format = 'gif';
  } else {
    opts.turntable = false;
    if (opts.format === 'gif') opts.format = support.webm ? 'webm' : support.mp4 ? 'mp4' : 'gif';
  }
  if (opts.format !== 'gif' && !support[opts.format]) opts.format = support.webm ? 'webm' : support.mp4 ? 'mp4' : 'gif';

  const vp = app.viewport.dom;
  const formatBtns = new Map<CaptureFormat, HTMLButtonElement>();
  const formatRow = h('div', { class: 'segmented compact cap-formats', role: 'group', 'aria-label': 'Format' });
  for (const f of ['webm', 'mp4', 'gif'] as const) {
    const ok = f === 'gif' || !!support[f];
    const b = h(
      'button',
      {
        class: 'seg-btn',
        type: 'button',
        dataset: { cap: `format-${f}` },
        disabled: !ok,
        title: ok
          ? f === 'gif'
            ? 'Animated GIF (own encoder, up to 960 px wide, 30 fps)'
            : `${f.toUpperCase()} video via MediaRecorder`
          : (support.reason ?? `This browser's MediaRecorder cannot write ${f.toUpperCase()}`),
      },
      f.toUpperCase(),
    );
    b.addEventListener('click', () => {
      opts.format = f;
      refresh();
    });
    formatBtns.set(f, b);
    formatRow.appendChild(b);
  }

  const widthSel = h('select', { class: 'select', dataset: { cap: 'width' } });
  const fpsSel = h('select', { class: 'select', dataset: { cap: 'fps' } });
  const duration = h('input', {
    class: 'plain cap-duration',
    type: 'number',
    min: '1',
    step: '0.5',
    dataset: { cap: 'duration' },
  });
  duration.value = String(opts.duration);
  const toggle = (key: 'deterministic' | 'turntable' | 'pauseSim' | 'restart', cap: string) => {
    const input = h('input', { type: 'checkbox', class: 'switch-input', dataset: { cap } });
    input.checked = opts[key];
    input.addEventListener('change', () => {
      opts[key] = input.checked;
      refresh();
    });
    return input;
  };
  const sw = (input: HTMLInputElement, label: string, hint: string) =>
    h(
      'label',
      { class: 'switch cap-switch', title: hint },
      input,
      h('span', { class: 'switch-track' }, h('span', { class: 'switch-thumb' })),
      h('span', { class: 'switch-label' }, label),
    );
  const detInput = toggle('deterministic', 'deterministic');
  const turnInput = toggle('turntable', 'turntable');
  const pauseInput = toggle('pauseSim', 'pause-sim');
  const restartInput = toggle('restart', 'restart');
  const targetSel = h('select', { class: 'select', dataset: { cap: 'target' } });
  targetSel.append(option('selection', 'Selection (whole scene if none)'), option('scene', 'Whole scene'));
  targetSel.value = opts.turntableTarget;
  targetSel.addEventListener('change', () => {
    opts.turntableTarget = targetSel.value as 'selection' | 'scene';
  });

  const info = h('p', { class: 'sub cap-info' });
  const errors = h('div', { class: 'cap-errors', role: 'alert' });
  const startBtn = h(
    'button',
    { class: 'btn primary', type: 'button', dataset: { cap: 'start' } },
    icon('camera'),
    'Start',
  );
  const cancelBtn = h('button', { class: 'btn', type: 'button' }, 'Cancel');

  const field = (label: string, el: HTMLElement) =>
    h('div', { class: 'row' }, h('div', { class: 'row-label' }, label), h('div', { class: 'row-control' }, el));
  const wrapSel = (s: HTMLSelectElement) =>
    h('div', { class: 'select-wrap' }, s, icon('chevronDown', 'icon select-caret'));

  let validation = validateOptions(opts, vp.width, vp.height);
  function refresh(): void {
    const gif = opts.format === 'gif';
    for (const [f, b] of formatBtns) b.classList.toggle('on', f === opts.format);
    // Size and rate choices follow the format's limits.
    const maxW = gif ? GIF_LIMITS.maxWidth : VIDEO_LIMITS.maxWidth;
    const widths = WIDTHS.filter((w) => w <= maxW);
    if (!widths.includes(opts.width))
      opts.width = widths.reduce((a, b) => (Math.abs(b - opts.width) < Math.abs(a - opts.width) ? b : a));
    widthSel.replaceChildren(
      ...widths.map((w) =>
        option(w, `${w} × ${validateOptions({ ...opts, width: w }, vp.width, vp.height).height} px`),
      ),
    );
    widthSel.value = String(opts.width);
    const rates = gif ? GIF_FPS : VIDEO_FPS;
    if (!rates.includes(opts.fps))
      opts.fps = rates.reduce((a, b) => (Math.abs(b - opts.fps) < Math.abs(a - opts.fps) ? b : a));
    fpsSel.replaceChildren(...rates.map((r) => option(r, `${r} fps`)));
    fpsSel.value = String(opts.fps);
    const pr = turnInput.checked !== opts.turntable;
    if (pr) turnInput.checked = opts.turntable;
    pauseInput.disabled = !opts.turntable;
    pauseInput.closest('label')?.classList.toggle('disabled', !opts.turntable);
    targetSel.disabled = !opts.turntable;
    restartInput.disabled = !opts.deterministic || (opts.turntable && opts.pauseSim);
    restartInput.closest('label')?.classList.toggle('disabled', restartInput.disabled);
    validation = validateOptions(opts, vp.width, vp.height);
    errors.replaceChildren(...validation.errors.map((e) => h('div', null, e)));
    startBtn.disabled = validation.errors.length > 0;
    const steps = Math.round(app.store.settings.physicsHz / Math.max(1, opts.fps));
    const parts = [
      `${validation.frames} frames of ${opts.width} × ${validation.height}`,
      opts.deterministic
        ? opts.turntable && opts.pauseSim
          ? 'simulation held still'
          : `about ${steps} physics step${steps === 1 ? '' : 's'} per frame, independent of machine speed`
        : 'real time: the clip shows whatever the simulation does while it is recorded',
    ];
    if (opts.deterministic && opts.format !== 'gif')
      parts.push(
        'MediaRecorder stamps frames with the wall clock, so the picture is reproducible but the capture runs in real time',
      );
    info.textContent = parts.join('. ') + '.';
  }

  const body = h(
    'div',
    { class: 'cap-form' },
    field('Format', formatRow),
    field('Size', wrapSel(widthSel)),
    field('Frame rate', wrapSel(fpsSel)),
    field('Duration', h('div', { class: 'cap-dur' }, duration, h('span', { class: 'num-unit' }, 's'))),
    h(
      'div',
      { class: 'cap-switches' },
      sw(
        detInput,
        'Deterministic (fixed timestep)',
        'Pause the live loop and advance the simulation frame by frame, so the output does not depend on how fast this machine is',
      ),
      sw(
        restartInput,
        'Restart simulation first',
        'Rebuild the simulation from the scene so the capture starts at t = 0',
      ),
      sw(turnInput, 'Turntable (orbit 360°)', 'Orbit the camera once around the selection or the scene'),
      sw(pauseInput, 'Freeze simulation while orbiting', 'Keep the simulation paused during the turntable'),
    ),
    field('Orbit around', wrapSel(targetSel)),
    errors,
    info,
    h('p', { class: 'sub cap-hint' }, 'Esc cancels a running capture. Keep this tab visible while capturing.'),
  );

  duration.addEventListener('input', () => {
    opts.duration = Number(duration.value);
    refresh();
  });
  widthSel.addEventListener('change', () => {
    opts.width = Number(widthSel.value);
    refresh();
  });
  fpsSel.addEventListener('change', () => {
    opts.fps = Number(fpsSel.value);
    refresh();
  });
  // Typing in the dialog must not trigger the editor's shortcuts.
  body.addEventListener('keydown', (e) => e.stopPropagation());

  const modal = openModal({
    title: preset === 'gif' ? 'Record animated GIF' : preset === 'turntable' ? 'Record turntable' : 'Record video',
    body,
    footer: [cancelBtn, startBtn],
    width: '480px',
  });
  cancelBtn.addEventListener('click', () => modal.close());
  startBtn.addEventListener('click', () => {
    if (validation.errors.length) return;
    const chosen: CaptureOptions = { ...validation.value };
    saveOptions(chosen);
    modal.close();
    onStarted(startCapture(app, chosen));
  });
  refresh();
  setTimeout(() => startBtn.focus(), 30);
}

/** Start a capture: indicator, Esc handling, progress, saving the file, toasts. */
export function startCapture(app: App, options: CaptureOptions): ActiveCapture {
  const label = h('span', { class: 'cap-label' }, 'Preparing…');
  const stopBtn = h(
    'button',
    {
      class: 'btn danger cap-stop',
      type: 'button',
      title: 'Stop and save what was captured',
      dataset: { cap: 'stop' },
    },
    'Stop',
  );
  const cancelBtn = h(
    'button',
    { class: 'btn cap-cancel', type: 'button', title: 'Discard the capture (Esc)', dataset: { cap: 'cancel' } },
    'Cancel',
  );
  const bar = h('div', { class: 'cap-bar' }, h('div', { class: 'cap-bar-fill' }));
  const indicator = h(
    'div',
    { class: 'capture-indicator', role: 'status', 'aria-live': 'polite' },
    h('span', { class: 'cap-dot', 'aria-hidden': 'true' }),
    h('span', { class: 'cap-rec' }, options.format === 'gif' ? 'GIF' : 'REC'),
    label,
    stopBtn,
    cancelBtn,
    bar,
  );
  document.body.appendChild(indicator);
  const fill = bar.firstElementChild as HTMLElement;

  const onProgress = (p: CaptureProgress) => {
    const pct = p.total ? Math.min(100, (p.frame / p.total) * 100) : 0;
    fill.style.width = `${pct}%`;
    indicator.classList.toggle('encoding', p.phase === 'encoding' || p.phase === 'finishing');
    if (p.phase === 'preparing') label.textContent = 'Preparing…';
    else if (p.phase === 'encoding') label.textContent = `Encoding GIF ${p.frame}/${p.total}`;
    else if (p.phase === 'finishing') label.textContent = 'Finishing…';
    else if (options.format === 'gif' || options.deterministic)
      label.textContent = `Frame ${p.frame}/${p.total} · ${fmtTime(p.seconds)} / ${fmtTime(options.duration)}`;
    else label.textContent = `${fmtTime(p.seconds)} / ${fmtTime(options.duration)}`;
  };
  const session = new CaptureSession(app, options, onProgress);
  const cancel = () => session.cancel();
  const stop = () => session.stop();
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  };
  window.addEventListener('keydown', onKey, true);
  stopBtn.addEventListener('click', stop);
  cancelBtn.addEventListener('click', cancel);
  app.toast(`Recording ${options.format.toUpperCase()}… press Esc to cancel`, 'info');

  const done = session
    .run()
    .then((r: CaptureResult) => {
      downloadBlob(r.blob, r.filename);
      if (window.__downloadHook) {
        window.__lastCapture = {
          format: r.format,
          frames: r.frames,
          width: r.width,
          height: r.height,
          size: r.blob.size,
          hashes: r.hashes,
          stoppedEarly: r.stoppedEarly,
        };
      }
      const kb = r.blob.size / 1024;
      app.toast(
        `Saved ${r.filename} (${kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`}, ${r.frames} frames${r.stoppedEarly ? ', stopped early' : ''})`,
        'success',
      );
    })
    .catch((e: unknown) => {
      if (e instanceof CaptureCancelled) app.toast('Capture cancelled — nothing was saved', 'info');
      else if (e instanceof CaptureUnavailable) app.toast(e.message, 'error');
      else {
        console.error('[capture]', e);
        app.toast(`Capture failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
      }
    })
    .finally(() => {
      window.removeEventListener('keydown', onKey, true);
      indicator.remove();
    });
  return { stop, cancel, done };
}
