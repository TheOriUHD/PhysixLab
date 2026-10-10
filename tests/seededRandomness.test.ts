/**
 * TM-6: nothing that influences the simulation may draw from the wall clock or `Math.random` — it all goes through the
 * world's seeded generator (`ctx.random()` / `WorldState.rng`), or a replay and a rewind would not reproduce a run.
 * (Cosmetic randomness — a camera shake, the noise of a sound — lives outside `src/physics` and may use `Math.random`.)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });

/** The code of a file without its comments and string literals. */
const code = (src: string): string =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');

describe('the physics code is seeded', () => {
  const physics = files(join(__dirname, '..', 'src', 'physics'));
  it('scans the physics folder', () => expect(physics.length).toBeGreaterThan(20));
  for (const f of physics) {
    it(`${f.slice(f.indexOf('src/physics'))} uses no Math.random / Date.now`, () => {
      const c = code(readFileSync(f, 'utf8'));
      expect(c).not.toMatch(/Math\.random\s*\(/);
      expect(c).not.toMatch(/Date\.now\s*\(|new Date\s*\(/);
    });
  }
});
