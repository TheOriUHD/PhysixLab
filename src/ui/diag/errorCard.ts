/**
 * The error cards (UI-43): the recovery card shown over a running app when something throws, and the screen shown
 * instead of the app when it cannot start. Plain-language text, a "Copy diagnostics" button, and recovery options that
 * never throw the user's scene away without saying so: anything that replaces the scene on screen asks for a second
 * click first and says what it will do.
 */
import type { App } from '../../app/app';
import type { CapReport } from './capabilities';
import { h } from '../dom';
import { formatReport, type ReportInput } from './report';

/** Copy text to the clipboard; falls back to a hidden textarea where the async API is blocked. Resolves to success. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = h('textarea', { style: 'position:fixed;left:-9999px;top:0', 'aria-hidden': 'true' });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** Remove the stored layout and preferences (never scenes: those are in IndexedDB, under other keys). */
export function resetPreferences(storage: Pick<Storage, 'length' | 'key' | 'removeItem'> = localStorage): string[] {
  const doomed: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    // Scene data in the legacy localStorage layout must survive a "reset".
    if (k && /^physicslab[:.]/.test(k) && !/autosave|library|scene/i.test(k)) doomed.push(k);
  }
  for (const k of doomed) storage.removeItem(k);
  return doomed;
}

interface ActionSpec {
  label: string;
  title: string;
  run: () => void | Promise<void>;
  /** Ask for a second click, showing this text, before running. */
  confirm?: string;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
}

function actionButton(a: ActionSpec): HTMLButtonElement {
  const b = h(
    'button',
    { class: `btn${a.primary ? ' primary' : ''}${a.danger ? ' danger' : ''}`, type: 'button', title: a.title },
    a.label,
  );
  if (a.disabled) b.disabled = true;
  let armed = false;
  let timer = 0;
  b.addEventListener('click', () => {
    if (a.confirm && !armed) {
      armed = true;
      b.textContent = a.confirm;
      b.classList.add('danger');
      timer = window.setTimeout(() => {
        armed = false;
        b.textContent = a.label;
        b.classList.toggle('danger', !!a.danger);
      }, 6000);
      return;
    }
    window.clearTimeout(timer);
    armed = false;
    b.textContent = a.label;
    void a.run();
  });
  return b;
}

/** "Copy diagnostics" button: the label confirms for a moment. */
export function copyDiagnosticsButton(getReport: () => ReportInput): HTMLButtonElement {
  const b = actionButton({
    label: 'Copy diagnostics',
    title: 'Copy a text report (browser, graphics card, limits, recent errors, scene summary) to paste into a bug report',
    run: async () => {
      const ok = await copyText(formatReport(getReport()));
      b.textContent = ok ? 'Copied' : 'Copy failed: select it in the Diagnostics panel';
      window.setTimeout(() => (b.textContent = 'Copy diagnostics'), 2500);
    },
  });
  return b;
}

export interface CardOptions {
  title: string;
  /** Plain-language explanation (paragraphs). */
  explanation: string[];
  /** Technical detail (message and the first stack lines), shown small. */
  detail?: string;
  caps?: CapReport;
  /** Additional errors since the card appeared. */
  more?: number;
  /** Errors are repeating quickly. */
  looping?: boolean;
  actions: ActionSpec[];
  /** Always-visible reassurance about the user's work. */
  safety: string;
  getReport: () => ReportInput;
  boot?: boolean;
}

export interface CardHandle {
  el: HTMLElement;
  /** Update the "N more errors" line. */
  setMore(n: number, looping: boolean): void;
  close(): void;
}

