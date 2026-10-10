/**
 * DT-41: package the desktop shell for the current OS / architecture with @electron/packager.
 * Copies ../dist to desktop/app-dist, bundles main.cjs + app-dist into an app, writes desktop/out/.
 *   node scripts/pack.cjs [--platform=win32|darwin|linux] [--arch=x64|arm64]   (cross-packaging downloads that Electron)
 */
const fs = require('node:fs');
const path = require('node:path');

const here = path.join(__dirname, '..');
const dist = path.join(here, '..', 'dist');
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

async function main() {
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    throw new Error('../dist not found: run `npm run build` in the repository root first.');
  }
  const appDist = path.join(here, 'app-dist');
  fs.rmSync(appDist, { recursive: true, force: true });
  // Skip the web service worker: inside the app everything is local, so there is nothing to cache or update.
  fs.cpSync(dist, appDist, { recursive: true, filter: (src) => path.basename(src) !== 'sw.js' });
  const { packager } = await import('@electron/packager');
  const out = await packager({
    dir: here,
    out: path.join(here, 'out'),
    name: 'PhysixLab',
    overwrite: true,
    platform: arg('platform') ?? process.platform,
    arch: arg('arch') ?? process.arch,
    prune: true,
    ignore: [/^\/out($|\/)/, /^\/scripts($|\/)/, /^\/smoke/, /^\/package-lock\.json$/],
  });
  process.stdout.write(`packaged: ${out.join('\n')}\n`);
}

main().catch((e) => {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
});
