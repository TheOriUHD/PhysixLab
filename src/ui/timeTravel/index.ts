/** Registers the time-travel UI: the Timeline, Replay and Ghosts tabs and the time commands. */
import { registerCommand, registerPanel } from '../../app/registry';
import { timeTravelFor } from '../../app/timeTravel';
import { ghostsPanel } from './ghostsPanel';
import { replayPanel } from './replayPanel';
import { timelinePanel } from './timelinePanel';

export function registerTimeTravelUi(): void {
  for (const p of [timelinePanel, replayPanel, ghostsPanel]) registerPanel(p);

  registerCommand({
    id: 'time.stepBack',
    label: 'Step one frame back',
    category: 'Simulation',
    icon: 'step',
    description: 'Go back one simulation step in the recorded run',
    keywords: ['rewind', 'previous', 'frame', 'undo time'],
    shortcut: 'Comma',
    enabled: (app) => app.sim.active,
    run: ({ app }) => timeTravelFor(app).stepBack(),
  });
  registerCommand({
    id: 'time.bookmark',
    label: 'Add timeline bookmark',
    category: 'Simulation',
    icon: 'plus',
    description: 'Bookmark the current frame of the run so you can jump back to it',
    keywords: ['marker', 'flag', 'timeline'],
    shortcut: 'Mod+Shift+B',
    enabled: (app) => app.sim.active,
    run: ({ app }) => {
      const b = timeTravelFor(app).addBookmark();
      app.toast(`${b.name} added at ${(b.step / timeTravelFor(app).hz).toFixed(2)} s`, 'success');
    },
  });
  registerCommand({
    id: 'time.toStart',
    label: 'Go to the start of the run',
    category: 'Simulation',
    icon: 'reset',
    keywords: ['rewind', 'beginning'],
    enabled: (app) => app.sim.active,
    run: ({ app }) => timeTravelFor(app).toStart(),
  });
  registerCommand({
    id: 'time.record',
    label: 'Record a replay',
    category: 'Simulation',
    icon: 'play',
    description: 'Record every input of the run and save it as a replay file',
    keywords: ['replay', 'record', 'capture'],
    enabled: (app) => !timeTravelFor(app).recording && !timeTravelFor(app).replaying,
    run: ({ app }) => timeTravelFor(app).startRecording(),
  });
  registerCommand({
    id: 'time.saveReplay',
    label: 'Save the recorded replay',
    category: 'Simulation',
    icon: 'download',
    keywords: ['replay', 'export'],
    enabled: (app) => timeTravelFor(app).recording,
    run: ({ app }) => timeTravelFor(app).exportReplay(),
  });
  registerCommand({
    id: 'time.determinism',
    label: 'Check determinism',
    category: 'Simulation',
    icon: 'zap',
    description: 'Run two copies of the scene and compare their states step by step',
    keywords: ['deterministic', 'validate', 'hash', 'diagnostics'],
    run: ({ app }) => {
      timeTravelFor(app).runDeterminism();
      app.prefs.set({ bottomTab: 'replay', showBottom: true });
    },
  });
  registerCommand({
    id: 'time.loop',
    label: 'Loop the marked region',
    category: 'Simulation',
    icon: 'reset',
    keywords: ['repeat', 'region'],
    enabled: (app) => app.sim.active,
    checked: (app) => timeTravelFor(app).loopOn,
    run: ({ app }) => timeTravelFor(app).toggleLoop(),
  });
  registerCommand({
    id: 'time.autoSlowmo',
    label: 'Slow motion on hard impacts',
    category: 'Simulation',
    icon: 'zap',
    description: 'Briefly slow the simulation to quarter speed after a hard impact',
    keywords: ['slow', 'impact', 'auto'],
    setting: true,
    checked: (app) => timeTravelFor(app).options.autoSlowmo,
    run: ({ app }) => timeTravelFor(app).setOptions({ autoSlowmo: !timeTravelFor(app).options.autoSlowmo }),
  });
}
