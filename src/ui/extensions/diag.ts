// ── UI-B: the Diagnostics and Profiler panels, "Copy diagnostics" and their Help-menu entries ──
import { registerCommand, registerMenuEntry, registerPanel } from '../../app/registry';
import { errorLog } from '../diag/boot';
import { collectReport } from '../diag/collect';
import { copyText } from '../diag/errorCard';
import { diagnosticsPanel, profilerPanel } from '../diag/panels';
import { formatReport } from '../diag/report';

registerPanel(diagnosticsPanel);
registerPanel(profilerPanel);

registerCommand({
  id: 'diag.copy',
  label: 'Copy diagnostics',
  category: 'Help',
  icon: 'copy',
  description: 'Copy a text report of your browser, graphics card, limits and recent errors for a bug report',
  keywords: ['bug', 'report', 'debug', 'support', 'system info'],
  run: async ({ app }) => {
    const ok = await copyText(formatReport(collectReport(app, errorLog)));
    app.toast(
      ok ? 'Diagnostics copied to the clipboard' : 'Could not copy: open the Diagnostics panel instead',
      ok ? 'success' : 'warn',
    );
  },
});

registerMenuEntry({
  id: 'menu.help.diagnostics',
  menu: 'help',
  group: 'diag',
  order: 200,
  command: 'panel.diagnostics',
  icon: 'settings',
});
registerMenuEntry({
  id: 'menu.help.profiler',
  menu: 'help',
  group: 'diag',
  order: 210,
  command: 'panel.profiler',
  icon: 'wave',
});
registerMenuEntry({
  id: 'menu.help.copyDiagnostics',
  menu: 'help',
  group: 'diag',
  order: 220,
  command: 'diag.copy',
  icon: 'copy',
});
