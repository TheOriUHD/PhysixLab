/**
 * The on-screen part of the zones package: while the simulation runs, a small race board at the top of the viewport
 * (position, racer, lap, running lap time, best lap), the score, a flash for the last message a zone showed, and a feed
 * of what just happened (laps, finishes, respawns). Nothing is shown in the editor or when no zone has anything to say,
 * so scenes without races look exactly as before.
 */
import type { App } from '../app/app';
import { formatRaceTime, type RacePublic } from '../model/zones';
import { h } from './dom';
import { icon } from './icons';

export function mountZoneHud(app: App, host: HTMLElement): void {
  const bridge = app.zones;
  const board = h('div', { class: 'zh-board' });
  const score = h('div', { class: 'zh-score' }, 'Score ', h('b', null, '0'));
  const flash = h('div', { class: 'zh-flash' });
  const hud = h('div', { class: 'zone-hud', 'aria-live': 'polite' }, board, score, flash);
  const feed = h('div', { class: 'zone-feed', 'aria-live': 'polite' });
  host.append(hud, feed);

  let lastMessage = 0;
  let flashUntil = 0;
  let boardSig = '';
  const rows = new Map<string, { lap: HTMLElement; time: HTMLElement; best: HTMLElement }>();

  const paintBoard = (races: RacePublic[], now: number) => {
    const sig = races.map((r) => `${r.race}:${r.racers.map((x) => x.racer).join(',')}`).join('|');
    if (sig !== boardSig) {
      boardSig = sig;
      rows.clear();
      board.replaceChildren(
        ...races.slice(0, 2).map((r) => {
          const block = h(
            'div',
            { class: 'zh-race' },
            h(
              'div',
              { class: 'zh-head' },
              icon('flag'),
              h('span', null, r.race),
              h('em', null, r.laps > 1 ? `${r.laps} laps` : ''),
            ),
          );
          r.racers.slice(0, 4).forEach((x, i) => {
            const c = {
              lap: h('span', { class: 'zh-lap' }),
              time: h('span', { class: 'zh-time' }),
              best: h('span', { class: 'zh-best' }),
            };
            rows.set(`${r.race}\u0000${x.racer}`, c);
            block.appendChild(
              h(
                'div',
                { class: 'zh-row' },
                h('span', { class: 'zh-pos' }, String(i + 1)),
                h('span', { class: 'zh-name' }, bridge.nameOf(x.racer)),
                c.lap,
                c.time,
                c.best,
              ),
            );
          });
          return block;
        }),
      );
    }
    for (const r of races.slice(0, 2)) {
      for (const x of r.racers.slice(0, 4)) {
        const c = rows.get(`${r.race}\u0000${x.racer}`);
        if (!c) continue;
        const lap = x.finished ? 'Finished' : `Lap ${Math.min(x.lap + 1, r.laps)}/${r.laps}`;
        if (c.lap.textContent !== lap) c.lap.textContent = lap;
        const t = formatRaceTime(x.finished ? (x.finishTime ?? 0) : bridge.lapTime(x, now));
        if (c.time.textContent !== t) c.time.textContent = t;
        const b = x.bestLap === null ? '' : `best ${formatRaceTime(x.bestLap)}`;
        if (c.best.textContent !== b) c.best.textContent = b;
      }
    }
  };

  app.on('frame', () => {
    const st = app.sim.active ? bridge.state : null;
    const hasRaces = !!st && st.races.length > 0;
    board.style.display = hasRaces ? '' : 'none';
    if (st && hasRaces) paintBoard(st.races, bridge.now);
    else boardSig = '';
    const showScore = !!st && (st.score.total !== 0 || Object.keys(st.score.byRacer).length > 0);
    score.style.display = showScore ? '' : 'none';
    if (showScore) {
      const text = String(st.score.total);
      const b = score.querySelector('b');
      if (b && b.textContent !== text) b.textContent = text;
    }
    const now = performance.now();
    const m = st?.message;
    if (m && m.id !== lastMessage) {
      lastMessage = m.id;
      flash.textContent = m.text;
      flash.classList.remove('on');
      void flash.offsetWidth; // restart the animation
      flash.classList.add('on');
      flashUntil = now + 2400;
    }
    if (flashUntil && now > flashUntil) {
      flashUntil = 0;
      flash.classList.remove('on');
    }
    if (!st && lastMessage) lastMessage = 0;
    // the feed of recent events
    const fresh = app.sim.active ? bridge.feed.filter((f) => f.until > now) : [];
    bridge.feed.splice(0, bridge.feed.length, ...fresh);
    const sig = fresh.map((f) => f.entry.id).join(',');
    if (feed.dataset.sig !== sig) {
      feed.dataset.sig = sig;
      feed.replaceChildren(...fresh.map((f) => h('div', { class: `zf-line ${f.entry.name}` }, f.entry.text)));
    }
  });
}
