import { describe, expect, it } from 'vitest';
import { detectCrash, HEARTBEAT_MS, SESSION_KEY, SessionGuard, STALE_MS } from '../src/app/storage/recovery';

const mem = () => {
  const d: Record<string, string> = {};
  return { getItem: (k: string) => d[k] ?? null, setItem: (k: string, v: string) => void (d[k] = v), d };
};

describe('crash detection (DT-12)', () => {
  it('a clean shutdown is not a crash', () => {
    const ls = mem();
    let t = 1_000_000;
    const g = new SessionGuard(ls, () => t);
    g.start();
    t += 10_000;
    g.markClean();
    expect(detectCrash(ls, t + 60_000)).toEqual({ crashed: false, lastAlive: null });
  });
  it('a record left running with a stale heartbeat is a crash, with the last-alive time', () => {
    const ls = mem();
    const t = 5_000_000;
    new SessionGuard(ls, () => t).start(); // never marked clean
    const c = detectCrash(ls, t + STALE_MS + 1);
    expect(c).toEqual({ crashed: true, lastAlive: t });
  });
  it('a fresh heartbeat means another tab is alive, not a crash', () => {
    const ls = mem();
    const t = 9_000_000;
    new SessionGuard(ls, () => t).start();
    expect(detectCrash(ls, t + HEARTBEAT_MS).crashed).toBe(false);
  });
  it('first run and garbage records are not crashes', () => {
    const ls = mem();
    expect(detectCrash(ls).crashed).toBe(false);
    ls.setItem(SESSION_KEY, '{nope');
    expect(detectCrash(ls).crashed).toBe(false);
    ls.setItem(SESSION_KEY, JSON.stringify({ id: 1 }));
    expect(detectCrash(ls).crashed).toBe(false);
  });
});
