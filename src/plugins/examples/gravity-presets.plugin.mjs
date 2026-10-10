/* global plugin */
/* @physicslab-plugin
{
  "id": "gravity-presets",
  "name": "Gravity presets",
  "version": "1.0.0",
  "description": "A panel and commands that set the scene's gravity to the Moon, Mars, Earth or Jupiter.",
  "permissions": ["ui", "scene.read", "scene.write"]
}
*/
const PRESETS = [
  { id: 'moon', label: 'Moon', g: 1.62 },
  { id: 'mars', label: 'Mars', g: 3.72 },
  { id: 'earth', label: 'Earth', g: 9.81 },
  { id: 'jupiter', label: 'Jupiter', g: 24.79 },
];

async function setGravity(g, label) {
  await plugin.scene.settings({ gravity: [0, -g, 0] });
  await plugin.toast('Gravity set to ' + label + ' (' + g + ' m/s²)', 'success');
}

for (const p of PRESETS) {
  await plugin.registerCommand({
    id: 'gravity-' + p.id,
    label: 'Gravity: ' + p.label,
    category: 'Gravity',
    run: () => setGravity(p.g, p.label),
  });
}

await plugin.registerPanel({
  id: 'gravity',
  label: 'Gravity',
  region: 'right',
  async render() {
    const s = await plugin.scene.settings();
    const current = Math.abs(s.gravity[1]);
    return {
      type: 'column',
      children: [
        { type: 'heading', text: 'Gravity presets' },
        { type: 'muted', text: 'Current: ' + current.toFixed(2) + ' m/s² (downwards)' },
        {
          type: 'row',
          children: PRESETS.map((p) => ({
            type: 'button',
            label: p.label,
            primary: Math.abs(current - p.g) < 0.01,
            onClick: () => setGravity(p.g, p.label),
          })),
        },
        {
          type: 'number',
          label: 'Custom (m/s²)',
          value: current,
          min: 0,
          max: 100,
          step: 0.1,
          onChange: (v) => plugin.scene.settings({ gravity: [0, -v, 0] }),
        },
      ],
    };
  },
});
plugin.on('scene:change', () => plugin.refresh());
