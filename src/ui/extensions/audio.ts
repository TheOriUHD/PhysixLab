// ── FX: sound — the Sound sections of the Effects panel, the mute command (Shift+M), the sound settings and test sounds ──
import { registerCommand, registerMenuEntry } from '../../app/registry';
import type { CommandDef } from '../../app/registry';
import type { SoundPreview } from '../../app/audio/audioDirector';
import type { AudioSettings } from '../../audio/settings';
import { registerAudioPanelSections, toggleMute } from '../audioPanel';

registerAudioPanelSections();

// "M" is the Measure tool's long-standing key, so mute is Shift+M (and the speaker button in the top bar).
registerCommand({
  id: 'audio.mute',
  label: 'Mute sound',
  labelFor: (app) =>
    !app.prefs.value.audio.enabled ? 'Turn sound on' : app.prefs.value.audio.muted ? 'Unmute sound' : 'Mute sound',
  category: 'Sound',
  icon: 'speaker',
  setting: true,
  description: 'Silence all sound without losing the volume settings',
  keywords: ['volume', 'audio', 'silence', 'quiet', 'speaker', 'sound'],
  shortcut: 'Shift+M',
  checked: (app) => app.prefs.value.audio.muted || !app.prefs.value.audio.enabled,
  run: ({ app, source }) => toggleMute(app, source === 'shortcut' || source === 'button'),
});

const SWITCHES: [keyof AudioSettings, string, string][] = [
  ['enabled', 'Sound', 'Master switch for all sound (nothing is created while it is off)'],
  ['spatial', '3D sound positioning', 'Pan and attenuate sounds by where they are relative to the camera'],
  ['doppler', 'Doppler shift', 'Pitch rises for things moving towards the camera and falls as they move away'],
  ['pitchWithTimeScale', 'Pitch follows speed', 'Slow motion lowers the pitch of every sound'],
  ['uiSounds', 'Interface sounds', 'Subtle sounds for select, place, delete, errors and success'],
];
for (const [key, label, description] of SWITCHES) {
  registerCommand({
    id: `audio.${key}`,
    label,
    category: 'Sound',
    setting: true,
    description,
    keywords: ['audio', 'sound', 'volume'],
    checked: (app) => app.prefs.value.audio[key] === true,
    run: ({ app }) => app.audioDirector.setSettings({ [key]: !app.prefs.value.audio[key] }),
  });
}

const TESTS: [SoundPreview, string][] = [
  ['steel', 'a steel clang'],
  ['wood', 'a wood knock'],
  ['glass', 'a glass chime'],
  ['rubber', 'a rubber thud'],
  ['stone', 'a stone clack'],
  ['explosion', 'an explosion'],
  ['engine', 'an engine'],
  ['rolling', 'rolling and sliding'],
  ['wind', 'wind'],
];
for (const [kind, label] of TESTS) {
  const def: CommandDef = {
    id: `audio.test.${kind}`,
    label: `Play test sound: ${label}`,
    category: 'Sound',
    icon: 'speaker',
    description: 'Play a sample in front of the camera at the current volumes',
    keywords: ['audio', 'sound', 'test', 'listen'],
    run: ({ app }) => {
      if (!app.audioDirector.preview(kind))
        app.toast('Sound is off, muted or not started yet — click in the page first.', 'warn');
    },
  };
  registerCommand(def);
}

registerMenuEntry({ id: 'menu.view.soundHeading', menu: 'view', group: 'sound', order: 480, heading: 'Sound' });
registerMenuEntry({ id: 'menu.view.soundMute', menu: 'view', group: 'sound', order: 490, command: 'audio.mute' });
registerMenuEntry({ id: 'menu.view.soundSpatial', menu: 'view', group: 'sound', order: 495, command: 'audio.spatial' });
