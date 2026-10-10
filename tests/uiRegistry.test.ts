/**
 * The UI registries (commands, tools, panels, menus, help, keymap) without a DOM: registration rules, the
 * shortcut syntax, key lookup, and — the important part — that the built-in registrations keep every shortcut,
 * menu entry and toolbox button the app had before they were generated from the registries.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from '../src/app/app';
import { registerAppBuiltins } from '../src/app/builtin';
import { PrefsStore } from '../src/app/prefs';
import {
  commandChecked,
  commandEnabled,
  commandLabel,
  getCommand,
  listCommands,
  registerCommand,
  runCommand,
  withShortcut,
  type CommandDef,
} from '../src/app/registry/commands';
import { helpSections, registerHelp } from '../src/app/registry/help';
import { keymap, shouldPreventDefault } from '../src/app/registry/keymap';
import { listBarMenus, registerMenu, registerMenuEntry, resolveMenu, type MenuItem } from '../src/app/registry/menus';
import { listPanels, registerPanel, unregisterPanel } from '../src/app/registry/panels';
import {
  chordMatches,
  formatShortcut,
  parseShortcut,
  shortcutTokens,
  type KeyLike,
} from '../src/app/registry/shortcuts';
import {
  commandIdOf,
  getTool,
  hintForMode,
  listTools,
  registerTool,
  toolForMode,
  toolModes,
  unregisterTool,
} from '../src/app/registry/tools';
import { hasIcon } from '../src/ui/icons';
import { registerUiBuiltins } from '../src/ui/builtin';
import { listTemplates } from '../src/model/content';
import { listShapes } from '../src/model/shapeRegistry';
import { createBody } from '../src/model/factory';
import { SceneStore } from '../src/model/store';

const key = (k: string, mods: Partial<Pick<KeyLike, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>> = {}): KeyLike => ({
  key: k,
  code: k.length === 1 ? (/[a-z]/i.test(k) ? `Key${k.toUpperCase()}` : /\d/.test(k) ? `Digit${k}` : '') : k,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});
/** An event identified by its `code` (Space, Delete …). */
const code = (c: string, mods: Partial<KeyLike> = {}): KeyLike => ({ ...key(c), key: c, code: c, ...mods });

interface FakeSim {
  active: boolean;
  mode: 'edit' | 'running' | 'paused';
  toggle: () => void;
  reset: () => void;
  step: (n: number) => void;
}

function fakeApp() {
  const sim: FakeSim = { active: false, mode: 'edit', toggle: vi.fn(), reset: vi.fn(), step: vi.fn() };
  const toasts: string[] = [];
  const app = {
    store: new SceneStore(),
    prefs: new PrefsStore(),
    sim,
    toast: (t: string) => toasts.push(t),
    frameAll: vi.fn(),
    frameSelection: vi.fn(),
    setGizmo: vi.fn(),
    setTool: vi.fn(),
    addShape: vi.fn(),
    placement: { ghost: { arm: vi.fn() } },
    editor: { duplicateSelection: vi.fn(), deleteSelection: vi.fn(), copy: vi.fn(), paste: vi.fn() },
  };
  return { app: app as unknown as App, raw: app, toasts, sim };
}

beforeAll(() => {
  registerAppBuiltins();
  registerUiBuiltins();
});

