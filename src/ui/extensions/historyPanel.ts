// -- ED-B: undo history panel --
import { registerCommand, registerPanel } from '../../app/registry';
import { h } from '../dom';
import { icon } from '../icons';
import { loadHistoryLimit, saveHistoryLimit } from '../historyLimit';

registerCommand({
  id: 'edit.history.clear',
  label: 'Clear undo history',
  category: 'Edit',
  icon: 'trash',
  description: 'Forget all undo and redo steps (the scene itself is untouched)',
  keywords: ['history', 'forget', 'reset undo'],
  enabled: (app) => app.store.canUndo || app.store.canRedo,
  run: ({ app }) => {
    app.store.clearHistory();
    app.toast('Undo history cleared', 'info');
  },
});

registerPanel({
  id: 'history',
  label: 'History',
  icon: 'history',
  region: 'right',
  order: 60,
  title: 'Undo history — click a step to jump to that state',
  build: (app) => {
    const store = app.store;
    store.historyLimit = loadHistoryLimit();
    const list = h('div', { class: 'hist-list', role: 'listbox', 'aria-label': 'Undo history' });
    const clear = h('button', { class: 'btn small', type: 'button', title: 'Forget all undo and redo steps' }, 'Clear');
    clear.addEventListener('click', () => store.clearHistory());
    const limit = h('input', {
      class: 'hist-limit',
      type: 'number',
      min: '10',
      max: '1000',
      step: '10',
      value: String(store.historyLimit),
      title: 'Maximum number of undo steps kept (10 – 1000)',
      'aria-label': 'History limit',
    });
    limit.addEventListener('change', () => {
      const n = saveHistoryLimit(Number(limit.value));
      store.historyLimit = n;
      limit.value = String(n);
    });
    const foot = h('div', { class: 'hist-foot' }, h('label', null, 'Keep ', limit, ' steps'), clear);
    const el = h('div', { class: 'hist-panel' }, h('div', { class: 'panel-body' }, list), foot);

    let rows: HTMLElement[] = [];
    let focusIdx = 0;
    const setFocus = (i: number, move = true) => {
      if (!rows.length) return;
      focusIdx = Math.max(0, Math.min(rows.length - 1, i));
      rows.forEach((r, k) => (r.tabIndex = k === focusIdx ? 0 : -1));
      if (move) rows[focusIdx].focus();
    };
    // Row k corresponds to "k commands applied"; row 0 is the starting state.
    const render = () => {
      const { done, undone } = store.historyEntries();
      const hadFocus = list.contains(document.activeElement);
      limit.value = String(store.historyLimit);
      clear.disabled = !done.length && !undone.length;
      rows = [];
      if (!done.length && !undone.length) {
        list.replaceChildren(
          h(
            'div',
            { class: 'empty-state' },
            icon('history'),
            h('h4', null, 'Nothing to undo yet'),
            h('p', null, 'Edits you make are listed here. Click one to jump back to it.'),
          ),
        );
        return;
      }
      const mk = (applied: number, label: string, state: 'done' | 'current' | 'redo') => {
        const r = h(
          'div',
          {
            class: `hist-row ${state}`,
            role: 'option',
            'aria-selected': state === 'current' ? 'true' : 'false',
            tabIndex: -1,
          },
          h('span', { class: 'hist-n' }, applied ? String(applied) : '·'),
          h('span', { class: 'hist-label' }, label),
          state === 'current' ? h('span', { class: 'hist-now' }, 'now') : null,
        );
        r.addEventListener('click', () => store.jumpTo(applied));
        rows.push(r);
        return r;
      };
      const out: HTMLElement[] = [];
      out.push(mk(0, 'Start', done.length === 0 ? 'current' : 'done'));
      done.forEach((l, i) => out.push(mk(i + 1, l, i + 1 === done.length ? 'current' : 'done')));
      if (undone.length) {
        out.push(h('div', { class: 'hist-branch' }, '↷ redo branch — discarded if you edit now'));
        undone.forEach((l, i) => out.push(mk(done.length + i + 1, l, 'redo')));
      }
      list.replaceChildren(...out);
      setFocus(done.length, hadFocus);
      rows[done.length]?.scrollIntoView?.({ block: 'nearest' });
    };
    list.addEventListener('keydown', (e) => {
      const i = rows.findIndex((r) => r === document.activeElement);
      if (e.key === 'ArrowDown') setFocus((i < 0 ? focusIdx : i) + 1);
      else if (e.key === 'ArrowUp') setFocus((i < 0 ? focusIdx : i) - 1);
      else if (e.key === 'Home') setFocus(0);
      else if (e.key === 'End') setFocus(rows.length - 1);
      else if (e.key === 'Enter' || e.key === ' ') {
        if (i >= 0) store.jumpTo(i);
      } else return;
      e.preventDefault();
    });
    const off = store.on('history', render);
    render();
    return { el, onShow: render, dispose: off };
  },
});
// -- end ED-B --
