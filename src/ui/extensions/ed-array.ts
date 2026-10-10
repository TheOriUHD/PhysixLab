/**
 * ED-12: array tools — linear, grid, radial and along-a-path — with a live wireframe preview, and either
 * independent copies or a linked (re-editable) array held by a group.
 *
 *   panel "Array" (right dock)            parameters, preview, Apply / Cancel, independent or linked
 *   commands (category "Arrange")         open the panel for a kind, apply, update a linked array, make it independent
 *   inspector section "Linked array"      shown for a group that holds an array: edit the parameters (rebuilds the
 *                                         copies, one undo step), update from the source, make independent
 *
 * The arithmetic is `model/edit/arrays.ts`, the state and store edits are `app/edit/arrayTool.ts`.
 */
import {
  registerCommand,
  registerInspectorSection,
  registerMenuEntry,
  registerPanel,
  runCommand,
} from '../../app/registry';
import {
  getArrayTool,
  linkedArraysOf,
  rebuildLinkedArray,
  unlinkArray,
  updateLinkedArrays,
} from '../../app/edit/arrayTool';
import {
  ARRAY_KIND_LABELS,
  ARRAY_KINDS,
  defaultSpec,
  type ArrayKind,
  type ArraySpec,
} from '../../model/edit/arraySpec';
import { isGroup } from '../../model/types';
import type { App } from '../../app/app';
import { button, row, section, segmented } from '../controls';
import { buildArrayForm } from '../arrayForm';
import { h } from '../dom';

const ARRAY_ICON =
  '<rect x="3" y="8" width="5" height="8" rx="1"/><rect x="10" y="8" width="5" height="8" rx="1" opacity=".65"/><rect x="17" y="8" width="4" height="8" rx="1" opacity=".35"/>';

const pluralise = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// ── the panel ───────────────────────────────────────────────────────────────────────────────────────────────────

registerPanel({
  id: 'array',
  label: 'Array',
  icon: ARRAY_ICON,
  region: 'right',
  order: 25,
  title: 'Repeat the selection in a line, a grid, around an axis or along a path',
  build: (app, ctx) => {
    const tool = getArrayTool(app);
    const info = h('p', { class: 'ed-array-info' });
    const status = h('p', { class: 'ed-array-status', role: 'status' });
    const form = buildArrayForm({
      spec: tool.spec,
      paths: () => tool.paths(),
      onChange: (s) => tool.setSpec(s),
      onKind: (k) => tool.setKind(k),
    });
    const mode = segmented<'independent' | 'linked'>({
      value: tool.mode,
      options: [
        { value: 'independent', label: 'Independent', title: 'Plain copies: ordinary bodies you can edit one by one' },
        {
          value: 'linked',
          label: 'Linked',
          title:
            'A group that remembers the parameters: re-edit them later in the Inspector; edit the original and update',
        },
      ],
      onChange: (m) => tool.setMode(m),
    });
    const apply = button('Apply', () => void tool.apply(), {
      cls: 'primary',
      title: 'Make the copies (one undo step)',
    });
    apply.dataset.action = 'apply-array';
    const cancel = button('Cancel', () => tool.cancel(), { title: 'Discard the preview' });
    cancel.dataset.action = 'cancel-array';

    const update = () => {
      form.sync(tool.spec);
      mode.set(tool.mode);
      const n = tool.sources.length;
      const why = tool.problem();
      info.textContent = n
        ? `Repeating ${pluralise(n, 'selected object')}.`
        : tool.armed
          ? 'Select the objects to repeat — a preview shows the copies.'
          : 'Array made. Select objects to make another one.';
      const copies = tool.copyCount();
      status.textContent = why
        ? n && why !== 'Select the objects to repeat.'
          ? why
          : ''
        : `${pluralise(copies, 'new copy', 'new copies')} of ${pluralise(n, 'object')}${tool.mode === 'linked' ? ', in a linked group' : ''}.`;
      status.classList.toggle('warn', !!why && !!n);
      apply.disabled = !!why;
      cancel.disabled = !n;
    };
    tool.on('change', update);
    update();

    // The preview exists only while this tab is the visible one.
    const stop = app.on('frame', () => {
      tool.setVisible(ctx.active() && app.prefs.value.showRight);
    });

    return {
      el: h(
        'div',
        { class: 'ed-array-panel panel-body' },
        info,
        form.el,
        row('Result', mode.el),
        status,
        h('div', { class: 'ed-array-buttons' }, apply, cancel),
      ),
      onShow: () => {
        tool.setVisible(true);
        update();
      },
      dispose: () => {
        stop();
        tool.dispose();
      },
    };
  },
});

// ── commands ────────────────────────────────────────────────────────────────────────────────────────────────────

const openPanel = (app: App) => runCommand('panel.array', app, 'api');

registerCommand({
  id: 'edit.array.open',
  label: 'Array…',
  category: 'Arrange',
  icon: ARRAY_ICON,
  description: 'Repeat the selection in a line, grid, circle or along a path, with a live preview',
  keywords: ['array', 'repeat', 'pattern', 'copies', 'linear', 'grid', 'radial', 'circular', 'path', 'instances'],
  shortcut: 'Shift+Y',
  enabled: (app) => !app.sim.active,
  run: ({ app }) => {
    openPanel(app);
    getArrayTool(app).setVisible(true);
  },
});