describe('shortcut syntax', () => {
  it('parses modifiers, characters and key names', () => {
    expect(parseShortcut('Mod+Shift+Z')).toEqual({ mod: true, shift: true, by: 'key', key: 'z' });
    expect(parseShortcut('Q')).toEqual({ mod: false, shift: null, by: 'key', key: 'q' });
    expect(parseShortcut('Shift+Space')).toEqual({ mod: false, shift: true, by: 'code', key: 'Space' });
    expect(parseShortcut('?')).toEqual({ mod: false, shift: null, by: 'key', key: '?' });
    expect(parseShortcut('Mod+Plus')).toEqual({ mod: true, shift: null, by: 'key', key: '+' });
    expect(parseShortcut('F5').key).toBe('F5');
    expect(parseShortcut('NumpadDecimal').by).toBe('code');
  });

  it('rejects typos with a message that says what to write instead', () => {
    expect(() => parseShortcut('')).toThrow(/cannot be empty/);
    expect(() => parseShortcut('Ctrl+Z')).toThrow(/unknown modifier "Ctrl" \(use Mod and Shift\)/);
    expect(() => parseShortcut('Mod+')).toThrow(/has no key/);
    expect(() => parseShortcut('Esc')).toThrow(/not a key name/);
    expect(() => parseShortcut('Del')).toThrow(/not a key name/);
    expect(() => parseShortcut('Mod+Shift')).toThrow(/not a key name/);
  });

  it('matches like the app always did: Mod is Ctrl or ⌘, Shift is "either" unless named, Alt is ignored', () => {
    const z = parseShortcut('Mod+Z');
    expect(chordMatches(z, key('z', { ctrlKey: true }))).toBe(true);
    expect(chordMatches(z, key('z', { metaKey: true }))).toBe(true);
    expect(chordMatches(z, key('Z', { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(chordMatches(z, key('z'))).toBe(false);
    expect(chordMatches(parseShortcut('Mod+Shift+Z'), key('z', { ctrlKey: true }))).toBe(false);
    const q = parseShortcut('Q');
    expect(chordMatches(q, key('q'))).toBe(true);
    expect(chordMatches(q, key('Q', { shiftKey: true }))).toBe(true);
    expect(chordMatches(q, key('q', { altKey: true }))).toBe(true);
    expect(chordMatches(q, key('q', { ctrlKey: true })), 'plain letters never fire inside Ctrl combinations').toBe(
      false,
    );
    const space = parseShortcut('Space');
    expect(chordMatches(space, code('Space'))).toBe(true);
    expect(chordMatches(space, { ...code('Space'), key: ' ' }), 'by code, whatever the layout puts in key').toBe(true);
  });

  it('formats for PC and Mac', () => {
    expect(formatShortcut('Mod+Shift+Z', 'pc')).toBe('Ctrl+Shift+Z');
    expect(formatShortcut('Mod+Shift+Z', 'mac')).toBe('⌘⇧Z');
    expect(formatShortcut('Delete', 'pc')).toBe('Del');
    expect(formatShortcut('Shift+Space', 'pc')).toBe('Shift+Space');
    expect(formatShortcut('Period', 'pc')).toBe('.');
    expect(shortcutTokens('Mod+K', 'pc')).toEqual(['Ctrl', 'K']);
    expect(formatShortcut('Home', 'pc')).toBe('Home');
    expect(formatShortcut('?', 'pc')).toBe('?');
  });
});

describe('command registry', () => {
  const base = (over: Partial<CommandDef> = {}): CommandDef => ({
    id: 'test.cmd',
    label: 'Test',
    category: 'Test',
    run: () => undefined,
    ...over,
  });

  it('registers, finds, lists and unregisters', () => {
    const off = registerCommand(base());
    expect(getCommand('test.cmd')?.label).toBe('Test');
    expect(listCommands().some((c) => c.id === 'test.cmd')).toBe(true);
    off();
    expect(getCommand('test.cmd')).toBeUndefined();
  });

  it('rejects a command without a label, category or run()', () => {
    expect(() => registerCommand(base({ label: ' ' }))).toThrow(/label must not be empty/);
    expect(() => registerCommand(base({ category: '' }))).toThrow(/category must not be empty/);
    expect(() => registerCommand(base({ run: undefined as unknown as CommandDef['run'] }))).toThrow(
      /needs a run\(\) function/,
    );
  });

  it('rejects a shortcut that is already taken, naming the owner, and a malformed one', () => {
    expect(() => registerCommand(base({ shortcut: 'Mod+Z' }))).toThrow(
      /shortcut "Mod\+Z" is already used by "edit.undo"/,
    );
    expect(() => registerCommand(base({ shortcut: 'Q' }))).toThrow(/already used by "tool.select"/);
    expect(() => registerCommand(base({ shortcut: ['F9', 'Esc'] }))).toThrow(/not a key name/);
    // Same key with and without an explicit Shift are different chords (Space / Shift+Space is how the app works).
    const off = registerCommand(base({ shortcut: 'Shift+F9' }));
    const off2 = registerCommand(base({ id: 'test.cmd2', shortcut: 'F9' }));
    off();
    off2();
    // A failed registration leaves nothing behind.
    expect(getCommand('test.cmd')).toBeUndefined();
  });

  it('runs a command only when it exists and is enabled, and reports a failing command instead of throwing', () => {
    const { app, toasts } = fakeApp();
    const run = vi.fn();
    const off = registerCommand(base({ enabled: () => false, run }));
    expect(runCommand('test.cmd', app)).toBe(false);
    expect(run).not.toHaveBeenCalled();
    off();
    expect(runCommand('test.nope', app)).toBe(false);

    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const off2 = registerCommand(
      base({
        run: () => {
          throw new Error('boom');
        },
      }),
    );
    expect(runCommand('test.cmd', app)).toBe(true);
    expect(toasts).toEqual(['“Test” failed: boom']);
    off2();
    const off3 = registerCommand(base({ run: () => Promise.reject(new Error('later')) }));
    expect(runCommand('test.cmd', app)).toBe(true);
    off3();
    err.mockRestore();
  });

  it('passes the source and the key event to run()', () => {
    const { app } = fakeApp();
    const run = vi.fn();
    const off = registerCommand(base({ run }));
    const ev = {} as KeyboardEvent;
    runCommand('test.cmd', app, 'shortcut', ev);
    expect(run).toHaveBeenCalledWith({ app, source: 'shortcut', event: ev });
    off();
  });

  it('tooltips take the shortcut from the command: "Undo (Ctrl+Z)", nothing appended without one', () => {
    expect(withShortcut('Undo', 'edit.undo')).toBe(`Undo (${formatShortcut('Mod+Z')})`);
    expect(withShortcut('Redo Move', 'edit.redo')).toBe(`Redo Move (${formatShortcut('Mod+Shift+Z')})`);
    expect(withShortcut('Stop', 'sim.reset')).toBe(`Stop (${formatShortcut('Shift+Space')})`);
    expect(withShortcut('Anything', 'edit.rotate90')).toBe('Anything'); // a command without a shortcut
    expect(withShortcut('Anything', 'no.such.command')).toBe('Anything');
  });

  it('every built-in command and tool uses an icon of the icon set', () => {
    for (const c of listCommands())
      if (c.icon) expect(hasIcon(c.icon) || c.icon.startsWith('<'), `${c.id}: ${c.icon}`).toBe(true);
    for (const t of listTools('toolbox').concat(listTools('viewbar')))
      expect(hasIcon(t.icon), `${t.id}: ${t.icon}`).toBe(true);
  });
});

describe('the built-in keymap keeps every shortcut the app had', () => {
  const press = (e: KeyLike) => keymap.find(e)?.id;
  const ctrl = { ctrlKey: true };

  it('Ctrl / ⌘ combinations', () => {
    expect(press(key('z', ctrl))).toBe('edit.undo');
    expect(press(key('Z', { ...ctrl, shiftKey: true }))).toBe('edit.redo');
    expect(press(key('y', ctrl))).toBe('edit.redo');
    expect(press(key('d', ctrl))).toBe('edit.duplicate');
    expect(press(key('g', ctrl))).toBe('edit.group');
    expect(press(key('G', { ...ctrl, shiftKey: true }))).toBe('edit.ungroup');
    expect(press(key('c', ctrl))).toBe('edit.copy');
    expect(press(key('v', ctrl))).toBe('edit.paste');
    expect(press(key('a', ctrl))).toBe('edit.selectAll');
    expect(press(key('s', ctrl))).toBe('file.save');
    expect(press(key('k', ctrl))).toBe('app.palette');
    expect(press(key('z', { metaKey: true }))).toBe('edit.undo');
    expect(press(key('q', ctrl)), 'unbound Ctrl combination').toBeUndefined();
  });

  it('Space, Shift+Space, period, delete, escape, home', () => {
    expect(press(code('Space'))).toBe('sim.toggle');
    expect(press(code('Space', { shiftKey: true }))).toBe('sim.reset');
    expect(press(code('Period'))).toBe('sim.step');
    expect(press(code('Delete'))).toBe('edit.delete');
    expect(press(code('Backspace'))).toBe('edit.delete');
    expect(press(code('Escape'))).toBe('edit.cancel');
    expect(press(code('Home'))).toBe('view.frameAll');
    expect(press(code('NumpadDecimal'))).toBe('view.frameSelection');
  });

  it('single letters: tools, snapping, space, hide, lock, follow, frame', () => {
    const letters: Record<string, string> = {
      q: 'tool.select',
      w: 'tool.move',
      e: 'tool.rotate',
      r: 'tool.scale',
      j: 'tool.joint',
      m: 'tool.measure',
      b: 'tool.blast',
      t: 'tool.shoot',
      f: 'view.frameSelection',
      g: 'view.snap',
      x: 'view.space',
      h: 'edit.hide',
      l: 'edit.lock',
      c: 'view.follow',
      '?': 'help.shortcuts',
    };
    for (const [k, id] of Object.entries(letters)) expect(press(key(k)), k).toBe(id);
    // As before, Shift does not turn a letter shortcut off.
    expect(press(key('Q', { shiftKey: true }))).toBe('tool.select');
  });

  it('1–9 add the first nine shapes of the registry, in registry order', () => {
    const shapes = listShapes();
    for (let i = 1; i <= 9; i++) {
      const id = press(key(String(i)));
      if (i <= shapes.length) expect(id, String(i)).toBe(`add.shape.${shapes[i - 1].id}`);
      else expect(id).toBeUndefined();
    }
  });

  it('arrow keys nudge, with or without Shift', () => {
    expect(press(code('ArrowUp'))).toBe('edit.nudge.forward');
    expect(press(code('ArrowDown', { shiftKey: true }))).toBe('edit.nudge.back');
    expect(press(code('ArrowLeft'))).toBe('edit.nudge.left');
    expect(press(code('ArrowRight', { shiftKey: true }))).toBe('edit.nudge.right');
  });

  it('owns its keys: the browser action is prevented even while the command is disabled, except where the old code let it through', () => {
    const cmd = (id: string) => getCommand(id)!;
    // Ctrl+D with nothing selected must not bookmark the page, Ctrl+Y must not open the history, Shift+Space must not
    // click a focused button — the command being disabled changes nothing about that.
    for (const id of [
      'edit.duplicate',
      'edit.redo',
      'edit.undo',
      'edit.group',
      'edit.ungroup',
      'sim.reset',
      'edit.delete',
      'file.save',
    ])
      expect(shouldPreventDefault(cmd(id), false), id).toBe(true);
    // Arrow keys keep scrolling things unless there is something to nudge.
    expect(shouldPreventDefault(cmd('edit.nudge.left'), false)).toBe(false);
    expect(shouldPreventDefault(cmd('edit.nudge.left'), true)).toBe(true);
    // Ctrl+C must reach the browser; Escape was never prevented.
    expect(shouldPreventDefault(cmd('edit.copy'), true)).toBe(false);
    expect(shouldPreventDefault(cmd('edit.cancel'), true)).toBe(false);
  });

  it('follows the registry live: a new command is found, a removed one is not', () => {
    expect(press(key('8', {}))).toBeDefined();
    const off = registerCommand({ id: 'test.f9', label: 'F9', category: 'Test', shortcut: 'F9', run: () => undefined });
    expect(press(code('F9'))).toBe('test.f9');
    off();
    expect(press(code('F9'))).toBeUndefined();
  });
});

describe('built-in commands behave as the hard-wired code did', () => {
  it('undo and redo are enabled by the history, labelled by it, and toast only for shortcuts', () => {
    const { app, raw, toasts } = fakeApp();
    const undo = getCommand('edit.undo')!;
    expect(commandEnabled(undo, app)).toBe(false);
    expect(commandLabel(undo, app)).toBe('Undo');
    raw.store.add([createBody({ name: 'Crate', shape: { type: 'box' } })], 'Add Crate');
    expect(commandEnabled(undo, app)).toBe(true);
    expect(commandLabel(undo, app)).toBe('Undo Add Crate');
    runCommand('edit.undo', app, 'menu');
    expect(toasts).toEqual([]);
    runCommand('edit.redo', app, 'shortcut');
    expect(toasts).toEqual(['Redo: Add Crate']);
    runCommand('edit.undo', app, 'shortcut');
    expect(toasts).toEqual(['Redo: Add Crate', 'Undo: Add Crate']);
  });

  it('simulation commands drive the controller; Reset needs a simulation', () => {
    const { app, sim } = fakeApp();
    runCommand('sim.toggle', app, 'shortcut');
    runCommand('sim.step', app, 'shortcut');
    expect(sim.toggle).toHaveBeenCalledOnce();
    expect(sim.step).toHaveBeenCalledWith(1);
    expect(runCommand('sim.reset', app)).toBe(false);
    sim.mode = 'running';
    sim.active = true;
    expect(commandLabel(getCommand('sim.toggle')!, app)).toBe('Pause simulation');
    runCommand('sim.reset', app);
    expect(sim.reset).toHaveBeenCalledOnce();
  });

  it('toggles report their state and flip the preference', () => {
    const { app, raw, toasts } = fakeApp();
    const snap = getCommand('view.snap')!;
    const before = raw.prefs.value.snap;
    expect(commandChecked(snap, app)).toBe(before);
    runCommand('view.snap', app, 'shortcut');
    expect(raw.prefs.value.snap).toBe(!before);
    expect(toasts).toEqual([!before ? 'Snapping on' : 'Snapping off']);
    runCommand('view.snap', app, 'button');
    expect(raw.prefs.value.snap).toBe(before);
    expect(toasts).toHaveLength(1);
    runCommand('view.overlay.velocity', app, 'menu');
    expect(raw.prefs.value.overlays.velocity).toBe(true);
    expect(commandChecked(getCommand('view.overlay.velocity')!, app)).toBe(true);
    runCommand('view.color.speed', app);
    expect(raw.prefs.value.colorMode).toBe('speed');
    expect(commandChecked(getCommand('view.color.speed')!, app)).toBe(true);
    expect(commandChecked(getCommand('view.color.material')!, app)).toBe(false);
  });

  it('gravity presets set the document gravity in one undo step and report which one is active', () => {
    const { app, raw } = fakeApp();
    const moon = getCommand('world.gravity.moon')!;
    expect(commandChecked(getCommand('world.gravity.earth')!, app)).toBe(true);
    expect(commandChecked(moon, app)).toBe(false);
    runCommand('world.gravity.moon', app, 'palette');
    expect(raw.store.settings.gravity).toEqual([0, -1.62, 0]);
    expect(commandChecked(moon, app)).toBe(true);
    expect(raw.store.undoLabel).toContain('Moon');
    raw.store.undo();
    expect(commandChecked(getCommand('world.gravity.earth')!, app)).toBe(true);
    runCommand('world.gravity.zero', app);
    expect(raw.store.settings.gravity).toEqual([0, -0, 0]);
  });

  it('a number key arms a ghost that follows the pointer; a programmatic call still adds at the view centre', () => {
    const { app, raw } = fakeApp();
    runCommand(`add.shape.${listShapes()[1].id}`, app, 'shortcut');
    expect(raw.placement.ghost.arm).toHaveBeenCalledTimes(1);
    expect(raw.placement.ghost.arm.mock.calls[0][0].id).toBe(`shape:${listShapes()[1].id}`);
    expect(raw.addShape).not.toHaveBeenCalled();
    runCommand(`add.shape.${listShapes()[1].id}`, app);
    expect(raw.addShape).toHaveBeenCalledWith(listShapes()[1].id);
  });
});

describe('tool registry', () => {
  it('registers the toolbox in the order and groups the app always had', () => {
    expect(listTools('toolbox').map((t) => `${t.group}:${t.id}`)).toEqual([
      'transform:select',
      'transform:move',
      'transform:rotate',
      'transform:scale',
      'build:joint',
      'build:measure',
      'interact:blast',
      'interact:shoot',
      'options:snap',
      'options:snapGrid',
      'options:space',
    ]);
    expect(listTools('viewbar').map((t) => t.id)).toEqual([
      'viewVelocity',
      'viewForce',
      'viewContacts',
      'viewCom',
      'viewTrails',
      'viewJoints',
      'viewFollow',
      'viewFrame',
    ]);
  });

  it('every button that mirrors a command points at one that exists, and own-behaviour tools got their command', () => {
    for (const t of [...listTools('toolbox'), ...listTools('viewbar')])
      expect(getCommand(commandIdOf(t)), `${t.id} → ${commandIdOf(t)}`).toBeDefined();
    expect(getCommand('tool.joint')?.shortcut).toBe('J');
  });

  it('pointer handling and hints are looked up by interaction mode; move / rotate / scale share select', () => {
    expect(toolModes().sort()).toEqual(['blast', 'joint', 'measure', 'select', 'shoot']);
    for (const mode of toolModes()) expect(toolForMode(mode)?.pointerDown, mode).toBeTypeOf('function');
    expect(toolForMode('select')?.id).toBe('select');
    expect(getTool('move')?.mode).toBe('select');
    const { app, sim } = fakeApp();
    expect(hintForMode('select', app)).toBeNull();
    sim.active = true;
    expect(hintForMode('select', app)).toMatch(/Drag<\/b> a body to throw it/);
    expect(hintForMode('blast', app)).toMatch(/^Click anywhere to set off a blast/); // -- ED-B: the hint also names the blast kind --
    sim.active = false;
    expect(hintForMode('blast', app)).toMatch(/Start the simulation/);
    expect(hintForMode('nothing', app)).toBeNull();
  });

  it('a package tool gets a button, a command, a shortcut and pointer dispatch from one registration', () => {
    const pointerDown = vi.fn();
    const off = registerTool({
      id: 'paint',
      group: 'build',
      order: 55,
      label: 'Paint bodies',
      title: 'Paint',
      icon: 'select',
      shortcut: 'P',
      activate: (app) => app.setTool('paint'),
      isActive: (app) => app.prefs.value.tool === 'paint',
      pointerDown,
      hint: () => 'Click a body to paint it',
    });
    expect(listTools('toolbox').map((t) => t.id)).toContain('paint');
    expect(keymap.find(key('p'))?.id).toBe('tool.paint');
    expect(toolModes()).toContain('paint');
    const { app, raw } = fakeApp();
    runCommand('tool.paint', app, 'shortcut');
    expect(raw.setTool).toHaveBeenCalledWith('paint');
    expect(toolForMode('paint')?.pointerDown).toBe(pointerDown);
    off();
    expect(getTool('paint')).toBeUndefined();
    expect(getCommand('tool.paint')).toBeUndefined();
    expect(keymap.find(key('p'))).toBeUndefined();
  });

  it('validates tools: a button for a command cannot also define behaviour; a clashing shortcut leaves nothing behind', () => {
    expect(() =>
      registerTool({
        id: 'bad1',
        group: 'x',
        order: 1,
        icon: 'select',
        command: 'view.snap',
        activate: () => undefined,
      }),
    ).toThrow(/cannot also define its own behaviour/);
    expect(() => registerTool({ id: 'bad2', group: 'x', order: 1, icon: 'select' })).toThrow(/needs a label/);
    expect(() => registerTool({ id: 'bad3', group: 'x', order: 1, icon: 'select', label: 'Bad' })).toThrow(
      /needs an activate\(\) function/,
    );
    expect(() =>
      registerTool({
        id: 'bad4',
        group: 'x',
        order: 1,
        icon: 'select',
        label: 'Bad',
        shortcut: 'Q',
        activate: () => undefined,
      }),
    ).toThrow(/already used by "tool.select"/);
    expect(getTool('bad4')).toBeUndefined();
    expect(getCommand('tool.bad4')).toBeUndefined();
    expect(unregisterTool('bad4')).toBe(false);
  });
});

describe('panel registry', () => {
  it('registering a panel also registers its "Show …" command, which opens the region on that tab', () => {
    const off = registerPanel({
      id: 'testpanel',
      label: 'Test panel',
      icon: 'layers',
      region: 'left',
      order: 99,
      build: () => ({ el: {} as HTMLElement }),
    });
    expect(listPanels('left').at(-1)?.id).toBe('testpanel');
    const cmd = getCommand('panel.testpanel')!;
    expect(cmd.label).toBe('Show Test panel');
    const { app, raw } = fakeApp();
    raw.prefs.set({ showLeft: false });
    expect(commandChecked(cmd, app)).toBe(false);
    runCommand('panel.testpanel', app, 'palette');
    expect(raw.prefs.value.leftTab).toBe('testpanel');
    expect(raw.prefs.value.showLeft).toBe(true);
    expect(commandChecked(cmd, app)).toBe(true);
    off();
    expect(getCommand('panel.testpanel')).toBeUndefined();
    expect(unregisterPanel('testpanel')).toBe(false);
  });

  it('validates the region and refuses an empty label', () => {
    const base = {
      id: 'p1',
      label: 'P',
      icon: 'layers',
      region: 'left' as const,
      order: 1,
      build: () => ({ el: {} as HTMLElement }),
    };
    expect(() => registerPanel({ ...base, region: 'top' as 'left' })).toThrow(/region must be left, right or bottom/);
    expect(() => registerPanel({ ...base, label: ' ' })).toThrow(/needs a label/);
    expect(getCommand('panel.p1')).toBeUndefined();
  });
});

describe('menus resolve from the registry', () => {
  const labels = (items: MenuItem[]) =>
    items.map((i) => ('sep' in i ? '---' : 'heading' in i ? `# ${i.heading}` : i.label));

  it('has the same menu bar as before', () => {
    expect(listBarMenus().map((m) => m.label)).toEqual(['File', 'Edit', 'View', 'Help']);
  });

  it('File: new, examples (every registered template), library, files — grouped like the old menu', () => {
    const { app } = fakeApp();
    const l = labels(resolveMenu(app, 'file'));
    expect(l.slice(0, 3)).toEqual(['New scene', '# Examples', expect.any(String)]);
    const sep1 = l.indexOf('---');
    const templates = l.slice(2, sep1);
    expect(templates).toEqual(listTemplates().map((t) => t.name));
    expect(templates).toContain('Drivable car');
    expect(l.slice(sep1 + 1)).toEqual([
      'Save to library',
      'Open scene library…',
      '---',
      'Export scene file…',
      'Import scene file…',
      'Copy share link',
    ]);
    expect(l.filter((x) => x === '---')).toHaveLength(2);
  });

  it('Edit: labels, shortcuts and disabled states follow the commands and the document', () => {
    const { app, raw } = fakeApp();
    const find = (items: MenuItem[], label: string) =>
      items.find((i): i is Extract<MenuItem, { label: string }> => 'label' in i && i.label === label)!;
    let edit = resolveMenu(app, 'edit');
    expect(labels(edit)).toEqual([
      'Undo',
      'Redo',
      '---',
      'Duplicate',
      'Copy',
      'Paste',
      'Delete',
      '---',
      'Select all',
      'Group selection',
      'Ungroup',
      'Rotate selection 90° about Y',
      'Frame selection',
      '---',
      'Use current simulation state as the starting layout',
      '---',
      'Copy joint settings to selected joints',
      'Mirror joints with bodies: X = 0',
      'Mirror joints with bodies: Y = 0',
      'Mirror joints with bodies: Z = 0',
    ]);
    expect(find(edit, 'Undo').disabled).toBe(true);
    expect(find(edit, 'Undo').kbd).toBe('Ctrl+Z');
    expect(find(edit, 'Redo').kbd).toBe('Ctrl+Shift+Z');
    expect(find(edit, 'Delete').kbd).toBe('Del');
    expect(find(edit, 'Frame selection').kbd).toBe('F');
    expect(find(edit, 'Duplicate').disabled).toBe(true);
    expect(find(edit, 'Group selection').disabled).toBe(true);
    expect(find(edit, 'Paste').disabled).toBe(false);
    const body = createBody({ name: 'Crate', shape: { type: 'box' } });
    raw.store.add([body], 'Add Crate');
    raw.store.setSelection([body.id]);
    edit = resolveMenu(app, 'edit');
    expect(find(edit, 'Undo Add Crate').disabled).toBe(false);
    expect(find(edit, 'Duplicate').disabled).toBe(false);
    expect(find(edit, 'Group selection').disabled).toBe(false);
    expect(find(edit, 'Ungroup').disabled).toBe(true);
    expect(find(edit, 'Rotate selection 90° about Y').disabled).toBe(false);
    raw.sim.active = true;
    expect(find(resolveMenu(app, 'edit'), 'Rotate selection 90° about Y').disabled).toBe(true);
    expect(find(resolveMenu(app, 'edit'), 'Use current simulation state as the starting layout').disabled).toBe(false);
  });

  it('View: radio choices and toggles show check marks, trails shows its mode in the label', () => {
    const { app, raw } = fakeApp();
    const v = resolveMenu(app, 'view');
    expect(labels(v)).toEqual([
      '# Colour bodies by',
      'Material',
      'Body type',
      'Speed',
      'Kinetic energy',
      'Net force',
      'Sleep state',
      '---',
      '# Overlays (live while simulating)',
      'Velocity vectors',
      'Net force vectors',
      'Contact points & forces',
      'Centres of mass',
      'Motion trails: off',
      '---',
      'Show joints & constraints',
      'Camera follows selection',
      '---',
      '# Graphics quality',
      'Auto — adapts to GPU',
      'Low — fastest',
      'Medium — shadows + FXAA',
      'High — shadows + AO + bloom + MSAA',
      'Ultra — reflections, shafts, blur',
      '---',
      'Appearance…',
      '---',
      'Frame everything',
      // -- UI-A: layout presets --
      '---',
      '# Layout',
      'Build',
      'Simulate',
      'Analyse',
      'Present',
      'Save layout as…',
      'Reset layout',
      '---',
      '# Interface',
      'Simple interface',
      'Advanced interface',
      'Quick properties bar',
      'Floating inspector',
    ]);
    const item = (label: string) =>
      v.find((i): i is Extract<MenuItem, { label: string }> => 'label' in i && i.label === label)!;
    expect(item('Material').checked).toBe(true);
    expect(item('Speed').checked).toBe(false);
    expect(item('Motion trails: off').checked).toBeUndefined();
    expect(item('Camera follows selection').kbd).toBe('C');
    expect(item('Frame everything').kbd).toBe('Home');
    expect(item('Medium — shadows + FXAA').checked).toBe(raw.prefs.value.quality === 'medium');
    // Clicking an item runs its command.
    void item('Speed').action();
    expect(raw.prefs.value.colorMode).toBe('speed');
  });

  it('context menu: the same entries and shortcuts as before, and Simulate / Reset follows the simulation', () => {
    const { app, sim } = fakeApp();
    const find = (items: MenuItem[], label: string) =>
      items.find((i): i is Extract<MenuItem, { label: string }> => 'label' in i && i.label === label)!;
    let c = resolveMenu(app, 'context');
    expect(labels(c)).toEqual([
      'Frame',
      'Duplicate',
      'Hide / show',
      'Lock / unlock',
      '---',
      'Delete',
      '---',
      'Simulate',
    ]);
    expect(find(c, 'Frame').kbd).toBe('F');
    expect(find(c, 'Hide / show').kbd).toBe('H');
    expect(find(c, 'Lock / unlock').kbd).toBe('L');
    expect(find(c, 'Duplicate').kbd).toBe('Ctrl+D');
    expect(find(c, 'Simulate').kbd).toBe('Space');
    expect(find(c, 'Simulate').icon).toBe('play');
    sim.active = true;
    sim.mode = 'running';
    c = resolveMenu(app, 'context');
    expect(find(c, 'Reset simulation').kbd).toBe('Shift+Space');
    expect(find(c, 'Reset simulation').icon).toBe('reset');
  });

  it('an entry with `when` is only listed while the condition holds', () => {
    const offMenu = registerMenu({ id: 'cond', label: 'Cond', order: 60, bar: false });
    let show = false;
    const offEntry = registerMenuEntry({
      id: 'menu.cond.sim',
      menu: 'cond',
      group: 'g',
      order: 1,
      command: 'sim.toggle',
      when: () => show,
    });
    const offKeep = registerMenuEntry({
      id: 'menu.cond.step',
      menu: 'cond',
      group: 'g',
      order: 2,
      command: 'sim.step',
    });
    const { app } = fakeApp();
    expect(labels(resolveMenu(app, 'cond'))).toEqual(['Advance one physics step']);
    show = true;
    expect(labels(resolveMenu(app, 'cond'))).toEqual(['Simulate', 'Advance one physics step']);
    offKeep();
    offEntry();
    offMenu();
  });

  it('a package adds a menu and an entry; unknown menus and missing commands are refused or skipped', () => {
    const offMenu = registerMenu({ id: 'game', label: 'Game', order: 50 });
    const offEntry = registerMenuEntry({
      id: 'menu.game.pause',
      menu: 'game',
      group: 'g',
      order: 1,
      command: 'sim.toggle',
    });
    expect(listBarMenus().map((m) => m.label)).toEqual(['File', 'Edit', 'View', 'Game', 'Help']);
    const { app } = fakeApp();
    expect(labels(resolveMenu(app, 'game'))).toEqual(['Simulate']);
    expect(() =>
      registerMenuEntry({ id: 'menu.x', menu: 'nope', group: 'g', order: 1, command: 'sim.toggle' }),
    ).toThrow(/there is no menu "nope"/);
    expect(() => registerMenuEntry({ id: 'menu.y', menu: 'game', group: 'g', order: 1 })).toThrow(
      /needs a command, a heading or items/,
    );
    const offGhost = registerMenuEntry({
      id: 'menu.game.ghost',
      menu: 'game',
      group: 'g',
      order: 2,
      command: 'no.such.command',
    });
    expect(labels(resolveMenu(app, 'game'))).toEqual(['Simulate']);
    offGhost();
    offEntry();
    offMenu();
    expect(listBarMenus().map((m) => m.label)).toEqual(['File', 'Edit', 'View', 'Help']);
  });
});

describe('shortcut help is generated', () => {
  it('lists every command that has a shortcut, plus the gesture entries, grouped by category', () => {
    const sections = helpSections('pc');
    const titles = sections.map((s) => s.title);
    expect(titles).toEqual(expect.arrayContaining(['Simulation', 'Tools', 'Edit', 'Camera', 'File']));
    expect(titles.indexOf('Simulation')).toBeLessThan(titles.indexOf('Tools'));
    const rows = (t: string) => sections.find((s) => s.title === t)!.rows;
    const keys = (t: string, label: string) =>
      rows(t)
        .find((r) => r.label === label)!
        .alternatives.map((a) => a.join('+'));
    expect(keys('Simulation', 'Start / pause simulation')).toEqual(['Space']);
    expect(keys('Simulation', 'Stop and return to the editable layout')).toEqual(['Shift+Space']);
    expect(keys('Simulation', 'Advance one physics step')).toEqual(['.']);
    expect(keys('Edit', 'Redo')).toEqual(['Ctrl+Shift+Z', 'Ctrl+Y']);
    expect(keys('Edit', 'Delete')).toEqual(['Del', 'Backspace']);
    expect(keys('Tools', 'Joint tool')).toEqual(['J']);
    expect(keys('Camera', 'Frame everything')).toEqual(['Home']);
    expect(keys('File', 'Save to library')).toEqual(['Ctrl+S']);
    expect(rows('Camera').find((r) => r.label === 'Orbit')!.alternatives).toEqual([
      ['Right', 'drag'],
      ['Alt', 'drag'],
    ]);
    expect(rows('Add').find((r) => r.label === 'Add shape at view')!.alternatives).toEqual([
      ['1', '–', String(Math.min(9, listShapes().length))],
    ]);
    // The nine "Add <shape>" commands are summarised by one row, not listed.
    expect(rows('Add').some((r) => r.label.startsWith('Add Box'))).toBe(false);
    // Mac keycaps.
    const mac = helpSections('mac');
    expect(mac.find((s) => s.title === 'Edit')!.rows.find((r) => r.label === 'Undo')!.alternatives).toEqual([
      ['⌘', 'Z'],
    ]);
  });

  it('a new command with a shortcut shows up, and a new gesture row can be registered', () => {
    const off = registerCommand({
      id: 'test.help',
      label: 'Do the thing',
      category: 'Test',
      shortcut: 'Mod+F9',
      run: () => undefined,
    });
    const off2 = registerHelp({ id: 'test.gesture', group: 'Test', label: 'Wiggle', keys: 'Shift drag', order: 1 });
    const t = helpSections('pc').find((s) => s.title === 'Test')!;
    expect(t.rows.map((r) => r.label)).toEqual(['Do the thing', 'Wiggle']);
    expect(t.rows[0].alternatives).toEqual([['Ctrl', 'F9']]);
    off();
    off2();
    expect(helpSections('pc').some((s) => s.title === 'Test')).toBe(false);
  });
});

describe('integrity of the built-in registrations', () => {
  it('has a command for everything a menu entry points at', () => {
    const { app } = fakeApp();
    for (const m of ['file', 'edit', 'view', 'help', 'context'])
      for (const item of resolveMenu(app, m)) if ('label' in item) expect(item.label.length).toBeGreaterThan(0);
    // Every command referenced by a menu entry exists (resolveMenu silently skips missing ones, so check by count).
    expect(resolveMenu(app, 'view').filter((i) => 'label' in i)).toHaveLength(6 + 5 + 2 + 5 + 1 + 6 + 4 + 1);
  });

  it('gives every command a category from the known list or a sensible one, and no label is empty', () => {
    for (const c of listCommands()) {
      expect(c.label.trim().length, c.id).toBeGreaterThan(0);
      expect(c.category.trim().length, c.id).toBeGreaterThan(0);
    }
    const ids = listCommands().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
