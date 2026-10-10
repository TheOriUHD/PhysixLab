// -- DT-2: Record dialog commands (video, GIF, turntable) and their File-menu entries --
// The capture code (dialog, session, GIF encoder) is loaded on first use, never at start-up.
import { registerCommand, registerMenuEntry } from '../../app/registry';
import type { App } from '../../app/app';
import type { ActiveCapture, CapturePreset } from '../captureDialog';

let current: ActiveCapture | null = null;

async function open(app: App, preset: CapturePreset): Promise<void> {
  const m = await import('../captureDialog');
  m.openCaptureDialog(app, preset, (c) => {
    current = c;
    void c.done.finally(() => {
      if (current === c) current = null;
    });
  });
}

const idle = () => current === null;

registerCommand({
  id: 'record.start',
  label: 'Record video…',
  category: 'File',
  icon: 'camera',
  description: 'Record the viewport to a WebM or MP4 video (MediaRecorder)',
  keywords: ['capture', 'screen', 'movie', 'webm', 'mp4', 'video'],
  enabled: idle,
  run: ({ app }) => open(app, 'video'),
});

registerCommand({
  id: 'record.stop',
  label: 'Stop recording',
  category: 'File',
  icon: 'close',
  description: 'Stop the running capture and save what was recorded (Esc cancels without saving)',
  keywords: ['capture', 'finish', 'save'],
  enabled: () => current !== null,
  run: () => current?.stop(),
});

registerCommand({
  id: 'capture.gif',
  label: 'Record animated GIF…',
  category: 'File',
  icon: 'camera',
  description: 'Capture the viewport as an animated GIF, optionally frame by frame with a fixed timestep',
  keywords: ['capture', 'animation', 'gif', 'deterministic'],
  enabled: idle,
  run: ({ app }) => open(app, 'gif'),
});

registerCommand({
  id: 'capture.turntable',
  label: 'Record turntable…',
  category: 'File',
  icon: 'camera',
  description: 'Orbit the camera 360° around the scene or the selection while recording',
  keywords: ['capture', 'orbit', 'rotate', 'spin', '360'],
  enabled: idle,
  run: ({ app }) => open(app, 'turntable'),
});

registerMenuEntry({ id: 'menu.file.record', menu: 'file', group: 'capture', order: 330, command: 'record.start' });
registerMenuEntry({ id: 'menu.file.recordGif', menu: 'file', group: 'capture', order: 331, command: 'capture.gif' });
registerMenuEntry({
  id: 'menu.file.recordTurntable',
  menu: 'file',
  group: 'capture',
  order: 332,
  command: 'capture.turntable',
});
registerMenuEntry({ id: 'menu.file.recordStop', menu: 'file', group: 'capture', order: 333, command: 'record.stop' });
