/**
 * The UI registries. Import from here:
 *
 *   commands           every user-invokable action (id, label, category, icon, shortcut, enabled, run)
 *   tools              toolbox / view bar buttons and the interaction modes behind them
 *   panels             tabs of the left, right and bottom regions
 *   inspectorSections  what the inspector shows for a selection
 *   menus              the menu bar and the context menu
 *   help               the shortcut help (generated; gestures are registered here)
 *
 * The built-in registrations live in `src/app/builtin` (no DOM) and `src/ui/builtin` (DOM); see docs/EXTENDING.md.
 */
export * from './commands';
export * from './help';
export * from './inspectorSections';
export * from './keymap';
export * from './menus';
export * from './panels';
export * from './shortcuts';
export * from './tools';
