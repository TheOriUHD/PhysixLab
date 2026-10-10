/**
 * Adapter to the shapes package's "merge into compound" command (SH-20). The command is looked up when it is needed,
 * so this file works before and after the shapes package lands: until then `mergeCommand()` is undefined and the
 * "Merge group into compound" entry says what it needs instead of pretending.
 */
import type { App } from '../app';
import { commandEnabled, getCommand, listCommands, runCommand, type CommandDef } from '../registry';
import { groupBodies } from './groupOps';

/** Command ids the shapes package may use, most specific first. */
const KNOWN_IDS = ['shape.mergeCompound', 'shapes.mergeCompound', 'edit.mergeCompound', 'edit.mergeIntoCompound'];

export function mergeCommand(): CommandDef | undefined {
  for (const id of KNOWN_IDS) {
    const c = getCommand(id);
    if (c) return c;
  }
  return listCommands().find((c) => /compound/i.test(c.id) && /merge|combine/i.test(`${c.id} ${c.label}`));
}

export const MERGE_NEEDS = 'Needs the “Merge into compound” command from the shapes package';

/**
 * Select the group's bodies, run the shapes package's merge command and replace the group by the result (the group
 * is removed when nothing but the merged compound was inside it). One undo step. Returns false when the command is
 * missing or refuses, or the group has fewer than two bodies.
 */
export function mergeGroupIntoCompound(app: App, groupId: string): boolean {
  const cmd = mergeCommand();
  const { store } = app;
  const group = store.group(groupId);
  if (!cmd || !group) return false;
  const bodies = groupBodies(store, groupId);
  if (bodies.length < 2) return false;
  let ran = false;
  store.transact('Merge group into compound', () => {
    store.setSelection(bodies.map((b) => b.id));
    if (!commandEnabled(cmd, app)) return;
    ran = runCommand(cmd.id, app, 'api');
    if (!ran || !store.group(groupId)) return;
    const rest = store.descendants(groupId).filter((e) => e.kind !== 'joint');
    if (rest.length <= 1) {
      // The merged body stays where the group was; the empty shell goes.
      store.updateMany(
        store.children(groupId).map((c): [string, { parent: string | undefined }] => [c.id, { parent: group.parent }]),
        'Merge',
      );
      store.remove([groupId], 'Merge');
    }
  });
  return ran;
}
