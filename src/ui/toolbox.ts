/**
 * The two floating bars over the viewport — the toolbox (left) and the view bar (right) — generated from the tool
 * registry (`src/app/registry/tools.ts`). Each button runs a command; its highlight, enabled state and tooltip
 * (with the shortcut) follow that command, so a tool registered by a package appears here without any edit.
 */
import type { App } from '../app/app';
import { commandChecked, commandEnabled, getCommand, runCommand, shortcutsOf } from '../app/registry/commands';
import { formatShortcut } from '../app/registry/shortcuts';
import { commandIdOf, listTools, toolRegistry, type ToolDef, type ToolRegion } from '../app/registry/tools';
import { h } from './dom';
import { icon } from './icons';

interface Built {
  def: ToolDef;
  el: HTMLButtonElement;
}

function tooltip(def: ToolDef): string {
  const cmd = getCommand(commandIdOf(def));
  const base = def.title ?? cmd?.description ?? cmd?.label ?? def.id;
  const shortcut = (cmd ? shortcutsOf(cmd) : [])[0];
  return def.showShortcut !== false && shortcut ? `${base} (${formatShortcut(shortcut)})` : base;
}

export function buildToolbox(app: App): { toolbox: HTMLElement; viewbar: HTMLElement; chips: HTMLElement } {
  const toolbox = h('div', { class: 'floating toolbox' });
  const viewbar = h('div', { class: 'floating viewbar' });
  const chips = h('div', { class: 'stage-chip' });
  let built: Built[] = [];

  const render = (region: ToolRegion, bar: HTMLElement, separator: () => HTMLElement) => {
    bar.replaceChildren();
    let group: string | null = null;
    for (const def of listTools(region)) {
      if (group !== null && def.group !== group) bar.appendChild(separator());
      group = def.group;
      const el = h(
        'button',
        {
          class: `icon-btn${def.text ? ' opt-btn' : ''}`,
          type: 'button',
          title: tooltip(def),
          'aria-label': tooltip(def),
          dataset: { tool: def.id, label: def.label ?? def.id }, // label: caption in the touch layout
        },
        def.text ? null : icon(def.icon),
      );
      el.addEventListener('click', () => runCommand(commandIdOf(def), app, 'button'));
      built.push({ def, el });
      bar.appendChild(el);
    }
  };

  const sync = () => {
    for (const { def, el } of built) {
      const cmd = getCommand(commandIdOf(def));
      const on = def.isActive ? def.isActive(app) : !!cmd && commandChecked(cmd, app) === true;
      el.classList.toggle('on', on);
      el.setAttribute('aria-pressed', on ? 'true' : 'false');
      el.disabled = !!cmd && !commandEnabled(cmd, app);
      if (def.text) el.textContent = def.text(app);
    }
  };

  const renderAll = () => {
    built = [];
    render('toolbox', toolbox, () => h('hr'));
    render('viewbar', viewbar, () => h('span', { class: 'sep' }));
    sync();
  };
  toolRegistry.onChange(renderAll);
  renderAll();

  app.prefs.on('change', sync);
  app.cameraRig.on('change', sync); // -- CM-A: the camera-mode chip and the projection toggle follow the rig
  app.store.on('selection', sync);
  app.sim.on('mode', sync);
  return { toolbox, viewbar, chips };
}
