/* global plugin */
/* @physicslab-plugin
{
  "id": "domino-tools",
  "name": "Domino tools",
  "version": "1.0.0",
  "description": "Adds a domino-line command (one undo step), a scene statistics panel and an example scene.",
  "permissions": ["ui", "scene.read", "scene.write", "view"]
}
*/
await plugin.registerCommand({
  id: 'domino-line',
  label: 'Add a line of 12 dominoes',
  category: 'Add',
  async run() {
    const calls = [];
    for (let i = 0; i < 12; i++)
      calls.push([
        'addBody',
        'box',
        [i * 0.5 - 3, 0.35, 0],
        { name: 'Domino ' + (i + 1), shape: { type: 'box', size: [0.12, 0.7, 0.4] } },
      ]);
    await plugin.scene.batch('Domino line', calls);
    await plugin.view.frameAll();
    await plugin.toast('Added 12 dominoes — Ctrl+Z removes them all', 'success');
  },
});

await plugin.registerPanel({
  id: 'stats',
  label: 'Stats',
  region: 'right',
  async render() {
    const bodies = await plugin.scene.entities({ kind: 'body' });
    const dynamic = bodies.filter((b) => b.bodyType === 'dynamic').length;
    return {
      type: 'column',
      children: [
        { type: 'heading', text: 'Scene statistics' },
        {
          type: 'table',
          columns: ['What', 'Count'],
          rows: [
            ['Bodies', String(bodies.length)],
            ['Dynamic', String(dynamic)],
            ['Static / kinematic', String(bodies.length - dynamic)],
          ],
        },
        { type: 'progress', label: 'Dynamic share', value: bodies.length ? dynamic / bodies.length : 0 },
        { type: 'button', label: 'Refresh', onClick: () => undefined },
      ],
    };
  },
});
plugin.on('scene:change', () => plugin.refresh());

await plugin.registerTemplate({
  id: 'domino-arc',
  name: 'Domino arc (plugin)',
  category: 'Plugins',
  blurb: 'A curved domino run built by the Domino tools plugin.',
  build(dsl) {
    dsl.name('Domino arc');
    dsl.body('Floor', 'box', [12, 0.2, 8], [0, -0.1, 0], { bodyType: 'static', material: 'concrete' });
    dsl.array(24, (i) => {
      const a = (i / 24) * Math.PI;
      dsl.body('Domino ' + (i + 1), 'box', [0.12, 0.7, 0.4], [Math.cos(a) * 3, 0.35, Math.sin(a) * 3], {
        rotation: dsl.rotY(-(a * 180) / Math.PI),
      });
    });
    dsl.body('Starter', 'sphere', [0.5, 0.5, 0.5], [3.4, 0.5, -0.8], {
      material: 'steel',
      linearVelocity: [0, 0, 1.2],
    });
  },
});
