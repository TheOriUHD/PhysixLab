/**
 * The Replay tab of the bottom dock: record the inputs of a run and save them as a replay file or link (TM-4), open a
 * replay in the viewer with its verification result, choose how much rewind history to keep (TM-1), and check that the
 * scene is deterministic (TM-7).
 */
import type { App } from '../../app/app';
import type { PanelDef, PanelView } from '../../app/registry/panels';
import { REPLAY_EXTENSION } from '../../app/replayFile';
import { timeTravelFor } from '../../app/timeTravel';
import { button, row, section, toggleField } from '../controls';
import { h } from '../dom';
import { confirmReplace } from '../sceneActions';

function build(app: App, ctx: { active: () => boolean }): PanelView {
  const tt = timeTravelFor(app);

  // ---- recording / viewing ---------------------------------------------------------------------
  const status = h('div', { class: 'tm-status' });
  const recBtn = button('Record', () => tt.startRecording(), {
    icon: 'play',
    cls: 'primary',
    title: 'Start recording the inputs of this run from now on',
  });
  const saveBtn = button('Save replay', () => tt.exportReplay(), {
    icon: 'download',
    title: 'Stop recording and save a replay file',
  });
  const linkBtn = button('Copy link', () => tt.copyReplayLink(), {
    icon: 'share',
    title: 'Stop recording and copy a link that replays the run (small runs only)',
  });
  const cancelBtn = button('Discard', () => tt.cancelRecording(), { title: 'Stop recording without saving' });
  const input = h('input', {
    type: 'file',
    accept: `${REPLAY_EXTENSION},.json,application/octet-stream`,
    hidden: true,
  });
  input.addEventListener('change', () => {
    const f = input.files?.[0];
    input.value = '';
    if (f) void confirmReplace(app, () => void tt.importReplay(f));
  });
  const openBtn = button('Open replay…', () => input.click(), {
    icon: 'upload',
    title: 'Open a replay file in the viewer',
  });
  const exitBtn = button('Exit replay', () => tt.exitReplay(), { title: 'Leave the viewer and return to the editor' });
  const verify = h('div', { class: 'tm-verify' });

  // ---- history -----------------------------------------------------------------------------------
  const memory = h(
    'select',
    {
      class: 'tm-select',
      title: 'Memory the rewind history may use. Older snapshots are thinned out, never dropped, when it fills.',
    },
    ...[32, 64, 128, 256, 512].map((mb) => h('option', { value: String(mb) }, `${mb} MB`)),
  );
  memory.value = '128';
  memory.addEventListener('change', () =>
    app.sim.client.sendCustom('timeline', { cmd: 'config', budgetMB: Number(memory.value) }),
  );
  const history = toggleField({
    value: true,
    onChange: (v) => app.sim.client.sendCustom('timeline', { cmd: 'config', enabled: v }),
  });
  const impacts = toggleField({ value: tt.options.markImpacts, onChange: (v) => tt.setOptions({ markImpacts: v }) });
  const slowmo = toggleField({ value: tt.options.autoSlowmo, onChange: (v) => tt.setOptions({ autoSlowmo: v }) });

  // ---- determinism -------------------------------------------------------------------------------
  const detResult = h('div', { class: 'tm-det' });
  const detSteps = h(
    'select',
    { class: 'tm-select', title: 'How many steps the two runs take' },
    ...[120, 240, 600, 1200].map((n) => h('option', { value: String(n) }, `${n} steps`)),
  );
  detSteps.value = '240';
  const detBtn = button('Check determinism', () => tt.runDeterminism(Number(detSteps.value)), {
    icon: 'zap',
    title: 'Runs two copies of the current state side by side and compares their hashes',
  });

  const el = h(
    'div',
    { class: 'tm-replay' },
    h(
      'div',
      { class: 'tm-col' },
      h('div', { class: 'tm-h' }, 'Replay'),
      status,
      h('div', { class: 'tm-actions' }, recBtn, saveBtn, linkBtn, cancelBtn, openBtn, exitBtn, input),
      verify,
    ),
    h(
      'div',
      { class: 'tm-col' },
      h('div', { class: 'tm-h' }, 'Determinism'),
      detResult,
      h('div', { class: 'tm-actions' }, detBtn, detSteps),
    ),
    h(
      'div',
      { class: 'tm-col' },
      h('div', { class: 'tm-h' }, 'History'),
      row('Rewind memory', memory, 'How much memory the snapshot ring may use'),
      row('Keep history', history.el, 'Take snapshots while the simulation runs (needed for rewind and scrubbing)'),
      row('Mark impacts', impacts.el, 'Show hard contacts as markers on the timeline'),
      row('Auto slow-mo', slowmo.el, 'Slow the simulation briefly after a hard impact'),
    ),
  );
  void section;

  function paint(): void {
    const st = tt.status;
    const live = tt.active;
    const rec = st?.recording;
    const rep = st?.replay;
    recBtn.hidden = !!rec || !!rep;
    recBtn.disabled = false;
    saveBtn.hidden = linkBtn.hidden = cancelBtn.hidden = !rec;
    exitBtn.hidden = !rep;
    openBtn.hidden = !!rep;
    status.textContent = rep
      ? `Viewing “${tt.replayName ?? 'replay'}” — ${rep.endStep.toLocaleString()} steps (${(rep.endStep / (st?.hz ?? 60)).toFixed(1)} s). Your inputs are ignored; the recorded ones drive the scene.`
      : rec
        ? `Recording from step ${rec.startStep.toLocaleString()} — ${rec.entries.toLocaleString()} inputs so far${rec.fromStart ? ', from a fresh scene' : ', with the current state as the start'}.`
        : live
          ? 'Press Record to capture every input (grabs, shots, keys, edits) of this run. Replays are exact: same scene, same seed, same inputs.'
          : 'Start the simulation, then record. Or open a replay file.';
    verify.replaceChildren();
    if (rep) {
      const done = rep.checked;
      const bad = rep.firstBad;
      verify.className = `tm-verify ${bad ? 'bad' : done > 0 ? 'ok' : ''}`;
      verify.textContent = bad
        ? `✗ Diverged from the recording at step ${bad.step} — this build does not reproduce the run exactly.`
        : done > 0
          ? `✓ Verified ${done} of ${rep.checkpoints} checkpoints so far — the playback matches the recording bit for bit.`
          : rep.checkpoints > 0
            ? 'Verification starts when you press play.'
            : 'This replay has no checkpoints to verify.';
    } else verify.className = 'tm-verify';
    const d = tt.determinismSummary();
    detResult.className = `tm-det ${d.ok === true ? 'ok' : d.ok === false ? 'bad' : ''}`;
    detResult.textContent = `${d.ok === true ? '✓ ' : d.ok === false ? '✗ ' : ''}${d.text}`;
    detBtn.disabled = tt.determinismRunning;
    if (st && Number(memory.value) !== Math.round(st.budgetBytes / 1048576))
      memory.value = String(Math.round(st.budgetBytes / 1048576));
    if (![...memory.options].some((o) => o.value === memory.value)) memory.value = '128';
    history.set(st?.enabled ?? true);
    impacts.set(tt.options.markImpacts);
    slowmo.set(tt.options.autoSlowmo);
  }

  let dirty = true;
  tt.on('change', () => (dirty = true));
  const off = app.on('frame', () => {
    if (dirty && ctx.active()) {
      paint();
      dirty = false;
    }
  });
  return { el, onShow: paint, dispose: off };
}

export const replayPanel: PanelDef = {
  id: 'replay',
  label: 'Replay',
  icon: 'play',
  region: 'bottom',
  order: 6,
  title: 'Record and replay runs, check determinism, rewind history',
  build,
};
