/**
 * Registers the built-in registrations that need the DOM: dialog commands, the menus, the panels and the
 * inspector sections. `registerBuiltins()` does everything (app + ui) and is what `main.ts` calls; afterwards
 * `loadExtensions()` imports the files dropped into `src/ui/extensions/`.
 */
import { registerAppBuiltins } from '../../app/builtin';
import { registerCommand } from '../../app/registry/commands';
import { registerInspectorSection } from '../../app/registry/inspectorSections';
import { BUILTIN_INSPECTOR_SECTIONS } from '../inspector/sections';
import { uiCommands } from './commands';
import { registerBuiltinMenus } from './menus';
import { registerBuiltinPanels } from './panels';
import { registerAppearance } from '../appearance';
// -- UI-A: layout commands and menu --
import { layoutCommands, registerLayoutMenu } from '../dock/layoutCommands';
import { registerUiA } from '../uiA';

let done = false;

export function registerUiBuiltins(): void {
  if (done) return;
  done = true;
  for (const c of uiCommands()) registerCommand(c);
  registerBuiltinMenus();
  for (const s of BUILTIN_INSPECTOR_SECTIONS) registerInspectorSection(s);
  registerBuiltinPanels();
  registerAppearance(); // -- VZ-50 --
  // -- UI-A: layout presets, save / reset, maximise --
  for (const c of layoutCommands()) registerCommand(c);
  registerLayoutMenu();
  registerUiA();
}

/** All built-in commands, tools, help, menus, panels and inspector sections. */
export function registerBuiltins(): void {
  registerAppBuiltins();
  registerUiBuiltins();
}

/**
 * Import every module in `src/ui/extensions/` (a file there registers commands, tools, panels, inspector sections
 * or menu entries by calling the `register…` functions of `src/app/registry`). They load *after* the built-ins, so
 * they can refer to built-in commands and menus. A module that fails to load is reported and skipped; the rest of
 * the app starts normally. Returns the failures, for the caller to show.
 */
export async function loadExtensions(): Promise<{ file: string; error: Error }[]> {
  const modules = import.meta.glob(['../extensions/*.ts', '!../extensions/*.test.ts']);
  const failures: { file: string; error: Error }[] = [];
  for (const [file, load] of Object.entries(modules)) {
    try {
      await load();
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      console.error(`[extension ${file}]`, error);
      failures.push({ file: file.replace('../extensions/', ''), error });
    }
  }
  return failures;
}
