/** Settings › Keyboard / Gamepad: rebinding, presets, import / export, vehicle profiles and axis tuning. */
import type { App } from '../../app/app';
import { DEFAULT_AXIS, type AxisCfg } from '../../app/input/axes';
import { chordFromEvent } from '../../app/input/chord';
import { PAD_BUTTONS, padLabel } from '../../app/input/gamepad';
import { inputMap, type BindingRow } from '../../app/input/inputMap';
import { PRESETS, presetById } from '../../app/input/presets';
import { PROFILES, profileById } from '../../app/input/profiles';
import { COMMAND_CATEGORY_ORDER } from '../../app/registry/commands';
import { formatShortcut } from '../../app/registry/shortcuts';
import { button, selectField, sliderField, toggleField, row } from '../controls';
import { h } from '../dom';
import { icon } from '../icons';
import { openModal } from '../modal';

type TabId = 'keyboard' | 'gamepad' | 'touch';

export function showInputSettings(app: App, tab: TabId = 'keyboard'): void {
  const body = h('div', { class: 'input-settings' });
  const tabs = h('div', { class: 'seg-tabs', role: 'tablist' });
  let current: TabId = tab;
  let stopLive: (() => void) | null = null;
  const render = () => {
    stopLive?.();
    stopLive = null;
    for (const b of tabs.querySelectorAll('button')) b.classList.toggle('on', b.dataset.tab === current);
    body.replaceChildren(
      current === 'keyboard'
        ? keyboardTab()
        : current === 'gamepad'
          ? gamepadTab(app, (s) => (stopLive = s))
          : touchTab(app),
    );
  };
  for (const [id, label] of [
    ['keyboard', 'Keyboard'],
    ['gamepad', 'Gamepad & axes'],
    ['touch', 'Touch'],
  ] as const) {
    const b = h('button', { class: 'seg-btn', type: 'button', role: 'tab', dataset: { tab: id } }, label);
    b.addEventListener('click', () => {
      current = id;
      render();
    });
    tabs.appendChild(b);
  }
  const m = openModal({
    title: 'Input settings',
    body: [tabs, body],
    width: '860px',
    onClose: () => stopLive?.(),
  });
  m.el.classList.add('input-modal');
  render();
}

// ---- keyboard ----------------------------------------------------------------------------------

