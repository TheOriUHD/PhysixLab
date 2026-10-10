// ── DT-23: peer-to-peer collaboration — the "Collaborate..." command, its File menu entry, and "Leave session" ──
import { registerCommand, registerMenuEntry } from '../../app/registry';
import { getCollab } from '../collabController';
import { openCollabDialog } from '../collabDialog';

registerCommand({
  id: 'collab.open',
  label: 'Collaborate...',
  category: 'File',
  icon: 'share',
  description: 'Edit this scene together with other people: host or join a live session (no server needed)',
  keywords: ['collaborate', 'multiplayer', 'share', 'live', 'session', 'webrtc', 'peer', 'join', 'host', 'together'],
  run: ({ app }) => openCollabDialog(app),
});

registerCommand({
  id: 'collab.leave',
  label: 'Leave collaboration session',
  category: 'File',
  description: 'Disconnect from the live session (you keep the scene as it is now)',
  keywords: ['collaborate', 'disconnect', 'session'],
  enabled: (app) => getCollab(app).active,
  run: ({ app }) => getCollab(app).leave(),
});

registerMenuEntry({
  id: 'menu.file.collab',
  menu: 'file',
  group: 'io',
  order: 330,
  command: 'collab.open',
  icon: 'share',
});
