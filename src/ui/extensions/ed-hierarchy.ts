// ── ED-A hierarchy: group scale / weld / merge, the persisted clipboard (paste variants) and their menu entries ──
import type { Vec3 } from '../../core/math';
import type { App } from '../../app/app';
import { mergeCommand, mergeGroupIntoCompound, MERGE_NEEDS } from '../../app/edit/compoundAdapter';
import {
  hasClipboard,
  pasteAnchor,
  pasteStored,
  pasteText,
  readSystemClipboard,
  setClipboardNotifier,
  setPasteAnchor,
  type PasteResult,
} from '../../app/edit/clipboard';
import { groupBodies, scaleGroup, unweldGroup, weldCount, weldGroup } from '../../app/edit/groupOps';
import { registerCommand, registerInspectorSection, registerMenuEntry } from '../../app/registry';
import type { PasteOptions } from '../../model/edit/clipboard';
import { parseScaleFactor } from '../../model/edit/groupScale';
import { isGroup } from '../../model/types';
import { groupScaleSection } from '../edit/groupSection';
import { promptText } from '../modal';

const currentApp = (): App | undefined => (window as unknown as { physicslab?: App }).physicslab;

// ── groups ──────────────────────────────────────────────────────────────────────────────────────────

const selectedGroups = (app: App): string[] => app.store.selection.filter((id) => app.store.group(id));
const canEditGroups = (app: App): boolean => !app.sim.active && selectedGroups(app).length > 0;

registerCommand({
  id: 'edit.scaleGroup',
  label: 'Scale group…',
  category: 'Edit',
  icon: 'scale',
  description: 'Scale the selected group’s members about its pivot by a factor (one number, or x y z)',
  keywords: ['resize', 'grow', 'shrink', 'size', 'group'],
  enabled: canEditGroups,
  run: async ({ app }) => {
    const text = await promptText(
      'Scale group',
      'Factor along the group’s axes: one number (uniform, always exact) or “x y z”.',
      '2',
      'Scale',
    );
    if (text === null) return;
    const f = parseScaleFactor(text);
    if (!f) {
      app.toast('Enter one positive number, or three (x y z)', 'warn');
      return;
    }
    let approximate = false;
    app.store.transact('Scale group', () => {
      for (const id of selectedGroups(app)) approximate ||= scaleGroup(app.store, id, f).approximate;
    });
    if (approximate)
      app.toast('Some members are turned against the group’s axes, so this scale is approximate for them.', 'warn');
  },
});

registerCommand({
  id: 'edit.weldGroup',
  label: 'Weld group',
  category: 'Edit',
  icon: 'weld',
  description: 'Join the bodies of the selected group into one rigid assembly with fixed joints',
  keywords: ['fixed', 'rigid', 'glue', 'join', 'group'],
  enabled: (app) => canEditGroups(app) && selectedGroups(app).some((id) => groupBodies(app.store, id).length > 1),
  run: ({ app }) => {
    let n = 0;
    app.store.transact('Weld group', () => {
      for (const id of selectedGroups(app)) n += weldGroup(app.store, id);
    });
    app.toast(
      n ? `${n} fixed joint${n === 1 ? '' : 's'} added` : 'Nothing to weld: the bodies are already welded',
      n ? 'success' : 'info',
    );
  },
});

registerCommand({
  id: 'edit.unweldGroup',
  label: 'Unweld group',
  category: 'Edit',
  description: 'Remove the fixed joints made by “Weld group” (other joints stay)',
  keywords: ['unglue', 'separate', 'group'],
  enabled: (app) => canEditGroups(app) && selectedGroups(app).some((id) => weldCount(app.store, id) > 0),
  run: ({ app }) => {
    let n = 0;
    app.store.transact('Unweld group', () => {
      for (const id of selectedGroups(app)) n += unweldGroup(app.store, id);
    });
    app.toast(`${n} weld joint${n === 1 ? '' : 's'} removed`, 'info');
  },
});

registerCommand({
  id: 'edit.mergeGroupCompound',
  label: 'Merge group into compound',
  category: 'Edit',
  icon: 'box',
  description: 'Combine the bodies of the selected group into one compound body',
  keywords: ['compound', 'combine', 'union', 'group'],
  enabled: (app) =>
    canEditGroups(app) && !!mergeCommand() && selectedGroups(app).some((id) => groupBodies(app.store, id).length > 1),
  run: ({ app }) => {
    const gid = selectedGroups(app).find((id) => groupBodies(app.store, id).length > 1);
    if (!gid) return;
    if (!mergeCommand()) app.toast(MERGE_NEEDS, 'warn');
    else if (!mergeGroupIntoCompound(app, gid)) app.toast('Could not merge this group into a compound', 'warn');
  },
});

registerInspectorSection({
  id: 'ed-hierarchy.group',
  order: 150,
  appliesTo: (sel) => sel.length === 1 && isGroup(sel[0]),
  build: (ctx, sel) => (isGroup(sel[0]) ? groupScaleSection(ctx, sel[0]) : []),
});

// ── clipboard ───────────────────────────────────────────────────────────────────────────────────────

