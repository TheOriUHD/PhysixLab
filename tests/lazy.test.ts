import { describe, expect, it } from 'vitest';
import { lazy } from '../src/core/lazy';

describe('lazy()', () => {
  it('runs the loader once and shares the result', async () => {
    let calls = 0;
    const get = lazy(() => Promise.resolve({ n: ++calls }));
    const [a, b] = await Promise.all([get(), get()]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
    expect(await get()).toBe(a);
  });

  it('does not cache a failure', async () => {
    let calls = 0;
    const get = lazy(() => (++calls === 1 ? Promise.reject(new Error('offline')) : Promise.resolve('ok')));
    await expect(get()).rejects.toThrow('offline');
    expect(await get()).toBe('ok');
    expect(calls).toBe(2);
  });
});
