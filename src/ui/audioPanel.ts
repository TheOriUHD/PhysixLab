/**
 * The sound sections of the Effects panel (FX-10, FX-14): master switch, mute, master and per-category volumes, the
 * spatial / Doppler / time-scale / interface options, buttons that play a sample of each kind of sound, and a live
 * status with the measured output level. They are registered with `registerFxPanelSection`, so the panel itself did not
 * change; everything shown is real — the switches are `Prefs.audio` (persisted, validated on load), the test buttons play
 * the actual synthesisers, the level bar is an analyser on the master output.
 */
import type { App } from '../app/app';
import type { SoundPreview } from '../app/audio/audioDirector';
import { registerFxPanelSection, type FxPanelSection } from './fxPanel';
import { AUDIO_CATEGORIES } from '../audio/settings';
import { button, row, section, sliderField, toggleField } from './controls';
import { h } from './dom';

const pct = (v: number): number => Math.round(v * 100);

/** Dim a block and take it out of the tab order and the accessibility tree while sound is off. */
function setDisabled(block: Element | null, off: boolean): void {
  block?.classList.toggle('fx-disabled-block', off);
  block?.toggleAttribute('inert', off);
}

const STATE_TEXT: Record<string, string> = {
  idle: 'waiting for your first click or key press',
  running: 'running',
  suspended: 'idle (muted, off or in a background tab)',
  unsupported: 'not available in this browser',
};

function soundSection(app: App) {
  const d = app.audioDirector;
  const enabled = toggleField({
    label: 'Sound',
    title: 'Master switch: off means no audio is created and the physics sends no contact events for sound',
    onChange: (v) => d.setSettings(v ? { enabled: true, muted: false } : { enabled: false }),
  });
  const mute = toggleField({
    label: 'Mute',
    title: 'Silence everything without losing your volume settings (Shift+M)',
    onChange: (v) => d.setSettings({ muted: v }),
  });
  const note = h('p', { class: 'hint-text audio-note' });
  const master = sliderField({
    min: 0,
    max: 100,
    step: 1,
    digits: 0,
    unit: '%',
    onChange: (v) => d.setSettings({ master: v / 100 }),
  });
  const cats = AUDIO_CATEGORIES.map((c) => {
    const f = sliderField({
      min: 0,
      max: 100,
      step: 1,
      digits: 0,
      unit: '%',
      onChange: (v) => d.setSettings({ volume: { [c.id]: v / 100 } }),
    });
    return { c, f, el: row(c.label, f.el, c.hint) };
  });
  const spatial = toggleField({
    label: '3D positioning',
    title:
      'Pan and attenuate sounds by where they are relative to the camera. Off: everything plays centred at full level.',
    onChange: (v) => d.setSettings({ spatial: v }),
  });
  const doppler = toggleField({
    label: 'Doppler shift',
    title: 'Pitch rises for things moving towards the camera and falls as they move away',
    onChange: (v) => d.setSettings({ doppler: v }),
  });
  const pitch = toggleField({
    label: 'Pitch follows speed',
    title: 'Slow motion lowers the pitch of every sound (and fast-forward raises it a little)',
    onChange: (v) => d.setSettings({ pitchWithTimeScale: v }),
  });
  const ui = toggleField({
    label: 'Interface sounds',
    title: 'Subtle sounds for select, place, delete, errors and success',
    onChange: (v) => d.setSettings({ uiSounds: v }),
  });
  const off = h(
    'p',
    { class: 'hint-text fx-off-note' },
    'Sound is off. Turn it on to hear collisions, engines and the rest.',
  );
  const inner = h(
    'div',
    { class: 'fx-dim-inner' },
    mute.el,
    row('Master volume', master.el, 'Overall level, 0 – 100 %'),
    ...cats.map((c) => c.el),
    spatial.el,
    doppler.el,
    pitch.el,
    ui.el,
  );
  const el = section('Sound', [enabled.el, off, note, inner], { id: 'audio-sound' });
  const update = () => {
    const s = app.prefs.value.audio;
    enabled.set(s.enabled);
    mute.set(s.muted);
    master.set(pct(s.master));
    for (const { c, f } of cats) f.set(pct(s.volume[c.id]));
    spatial.set(s.spatial);
    doppler.set(s.doppler);
    pitch.set(s.pitchWithTimeScale);
    ui.set(s.uiSounds);
    el.classList.toggle('fx-disabled', !s.enabled);
    setDisabled(inner, !s.enabled);
    const st = app.audio.state;
    note.textContent =
      st === 'idle' && s.enabled
        ? 'Browsers only allow sound after you interact with the page: it starts with your first click or key press.'
        : st === 'unsupported'
          ? 'This browser has no WebAudio support: sound is not available.'
          : '';
    note.toggleAttribute('hidden', !note.textContent);
  };
  return { el, update };
}

