/**
 * UI-A: the Readout panel — live numbers of the selected body while the simulation runs: position, velocity, speed,
 * angular velocity, acceleration, net force, mass, momentum, kinetic / potential / mechanical energy, state and the
 * recent contacts. Every number comes from the running engine (`app.sim.velocityOf` / `poseOf`, the mass the engine
 * built, the contact events of `app.contacts`); the potential energy is computed from the scene's gravity exactly as
 * the engine's own energy statistics do. Units can be switched per row (SI / imperial), the table can be copied as
 * text, and the panel can be pinned to a body so it keeps following it when the selection changes.
 */
import { qrot, vlen } from '../core/math';
import type { Vec3 } from '../core/math';
import type { App } from '../app/app';
import type { PanelContext, PanelDef, PanelView } from '../app/registry/panels';
import type { ContactEvent } from '../physics/protocol';
import { GROUND_ID } from '../physics/protocol';
import { fmt } from './controls';
import { h } from './dom';
import { icon } from './icons';
import { followUnits, systemOf, unitChip } from './inspector/upgrades/fieldUnits';
import { quantityById, toDisplay, unitLabel } from './inspector/upgrades/units';
import { isBody, isJoint } from '../model/types';

/** Contacts remembered for the readout. */
const MAX_CONTACTS = 6;

interface RowDef {
  id: string;
  label: string;
  hint?: string;
  quantity: string;
  digits?: number;
  /** Native-unit values to show: one number, or a vector. */
  read: (s: Sample) => number | Vec3 | null;
  /** Only for the sections of a body / joint. */
  for: 'body' | 'joint';
}

interface Sample {
  id: string;
  pos: Vec3;
  vel: Vec3;
  ang: Vec3;
  force: Vec3;
  mass: number;
  ke: number;
  pe: number;
  state: number;
  // joint
  jointValue: number;
  jointSpeed: number;
  jointForce: number;
}

const gravityPE = (mass: number, scale: number, g: Vec3, com: Vec3): number =>
  -mass * scale * (g[0] * com[0] + g[1] * com[1] + g[2] * com[2]);

const ROWS: RowDef[] = [
  { id: 'pos', label: 'Position', quantity: 'length', digits: 3, read: (s) => s.pos, for: 'body' },
  { id: 'vel', label: 'Velocity', quantity: 'speed', digits: 3, read: (s) => s.vel, for: 'body' },
  { id: 'speed', label: 'Speed', quantity: 'speed', digits: 3, read: (s) => vlen(s.vel), for: 'body' },
  {
    id: 'ang',
    label: 'Spin',
    quantity: 'angSpeed',
    digits: 3,
    read: (s) => s.ang,
    for: 'body',
    hint: 'Angular velocity, world axes',
  },
  {
    id: 'accel',
    label: 'Acceleration',
    quantity: 'accel',
    digits: 3,
    hint: 'Net force ÷ mass: the average change of velocity over the last frame (includes gravity)',
    read: (s) => (s.mass > 0 ? ([s.force[0] / s.mass, s.force[1] / s.mass, s.force[2] / s.mass] as Vec3) : null),
    for: 'body',
  },
  {
    id: 'force',
    label: 'Net force',
    quantity: 'force',
    digits: 2,
    read: (s) => s.force,
    for: 'body',
    hint: 'Average m·Δv/Δt over the last frame',
  },
  { id: 'mass', label: 'Mass', quantity: 'mass', digits: 3, read: (s) => s.mass, for: 'body' },
  {
    id: 'mom',
    label: 'Momentum',
    quantity: 'momentum',
    digits: 3,
    read: (s) => [s.vel[0] * s.mass, s.vel[1] * s.mass, s.vel[2] * s.mass] as Vec3,
    for: 'body',
  },
  {
    id: 'ke',
    label: 'Kinetic energy',
    quantity: 'energy',
    digits: 3,
    read: (s) => s.ke,
    for: 'body',
    hint: 'Translational + rotational, from the engine',
  },
  {
    id: 'pe',
    label: 'Potential energy',
    quantity: 'energy',
    digits: 3,
    read: (s) => s.pe,
    for: 'body',
    hint: 'Gravity, relative to y = 0 (m·g·h at the centre of mass)',
  },
  {
    id: 'me',
    label: 'Mech. energy',
    quantity: 'energy',
    digits: 3,
    read: (s) => s.ke + s.pe,
    for: 'body',
    hint: 'Kinetic + potential',
  },
  {
    id: 'jv',
    label: 'Value',
    quantity: 'length',
    digits: 4,
    read: (s) => s.jointValue,
    for: 'joint',
    hint: 'Angle (rad) of a hinge, position (m) of a slider, length (m) of a spring / rope',
  },
  { id: 'js', label: 'Rate', quantity: 'speed', digits: 4, read: (s) => s.jointSpeed, for: 'joint' },
  {
    id: 'jf',
    label: 'Force',
    quantity: 'force',
    digits: 3,
    read: (s) => s.jointForce,
    for: 'joint',
    hint: 'Spring force along the spring, rope tension estimate',
  },
];

