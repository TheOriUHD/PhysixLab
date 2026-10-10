/**
 * DT-32: the "Scene script" dialog. Loaded on demand (see src/ui/extensions/scene-script.ts → lazy()).
 */
import type { App } from '../app/app';
import { button } from '../ui/controls';
import { h } from '../ui/dom';
import { openModal } from '../ui/modal';
import { applyScriptScene, type ApplyMode } from './apply';
import { SCRIPT_EXAMPLES } from './examples';
import { runSceneScript, ScriptFailure, SCRIPT_LIMITS, type ScriptRun } from './run';

const STORAGE_KEY = 'physixlab.sceneScript';

function remembered(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? SCRIPT_EXAMPLES[0].code;
  } catch {
    return SCRIPT_EXAMPLES[0].code;
  }
}

function remember(code: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, code.slice(0, SCRIPT_LIMITS.maxCodeChars));
  } catch {
    /* storage blocked or full: the script just is not remembered */
  }
}

export function openSceneScriptDialog(app: App): void {
  const editor = h('textarea', {
    class: 'dtb-code',
    spellcheck: false,
    autocapitalize: 'off',
    'aria-label': 'Scene script (JavaScript)',
    value: remembered(),
    wrap: 'off',
  });
  const status = h('div', { class: 'dtb-status', role: 'status', 'aria-live': 'polite' });
  const hint = h(
    'div',
    { class: 'dtb-note' },
    'Tab indents · Shift+Tab leaves the editor · Ctrl+Enter replaces the scene',
  );
  const log = h('pre', { class: 'dtb-log', 'aria-label': 'Script output' });
  let busy = false;

  const examples = h(
    'select',
    { class: 'plain dtb-examples', title: 'Load an example script', 'aria-label': 'Examples' },
    h('option', { value: '' }, 'Examples…'),
    ...SCRIPT_EXAMPLES.map((e) => h('option', { value: e.id, title: e.blurb }, e.title)),
  );
  examples.addEventListener('change', () => {
    const ex = SCRIPT_EXAMPLES.find((e) => e.id === examples.value);
    if (ex) {
      editor.value = ex.code;
      status.textContent = ex.blurb;
      status.className = 'dtb-status';
      log.textContent = '';
    }
    examples.value = '';
  });

  editor.addEventListener('keydown', (e) => {
    e.stopPropagation(); // typing must never trigger the app's shortcuts
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: t } = editor;
      editor.setRangeText('  ', s, t, 'end');
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void run('replace');
    }
  });
  editor.addEventListener('input', () => remember(editor.value));

  const show = (kind: 'ok' | 'error' | 'busy', text: string) => {
    status.className = `dtb-status ${kind}`;
    status.textContent = text;
  };
  const showLogs = (logs: ScriptRun['logs']) => {
    log.textContent = logs.map((l) => (l.level === 'log' ? l.text : `${l.level}: ${l.text}`)).join('\n');
  };

  async function run(mode: ApplyMode): Promise<void> {
    if (busy) return;
    if (app.sim.active) app.sim.reset();
    busy = true;
    buttons.forEach((b) => (b.disabled = true));
    show('busy', 'Running in the sandbox…');
    try {
      const r = await runSceneScript(editor.value);
      const n = applyScriptScene(app.store, r.doc, mode);
      showLogs(r.logs);
      const warnings = r.report.warnings.length
        ? ` · ${r.report.warnings.length} value(s) repaired: ${r.report.warnings[0]}`
        : '';
      show(
        'ok',
        `${mode === 'replace' ? 'Built' : 'Added'} ${n} object${n === 1 ? '' : 's'} in ${r.ms} ms${warnings}. Undo (Ctrl+Z) reverts it in one step.`,
      );
      app.frameAll(false);
    } catch (e) {
      if (e instanceof ScriptFailure) {
        showLogs(e.logs);
        show('error', e.line ? `Line ${e.line}: ${e.message}` : e.message);
        if (e.line) {
          const start =
            editor.value
              .split('\n')
              .slice(0, e.line - 1)
              .join('\n').length + (e.line > 1 ? 1 : 0);
          editor.focus();
          editor.setSelectionRange(start, start);
        }
      } else {
        show('error', `Could not run the script: ${(e as Error).message}`);
      }
    } finally {
      busy = false;
      buttons.forEach((b) => (b.disabled = false));
    }
  }

  const replaceBtn = button('Replace scene', () => void run('replace'), { cls: 'primary' });
  replaceBtn.title = 'Build the scene from the script, replacing everything (Ctrl+Enter). One undo step.';
  const addBtn = button('Add to scene', () => void run('add'));
  addBtn.title = 'Add the script’s objects to the current scene. One undo step.';
  const buttons = [replaceBtn, addBtn];

  const help = h(
    'details',
    { class: 'dtb-help' },
    h('summary', null, 'Builder DSL reference'),
    h(
      'ul',
      null,
      ...[
        "body(name, shape, size, position, opts) — shape: 'box' 'sphere' 'cylinder' 'capsule' 'cone' 'wedge' …; opts: { material, bodyType, rotation, … }; returns a handle",
        "soft(name, 'jelly' | 'balloon' | 'cloth' | 'cable', position, opts)",
        "joint(type, bodyA, bodyB, worldPoint, axis, opts) — 'hinge' 'slider' 'ball' 'fixed' …; null = the world",
        "tether('spring' | 'rope', bodyA, pointA, bodyB, pointB, opts)",
        'array(n, i => …) · grid(nx, ny, dx, dy, (x, y, i, j) => …) · ring(n, radius, (x, y, angle, i) => …) · range(a, b, step)',
        'rotX(deg) · rotY(deg) · rotZ(deg) → quaternion · DEG · Math · random() / seed(n) (deterministic)',
        'name(text) · settings({ gravity: [0, -3.7, 0], … }) · console.log(…)',
      ].map((t) => h('li', null, t)),
    ),
    h(
      'p',
      { class: 'dtb-note' },
      `The script runs in an isolated sandbox: no network, no page or storage access, at most ${SCRIPT_LIMITS.timeoutMs / 1000} s and 20 000 calls. It only describes objects; PhysixLab validates and builds them.`,
    ),
  );

  openModal({
    title: 'Scene script',
    width: 'min(880px, 94vw)',
    body: [
      h('div', { class: 'dtb-bar' }, examples, h('span', { class: 'dtb-spacer' }), ...buttons),
      editor,
      hint,
      status,
      log,
      help,
    ],
  });
  editor.focus();
}