export function buildCard(o: CardOptions): CardHandle {
  const more = h('p', { class: 'err-more', role: 'status' });
  const setMore = (n: number, looping: boolean) => {
    more.textContent = n
      ? `${n} more ${n === 1 ? 'error' : 'errors'} happened since this card appeared${looping ? ': errors are repeating, so reloading is the safest option' : '.'}`
      : '';
    more.style.display = n ? '' : 'none';
  };
  setMore(o.more ?? 0, !!o.looping);
  const capList = o.caps
    ? h(
        'ul',
        { class: 'cap-list' },
        ...o.caps.items
          .filter((i) => i.status !== 'ok')
          .map((i) =>
            h('li', { class: i.status }, h('b', null, `${i.label}: `), i.summary, i.guidance ? ` ${i.guidance}` : ''),
          ),
      )
    : null;
  const actions = h('div', { class: 'err-actions' }, ...o.actions.map(actionButton));
  const card = h(
    'div',
    { class: 'err-card', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': o.title },
    h('h2', null, o.title),
    ...o.explanation.map((t) => h('p', null, t)),
    capList,
    o.detail ? h('div', { class: 'err-detail', title: 'Technical detail' }, o.detail) : null,
    more,
    h('h3', null, 'What you can do'),
    actions,
    h('p', { class: 'err-safety' }, o.safety),
    h('div', { class: 'err-actions', style: { marginTop: '10px' } }, copyDiagnosticsButton(o.getReport)),
  );
  const el = h('div', { class: `err-screen${o.boot ? ' boot' : ''}` }, card);
  return { el, setMore, close: () => el.remove() };
}

// ── the recovery card of a running app ─────────────────────────────────────────────────────────

export interface RuntimeCardArgs {
  app: App | null;
  message: string;
  stack?: string;
  source?: string;
  getReport: () => ReportInput;
  onClose: () => void;
}

export function showRuntimeCard(a: RuntimeCardArgs): CardHandle {
  const { app } = a;
  const close = () => {
    handle.close();
    a.onClose();
  };
  const actions: ActionSpec[] = [
    { label: 'Keep working', title: 'Close this card and carry on; the app may still be fine', run: close, primary: true },
  ];
  if (app) {
    const auto = app.persistence.loadAutosave();
    actions.push(
      {
        label: 'Download scene (JSON)',
        title: 'Save the scene as it is on screen to a file first, so nothing can be lost',
        run: () => app.persistence.exportFile(),
      },
      {
        label: 'Reload',
        title: 'Reload the page. The scene on screen is autosaved first and comes back after the reload',
        run: () => {
          app.persistence.saveNow();
          void app.persistence.flush().finally(() => location.reload());
        },
      },
      {
        label: 'Restore last autosave',
        title: auto
          ? `Replace the scene on screen with the last autosaved copy (“${auto.name}”, ${auto.entities.length} objects)`
          : 'There is no autosaved copy yet',
        confirm: 'Click again: this replaces the scene on screen',
        disabled: !auto,
        run: () => {
          if (auto) app.loadDocument(auto, 'frame');
          close();
        },
      },
      {
        label: 'Reset layout and preferences',
        title: 'Restore the default panels and settings (scenes are not touched) and reload',
        confirm: 'Click again: resets panels and settings, then reloads',
        run: () => {
          app.persistence.saveNow();
          resetPreferences();
          void app.persistence.flush().finally(() => location.reload());
        },
      },
      {
        label: 'Start empty',
        title: 'Replace the scene on screen with an empty one (download it first if you want to keep it)',
        confirm: 'Click again: this replaces the scene on screen',
        danger: true,
        run: () => {
          app.newScene();
          close();
        },
      },
    );
  } else {
    actions.push({ label: 'Reload', title: 'Reload the page', run: () => location.reload() });
  }
  const detail = [a.message, a.source ? `at ${a.source}` : '', ...(a.stack ? a.stack.split('\n').slice(0, 4) : [])]
    .filter(Boolean)
    .join('\n');
  const handle = buildCard({
    title: 'Something went wrong',
    explanation: [
      'PhysicsLab hit an unexpected error. The app may still work, or part of it may be stuck.',
      'Nothing has been deleted. If you want to be sure, download your scene first, then choose one of the options below.',
    ],
    detail,
    actions,
    safety:
      'Your scene is autosaved in this browser as you work. “Download scene” keeps a copy in a file. Options that replace the scene on screen ask for a second click.',
    getReport: a.getReport,
  });
  document.body.appendChild(handle.el);
  (handle.el.querySelector('.btn.primary') as HTMLElement | null)?.focus();
  handle.el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  return handle;
}

// ── the start-up failure screen ────────────────────────────────────────────────────────────────

export function showBootScreen(root: HTMLElement, o: { error: unknown; caps: CapReport; getReport: () => ReportInput }): void {
  const msg = o.error instanceof Error ? o.error.message : String(o.error ?? '');
  const stack = o.error instanceof Error ? o.error.stack : undefined;
  const missing = o.caps.fatal;
  const handle = buildCard({
    boot: true,
    title: 'PhysicsLab couldn’t start',
    explanation: missing
      ? [
          o.caps.headline,
          'Nothing is wrong with your scenes: they are stored in this browser and will be there once PhysicsLab can run. Here is what to try:',
        ]
      : [
          'PhysicsLab ran into a problem while starting. Reloading often fixes it; if it keeps happening, copy the diagnostics and send them with a bug report.',
          'Your scenes are stored in this browser and have not been touched.',
        ],
    caps: o.caps,
    detail: missing ? undefined : [msg, ...(stack ? stack.split('\n').slice(0, 4) : [])].filter(Boolean).join('\n'),
    actions: [
      { label: 'Reload', title: 'Try again', run: () => location.reload(), primary: true },
      {
        label: 'Reset layout and preferences',
        title: 'Forget the saved panel layout and settings (scenes are not touched) and reload',
        confirm: 'Click again: resets panels and settings, then reloads',
        run: () => {
          resetPreferences();
          location.reload();
        },
      },
    ],
    safety: 'None of these buttons deletes a scene.',
    getReport: o.getReport,
  });
  root.replaceChildren(handle.el);
}
