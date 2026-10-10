/**
 * The keymap: key events → commands. It is *derived* from the command registry (nothing else binds keys), indexed
 * by key so a lookup costs a map access, and rebuilt lazily whenever a command is registered or removed.
 */
import { commandRegistry, type CommandDef } from './commands';
import { chordMatches, parseShortcut, shortcutList, type Chord, type KeyLike } from './shortcuts';

interface Binding {
  chord: Chord;
  command: CommandDef;
}

export class Keymap {
  private index = new Map<string, Binding[]>();
  private builtFor = -1;

  private rebuild(): void {
    const index = new Map<string, Binding[]>();
    for (const command of commandRegistry.list())
      for (const s of shortcutList(command.shortcut)) {
        const chord = parseShortcut(s);
        const k = `${chord.by}:${chord.key}`;
        const list = index.get(k);
        if (list) list.push({ chord, command });
        else index.set(k, [{ chord, command }]);
      }
    this.index = index;
    this.builtFor = commandRegistry.revision;
  }

  /** The command a key event triggers, if any. An exact Shift match beats a chord that ignores Shift. */
  find(e: KeyLike): CommandDef | undefined {
    if (this.builtFor !== commandRegistry.revision) this.rebuild();
    const byKey = this.index.get(`key:${e.key.toLowerCase()}`);
    const byCode = this.index.get(`code:${e.code}`);
    let loose: CommandDef | undefined;
    for (const list of [byKey, byCode]) {
      if (!list) continue;
      for (const b of list) {
        if (!chordMatches(b.chord, e)) continue;
        if (b.chord.shift !== null) return b.command;
        loose ??= b.command;
      }
    }
    return loose;
  }
}

/** The app's keymap. */
export const keymap = new Keymap();
