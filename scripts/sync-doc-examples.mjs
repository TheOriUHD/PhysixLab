/**
 * Keeps the code blocks of docs/EXTENDING.md identical to the example files in tests/examples/.
 *
 *   node scripts/sync-doc-examples.mjs           rewrite the blocks that differ
 *   node scripts/sync-doc-examples.mjs --check   only report (exit 1 if a block is out of date)
 *
 * In the guide, an example is a marker line `<!-- example: <file in tests/examples> -->` followed by a fenced
 * `ts` block. The block shows the file with its `../../src/...` imports rewritten as they would be written in the
 * folder named on the file's first line (`// File: src/ui/extensions/x.ts`). tests/extending.test.ts checks the
 * same thing, so a stale guide fails the unit tests.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const guidePath = join(root, 'docs', 'EXTENDING.md');

export function forItsHome(source) {
  const home = /^\/\/ File: (\S+)/.exec(source)?.[1];
  if (!home) throw new Error('an example must start with "// File: <path it belongs at>"');
  return source.replace(/from '(\.\.\/\.\.\/src\/[^']+)'/g, (_m, spec) => {
    let rel = posix.relative(posix.dirname(home), spec.slice('../../'.length));
    if (!rel.startsWith('.')) rel = `./${rel}`;
    return `from '${rel}'`;
  });
}

const check = process.argv.includes('--check');
const guide = readFileSync(guidePath, 'utf8');
let stale = 0;
const next = guide.replace(
  /(<!-- example: (\S+) -->\r?\n```ts\r?\n)([\s\S]*?)(\r?\n```)/g,
  (all, head, file, code, tail) => {
    const want = forItsHome(readFileSync(join(root, 'tests', 'examples', file), 'utf8')).trimEnd();
    if (code.trimEnd() === want) return all;
    stale++;
    return head + want + tail;
  },
);
if (check) {
  process.stdout.write(
    stale
      ? `${stale} example block(s) in docs/EXTENDING.md are out of date\n`
      : 'docs/EXTENDING.md examples are up to date\n',
  );
  process.exit(stale ? 1 : 0);
}
if (stale) writeFileSync(guidePath, next);
process.stdout.write(stale ? `updated ${stale} example block(s)\n` : 'nothing to update\n');
