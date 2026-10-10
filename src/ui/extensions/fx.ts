// ── FX: the Effects panel, its commands and View-menu entries (particles, impact effects, skid marks, explosions) ──
import { registerCommand, registerMenuEntry, registerPanel } from '../../app/registry';
import type { CommandDef } from '../../app/registry';
import type { FxPreview } from '../../app/fx/fxDirector';
import type { FxQuality, FxSettings } from '../../render/fx';
import { buildFxPanel } from '../fxPanel';

registerPanel({
  id: 'fx',
  label: 'Effects',
  icon: 'sparkle',
  region: 'right',
  order: 40,
  title: 'Particles, impact effects, skid marks and explosions: quality and switches',
  build: (app, ctx) => buildFxPanel(app, ctx),
});

registerCommand({
  id: 'fx.toggle',
  label: 'Visual effects',
  category: 'View',
  icon: 'sparkle',
  setting: true,
  description: 'Master switch for particles, impact effects, skid marks and explosions',
  keywords: ['particles', 'sparks', 'smoke', 'dust', 'effects', 'fx'],
  checked: (app) => app.prefs.value.fx.enabled,
  run: ({ app }) => app.fxDirector.setSettings({ enabled: !app.prefs.value.fx.enabled }),
});

const QUALITIES: [FxQuality, string][] = [
  ['auto', 'Auto'],
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
];
for (const [q, label] of QUALITIES) {
  registerCommand({
    id: `fx.quality.${q}`,
    label: `Effects quality: ${label}`,
    category: 'View',
    setting: true,
    description:
      q === 'auto' ? 'Particle budget follows the graphics quality' : `Fixed ${label.toLowerCase()} particle budget`,
    keywords: ['particles', 'effects', 'fx', 'performance'],
    checked: (app) => app.prefs.value.fx.quality === q,
    run: ({ app }) => app.fxDirector.setSettings({ quality: q }),
  });
}

const KINDS: [keyof FxSettings, string, string][] = [
  ['impacts', 'Impact sparks & dust', 'Sparks, dust, chips, shards and scuffs from collisions'],
  ['trails', 'Dust trails & tyre smoke', 'Smoke from slipping wheels, dust behind fast bodies'],
  ['skidMarks', 'Skid marks', 'Persistent marks from slipping wheels and sliding bodies'],
  ['explosions', 'Explosion effects', 'Fireball, shock ring, smoke and light flash for blasts'],
  ['debris', 'Debris chips', 'Chunks thrown from very hard hits on brittle materials'],
  ['physicalDebris', 'Physical debris bodies', 'Real rigid fragments from those hits (capped, auto-cleaned)'],
];
for (const [key, label, description] of KINDS) {
  registerCommand({
    id: `fx.kind.${key}`,
    label,
    category: 'View',
    setting: true,
    description,
    keywords: ['effects', 'fx', 'particles'],
    checked: (app) => app.prefs.value.fx[key] === true,
    run: ({ app }) => app.fxDirector.setSettings({ [key]: !app.prefs.value.fx[key] }),
  });
}

registerCommand({
  id: 'fx.skid.clear',
  label: 'Clear skid marks',
  category: 'View',
  icon: 'trash',
  description: 'Remove every skid mark from the ground',
  keywords: ['tyre', 'tire', 'marks', 'rubber'],
  run: ({ app }) => {
    const n = app.fx.stats.skidSegments;
    app.fx.clearSkidMarks();
    app.toast(n ? 'Skid marks cleared.' : 'There are no skid marks to clear.');
  },
});

const PREVIEWS: [FxPreview, string][] = [
  ['sparks', 'sparks'],
  ['dust', 'dust'],
  ['glass', 'shattering glass'],
  ['tyre', 'tyre smoke'],
  ['explosion', 'an explosion'],
];
for (const [kind, label] of PREVIEWS) {
  const def: CommandDef = {
    id: `fx.preview.${kind}`,
    label: `Preview effect: ${label}`,
    category: 'View',
    description: 'Fire the effect on the ground where the camera looks',
    keywords: ['effects', 'fx', 'test', 'particles'],
    run: ({ app }) => {
      if (!app.fxDirector.preview(kind)) app.toast('Visual effects are switched off.', 'warn');
    },
  };
  registerCommand(def);
}

registerMenuEntry({ id: 'menu.view.fxHeading', menu: 'view', group: 'fx', order: 450, heading: 'Effects' });
registerMenuEntry({ id: 'menu.view.fx', menu: 'view', group: 'fx', order: 460, command: 'fx.toggle' });
registerMenuEntry({ id: 'menu.view.fxClear', menu: 'view', group: 'fx', order: 470, command: 'fx.skid.clear' });
