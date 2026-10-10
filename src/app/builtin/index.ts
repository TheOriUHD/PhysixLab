/**
 * Registers the built-in commands, tools and help rows that need no DOM. Call it once at start-up (before any
 * UI is built); `src/ui/builtin` does the same for what needs the DOM.
 *
 * A package does not edit this file: it calls `registerCommand` / `registerTool` / … from its own module.
 */
import { registerCommand } from '../registry/commands';
import { registerTool } from '../registry/tools';
import { builtinCommands, registerBuiltinHelp } from './commands';
import { BUILTIN_TOOLS } from './tools';

let done = false;

export function registerAppBuiltins(): void {
  if (done) return;
  done = true;
  for (const c of builtinCommands()) registerCommand(c);
  // Tools after commands: buttons that mirror a command look it up when the bar is built.
  for (const t of BUILTIN_TOOLS) registerTool(t);
  registerBuiltinHelp();
}
