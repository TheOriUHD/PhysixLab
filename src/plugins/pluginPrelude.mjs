/* global build */
/*
 * DT-31: the `plugin` object as seen by plugin code. Runs INSIDE the sandbox worker, after dslPrelude.mjs (which
 * defines build(api) = the scene DSL, reused for templates). Everything here only forwards messages to the host,
 * which checks the plugin's granted permissions before doing anything.
 */
// eslint-disable-next-line no-unused-vars -- called by the host through `return buildPlugin(api)`
function buildPlugin(api) {
  const METHODS = {
    scene: [
      'get',
      'toJSON',
      'load',
      'clear',
      'name',
      'setName',
      'entities',
      'entity',
      'add',
      'addBody',
      'update',
      'remove',
      'select',
      'selection',
      'settings',
      'undo',
      'redo',
    ],
    simulation: ['mode', 'play', 'pause', 'toggle', 'step', 'reset', 'timeScale', 'stats'],
    query: ['pose', 'velocity', 'raycast'],
    view: ['get', 'set', 'frameAll', 'frameSelection'],
  };
  const plugin = {};
  for (const group of Object.keys(METHODS)) {
    plugin[group] = {};
    for (const m of METHODS[group]) plugin[group][m] = (...args) => api.call('api.' + group + '.' + m, args);
  }
  /** One undo step for several scene calls: batch('Label', [['addBody', 'box', [0,1,0]], ['update', id, {…}]]). */
  plugin.scene.batch = (label, calls) => api.call('api.scene.batch', [label, calls]);
  plugin.on = (event, handler) => api.call('events.subscribe', [event, api.cb(handler)]);
  plugin.registerCommand = (def) => {
    if (!def || typeof def.run !== 'function') throw new Error('registerCommand needs { id, label, run() }');
    return api.call('register.command', [
      { id: def.id, label: def.label, category: def.category, description: def.description, run: api.cb(def.run) },
    ]);
  };
  plugin.registerPanel = (def) => {
    if (!def || typeof def.render !== 'function') throw new Error('registerPanel needs { id, label, render() }');
    const toWire = (node) => {
      if (Array.isArray(node)) return node.map(toWire);
      if (node && typeof node === 'object') {
        const out = {};
        for (const k of Object.keys(node)) {
          const v = node[k];
          out[k] = typeof v === 'function' ? api.cb(v) : toWire(v);
        }
        return out;
      }
      return node;
    };
    const render = async () => toWire(await def.render());
    return api.call('register.panel', [{ id: def.id, label: def.label, region: def.region, render: api.cb(render) }]);
  };
  plugin.registerTemplate = (def) => {
    if (!def || typeof def.build !== 'function') throw new Error('registerTemplate needs { id, name, build(dsl) }');
    const dsl = build(api);
    def.build(dsl.scope);
    const rec = dsl.finish();
    return api.call('register.template', [
      { id: def.id, name: def.name, category: def.category, blurb: def.blurb, scene: rec },
    ]);
  };
  plugin.toast = (text, kind) => api.call('ui.toast', [String(text), kind || 'info']);
  plugin.refresh = () => api.call('ui.refresh', []);
  Object.freeze(plugin.scene);
  const scope = {
    plugin: Object.freeze(plugin),
    console: api.console,
    Math,
    setTimeout: api.setTimeout,
    clearTimeout: api.clearTimeout,
  };
  return {
    scope,
    finish() {
      return null;
    },
  };
}
