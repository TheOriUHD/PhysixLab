/** DT-31: plugin manager dialog and permission prompt. Loaded on demand. */
import type { App } from '../app/app';
import type { PhysixLabApi } from '../api/types';
import { button } from '../ui/controls';
import { h } from '../ui/dom';
import { openModal } from '../ui/modal';
import { PluginHost } from './host';
import { ManifestError, parseManifest, PERMISSIONS, type Permission, type PluginManifest } from './manifest';
import { LocalPluginStore } from './store';
import gravityPresets from './examples/gravity-presets.plugin.mjs?raw';
import dominoTools from './examples/domino-tools.plugin.mjs?raw';

export const EXAMPLE_PLUGINS: { title: string; source: string }[] = [
  { title: 'Gravity presets', source: gravityPresets },
  { title: 'Domino tools', source: dominoTools },
];

let host: PluginHost | null = null;

/** The one host per page (created on first use). */
export function pluginHost(app: App): PluginHost {
  host ??= new PluginHost(
    app,
    ((window as unknown as { physixlab?: unknown }).physixlab ?? app) as PhysixLabApi,
    new LocalPluginStore(),
  );
  return host;
}

/** Ask the user to approve a plugin's permissions. Resolves with the granted list, or null when declined. */
export function askPermissions(m: PluginManifest, origin: string, updating: boolean): Promise<Permission[] | null> {
  return new Promise((resolve) => {
    let done = false;
    const checks = m.permissions.map((p) => {
      const box = h('input', { type: 'checkbox', checked: true, id: `plg-perm-${p}` });
      return {
        p,
        box,
        row: h('label', { class: 'plg-perm' }, box, h('span', null, h('b', null, p), ' — ', PERMISSIONS[p])),
      };
    });
    const finish = (v: Permission[] | null) => {
      if (done) return;
      done = true;
      modal.close();
      resolve(v);
    };
    const allow = button(
      updating ? 'Update plugin' : 'Install plugin',
      () => finish(checks.filter((c) => c.box.checked).map((c) => c.p)),
      { cls: 'primary' },
    );
    const cancel = button('Cancel', () => finish(null));
    const modal = openModal({
      title: `Install “${m.name}” ${m.version}?`,
      width: 'min(520px, 94vw)',
      onClose: () => finish(null),
      body: [
        h('p', { class: 'plg-text' }, m.description || 'No description.'),
        h('p', { class: 'plg-muted plg-text' }, `Source: ${origin}`),
        m.permissions.length
          ? h(
              'div',
              null,
              h('p', { class: 'plg-text' }, 'This plugin asks for permission to:'),
              ...checks.map((c) => c.row),
            )
          : h('p', { class: 'plg-text' }, 'It asks for no permissions.'),
        h(
          'p',
          { class: 'plg-muted plg-text' },
          'Plugins run in an isolated sandbox. They never get network, storage or page access, whatever they ask for.',
        ),
      ],
      footer: [cancel, allow],
    });
    cancel.focus(); // a security prompt defaults to the safe answer
  });
}

export async function installFromSource(app: App, source: string, origin: string): Promise<boolean> {
  const manifest = parseManifest(source);
  const h2 = pluginHost(app);
  const updating = h2.list().some((p) => p.manifest.id === manifest.id);
  const granted = await askPermissions(manifest, origin, updating);
  if (!granted) return false;
  const info = await h2.install(source, origin, granted);
  if (info.state === 'error') app.toast(`“${manifest.name}” was installed but failed to start: ${info.error}`, 'error');
  else
    app.toast(
      info.panels.length
        ? `Plugin “${manifest.name}” installed — open its panel from the command palette (Ctrl+K → “Show …”)`
        : `Plugin “${manifest.name}” installed`,
      'success',
    );
  return true;
}

