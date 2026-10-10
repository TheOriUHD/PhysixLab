/**
 * The tip slot of the status bar (UI-44): rotates through the tips of the registry (`registerStatusTip`), every 15
 * seconds and whenever the context changes (selection, simulation mode, tool), and can be switched off.
 */
import type { App } from '../app/app';
import { chooseTip, listStatusTips, type StatusTipDef } from '../app/registry/tips';
import { h } from './dom';

const KEY = 'physicslab.tips';
const EVENT = 'physicslab:tips';

export function tipsEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setTipsEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* private mode: the choice lasts until the page closes */
  }
  window.dispatchEvent(new Event(EVENT));
}

/** The tips that apply right now (a `when` that throws counts as "does not apply"). */
export function applicableTips(app: App, tips: readonly StatusTipDef[] = listStatusTips()): StatusTipDef[] {
  return tips.filter((t) => {
    if (!t.when) return true;
    try {
      return t.when(app);
    } catch {
      return false;
    }
  });
}

export function tipText(app: App, tip: StatusTipDef): string {
  try {
    return typeof tip.text === 'function' ? tip.text(app) : tip.text;
  } catch {
    return '';
  }
}

/** Put the tip slot into the status bar (before its flexible spacer). */
export function mountStatusTips(app: App, bar: HTMLElement): void {
  const slot = h('span', { class: 'status-tip' });
  bar.insertBefore(slot, bar.querySelector('.grow'));
  let step = 0;
  let timer = 0;
  const show = () => {
    if (!tipsEnabled()) {
      slot.replaceChildren();
      slot.title = '';
      return;
    }
    const tip = chooseTip(applicableTips(app), step);
    const text = tip ? tipText(app, tip) : '';
    if (!tip || !text) {
      slot.replaceChildren();
      return;
    }
    slot.replaceChildren(h('b', null, tip.label ?? 'Tip'), text);
    slot.title = text;
    slot.dataset.tip = tip.id;
  };
  const contextChanged = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      step = 0;
      show();
    }, 150);
  };
  app.store.on('selection', contextChanged);
  // Edits and scene loads can change which tips apply (an empty scene, a new body): re-evaluate without restarting the rotation.
  let refresh = 0;
  app.store.on('change', () => {
    window.clearTimeout(refresh);
    refresh = window.setTimeout(show, 300);
  });
  app.sim.on('mode', contextChanged);
  app.prefs.on('change', (keys) => {
    if (keys.includes('tool')) contextChanged();
  });
  window.addEventListener(EVENT, show);
  window.setInterval(() => {
    step++;
    show();
  }, 15000);
  show();
}
