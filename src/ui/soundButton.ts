// ── FX: the speaker button of the top bar — mute / unmute (Shift+M) ──
import type { App } from '../app/app';
import { runCommand, withShortcut } from '../app/registry/commands';
import { iconButton } from './controls';
import { icon } from './icons';

export function buildSoundButton(app: App): HTMLButtonElement {
  const b = iconButton('speaker', 'Mute sound', () => runCommand('audio.mute', app, 'button'), 'sound-btn');
  const sync = () => {
    const s = app.prefs.value.audio;
    const silent = s.muted || !s.enabled;
    b.replaceChildren(icon(silent ? 'speakerOff' : 'speaker'));
    b.classList.toggle('silent', silent);
    b.setAttribute('aria-pressed', String(silent));
    b.title = withShortcut(
      !s.enabled ? 'Sound is off — turn it on' : s.muted ? 'Unmute sound' : 'Mute sound',
      'audio.mute',
    );
  };
  app.prefs.on('change', (keys) => {
    if (keys.includes('audio')) sync();
  });
  sync();
  return b;
}
