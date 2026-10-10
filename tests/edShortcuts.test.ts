/**
 * Every ED-A extension registers next to the built-ins without a shortcut clash. The registry throws on a duplicate
 * at start-up and the loader then skips the whole extension, so this loads them all together.
 */
import { describe, expect, it } from 'vitest';
import { registerBuiltins } from '../src/ui/builtin';
import { listCommands } from '../src/app/registry/commands';

describe('ED-A extensions', () => {
  it('load together with the built-ins and every other package without a duplicate shortcut', async () => {
    registerBuiltins();
    const files = import.meta.glob([
      '../src/ui/extensions/*.ts',
      '!../src/ui/extensions/*.test.ts',
      '!../src/ui/extensions/plugins.ts',
    ]);
    const failures: string[] = [];
    for (const [file, load] of Object.entries(files)) {
      try {
        await load();
      } catch (e) {
        failures.push(`${file}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    expect(failures).toEqual([]);
    expect(listCommands().length).toBeGreaterThan(100);
  });
});