for (const k of ARRAY_KINDS) {
  registerCommand({
    id: `edit.array.${k}`,
    label: `Array: ${ARRAY_KIND_LABELS[k].toLowerCase()}…`,
    category: 'Arrange',
    icon: ARRAY_ICON,
    description: {
      linear: 'Repeat the selection in a straight line',
      grid: 'Repeat the selection in a grid',
      radial: 'Repeat the selection around an axis (full circle or an arc)',
      path: 'Repeat the selection at equal spacing along a path',
    }[k],
    keywords: ['array', 'repeat', 'pattern', k],
    enabled: (app) => !app.sim.active,
    run: ({ app }) => {
      const tool = getArrayTool(app);
      if (tool.spec.kind !== k) tool.setKind(k);
      openPanel(app);
      tool.setVisible(true);
    },
  });
}

registerCommand({
  id: 'edit.array.apply',
  label: 'Apply array',
  category: 'Arrange',
  icon: ARRAY_ICON,
  description: 'Make the copies shown in the Array panel',
  keywords: ['array', 'apply', 'confirm'],
  enabled: (app) => getArrayTool(app).problem() === null,
  run: ({ app }) => void getArrayTool(app).apply(),
});

registerCommand({
  id: 'edit.array.update',
  label: 'Update linked array',
  category: 'Arrange',
  icon: ARRAY_ICON,
  description: 'Rebuild the copies of a linked array from its (edited) original objects',
  keywords: ['array', 'update', 'refresh', 'propagate', 'linked'],
  enabled: (app) => !app.sim.active && linkedArraysOf(app).length > 0,
  run: ({ app }) => {
    const n = updateLinkedArrays(app);
    if (n) app.toast(`Updated ${pluralise(n, 'linked array')}.`, 'success');
  },
});

registerCommand({
  id: 'edit.array.unlink',
  label: 'Make array independent',
  category: 'Arrange',
  description: 'Keep the copies as ordinary objects and forget the array parameters',
  keywords: ['array', 'unlink', 'break', 'independent'],
  enabled: (app) => !app.sim.active && app.store.selection.some((id) => !!app.store.group(id)?.array),
  run: ({ app }) => {
    for (const id of app.store.selection) unlinkArray(app, id);
  },
});

registerMenuEntry({
  id: 'menu.edit.array.open',
  menu: 'edit',
  group: 'array',
  order: 620,
  command: 'edit.array.open',
  icon: ARRAY_ICON,
});
registerMenuEntry({
  id: 'menu.edit.array.update',
  menu: 'edit',
  group: 'array',
  order: 621,
  command: 'edit.array.update',
});
registerMenuEntry({
  id: 'menu.edit.array.unlink',
  menu: 'edit',
  group: 'array',
  order: 622,
  command: 'edit.array.unlink',
});

// ── the inspector section of a linked array ─────────────────────────────────────────────────────────────────────

registerInspectorSection({
  id: 'ed-array',
  order: 110,
  appliesTo: (selection) => selection.length === 1 && isGroup(selection[0]) && !!selection[0].array,
  build: (ctx, selection) => {
    const first = selection[0];
    if (!isGroup(first) || !first.array) return [];
    const app = ctx.app;
    const id = first.id;
    const current = (): ArraySpec => app.store.group(id)?.array?.spec ?? first.array!.spec;
    const sourceNames = h('p', { class: 'ed-array-info' });
    const status = h('p', { class: 'ed-array-status', role: 'status' });
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: ArraySpec | null = null;
    const flush = () => {
      timer = null;
      const spec = pending;
      pending = null;
      if (spec) rebuildLinkedArray(app, id, spec, 'Edit array');
    };
    const queue = (spec: ArraySpec) => {
      pending = spec;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 180);
    };
    const form = buildArrayForm({
      spec: current(),
      paths: () => app.store.paths(),
      onChange: queue,
      onKind: (k: ArrayKind) => {
        const d = defaultSpec(k);
        queue(d.kind === 'path' ? { ...d, pathId: app.store.paths()[0]?.id ?? '' } : d);
      },
    });
    const describe = () => {
      const g = app.store.group(id);
      const def = g?.array;
      if (!g || !def) return;
      const names = def.sourceIds.map((s) => app.store.get(s)?.name ?? '(deleted)');
      sourceNames.textContent = `Copies of ${names.join(', ')}.`;
      const missing = def.sourceIds.some((s) => !app.store.has(s));
      status.textContent = missing
        ? 'An original object was deleted: the copies stay, but the array can no longer be rebuilt.'
        : `${pluralise(app.store.children(id).length, 'object')} in this array. Edit the originals, then Update.`;
      status.classList.toggle('warn', missing);
    };
    describe();
    ctx.updaters.push(() => {
      describe();
      if (!pending) form.sync(current());
    });
    const buttons = h(
      'div',
      { class: 'ed-array-buttons' },
      button('Update from originals', () => void rebuildLinkedArray(app, id), {
        icon: 'reset',
        title: 'Rebuild the copies from the current state of the original objects',
        cls: 'primary',
      }),
      button(
        'Select originals',
        () => app.store.setSelection(app.store.group(id)?.array?.sourceIds.filter((s) => app.store.has(s)) ?? []),
        { title: 'Select the objects this array repeats' },
      ),
      button('Make independent', () => unlinkArray(app, id), {
        title: 'Keep the copies as ordinary objects and forget the parameters',
      }),
    );
    return [section('Linked array', [sourceNames, form.el, status, buttons], { id: 'linked-array' })];
  },
});
