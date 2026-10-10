// ── UI-B: built-in status-bar tips and the switch that turns them off ──
import { formatShortcut, primaryShortcut, getCommand, registerCommand, registerStatusTip } from '../../app/registry';
import { setTipsEnabled, tipsEnabled } from '../statusTips';

/** "Ctrl+K" for the platform, taken from the command so a rebinding is followed. */
const key = (commandId: string, fallback: string): string => {
  const c = getCommand(commandId);
  const s = c && primaryShortcut(c);
  return formatShortcut(s ?? fallback);
};

// Contextual tips (shown first when the context changes).
registerStatusTip({
  id: 'tip.ctx.empty',
  priority: 10,
  when: (app) => app.store.size === 0,
  text: () => 'The scene is empty: click a shape in the Add tab, or press 1 to drop a box.',
});
registerStatusTip({
  id: 'tip.ctx.noSelection',
  priority: 10,
  when: (app) => app.store.size > 0 && app.sim.mode === 'edit' && app.store.selection.length === 0,
  text: () => 'Click an object to select it, or drag on empty space to box-select.',
});
registerStatusTip({
  id: 'tip.ctx.selected',
  priority: 10,
  when: (app) => app.sim.mode === 'edit' && app.store.selection.length > 0,
  text: () => 'Press W to move, E to rotate, R to scale. Ctrl+D duplicates, Delete removes.',
});
registerStatusTip({
  id: 'tip.ctx.running',
  priority: 10,
  when: (app) => app.sim.mode === 'running',
  text: () =>
    `Drag a body to throw it. ${key('sim.toggle', 'Space')} pauses, ${key('sim.reset', 'Shift+Space')} returns to your layout.`,
});
registerStatusTip({
  id: 'tip.ctx.paused',
  priority: 10,
  when: (app) => app.sim.mode === 'paused',
  text: () => `Paused: ${key('sim.step', 'Period')} advances one physics step, ${key('sim.toggle', 'Space')} resumes.`,
});

// General tips (rotate).
registerStatusTip({ id: 'tip.shortcuts', text: () => 'Press ? to see every keyboard shortcut, and search them.' });
registerStatusTip({
  id: 'tip.palette',
  text: () => `${key('app.palette', 'Mod+K')} searches every command, setting, scene and prefab.`,
});
registerStatusTip({ id: 'tip.help', text: () => `${key('help.open', 'F1')} opens the searchable help.` });
registerStatusTip({
  id: 'tip.undo',
  text: () => `${key('edit.undo', 'Mod+Z')} undoes anything. Your scene is autosaved as you work.`,
});
registerStatusTip({ id: 'tip.snap', text: () => `${key('view.snap', 'G')} turns grid snapping on and off.` });
registerStatusTip({
  id: 'tip.camera',
  text: () => 'Right-drag orbits, middle-drag pans, scroll zooms, double-click frames an object.',
});
registerStatusTip({ id: 'tip.vertical', text: () => 'Hold Shift while dragging a body to move it up and down.' });
registerStatusTip({
  id: 'tip.speed',
  text: () => 'The speed buttons in the top bar run the simulation in slow motion or fast forward.',
});
registerStatusTip({
  id: 'tip.joint',
  text: () => `${key('tool.joint', 'J')} starts the joint tool: click two bodies to connect them.`,
});

registerCommand({
  id: 'view.statusTips',
  label: 'Status bar tips',
  category: 'View',
  setting: true,
  keywords: ['hints', 'tips', 'status bar'],
  description: 'Show a rotating tip in the status bar',
  checked: () => tipsEnabled(),
  run: () => setTipsEnabled(!tipsEnabled()),
});
