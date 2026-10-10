// ── UI-B: the Help panel (F1), its commands and menu entries ──
import { registerCommand, registerMenuEntry, registerPanel } from '../../app/registry';
import { HELP_PAGES } from '../help/pages';
import { helpPanel, openHelp } from '../help/helpPanel';

registerPanel(helpPanel);

registerCommand({
  id: 'help.open',
  label: 'Help',
  category: 'Help',
  icon: 'info',
  description: 'Open the searchable help pages',
  keywords: ['manual', 'docs', 'documentation', 'guide', 'how to'],
  shortcut: 'F1',
  allowWhileTyping: true,
  run: ({ app }) => openHelp(app),
});

// One command per page, so the palette can jump straight to it ("Help: Joints & motors").
for (const p of HELP_PAGES)
  registerCommand({
    id: `help.page.${p.id.replace(/[^a-zA-Z0-9]+/g, '-')}`,
    label: `Help: ${p.title}`,
    category: 'Help',
    icon: 'info',
    description: p.summary,
    help: false,
    run: ({ app }) => openHelp(app, p.id),
  });

registerMenuEntry({ id: 'menu.help.open', menu: 'help', group: 'help', order: 80, command: 'help.open', icon: 'info' });
