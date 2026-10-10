/** The viewer's slim control bar (DT-22): play / pause, reset, camera reset and the simulated clock. */
import type { App } from '../../app/app';
import { iconButton } from '../controls';
import { h } from '../dom';
import { icon } from '../icons';

export function buildEmbedBar(app: App, resetCamera: () => void): HTMLElement {
  const sim = app.sim;
  const play = iconButton('play', 'Play', () => sim.toggle(), 'embed-play');
  const reset = iconButton('reset', 'Reset to the start', () => sim.reset(), 'embed-reset');
  const cam = iconButton('frame', 'Reset camera', resetCamera, 'embed-camera');
  const clock = h('span', { class: 'embed-clock' }, '');
  const bar = h(
    'div',
    { class: 'embed-bar', role: 'toolbar', 'aria-label': 'Simulation controls' },
    play,
    reset,
    cam,
    clock,
  );

  const sync = () => {
    const running = sim.mode === 'running';
    play.title = running ? 'Pause' : 'Play';
    play.setAttribute('aria-label', play.title);
    play.dataset.state = running ? 'running' : sim.mode;
    // Same icon family as the editor: swap the glyph instead of rebuilding the button.
    play.replaceChildren(icon(running ? 'pause' : 'play'));
    reset.disabled = sim.mode === 'edit';
    if (sim.mode === 'edit') clock.textContent = '';
  };
  sim.on('mode', sync);
  sync();
  // The clock follows the simulation without a per-frame DOM write when nothing changed.
  let last = '';
  window.setInterval(() => {
    if (sim.mode === 'edit') return;
    const t = `${(sim.client.stats?.simTime ?? 0).toFixed(1)} s`;
    if (t !== last) clock.textContent = last = t;
  }, 200);
  return bar;
}