/** Rows of three numbers get a line of their own (the panel is narrow). */
const VEC_ROWS = new Set(['pos', 'vel', 'ang', 'accel', 'force', 'mom']);

const STATE_TEXT = ['awake', 'asleep', 'fell out of the world'];

export function buildReadout(app: App, ctx: PanelContext): PanelView {
  const el = h('div', { class: 'panel-body ui-a-readout' });
  let pinned: string | null = null;
  let shownId = '';
  let lastSample: Sample | null = null;
  const contacts: { t: number; other: string; impulse: number; speed: number }[] = [];
  let contactCount = 0;
  let lastContactT = -1;
  let release: (() => void) | null = null;
  const cells = new Map<string, { value: HTMLElement; rowEl: HTMLElement; def: RowDef }>();
  let stateEl: HTMLElement | null = null;
  let contactsEl: HTMLElement | null = null;
  let title: HTMLElement | null = null;

  const targetId = (): string | null => {
    if (pinned && app.store.get(pinned)) return pinned;
    pinned = null;
    const e = app.store.selection.map((i) => app.store.get(i)).find((x) => x && (isBody(x) || isJoint(x)));
    return e?.id ?? null;
  };

  // ---- toolbar ----
  const pinBtn = h(
    'button',
    {
      class: 'icon-btn ui-a-pin',
      type: 'button',
      'aria-pressed': 'false',
      title: 'Pin: keep following this body when the selection changes',
    },
    icon('lock'),
  );
  pinBtn.addEventListener('click', () => {
    const id = targetId();
    pinned = pinned ? null : id;
    paintPin();
    rebuild();
  });
  const paintPin = () => {
    pinBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
    pinBtn.classList.toggle('on', !!pinned);
    pinBtn.title = pinned
      ? 'Pinned: click to follow the selection again'
      : 'Pin: keep following this body when the selection changes';
  };
  const copyBtn = h(
    'button',
    { class: 'icon-btn ui-a-copy', type: 'button', title: 'Copy the readout as text' },
    icon('copy'),
  );
  copyBtn.addEventListener('click', () => {
    const text = toText();
    if (!text) {
      app.toast('Nothing to copy: select a body and run the simulation', 'warn');
      return;
    }
    void copyText(text).then((ok) =>
      app.toast(ok ? 'Readout copied' : 'Could not copy to the clipboard', ok ? 'success' : 'warn'),
    );
  });

  // ---- text ----
  const fmtRow = (def: RowDef, v: number | Vec3 | null): string => {
    const q = quantityById(def.quantity)!;
    if (v === null) return '—';
    const sys = cells.get(def.id) ? systemOf(cells.get(def.id)!.rowEl, q) : 'si';
    const one = (n: number) => fmt(toDisplay(q, sys, n), def.digits ?? 3);
    return `${typeof v === 'number' ? one(v) : v.map(one).join(', ')} ${unitLabel(q, sys)}`;
  };
  const toText = (): string => {
    if (!lastSample) return '';
    const name = app.store.get(lastSample.id)?.name ?? lastSample.id;
    const lines = [`${name} @ t = ${fmt(app.sim.client.stats?.simTime ?? 0, 3)} s`];
    for (const c of cells.values()) lines.push(`${c.def.label}: ${fmtRow(c.def, c.def.read(lastSample))}`);
    if (lastSample && !cells.has('jv')) lines.push(`State: ${STATE_TEXT[lastSample.state] ?? '—'}`);
    for (const c of contacts)
      lines.push(
        `Contact: ${c.other}, impulse ${fmt(c.impulse, 2)} N·s, approach ${fmt(c.speed, 2)} m/s at t = ${fmt(c.t, 2)} s`,
      );
    return lines.join('\n');
  };

  // ---- sampling ----
  const sample = (id: string): Sample | null => {
    const e = app.store.get(id);
    if (!e) return null;
    if (isJoint(e)) {
      const j = app.liveJoint(id);
      if (!j) return null;
      return {
        id,
        pos: [0, 0, 0],
        vel: [0, 0, 0],
        ang: [0, 0, 0],
        force: [0, 0, 0],
        mass: 0,
        ke: 0,
        pe: 0,
        state: 0,
        jointValue: j.value,
        jointSpeed: j.speed,
        jointForce: j.force,
      };
    }
    const b = app.liveBody(id);
    const pose = app.sim.poseOf(id);
    if (!b || !pose) return null;
    const comLocal = app.sim.client.info.com[id] ?? [0, 0, 0];
    const r = qrot(pose.rotation, comLocal);
    const com: Vec3 = [pose.position[0] + r[0], pose.position[1] + r[1], pose.position[2] + r[2]];
    const scale = isBody(e) ? e.gravityScale : 1;
    return {
      id,
      pos: pose.position,
      vel: b.vel,
      ang: b.ang,
      force: b.force,
      mass: b.mass,
      ke: b.ke,
      pe: b.mass > 0 ? gravityPE(b.mass, scale, app.store.settings.gravity, com) : 0,
      state: b.state,
      jointValue: 0,
      jointSpeed: 0,
      jointForce: 0,
    };
  };

  // ---- contacts ----
  const wantContacts = (id: string | null): boolean =>
    !!id && ctx.active() && app.sim.active && isBody(app.store.get(id));
  const syncContacts = (id: string | null) => {
    const want = wantContacts(id);
    if (want && !release) {
      release = app.contacts.acquire('readout', {}, (ev: ContactEvent) => {
        const me = shownId;
        if (ev.a !== me && ev.b !== me) return;
        if (ev.t < lastContactT) {
          contacts.length = 0;
          contactCount = 0;
        }
        lastContactT = ev.t;
        const other = ev.a === me ? ev.b : ev.a;
        contactCount++;
        contacts.unshift({
          t: ev.t,
          other: other === GROUND_ID ? 'ground' : (app.store.get(other)?.name ?? other),
          impulse: ev.impulse,
          speed: ev.speed,
        });
        if (contacts.length > MAX_CONTACTS) contacts.pop();
      });
    } else if (!want && release) {
      release();
      release = null;
    }
  };

  // ---- DOM ----
  const rebuild = () => {
    cells.clear();
    stateEl = contactsEl = title = null;
    el.replaceChildren();
    const id = targetId();
    // the contact history belongs to one body in one simulation run: a rebuild for another reason (pinning,
    // switching tabs) keeps it
    if ((id ?? '') !== shownId || !app.sim.active) {
      contacts.length = 0;
      contactCount = 0;
      lastContactT = -1;
    }
    shownId = id ?? '';
    const ent = id ? app.store.get(id) : undefined;
    if (!ent) {
      el.append(
        emptyState(
          'Nothing to read',
          'Select a body (or a joint) and press Space: its live position, velocity, acceleration, forces, contacts and energy appear here.',
        ),
      );
      return;
    }
    if (!app.sim.active) {
      el.append(
        emptyState(
          `“${ent.name}” is not simulating`,
          'Press Space to start the simulation: the readout shows what the physics engine computes for the selected object, updated live.',
        ),
      );
      return;
    }
    title = h(
      'div',
      { class: 'ui-a-readout-title' },
      h('b', null, ent.name),
      pinned ? h('span', { class: 'badge' }, 'PINNED') : h('span', { class: 'badge' }, 'LIVE'),
      pinBtn,
      copyBtn,
    );
    const body = h('div', { class: 'ui-a-readout-rows' });
    for (const def of ROWS.filter((r) => r.for === (isJoint(ent) ? 'joint' : 'body'))) {
      const q = quantityById(def.quantity)!;
      const value = h('span', { class: 'ui-a-readout-value' }, '—');
      const r = h(
        'div',
        { class: VEC_ROWS.has(def.id) ? 'row stack' : 'row' },
        h('div', { class: 'row-label', title: def.hint ?? '' }, def.label),
        h('div', { class: 'row-control' }, value),
      );
      r.querySelector('.row-control')!.append(unitChip(() => r, q, 'num-unit'));
      cells.set(def.id, { value, rowEl: r, def });
      followUnits(r, () => lastSample && (value.textContent = valueText(def, lastSample)));
      body.append(r);
    }
    el.append(title, body);
    if (isBody(ent)) {
      stateEl = h('span', { class: 'ui-a-readout-value' }, '—');
      body.append(
        h(
          'div',
          { class: 'row' },
          h('div', { class: 'row-label' }, 'State'),
          h('div', { class: 'row-control' }, stateEl),
        ),
      );
      contactsEl = h('div', { class: 'ui-a-contacts' });
      el.append(h('div', { class: 'ui-a-readout-sub' }, 'Recent contacts'), contactsEl);
    }
  };

  const valueText = (def: RowDef, s: Sample): string => {
    const q = quantityById(def.quantity)!;
    const v = def.read(s);
    if (v === null) return '—';
    const sys = systemOf(cells.get(def.id)!.rowEl, q);
    const one = (n: number) => fmt(toDisplay(q, sys, n), def.digits ?? 3);
    return typeof v === 'number' ? one(v) : v.map(one).join(', ');
  };

  const emptyState = (head: string, text: string): HTMLElement =>
    h('div', { class: 'empty-state' }, icon('velocity', 'icon big'), h('h4', null, head), h('p', null, text));

  const tick = () => {
    const id = targetId();
    if ((id ?? '') !== shownId || (!!id && cells.size === 0 && app.sim.active) || (!app.sim.active && cells.size > 0)) {
      rebuild();
      paintPin();
    }
    syncContacts(id);
    if (!ctx.active() || !id || !app.sim.active) return;
    const s = sample(id);
    lastSample = s;
    if (!s) return;
    for (const c of cells.values()) c.value.textContent = valueText(c.def, s);
    if (stateEl) stateEl.textContent = STATE_TEXT[s.state] ?? '—';
    if (contactsEl) {
      if (!contacts.length)
        contactsEl.replaceChildren(
          h(
            'p',
            { class: 'hint-text' },
            'No impacts yet. Contact events appear when this body starts touching something.',
          ),
        );
      else {
        contactsEl.replaceChildren(
          h(
            'p',
            { class: 'hint-text' },
            `${contactCount} impact${contactCount === 1 ? '' : 's'} since the simulation started (new contacts only, not resting ones)`,
          ),
          ...contacts.map((c) =>
            h(
              'div',
              { class: 'ui-a-contact' },
              h('b', null, c.other),
              h('span', null, `${fmt(c.impulse, 2)} N·s · ${fmt(c.speed, 2)} m/s`),
              h('small', null, `t = ${fmt(c.t, 2)} s`),
            ),
          ),
        );
      }
    }
  };

  let last = 0;
  const onFrame = () => {
    const now = performance.now();
    if (now - last < 90) return;
    last = now;
    tick();
  };
  const offs = [
    app.on('frame', onFrame),
    app.store.on('selection', () => {
      if (!pinned) tick();
    }),
    app.sim.on('mode', () => {
      release?.();
      release = null;
      tick();
    }),
    app.store.on('change', (c) => {
      if (c.type === 'reset' || c.type === 'remove') tick();
    }),
  ];
  rebuild();
  paintPin();

  return {
    el,
    onShow: () => {
      rebuild();
      paintPin();
      tick();
    },
    dispose: () => {
      release?.();
      release = null;
      offs.forEach((f) => f());
    },
  };
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export const readoutPanel: PanelDef = {
  id: 'readout',
  label: 'Readout',
  icon: 'velocity',
  region: 'right',
  order: 15,
  title: 'Live position, velocity, acceleration, forces, contacts and energy of the selected body',
  build: (app, ctx) => buildReadout(app, ctx),
};