export function openPluginManager(app: App): void {
  const ph = pluginHost(app);
  const list = h('div', { class: 'plg-list' });
  const message = h('div', { class: 'dtb-status', role: 'status' });
  const fail = (e: unknown) => {
    message.className = 'dtb-status error';
    message.textContent = e instanceof ManifestError || e instanceof Error ? e.message : String(e);
  };
  const run = async (source: string, origin: string) => {
    message.textContent = '';
    message.className = 'dtb-status';
    try {
      await installFromSource(app, source, origin);
    } catch (e) {
      fail(e);
    }
  };

  const render = () => {
    const items = ph.list();
    list.replaceChildren(
      ...(items.length
        ? items.map((p) => {
            const toggle = h('input', {
              type: 'checkbox',
              checked: p.state === 'running' || p.state === 'starting',
              title: 'Enabled',
              'aria-label': `Enable ${p.manifest.name}`,
            });
            toggle.addEventListener(
              'change',
              () => void (toggle.checked ? ph.enable(p.manifest.id) : Promise.resolve(ph.disable(p.manifest.id))),
            );
            const rm = button('Remove', () => ph.remove(p.manifest.id), { cls: 'danger' });
            return h(
              'div',
              { class: `plg-item ${p.state}`, dataset: { plugin: p.manifest.id } },
              toggle,
              h(
                'div',
                { class: 'plg-item-main' },
                h(
                  'div',
                  null,
                  h('b', null, p.manifest.name),
                  ` ${p.manifest.version} `,
                  h('span', { class: `plg-state ${p.state}` }, p.state),
                ),
                h('div', { class: 'plg-muted' }, p.manifest.description),
                h(
                  'div',
                  { class: 'plg-chips' },
                  ...p.granted.map((g) => h('span', { class: 'plg-chip' }, g)),
                  ...(p.granted.length ? [] : [h('span', { class: 'plg-chip' }, 'no permissions')]),
                ),
                p.error ? h('div', { class: 'plg-error' }, p.error) : null,
              ),
              rm,
            );
          })
        : [h('p', { class: 'plg-text plg-muted' }, 'No plugins installed yet. Try one of the examples below.')]),
    );
  };
  const off = ph.onChange(render);
  render();

  const paste = h('textarea', {
    class: 'dtb-code plg-paste',
    spellcheck: false,
    placeholder:
      '/* @physixlab-plugin\n{ "id": "my-plugin", "name": "My plugin", "version": "1.0.0", "permissions": ["ui"] }\n*/\nplugin.registerCommand({ id: "hello", label: "Say hello", run: () => plugin.toast("Hello!") });',
    'aria-label': 'Plugin code',
  });
  paste.addEventListener('keydown', (e) => e.stopPropagation());
  const url = h('input', {
    class: 'plain',
    type: 'url',
    placeholder: 'https://example.com/plugin.js',
    'aria-label': 'Plugin URL',
  });
  url.addEventListener('keydown', (e) => e.stopPropagation());
  const file = h('input', { type: 'file', accept: '.js,.mjs,text/javascript', hidden: true });
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    if (f) void f.text().then((t) => run(t, `file: ${f.name}`), fail);
    file.value = '';
  });

  openModal({
    title: 'Plugins',
    width: 'min(760px, 94vw)',
    onClose: off,
    body: [
      list,
      h('h4', { class: 'plg-heading' }, 'Examples'),
      h(
        'div',
        { class: 'plg-row' },
        ...EXAMPLE_PLUGINS.map((e) => button(`Install “${e.title}”`, () => void run(e.source, 'example'))),
      ),
      h('h4', { class: 'plg-heading' }, 'Install from…'),
      h(
        'div',
        { class: 'plg-row' },
        url,
        button('Fetch URL', () => {
          const u = url.value.trim();
          if (!/^https?:\/\//i.test(u)) return fail(new Error('Enter an http(s) URL'));
          fetch(u)
            .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`The server answered ${r.status}`))))
            .then(
              (t) => run(t, `url: ${u}`),
              (e) => fail(new Error(`Could not load the plugin: ${e instanceof Error ? e.message : String(e)}`)),
            );
        }),
        button('Choose file…', () => file.click()),
        file,
      ),
      paste,
      h(
        'div',
        { class: 'plg-row' },
        button('Install pasted code', () => void run(paste.value, 'paste'), { cls: 'primary' }),
      ),
      message,
      h(
        'p',
        { class: 'plg-muted plg-text' },
        'Plugins run in an isolated sandbox with only the permissions you approve. See docs/PLUGINS.md.',
      ),
    ],
  });
}