const TESTS: { kind: SoundPreview; label: string; title: string }[] = [
  {
    kind: 'steel',
    label: 'Steel',
    title: 'A steel ball hitting the ground: a metallic clang with inharmonic partials',
  },
  { kind: 'wood', label: 'Wood', title: 'A wooden block: a short knock' },
  { kind: 'glass', label: 'Glass', title: 'A glass ball: a bright chime' },
  { kind: 'rubber', label: 'Rubber', title: 'A rubber ball: a soft thud' },
  { kind: 'stone', label: 'Stone', title: 'A concrete block: a dry clack' },
  { kind: 'explosion', label: 'Explosion', title: 'A blast of radius 6 m' },
  { kind: 'engine', label: 'Engine', title: 'An engine revving up and down: pitch and timbre follow rpm and load' },
  { kind: 'rolling', label: 'Rolling', title: 'A ball rolling up to speed, then skidding' },
  { kind: 'wind', label: 'Wind', title: 'Wind rising and falling with the speed of the camera' },
];

function testSection(app: App) {
  const buttons = TESTS.map((t) =>
    button(
      t.label,
      () => {
        if (!app.audioDirector.preview(t.kind)) {
          const s = app.prefs.value.audio;
          app.toast(
            !s.enabled
              ? 'Sound is switched off — turn it on in this panel to hear it.'
              : s.muted
                ? 'Sound is muted — unmute it (Shift+M) to hear it.'
                : 'Sound is not running yet — click or press a key in the page first.',
            'warn',
          );
        }
      },
      { cls: 'small', title: t.title },
    ),
  );
  const el = section(
    'Test sounds',
    [
      h('div', { class: 'fx-previews' }, buttons),
      h(
        'p',
        { class: 'hint-text' },
        'Plays the real synthesiser, in front of the camera, at the volumes set above. In a running simulation the same sounds follow the physics.',
      ),
    ],
    { id: 'audio-test' },
  );
  el.classList.add('fx-dim');
  return {
    el,
    update: () => {
      const s = app.prefs.value.audio;
      const off = !s.enabled;
      el.classList.toggle('fx-disabled', off);
      setDisabled(el.querySelector('.section-body'), off);
    },
  };
}

const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-US');

function statusSection(app: App) {
  const line = (label: string) => {
    const v = h('span', { class: 'fx-stat-v' }, '—');
    return { el: h('div', { class: 'fx-stat' }, h('span', { class: 'fx-stat-l' }, label), v), v };
  };
  const state = line('Audio engine');
  const meter = h('div', { class: 'fx-bar audio-meter', title: 'Output level' }, h('div', { class: 'fx-bar-fill' }));
  const voices = line('Voices');
  const loops = line('Rolling / motors');
  const buffers = line('Synthesised buffers');
  const contacts = line('Contact events');
  const el = section('Sound status', [state.el, meter, voices.el, loops.el, buffers.el, contacts.el], {
    id: 'audio-status',
    open: false,
  });
  const fill = meter.firstElementChild as HTMLElement;
  let peak = 0;
  const update = () => {
    const s = app.audioDirector.stats;
    state.v.textContent = `${STATE_TEXT[s.state] ?? s.state}${s.state === 'running' ? ` · ${(s.sampleRate / 1000).toFixed(1)} kHz` : ''}`;
    peak = Math.max(s.level, peak * 0.85);
    fill.style.width = `${Math.min(100, Math.sqrt(peak) * 140).toFixed(1)}%`;
    voices.v.textContent = `${s.voices} (${AUDIO_CATEGORIES.map((c) => `${s.byCategory[c.id]}`).join(' / ')})`;
    loops.v.textContent = `${s.rolling} / ${s.motors}${s.wind ? ' · wind' : ''}`;
    buffers.v.textContent = `${fmtInt(s.buffers)} · ${fmtInt(s.bufferKB)} kB`;
    contacts.v.textContent = s.contactsWatched ? 'on' : 'off';
  };
  return { el, update };
}

const SECTIONS: FxPanelSection[] = [
  { id: 'sound', order: 40, build: soundSection },
  { id: 'soundTest', order: 50, build: testSection },
  { id: 'soundStatus', order: 92, build: statusSection },
];

/** Add the sound sections to the Effects panel (call once, from the extension). */
export function registerAudioPanelSections(): void {
  for (const s of SECTIONS) registerFxPanelSection(s);
}

/** Toggle mute with feedback for the shortcut / button (used by the command). */
export function toggleMute(app: App, announce: boolean): void {
  const s = app.prefs.value.audio;
  if (!s.enabled) app.audioDirector.setSettings({ enabled: true, muted: false });
  else app.audioDirector.setSettings({ muted: !s.muted });
  if (announce)
    app.toast(app.prefs.value.audio.muted || !app.prefs.value.audio.enabled ? 'Sound muted.' : 'Sound on.', 'info');
}
