/** The options bar over the viewport: the controls registered for the active tool (src/app/toolOptions.ts). */
import type { App } from '../app/app';
import type { Prefs } from '../app/prefs';
import { optionsForMode, toolOptionsRegistry, type ToolOption } from '../app/toolOptions';
import { fmt } from './controls';
import { h } from './dom';

interface Control {
  option: ToolOption;
  wrap: HTMLElement;
  sync(p: Prefs): void;
}

export function mountToolOptions(app: App): void {
  const bar = h('div', { class: 'tool-options floating', role: 'toolbar', 'aria-label': 'Tool options' });
  bar.hidden = true;
  app.shell.stage.appendChild(bar);
  let mode = '';
  let controls: Control[] = [];

  const set = (key: keyof Prefs, v: unknown) => app.prefs.set({ [key]: v });
  const text = (p: Prefs, key: keyof Prefs): string => {
    const v = p[key];
    return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
  };

  const build = (option: ToolOption): Control => {
    const label = h('span', { class: 'to-label' }, option.label);
    let field: HTMLElement;
    let sync: (p: Prefs) => void;
    switch (option.kind) {
      case 'select': {
        const sel = h(
          'select',
          { class: 'to-select', 'aria-label': option.label },
          option.options.map((o) => h('option', { value: o.value }, o.label)),
        );
        sel.addEventListener('change', () => set(option.key, sel.value));
        field = sel;
        sync = (p) => (sel.value = text(p, option.key));
        break;
      }
      case 'range': {
        const input = h('input', {
          type: 'range',
          class: 'to-range',
          min: String(option.min),
          max: String(option.max),
          step: String(option.step),
          'aria-label': option.label,
        });
        const read = h('span', { class: 'to-read' });
        input.addEventListener('input', () => set(option.key, Number(input.value)));
        field = h('span', { class: 'to-range-wrap' }, input, read);
        sync = (p) => {
          const v = Number(p[option.key]);
          input.value = String(v);
          read.textContent = `${fmt(v, option.digits ?? 2)}${option.unit ? ` ${option.unit}` : ''}`;
        };
        break;
      }
      case 'color': {
        const input = h('input', { type: 'color', class: 'to-color', 'aria-label': option.label });
        input.addEventListener('input', () => set(option.key, input.value));
        field = input;
        sync = (p) => (input.value = text(p, option.key));
        break;
      }
      case 'swatches': {
        const box = h('span', { class: 'to-swatches' });
        let shown = '';
        sync = (p) => {
          const colors = typeof option.colors === 'function' ? option.colors(p) : option.colors;
          if (colors.join() !== shown) {
            shown = colors.join();
            box.replaceChildren(
              ...colors.map((c) => {
                const b = h('button', {
                  type: 'button',
                  class: 'to-swatch',
                  title: c,
                  'aria-label': c,
                  style: { background: c },
                  dataset: { color: c },
                });
                b.addEventListener('click', () => set(option.key, c));
                return b;
              }),
            );
          }
          for (const b of Array.from(box.children) as HTMLElement[])
            b.classList.toggle('on', b.dataset.color === p[option.key]);
        };
        field = box;
        break;
      }
    }
    const wrap = h('label', { class: 'to-item', title: option.title ?? option.label }, label, field);
    return { option, wrap, sync };
  };

  const refresh = () => {
    const p = app.prefs.value;
    const opts = optionsForMode(p.tool);
    if (p.tool !== mode) {
      mode = p.tool;
      controls = opts.map(build);
      bar.replaceChildren(...controls.map((c) => c.wrap));
    }
    for (const c of controls) {
      c.sync(p);
      c.wrap.hidden = !!c.option.when && !c.option.when(p, app);
    }
    bar.hidden = controls.every((c) => c.wrap.hidden);
  };

  app.prefs.on('change', refresh);
  app.sim.on('mode', refresh);
  toolOptionsRegistry.onChange(() => {
    mode = '';
    refresh();
  });
  refresh();
}
