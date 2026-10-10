/**
 * The Zones tab of the bottom dock (ZN-3): the race standings and the zone event log, live while the simulation runs.
 *
 *  - **Race**: one table per race — position, racer, lap, last / best lap, running time, checkpoints, penalties —
 *    built from the state the worker publishes (`app.zones.state`); times of racers that are still going tick at
 *    display rate from the simulation clock.
 *  - **Events**: the last events of every zone and of the world bounds as sentences, newest at the bottom.
 *
 * Empty states say what to add; the tab toolbar mutes zone sounds and clears the log.
 */
import type { App } from '../app/app';
import { zoneSound } from '../app/zoneSound';
import type { PanelDef, PanelView } from '../app/registry/panels';
import { formatRaceTime, type RacePublic, type RacerPublic } from '../model/zones';
import { iconButton } from './controls';
import { h } from './dom';
import { icon } from './icons';

const clock = (t: number): string => formatRaceTime(t);

function build(app: App, ctx: { active: () => boolean }): PanelView {
  const bridge = app.zones;
  const races = h('div', { class: 'zp-races' });
  const logList = h('div', { class: 'zp-log', role: 'log', 'aria-label': 'Zone events' });
  const el = h(
    'div',
    { class: 'zones-panel' },
    h(
      'div',
      { class: 'zp-col zp-race' },
      h('div', { class: 'zp-head' }, icon('stopwatch'), h('span', null, 'Race')),
      races,
    ),
    h(
      'div',
      { class: 'zp-col zp-events' },
      h('div', { class: 'zp-head' }, icon('event'), h('span', null, 'Events')),
      logList,
    ),
  );

  const mute = iconButton('speaker', 'Mute / unmute zone sounds', () => {
    zoneSound.setMuted(!zoneSound.muted);
    paintMute();
  });
  const paintMute = () => {
    mute.classList.toggle('active', zoneSound.muted);
    mute.title = zoneSound.muted ? 'Zone sounds are muted — click to unmute' : 'Mute zone sounds';
    mute.setAttribute('aria-pressed', String(zoneSound.muted));
  };
  paintMute();
  const clear = iconButton('trash', 'Clear the event log', () => bridge.clear());

  // ── events ──
  let logSig = -1;
  const paintLog = () => {
    const last = bridge.log[bridge.log.length - 1]?.id ?? 0;
    const sig = last * 1000 + bridge.log.length;
    if (sig === logSig) return;
    logSig = sig;
    if (!bridge.log.length) {
      logList.replaceChildren(
        h(
          'div',
          { class: 'zp-empty' },
          'Nothing has happened yet. Enter, exit, checkpoint, lap, launch, respawn … events appear here while the simulation runs.',
        ),
      );
      return;
    }
    const stick = logList.scrollTop + logList.clientHeight >= logList.scrollHeight - 24;
    logList.replaceChildren(
      ...bridge.log
        .slice(-120)
        .map((e) =>
          h(
            'div',
            { class: `zp-line ${e.source} ${e.name}` },
            h('span', { class: 'zp-t' }, clock(e.t)),
            h('span', { class: 'zp-n' }, e.name),
            h('span', { class: 'zp-x' }, e.text),
          ),
        ),
    );
    if (stick) logList.scrollTop = logList.scrollHeight;
  };

  // ── race tables ──
  let raceSig = '';
  const cells = new Map<string, Record<string, HTMLElement>>();
  const raceTable = (r: RacePublic): HTMLElement => {
    const head = h(
      'div',
      { class: 'zp-race-head' },
      h('b', null, r.race),
      h(
        'span',
        null,
        `${r.laps} lap${r.laps === 1 ? '' : 's'} · ${r.checkpoints.length} checkpoint${r.checkpoints.length === 1 ? '' : 's'}${r.hasStart ? '' : ' · clock from the start of the run'}`,
      ),
      r.record
        ? h(
            'span',
            { class: 'zp-record', title: 'Fastest lap of the race' },
            `Record ${clock(r.record.time)} · ${bridge.nameOf(r.record.racer)}`,
          )
        : null,
    );
    const table = h(
      'div',
      { class: 'zp-table', role: 'table', 'aria-label': `Race ${r.race}` },
      h(
        'div',
        { class: 'zp-row zp-hdr', role: 'row' },
        ...['#', 'Racer', 'Lap', 'Last', 'Best', 'Time', 'Gates', 'Penalty'].map((c) =>
          h('span', { role: 'columnheader' }, c),
        ),
      ),
    );
    r.racers.forEach((x, i) => {
      const row = h('div', { class: 'zp-row', role: 'row', dataset: { racer: x.racer } });
      const c: Record<string, HTMLElement> = {};
      for (const k of ['pos', 'name', 'lap', 'last', 'best', 'time', 'gates', 'pen']) {
        c[k] = h('span', { role: 'cell', class: `c-${k}` });
        row.appendChild(c[k]);
      }
      cells.set(`${r.race}\u0000${x.racer}`, c);
      c.pos.textContent = String(i + 1);
      c.name.textContent = bridge.nameOf(x.racer);
      table.appendChild(row);
    });
    return h('div', { class: 'zp-race-block' }, head, table);
  };
  const fill = (race: RacePublic, x: RacerPublic, now: number) => {
    const c = cells.get(`${race.race}\u0000${x.racer}`);
    if (!c) return;
    const set = (k: string, t: string) => {
      if (c[k].textContent !== t) c[k].textContent = t;
    };
    set('lap', x.finished ? `✓ ${race.laps}/${race.laps}` : `${Math.min(x.lap + 1, race.laps)}/${race.laps}`);
    set('last', x.lastLap === null ? '–' : clock(x.lastLap));
    set('best', x.bestLap === null ? '–' : clock(x.bestLap));
    c.best.classList.toggle('record', !!race.record && race.record.racer === x.racer && race.record.time === x.bestLap);
    set('time', x.clockStart === null ? 'waiting for the start' : clock(bridge.raceTime(x, now)));
    set('gates', `${x.passed}/${race.checkpoints.length}`);
    set('pen', x.penalty > 0 ? `+${x.penalty.toFixed(1)} s` : '');
    c.time.classList.toggle('done', x.finished);
  };
  const paintRaces = () => {
    const st = bridge.state;
    const live = app.sim.active;
    if (!st || !st.races.length) {
      if (raceSig !== 'empty') {
        raceSig = 'empty';
        cells.clear();
        races.replaceChildren(
          h(
            'div',
            { class: 'zp-empty' },
            live
              ? 'No racer has crossed a start, checkpoint or finish line yet.'
              : 'No race yet. Add a start / finish line and some checkpoints from the Add tab (Zones & race), give a vehicle or a ball a go, and press Play: laps, splits and the best lap are timed here and on screen.',
          ),
        );
      }
      return;
    }
    const sig = st.races.map((r) => `${r.race}:${r.racers.map((x) => x.racer).join(',')}`).join('|');
    if (sig !== raceSig) {
      raceSig = sig;
      cells.clear();
      races.replaceChildren(...st.races.map(raceTable));
    }
    const now = bridge.now;
    for (const r of st.races) for (const x of r.racers) fill(r, x, now);
  };

  let acc = 0;
  const off = app.on('frame', ({ dt }) => {
    if (!ctx.active()) return;
    acc += dt;
    if (acc < 0.08) return;
    acc = 0;
    paintRaces();
  });
  const offLog = bridge.on('log', () => {
    if (ctx.active()) paintLog();
  });
  const offMode = app.sim.on('mode', () => {
    raceSig = '';
    paintRaces();
  });
  paintLog();
  paintRaces();
  return {
    el,
    toolbar: [mute, clear],
    onShow: () => {
      logSig = -1;
      raceSig = '';
      paintLog();
      paintRaces();
    },
    dispose: () => {
      off();
      offLog();
      offMode();
    },
  };
}

export const zonesPanel: PanelDef = {
  id: 'zones',
  label: 'Zones',
  icon: 'stopwatch',
  region: 'bottom',
  order: 30,
  title: 'Race standings, lap and split times, and the events zones raise',
  build,
};
