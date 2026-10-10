/**
 * Wiring of the error boundary (UI-43), called from `src/main.ts`:
 *
 *   installDiagnostics()      first thing: window `error` / `unhandledrejection` handlers and the console-error log
 *   preflight()               capability check; shows the "can't start" screen and returns false when something
 *                             essential is missing
 *   attachDiagnostics(app)    once the app exists: recovery options can now act on the scene; degraded-mode notice
 *   showBootFailure(error)    what `boot().catch` shows instead of a bare message
 */
import type { App } from '../../app/app';
import { h } from '../dom';
import { capabilityReport, collectReport } from './collect';
import { showBootScreen, showRuntimeCard, type CardHandle } from './errorCard';
import { ErrorGate, ErrorLog, describeError, isIgnorableError } from './errorLog';

/** The last errors of this page (also read by the Diagnostics panel and "Copy diagnostics"). */
export const errorLog = new ErrorLog(30);

const gate = new ErrorGate();
let attached: App | null = null;
let card: CardHandle | null = null;
let installed = false;
let bootScreenShown = false;

const getReport = () => collectReport(attached, errorLog);

function handle(kind: 'error' | 'rejection', x: unknown, source?: string): void {
  const d = describeError(x);
  if (isIgnorableError(d.message, source)) return;
  const now = performance.now();
  errorLog.push({ t: now, kind, message: d.message, stack: d.stack, source });
  if (bootScreenShown) return;
  switch (gate.report(now)) {
    case 'card':
      try {
        card = showRuntimeCard({
          app: attached,
          message: d.message,
          stack: d.stack,
          source,
          getReport,
          onClose: () => {
            card = null;
            gate.closed(performance.now());
          },
        });
      } catch (e) {
        // The error screen must never raise errors of its own.
        console.warn('[diagnostics] could not show the error card', e);
        gate.closed(performance.now());
      }
      break;
    case 'count':
      card?.setMore(gate.suppressed, gate.looping(now));
      break;
    case 'toast':
      attached?.toast('Another error happened. Details are in the Diagnostics panel.', 'error');
      break;
    case 'quiet':
      break;
  }
}

/** Install the global handlers. Safe to call more than once. */
export function installDiagnostics(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('error', (e: ErrorEvent) => {
    const src = e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : undefined;
    handle('error', e.error ?? e.message, src);
  });
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => handle('rejection', e.reason));
  // Keep the last console errors for the report (the originals still run).
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    try {
      const message = args
        .map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : describeError(a).message))
        .join(' ');
      const first = args.find((a): a is Error => a instanceof Error);
      errorLog.push({ t: performance.now(), kind: 'console', message: message.slice(0, 500), stack: first?.stack });
    } catch {
      /* logging must never throw */
    }
    original(...args);
  };
}

/** Check the browser. Returns false (after showing the explanation) when the app cannot run here. */
export function preflight(): boolean {
  const caps = capabilityReport();
  if (!caps.fatal) return true;
  bootScreenShown = true;
  showBootScreen(document.getElementById('app') ?? document.body, {
    error: new Error(caps.headline),
    caps,
    getReport,
  });
  return false;
}

/** The app exists: recovery options can now act on the scene, and a degraded-mode notice is shown if needed. */
export function attachDiagnostics(app: App): void {
  attached = app;
  const caps = capabilityReport();
  if (!caps.degraded) return;
  const warn = caps.items.filter((i) => i.status === 'warn');
  const close = h(
    'button',
    { class: 'icon-btn small', type: 'button', title: 'Dismiss', 'aria-label': 'Dismiss this notice' },
    '×',
  );
  const bar = h(
    'div',
    { class: 'degraded-bar', role: 'status' },
    h('span', null, `${warn.map((i) => i.guidance).join(' ')}`),
    close,
  );
  close.addEventListener('click', () => bar.remove());
  document.body.appendChild(bar);
}

/** Replace the app with the "can't start" screen (what `boot().catch` calls). */
export function showBootFailure(error: unknown): void {
  console.error(error);
  bootScreenShown = true;
  card?.close();
  try {
    showBootScreen(document.getElementById('app') ?? document.body, { error, caps: capabilityReport(), getReport });
  } catch (e) {
    // Last resort: plain text, never a blank page.
    document.body.textContent = `PhysixLab couldn’t start: ${describeError(error).message} (${describeError(e).message})`;
  }
}