function toastPaste(app: App, r: PasteResult | null, opts: PasteOptions): void {
  if (!r) {
    app.toast(
      hasClipboard()
        ? 'The clipboard is empty or could not be pasted'
        : 'Nothing to paste: copy something first (Ctrl+C)',
      'info',
    );
    return;
  }
  const n = r.ids.length;
  const base = `Pasted ${n} ${n === 1 ? 'object' : 'objects'}`;
  app.toast(
    opts.withConnections && r.connections
      ? `${base} with ${r.connections} connection${r.connections === 1 ? '' : 's'}`
      : base,
    'success',
  );
}

const pasteAt = (): Vec3 | undefined => pasteAnchor() ?? undefined;

registerCommand({
  id: 'edit.pasteInPlace',
  label: 'Paste in place',
  category: 'Edit',
  icon: 'copy',
  description: 'Paste at the original coordinates, whichever scene the copy came from',
  keywords: ['original', 'position', 'same place'],
  shortcut: 'Mod+Shift+V',
  run: ({ app }) => {
    const opts: PasteOptions = { inPlace: true };
    toastPaste(app, pasteStored(app.editor, opts), opts);
  },
});

registerCommand({
  id: 'edit.pasteConnections',
  label: 'Paste with connections',
  category: 'Edit',
  icon: 'joint',
  description:
    'Paste, and keep the joints that tied the copy to objects that were not copied: they attach to the world where the other end was',
  keywords: ['joints', 'attached', 'links'],
  run: ({ app }) => {
    const opts: PasteOptions = { withConnections: true, at: pasteAt() };
    toastPaste(app, pasteStored(app.editor, opts), opts);
  },
});

registerCommand({
  id: 'edit.pasteSystem',
  label: 'Paste from system clipboard',
  category: 'Edit',
  description:
    'Paste a PhysicsLab copy that arrived as text (from another browser or window); the browser may ask permission',
  keywords: ['text', 'external', 'other tab'],
  run: async ({ app }) => {
    const text = await readSystemClipboard(false);
    if (text === null) {
      app.toast('The browser did not allow reading the clipboard. Use Ctrl+V in the page instead.', 'warn');
      return;
    }
    const opts: PasteOptions = { at: pasteAt() };
    toastPaste(app, pasteText(app.editor, text, opts), opts);
  },
});

registerMenuEntry({
  id: 'menu.edit.pasteInPlace',
  menu: 'edit',
  group: 'clipboard',
  order: 221,
  command: 'edit.pasteInPlace',
});
registerMenuEntry({
  id: 'menu.edit.pasteConnections',
  menu: 'edit',
  group: 'clipboard',
  order: 222,
  command: 'edit.pasteConnections',
});
registerMenuEntry({
  id: 'menu.edit.pasteSystem',
  menu: 'edit',
  group: 'clipboard',
  order: 223,
  command: 'edit.pasteSystem',
});
registerMenuEntry({ id: 'menu.edit.weldGroup', menu: 'edit', group: 'select', order: 321, command: 'edit.weldGroup' });
registerMenuEntry({
  id: 'menu.edit.unweldGroup',
  menu: 'edit',
  group: 'select',
  order: 322,
  command: 'edit.unweldGroup',
});
registerMenuEntry({
  id: 'menu.edit.mergeGroupCompound',
  menu: 'edit',
  group: 'select',
  order: 323,
  command: 'edit.mergeGroupCompound',
});
registerMenuEntry({
  id: 'menu.edit.scaleGroup',
  menu: 'edit',
  group: 'select',
  order: 324,
  command: 'edit.scaleGroup',
});

// ── browser glue (only in a real page) ──────────────────────────────────────────────────────────────

if (typeof document !== 'undefined') {
  setClipboardNotifier((message, kind) => currentApp()?.toast(message, kind));

  // The pointer's ground point is where a plain paste lands (only while the pointer is over the viewport).
  const last = { x: 0, y: 0, over: false };
  document.addEventListener(
    'pointermove',
    (e) => {
      last.x = e.clientX;
      last.y = e.clientY;
      last.over = e.target === currentApp()?.viewport.dom;
    },
    { passive: true },
  );
  setPasteAnchor(() => {
    const app = currentApp();
    if (!app || !last.over) return null;
    const p = app.picker.groundPoint({ clientX: last.x, clientY: last.y }, 0);
    if (!p || p.length() > 1000) return null;
    const s = app.prefs.value.snap ? app.prefs.value.snapGrid : 0;
    const q = (v: number) => (s > 0 ? Math.round(v / s) * s : v);
    return [q(p.x), 0, q(p.z)];
  });

  // A paste the browser itself delivers (its Edit menu, a context menu, touch keyboards) carries the system text.
  document.addEventListener('paste', (e) => {
    const app = currentApp();
    const t = e.target as HTMLElement | null;
    if (!app || (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) return;
    const text = e.clipboardData?.getData('text/plain');
    if (!text || !text.includes('physicslab-clipboard')) return;
    e.preventDefault();
    const opts: PasteOptions = { at: pasteAt() };
    toastPaste(app, pasteText(app.editor, text, opts), opts);
  });
}