function keyboardTab(): HTMLElement {
  const root = h('div', { class: 'kb-tab' });
  const list = h('div', { class: 'kb-list' });
  const filter = h('input', { class: 'plain', type: 'search', placeholder: 'Filter commands…', spellcheck: false });
  filter.addEventListener('keydown', (e) => e.stopPropagation());
  filter.addEventListener('input', () => renderList());
  const presetSel = selectField({
    options: PRESETS.map((p) => ({ value: p.id, label: p.label })),
    value: PRESETS.some((p) => p.id === inputMap.preset) ? inputMap.preset : 'default',
    onChange: (id) => {
      const p = presetById(id);
      if (p) inputMap.applyPreset(p);
    },
  });
  const presetNote = h('p', { class: 'hint-text' });
  const status = h('p', { class: 'kb-status', role: 'status' });
  const exportBtn = button('Export…', () => {
    const blob = new Blob([inputMap.exportJson()], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'physicslab-keybindings.json' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  const importBtn = button('Import…', () => {
    const inp = h('input', { type: 'file', accept: 'application/json,.json' });
    inp.addEventListener('change', () => {
      const f = inp.files?.[0];
      if (!f) return;
      void f.text().then((text) => {
        try {
          const r = inputMap.importJson(text);
          status.textContent = `Imported ${r.applied} binding${r.applied === 1 ? '' : 's'}${r.skipped ? `, skipped ${r.skipped} unknown or invalid` : ''}.`;
        } catch (e) {
          status.textContent = (e as Error).message;
        }
      });
    });
    inp.click();
  });
  const resetAll = button('Reset all', () => {
    inputMap.resetAll();
    status.textContent = 'All bindings are back to the defaults.';
  });
  root.append(
    h(
      'div',
      { class: 'kb-toolbar' },
      h('label', { class: 'kb-preset' }, h('span', null, 'Layout'), presetSel.el),
      filter,
      exportBtn,
      importBtn,
      resetAll,
    ),
    presetNote,
    status,
    list,
  );

  let listening: { cancel: () => void } | null = null;

  function rebindSlot(rowData: BindingRow, slot: number, btn: HTMLElement): void {
    listening?.cancel();
    btn.classList.add('listening');
    btn.textContent = 'Press keys…';
    const finish = () => {
      window.removeEventListener('keydown', onKey, true);
      listening = null;
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') {
        finish();
        renderList();
        return;
      }
      if (
        (e.code === 'Backspace' || e.code === 'Delete') &&
        !e.ctrlKey &&
        !e.metaKey &&
        slot < rowData.shortcuts.length
      ) {
        finish();
        inputMap.unbind(rowData.id, slot);
        return;
      }
      const chord = chordFromEvent(e);
      if (!chord) return; // a bare modifier: keep waiting for the real key
      finish();
      const res = inputMap.rebind(rowData.id, slot, chord);
      if (!res.ok && res.conflict) {
        status.replaceChildren(
          `${formatShortcut(chord)} is already “${res.conflict.label}”. `,
          button(
            'Take it over',
            () => {
              inputMap.rebind(rowData.id, slot, chord, true);
              status.textContent = `“${rowData.label}” now uses ${formatShortcut(chord)}; “${res.conflict?.label}” lost it.`;
            },
            { cls: 'small' },
          ),
        );
        renderList();
      } else status.textContent = `“${rowData.label}” → ${formatShortcut(chord)}`;
    };
    window.addEventListener('keydown', onKey, true);
    listening = {
      cancel: () => {
        finish();
        renderList();
      },
    };
  }

  function renderList(): void {
    const q = filter.value.trim().toLowerCase();
    const rows = inputMap
      .rows()
      .filter((r) => r.kind === 'action' || r.defaults.length > 0 || r.shortcuts.length > 0 || r.category !== 'Edit')
      .filter((r) => !q || `${r.label} ${r.category} ${r.shortcuts.join(' ')}`.toLowerCase().includes(q));
    const rank = (c: string) => {
      const i = COMMAND_CATEGORY_ORDER.indexOf(c);
      return i < 0 ? COMMAND_CATEGORY_ORDER.length : i;
    };
    const cats = [...new Set(rows.map((r) => r.category))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    list.replaceChildren();
    for (const cat of cats) {
      list.appendChild(h('div', { class: 'kb-cat' }, cat));
      for (const r of rows.filter((x) => x.category === cat)) {
        const slots = h('div', { class: 'kb-slots' });
        r.shortcuts.forEach((s, i) => {
          const b = h('button', {
            class: 'kb-slot',
            type: 'button',
            title: 'Click to rebind · Backspace while listening clears',
          });
          b.append(
            ...formatShortcut(s)
              .split(/(?=\+)|\+/)
              .filter(Boolean)
              .map((t) => h('kbd', null, t)),
          );
          b.addEventListener('click', () => rebindSlot(r, i, b));
          slots.appendChild(b);
        });
        if (r.shortcuts.length < 3) {
          const add = h(
            'button',
            { class: 'kb-slot add', type: 'button', title: 'Add another key' },
            r.shortcuts.length ? '+' : 'Unbound — click to set',
          );
          add.addEventListener('click', () => rebindSlot(r, r.shortcuts.length, add));
          slots.appendChild(add);
        }
        const reset = h(
          'button',
          { class: 'icon-btn kb-reset', type: 'button', title: 'Reset to the default' },
          icon('undo'),
        );
        reset.style.visibility = r.custom ? 'visible' : 'hidden';
        reset.addEventListener('click', () => inputMap.reset(r.id));
        list.appendChild(
          h(
            'div',
            { class: `kb-row${r.custom ? ' custom' : ''}` },
            h('span', { class: 'kb-label' }, r.label, r.scope ? h('em', null, ` · ${r.scope}`) : null),
            slots,
            reset,
          ),
        );
      }
    }
    if (!rows.length) list.appendChild(h('div', { class: 'empty-state' }, h('h4', null, 'No command matches')));
    const p = presetById(inputMap.preset);
    presetNote.textContent = p
      ? p.blurb
      : inputMap.preset === 'custom'
        ? 'Custom layout — your own changes on top of a preset.'
        : '';
    presetSel.set(PRESETS.some((x) => x.id === inputMap.preset) ? inputMap.preset : 'default');
  }
  const off = inputMap.on('change', renderList);
  const obs = new MutationObserver(() => {
    if (!root.isConnected) {
      off();
      listening?.cancel();
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
  renderList();
  return root;
}

// ---- gamepad -----------------------------------------------------------------------------------

const TUNING_FIELDS: {
  key: keyof Pick<AxisCfg, 'deadzone' | 'sensitivity' | 'expo' | 'smoothing' | 'rise' | 'fall'>;
  label: string;
  min: number;
  max: number;
  step: number;
  hint: string;
}[] = [
  { key: 'deadzone', label: 'Dead zone', min: 0, max: 0.6, step: 0.01, hint: 'Stick drift below this reads as zero' },
  {
    key: 'sensitivity',
    label: 'Sensitivity',
    min: 0.2,
    max: 3,
    step: 0.05,
    hint: 'Output multiplier (clamped to full deflection)',
  },
  { key: 'expo', label: 'Curve', min: 0.5, max: 4, step: 0.05, hint: '1 = linear · 2 = fine control near the centre' },
  { key: 'smoothing', label: 'Smoothing', min: 0, max: 0.5, step: 0.01, hint: 'Low-pass time constant in seconds' },
  {
    key: 'rise',
    label: 'Key ramp up',
    min: 0.05,
    max: 2,
    step: 0.05,
    hint: 'Seconds for a held key to reach full deflection',
  },
  {
    key: 'fall',
    label: 'Key ramp down',
    min: 0.05,
    max: 2,
    step: 0.05,
    hint: 'Seconds to return to centre after release',
  },
];

function gamepadTab(app: App, onStop: (stop: () => void) => void): HTMLElement {
  const hub = app.input;
  const root = h('div', { class: 'gp-tab' });
  const status = h('div', { class: 'gp-status' });
  const live = h('div', { class: 'gp-live' });

  const enable = toggleField({
    label: 'Use gamepads',
    value: hub.settings.gamepad,
    onChange: (v) => hub.update_settings({ gamepad: v }),
  });
  const ramp = toggleField({
    label: 'Ramp keyboard keys of analog motors like a stick',
    value: hub.settings.keyboardRamp,
    onChange: (v) => hub.update_settings({ keyboardRamp: v }),
  });
  const profileSel = selectField({
    options: PROFILES.map((p) => ({ value: p.id, label: p.label })),
    value: hub.settings.profile,
    onChange: (id) => {
      hub.update_settings({ profile: id });
      renderAxes();
    },
  });
  const blurb = h('p', { class: 'hint-text' });
  const axesBox = h('div', { class: 'gp-axes' });

  function renderAxes(): void {
    const p = profileById(hub.settings.profile);
    blurb.textContent = p.blurb;
    axesBox.replaceChildren();
    const names = Object.keys(p.pad);
    for (const name of names) {
      const cfg = hub.axisConfig(name);
      const head = h(
        'div',
        { class: 'gp-axis-head' },
        h('b', null, name),
        h('span', { class: 'gp-val', dataset: { axis: name } }, '0.00'),
      );
      const resetBtn = button(
        'Reset',
        () => {
          const all = { ...hub.settings.axisTuning };
          const mine = { ...(all[p.id] ?? {}) };
          delete mine[name];
          all[p.id] = mine;
          hub.update_settings({ axisTuning: all });
          renderAxes();
        },
        { cls: 'small' },
      );
      const inv = toggleField({
        label: 'Invert',
        value: cfg.invert,
        onChange: (v) => setTuning(name, { invert: v }),
      });
      const ac = toggleField({
        label: 'Keys auto-centre',
        value: cfg.autoCentre,
        onChange: (v) => setTuning(name, { autoCentre: v }),
      });
      const fields = TUNING_FIELDS.map((f) => {
        const sl = sliderField({
          min: f.min,
          max: f.max,
          step: f.step,
          digits: 2,
          value: cfg[f.key],
          onChange: (v) => setTuning(name, { [f.key]: v }),
        });
        return row(f.label, sl.el, f.hint);
      });
      axesBox.appendChild(h('div', { class: 'gp-axis' }, head, ...fields, inv.el, ac.el, resetBtn));
    }
    void DEFAULT_AXIS;
  }
  function setTuning(axis: string, patch: Partial<AxisCfg>): void {
    const p = profileById(hub.settings.profile);
    const all = { ...hub.settings.axisTuning };
    all[p.id] = { ...(all[p.id] ?? {}), [axis]: { ...(all[p.id]?.[axis] ?? {}), ...patch } };
    hub.update_settings({ axisTuning: all });
  }

  root.append(
    status,
    live,
    h('div', { class: 'gp-opts' }, enable.el, ramp.el),
    row('Vehicle profile', profileSel.el, 'Which axis names a pad drives'),
    blurb,
    h(
      'p',
      { class: 'hint-text' },
      'A motor reads an axis by name (set “Analog axis” in the joint inspector). Pad buttons also act as keys: D-pad = arrow keys, LB / RB = Q / E, and any button can be bound to a motor key.',
    ),
    axesBox,
  );
  renderAxes();

  // Live readout of the connected pad and the axes it drives.
  const tick = window.setInterval(() => {
    if (!root.isConnected) return;
    const c = hub.combined;
    status.textContent = hub.pad.connected
      ? `Connected: ${hub.pad.name} (${hub.pad.family})`
      : 'No controller detected — connect one and press any button.';
    status.classList.toggle('ok', hub.pad.connected);
    const pressed = PAD_BUTTONS.filter((b) => c.buttons[b]).map((b) => padLabel(b, hub.pad.family));
    live.textContent = `L (${c.LX.toFixed(2)}, ${c.LY.toFixed(2)})  R (${c.RX.toFixed(2)}, ${c.RY.toFixed(2)})  LT ${c.LT.toFixed(2)}  RT ${c.RT.toFixed(2)}  ${pressed.join(' · ')}`;
    for (const el of axesBox.querySelectorAll<HTMLElement>('.gp-val')) {
      const name = el.dataset.axis ?? '';
      el.textContent = hub.axisValue(name).toFixed(2);
    }
  }, 100);
  onStop(() => window.clearInterval(tick));
  return root;
}

// ---- touch (filled in by the touch package of this work) --------------------------------------

function touchTab(app: App): HTMLElement {
  const hub = app.input;
  const mode = selectField({
    options: [
      { value: 'auto', label: 'Automatic (touch devices)' },
      { value: 'on', label: 'Always show' },
      { value: 'off', label: 'Hide' },
    ],
    value: hub.settings.touchControls,
    onChange: (v) => hub.update_settings({ touchControls: v }),
  });
  return h(
    'div',
    { class: 'touch-tab' },
    row('On-screen controls', mode.el, 'Virtual joysticks and buttons that drive the same axes as a gamepad'),
    h(
      'p',
      { class: 'hint-text' },
      'Left joystick = left stick, right joystick = right stick, A / B buttons = South / East. Use two fingers to orbit, pan and pinch-zoom the camera; long-press for the context menu.',
    ),
  );
}
