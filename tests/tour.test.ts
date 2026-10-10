/**
 * UI-40: the tour engine's pure logic (step state machine, wait matching, placement, persistence) and its
 * registration side (commands, menu entries, validation). The DOM half is exercised in e2e/tests/tour.mjs.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app/app';
import { registerAppBuiltins } from '../src/app/builtin';
import { getCommand, listMenuEntries, resolveMenu } from '../src/app/registry';
import { registerUiBuiltins } from '../src/ui/builtin';
import { getTour, isTourRunning, listTours, registerTour, startTour } from '../src/ui/tour';
import { listHints, registerHint, TIPS } from '../src/ui/tour/hints';
import {
  computePlacement,
  GUIDE_STORAGE_KEY,
  GuideStore,
  localDay,
  sanitizeGuideState,
  TourMachine,
  waitSatisfied,
  type KeyValueStore,
  type Rect,
} from '../src/ui/tour/tourLogic';

class MemoryStorage implements KeyValueStore {
  data = new Map<string, string>();
  getItem = (k: string) => this.data.get(k) ?? null;
  setItem = (k: string, v: string) => void this.data.set(k, v);
}

describe('TourMachine', () => {
  it('walks forward and back, and finishes on next() at the last step', () => {
    const m = new TourMachine(3);
    expect(m.status).toBe('idle');
    expect(m.next(), 'not running yet').toBe(false);
    m.start();
    expect([m.index, m.label, m.isFirst, m.isLast]).toEqual([0, 'Step 1 of 3', true, false]);
    expect(m.back(), 'cannot go before the first step').toBe(false);
    expect(m.next()).toBe(true);
    expect(m.next()).toBe(true);
    expect([m.index, m.isLast, m.label]).toEqual([2, true, 'Step 3 of 3']);
    expect(m.back()).toBe(true);
    expect(m.next()).toBe(true);
    expect(m.next(), 'last step: finishes instead of moving').toBe(false);
    expect(m.status).toBe('completed');
    expect(m.index).toBe(2);
  });

  it('skip ends it, and nothing moves afterwards; zero steps are refused', () => {
    const m = new TourMachine(4);
    m.start();
    m.next();
    m.skip();
    expect(m.status).toBe('skipped');
    expect(m.next()).toBe(false);
    expect(m.back()).toBe(false);
    expect(() => new TourMachine(0)).toThrow(/at least one step/);
  });

  it('start() rewinds a finished tour', () => {
    const m = new TourMachine(1);
    m.start();
    m.next();
    expect(m.status).toBe('completed');
    m.start();
    expect([m.status, m.index]).toEqual(['running', 0]);
  });
});

describe('waitSatisfied', () => {
  it('matches commands by id (one or several), selections by count, sim modes and scene changes by kind', () => {
    expect(waitSatisfied({ event: 'command' }, { event: 'command', id: 'anything' })).toBe(true);
    expect(waitSatisfied({ event: 'command', id: 'edit.undo' }, { event: 'command', id: 'edit.undo' })).toBe(true);
    expect(waitSatisfied({ event: 'command', id: 'edit.undo' }, { event: 'command', id: 'edit.redo' })).toBe(false);
    expect(waitSatisfied({ event: 'command', id: ['a.b', 'c.d'] }, { event: 'command', id: 'c.d' })).toBe(true);
    expect(
      waitSatisfied({ event: 'selection' }, { event: 'selection', count: 0 }),
      'deselecting is not selecting',
    ).toBe(false);
    expect(waitSatisfied({ event: 'selection' }, { event: 'selection', count: 1 })).toBe(true);
    expect(waitSatisfied({ event: 'selection', min: 2 }, { event: 'selection', count: 1 })).toBe(false);
    expect(waitSatisfied({ event: 'sim-mode', mode: 'running' }, { event: 'sim-mode', mode: 'paused' })).toBe(false);
    expect(waitSatisfied({ event: 'sim-mode' }, { event: 'sim-mode', mode: 'paused' })).toBe(true);
    expect(waitSatisfied({ event: 'scene-change', type: 'add' }, { event: 'scene-change', type: 'remove' })).toBe(
      false,
    );
    expect(waitSatisfied({ event: 'scene-change', type: 'add' }, { event: 'scene-change', type: 'add' })).toBe(true);
  });

  it('never matches a signal of another kind; clicks use the step target unless the spec names a selector', () => {
    expect(waitSatisfied({ event: 'selection' }, { event: 'command', id: 'x.y' })).toBe(false);
    const clickOn = (hit: string) => ({ event: 'click' as const, matches: (s: string) => s === hit });
    expect(waitSatisfied({ event: 'click' }, clickOn('.play'), '.play')).toBe(true);
    expect(waitSatisfied({ event: 'click' }, clickOn('.stop'), '.play')).toBe(false);
    expect(waitSatisfied({ event: 'click', selector: '.stop' }, clickOn('.stop'), '.play')).toBe(true);
  });
});

describe('computePlacement', () => {
  const view = { w: 1000, h: 700 };
  const card = { w: 300, h: 160 };
  const inside = (p: { x: number; y: number }) =>
    p.x >= 12 && p.y >= 12 && p.x + card.w <= view.w - 12 && p.y + card.h <= view.h - 12;

  it('puts the card below a small target, centred on it', () => {
    const t: Rect = { x: 400, y: 100, w: 100, h: 40 };
    const p = computePlacement(t, card, view, 'bottom');
    expect(p.placement).toBe('bottom');
    expect(p.y).toBeGreaterThanOrEqual(t.y + t.h);
    expect(p.x + card.w / 2).toBeCloseTo(450, 5);
  });

  it('falls back to another side when the preferred one has no room, and prefers the roomiest for auto', () => {
    const low: Rect = { x: 400, y: 640, w: 100, h: 40 };
    expect(computePlacement(low, card, view, 'bottom').placement).not.toBe('bottom');
    expect(computePlacement(low, card, view, 'auto').placement).toBe('top');
    const left: Rect = { x: 10, y: 300, w: 200, h: 100 };
    expect(computePlacement(left, card, view, 'left').placement).not.toBe('left');
  });

  it('keeps the card inside the view for targets in every corner, and for huge ones', () => {
    const targets: Rect[] = [
      { x: 0, y: 0, w: 40, h: 30 },
      { x: 960, y: 0, w: 40, h: 30 },
      { x: 0, y: 670, w: 40, h: 30 },
      { x: 960, y: 670, w: 40, h: 30 },
      { x: 0, y: 0, w: 1000, h: 700 },
    ];
    for (const t of targets)
      for (const pref of ['auto', 'top', 'bottom', 'left', 'right'] as const)
        expect(inside(computePlacement(t, card, view, pref)), `${JSON.stringify(t)} ${pref}`).toBe(true);
  });

  it('centres the card when there is no target', () => {
    const p = computePlacement(null, card, view);
    expect(p).toEqual({ x: 350, y: 270, placement: 'center' });
  });
});

describe('GuideStore', () => {
  it('remembers tours, hints and switches across instances (same storage)', () => {
    const mem = new MemoryStorage();
    const a = new GuideStore(mem);
    expect(a.isResolved('onboarding')).toBe(false);
    a.markDismissed('onboarding');
    a.markCompleted('basics');
    a.markHintSeen('first-selection');
    a.setHintsOn(false);
    a.setTipsOn(false);
    const b = new GuideStore(mem);
    expect(b.isResolved('onboarding')).toBe(true);
    expect(b.isCompleted('onboarding'), 'declined is not completed').toBe(false);
    expect(b.isCompleted('basics')).toBe(true);
    expect(b.hasSeenHint('first-selection')).toBe(true);
    expect([b.state.hintsOn, b.state.tipsOn]).toEqual([false, false]);
    b.resetTour('onboarding');
    expect(new GuideStore(mem).isResolved('onboarding')).toBe(false);
    b.resetAll();
    expect(new GuideStore(mem).state.hintsSeen).toEqual([]);
    expect(new GuideStore(mem).state.hintsOn).toBe(true);
  });

  it('survives blocked, throwing, missing and corrupted storage', () => {
    const throwing: KeyValueStore = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    const g = new GuideStore(throwing);
    g.markCompleted('x'); // must not throw
    expect(g.isCompleted('x'), 'still works for this session').toBe(true);
    expect(new GuideStore(null).state.hintsOn).toBe(true);
    const mem = new MemoryStorage();
    mem.setItem(GUIDE_STORAGE_KEY, '{not json');
    expect(new GuideStore(mem).state.completed).toEqual([]);
  });

  it('sanitises stored data field by field', () => {
    const s = sanitizeGuideState({
      completed: ['a', 3, 'a', null, 'b'],
      dismissed: 'nope',
      hintsOn: 'yes',
      tipsOn: false,
      tipIndex: -4.7,
      tipDay: 'x'.repeat(40),
    });
    expect(s.completed).toEqual(['a', 'b']);
    expect(s.dismissed).toEqual([]);
    expect(s.hintsOn).toBe(true);
    expect(s.tipsOn).toBe(false);
    expect(s.tipIndex).toBe(0);
    expect(s.tipDay).toHaveLength(10);
  });

  it('rotates through the tips and shows the automatic one at most once a day', () => {
    const g = new GuideStore(new MemoryStorage());
    const day = localDay(new Date(2026, 0, 5));
    expect(day).toBe('2026-01-05');
    expect(g.tipDue(day)).toBe(true);
    expect(g.takeTip(3, day)).toBe(0);
    expect(g.tipDue(day)).toBe(false);
    expect(g.tipDue('2026-01-06')).toBe(true);
    expect([g.takeTip(3), g.takeTip(3), g.takeTip(3)]).toEqual([1, 2, 0]);
    g.setTipsOn(false);
    expect(g.tipDue('2030-01-01')).toBe(false);
    expect(TIPS.length).toBeGreaterThan(5);
    expect(new Set(TIPS).size).toBe(TIPS.length);
  });
});

describe('registering tours and hints', () => {
  beforeAll(() => {
    registerAppBuiltins();
    registerUiBuiltins();
  });

  it('registerTour adds a help.tour.<id> command and a Help menu entry, and unregisters cleanly', () => {
    const off = registerTour({
      id: 'unit-tour',
      title: 'Unit tour',
      steps: [{ target: null, title: 'Hello', body: 'Hi' }],
    });
    expect(getTour('unit-tour')?.steps).toHaveLength(1);
    const cmd = getCommand('help.tour.unit-tour')!;
    expect(cmd.label).toBe('Take the tour: Unit tour');
    expect(cmd.category).toBe('Help');
    expect(listMenuEntries('help').some((e) => e.command === 'help.tour.unit-tour')).toBe(true);
    const labels = resolveMenu({} as App, 'help').map((i) => ('label' in i ? i.label : null));
    expect(labels).toContain('Take the tour: Unit tour');
    off();
    expect(getTour('unit-tour')).toBeUndefined();
    expect(getCommand('help.tour.unit-tour')).toBeUndefined();
    expect(listTours().some((t) => t.id === 'unit-tour')).toBe(false);
  });

  it('rejects malformed tours and duplicates with a message that names the culprit', () => {
    const step = { target: null, title: 'T', body: 'B' };
    expect(() => registerTour({ id: 'Bad Id', title: 'x', steps: [step] })).toThrow(/Invalid tour id "Bad Id"/);
    expect(() => registerTour({ id: 'no-steps', title: 'x', steps: [] })).toThrow(/at least one step/);
    expect(() => registerTour({ id: 'no-title', title: ' ', steps: [step] })).toThrow(/needs a title/);
    expect(() => registerTour({ id: 'blank-step', title: 'x', steps: [{ ...step, title: '' }] })).toThrow(/step 1/);
    const off = registerTour({ id: 'dup-tour', title: 'x', steps: [step] });
    expect(() => registerTour({ id: 'dup-tour', title: 'y', steps: [step] })).toThrow(/already registered/);
    off();
  });

  it('startTour on an unknown id says so instead of throwing, and nothing runs', () => {
    const toasts: string[] = [];
    const app = { toast: (t: string) => toasts.push(t) } as unknown as App;
    expect(startTour('does-not-exist', app)).toBe(false);
    expect(toasts[0]).toMatch(/no tour called/);
    expect(isTourRunning()).toBe(false);
  });

  it('registerHint validates and unregisters', () => {
    const off = registerHint({ id: 'unit-hint', text: 'Hello', trigger: { event: 'selection' } });
    expect(listHints().some((h) => h.id === 'unit-hint')).toBe(true);
    expect(() => registerHint({ id: 'unit-hint', text: 'again', trigger: { event: 'selection' } })).toThrow(
      /already registered/,
    );
    expect(() => registerHint({ id: 'no-trigger', text: 'x' })).toThrow(/trigger or a when/);
    expect(() => registerHint({ id: 'empty-text', text: ' ', when: () => true })).toThrow(/needs a text/);
    off();
    expect(listHints().some((h) => h.id === 'unit-hint')).toBe(false);
  });

  it('the documented example (tests/examples/guided-tour.ts) registers its tour, command, menu entry and hint', async () => {
    await import('./examples/guided-tour');
    const tour = getTour('inspector-basics')!;
    expect(tour.steps.map((s) => s.title)).toEqual(['The Inspector', 'Pick something', 'Now run it']);
    expect(tour.steps[1].waitFor).toEqual({ event: 'selection' });
    expect(getCommand('help.tour.inspector-basics')?.label).toBe('Take the tour: Meet the Inspector');
    expect(listHints().some((h) => h.id === 'demo-first-add')).toBe(true);
  });
});
