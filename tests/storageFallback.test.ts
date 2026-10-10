import { describe, expect, it } from 'vitest';
import { getStorageStatus, setStorageForTests } from '../src/app/storage';

// No fake-indexeddb import here: in Node there is no `indexedDB`, which is exactly the "storage unavailable" case.
describe('storage fallback (DT-10)', () => {
  it('falls back to memory with a user-facing warning when IndexedDB is unavailable, and still works', async () => {
    setStorageForTests(null);
    expect(typeof indexedDB).toBe('undefined');
    const status = await getStorageStatus();
    expect(status.degraded).toBe(true);
    expect(status.backend.kind).toBe('memory');
    expect(status.warning).toMatch(/memory only/);
    await status.backend.put('scenes', 'a', { n: 1 });
    expect(await status.backend.get('scenes', 'a')).toEqual({ n: 1 });
    setStorageForTests(null);
  });
});
