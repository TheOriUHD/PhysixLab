/**
 * Inspector — properties of the current selection. Rebuilds its DOM when the kind of
 * selection changes and otherwise just refreshes field values (including live readouts from
 * the running simulation), so typing and scrubbing never lose focus.
 */
import { Vector3 } from 'three';
import { DEG, qfromEuler, qtoEuler, RAD, vlen, type Vec3 } from '../core/math';
import type { App } from '../app/app';
import { JOINT_TYPE_LABELS } from '../model/factory';
import { MATERIAL_PRESETS, PRESET_BY_ID } from '../model/materials';
import { normalizeSize, SHAPE_LABELS, shapeVolume } from '../model/shapes';
import type { BodyEntity, Entity, JointEntity, MotorMode, SoftEntity, SoftPin } from '../model/types';
import { isBody, isJoint, isSoft } from '../model/types';
import {
  checkChips, colorField, fmt, keyField, numberField, row, rowStack, section, segmented, selectField, sliderField, toggleField,
  vec3Field, button, type Field,
} from './controls';
import { clear, h } from './dom';
import { icon } from './icons';

type Updater = () => void;

export class Inspector {
  readonly el: HTMLElement = h('div', { class: 'panel-body' });
  private updaters: Updater[] = [];
  private live: Updater[] = [];
  private builtFor = '';
  private lastLive = 0;

  constructor(private app: App) {
    const { store } = app;
    store.on('selection', () => this.render());
    store.on('change', (c) => {
      if (c.type === 'reset' || c.type === 'remove') this.render();
      else this.refresh();
    });
    app.sim.on('mode', () => this.render());
    app.on('frame', () => {
      const now = performance.now();
      if (now - this.lastLive > 90 && this.live.length) {
        this.lastLive = now;
        this.live.forEach((f) => f());
      }
    });
    app.on('jointEnd', () => this.refresh());
    this.render();
  }

  // ------------------------------------------------------------------------------------------

  private selection(): Entity[] {
    return this.app.store.selection.map((id) => this.app.store.get(id)).filter((e): e is Entity => !!e);
  }

  private key(sel: Entity[]): string {
    const kinds = new Set(sel.map((e) => e.kind + (isJoint(e) ? e.type : '')));
    return `${sel.length > 1 ? 'multi' : sel[0]?.id ?? 'none'}:${[...kinds].join(',')}:${this.app.sim.mode === 'edit' ? 'e' : 's'}`;
  }

  render(): void {
    const sel = this.selection();
    this.builtFor = this.key(sel);
    this.updaters = [];
    this.live = [];
    clear(this.el);
    if (!sel.length) { this.el.appendChild(this.empty()); return; }
    if (sel.every(isBody)) this.el.append(...this.bodyInspector(sel as BodyEntity[]));
    else if (sel.every(isSoft)) this.el.append(...this.softInspector(sel as SoftEntity[]));
    else if (sel.length === 1 && isJoint(sel[0])) this.el.append(...this.jointInspector(sel[0]));
    else this.el.append(...this.summary(sel));
    this.refresh();
    this.live.forEach((f) => f());
  }

  refresh(): void {
    const sel = this.selection();
    if (this.key(sel) !== this.builtFor) { this.render(); return; }
    this.updaters.forEach((u) => u());
  }

  private empty(): HTMLElement {
    const n = this.app.store.size;
    return h('div', { class: 'empty-state' }, icon('select', 'icon big'),
      h('h4', null, n ? 'Nothing selected' : 'An empty lab'),
      h('p', null, n
        ? 'Click an object in the scene or the outliner to inspect and edit it. Drag on empty space to box-select.'
        : 'Add a shape from the library on the left (or press 1–8), then press Space to simulate.'));
  }

  // ------------------------------------------------------------------------------------------
  // shared bits
  // ------------------------------------------------------------------------------------------

  private header(sel: Entity[]): HTMLElement {
    const { store, editor } = this.app;
    const first = sel[0];
    const nameInput = h('input', { class: 'plain', type: 'text', value: sel.length > 1 ? `${sel.length} objects` : first.name, spellcheck: false, disabled: sel.length > 1 });
    nameInput.style.fontWeight = '600';
    nameInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') nameInput.blur(); });
    nameInput.addEventListener('change', () => store.update(first.id, { name: nameInput.value.trim() || first.name } as Partial<Entity>, 'Rename'));
    this.updaters.push(() => { const e = this.selection()[0]; if (e && sel.length === 1 && document.activeElement !== nameInput) nameInput.value = e.name; });
    const ids = sel.map((e) => e.id);
    const act = (ic: string, title: string, fn: () => void) => { const b = h('button', { class: 'icon-btn', type: 'button', title }, icon(ic)); b.addEventListener('click', fn); return b; };
    const bodies = sel.filter((e) => isBody(e) || isSoft(e));
    const lock = act(bodies.length && bodies.every((b) => b.locked) ? 'lock' : 'unlock', 'Lock (L): locked bodies cannot be moved in the editor', () => editor.toggleFlag(ids, 'locked'));
    lock.style.display = bodies.length ? '' : 'none';
    const hide = act(sel.every((e) => e.hidden) ? 'eyeOff' : 'eye', 'Hide (H)', () => editor.toggleFlag(ids, 'hidden'));
    this.updaters.push(() => {
      lock.replaceChildren(icon(bodies.length && sel.map((e) => store.get(e.id)).every((e) => (isBody(e) || isSoft(e)) && e.locked) ? 'lock' : 'unlock'));
      hide.replaceChildren(icon(sel.map((e) => store.get(e.id)).every((e) => e?.hidden) ? 'eyeOff' : 'eye'));
    });
    return h('div', { style: { display: 'flex', gap: '4px', padding: '10px 12px', alignItems: 'center', borderBottom: '1px solid var(--border)' } },
      nameInput, lock, hide,
      act('copy', 'Duplicate (Ctrl+D)', () => editor.duplicateSelection()),
      act('trash', 'Delete (Del)', () => editor.deleteSelection()));
  }

  private summary(sel: Entity[]): HTMLElement[] {
    const nb = sel.filter((e) => isBody(e) || isSoft(e)).length, nj = sel.filter(isJoint).length;
    return [
      this.header(sel),
      h('div', { class: 'empty-state' }, h('h4', null, `${sel.length} objects selected`),
        h('p', null, `${nb} bod${nb === 1 ? 'y' : 'ies'}, ${nj} joint${nj === 1 ? '' : 's'}. Select only bodies to edit shared properties, or one joint to edit its settings.`)),
    ];
  }

  /** Apply a patch to every selected entity of type T inside one undo step. */
  private edit<T extends Entity>(ids: string[], label: string, fn: (e: T) => Partial<T>): void {
    const { store } = this.app;
    const patches: [string, Partial<Entity>][] = [];
    for (const id of ids) {
      const e = store.get(id) as T | undefined;
      if (e) patches.push([id, fn(e) as Partial<Entity>]);
    }
    store.updateMany(patches, label);
  }

  private grouped(label: string): { onStart: () => void; onEnd: () => void } {
    return { onStart: () => this.app.store.begin(label), onEnd: () => this.app.store.end() };
  }

  // ------------------------------------------------------------------------------------------
  // bodies
  // ------------------------------------------------------------------------------------------

  private bodyInspector(sel: BodyEntity[]): HTMLElement[] {
    const { app } = this;
    const ids = sel.map((b) => b.id);
    const multi = sel.length > 1;
    const cur = (): BodyEntity[] => ids.map((id) => app.store.body(id)).filter((b): b is BodyEntity => !!b);
    const first = (): BodyEntity => cur()[0];
    const mixed = <T>(get: (b: BodyEntity) => T) => { const l = cur(); return l.some((b) => JSON.stringify(get(b)) !== JSON.stringify(get(l[0]))); };
    const live = app.sim.active;

    /** Register a field: `get` reads the first selection, `mixedOf` the multi-selection state. */
    const bind = <T>(f: Field<T>, get: (b: BodyEntity) => T) => {
      this.updaters.push(() => { if (cur().length) f.set(get(first()), multi && mixed(get)); });
      return f.el;
    };
    const num = (label: string, get: (b: BodyEntity) => number, set: (b: BodyEntity, v: number) => Partial<BodyEntity>, o: { step?: number; min?: number; max?: number; unit?: string; digits?: number; hint?: string } = {}) => {
      const g = this.grouped(`Edit ${label}`);
      const f = numberField({ step: o.step ?? 0.1, min: o.min, max: o.max, unit: o.unit, digits: o.digits, ...g, onChange: (v) => this.edit<BodyEntity>(ids, `Edit ${label}`, (b) => set(b, v)) });
      return row(label, bind(f, get), o.hint);
    };
    const out: HTMLElement[] = [this.header(sel)];

    // ---- transform ----------------------------------------------------------------------------
    if (!multi) {
      const poseOf = () => app.sim.poseOf(ids[0]);
      const gp = this.grouped('Move');
      const pos = vec3Field({ step: 0.05, unit: 'm', ...gp, onChange: (v) => {
        const p = poseOf(); if (p) app.editor.setPose(ids[0], v, p.rotation);
      } });
      this.updaters.push(() => { const p = poseOf(); if (p) pos.set(p.position); });
      const gr = this.grouped('Rotate');
      const rot = vec3Field({ step: 1, unit: '°', digits: 2, ...gr, onChange: (v) => {
        const q = qfromEuler([v[0] * DEG, v[1] * DEG, v[2] * DEG]);
        const p = poseOf(); if (p) app.editor.setPose(ids[0], p.position, q);
      } });
      this.updaters.push(() => {
        const p = poseOf();
        if (!p) return;
        const e = qtoEuler(p.rotation);
        const next: Vec3 = [e[0] * RAD, e[1] * RAD, e[2] * RAD];
        // keep the user's own representation while they are scrubbing
        if (document.activeElement && (document.activeElement as HTMLElement).closest('.vec3') === rot.el) return;
        rot.set(next);
      });
      const size = this.sizeFields(ids[0]);
      out.push(section('Transform', [
        rowStack('Position (m)', pos.el, live ? 'Live pose — editing moves the body in the running simulation only' : undefined),
        rowStack('Rotation (°)', rot.el),
        ...size,
      ], { id: 'transform' }));
    }

    // ---- physics ------------------------------------------------------------------------------
    const typeSeg = segmented<BodyEntity['bodyType']>({
      options: [
        { value: 'dynamic', label: 'Dynamic', title: 'Moves under forces and collisions' },
        { value: 'static', label: 'Static', title: 'Fixed in place; others collide with it' },
        { value: 'kinematic', label: 'Kinematic', title: 'Moves at a set velocity, unaffected by forces' },
      ],
      onChange: (v) => app.editor.setBodyType(ids, v),
    });
    this.updaters.push(() => { if (!mixed((b) => b.bodyType)) typeSeg.set(first().bodyType); else typeSeg.buttons.forEach((b) => b.classList.remove('on')); });

    const presetSel = selectField<string>({
      options: [...MATERIAL_PRESETS.map((p) => ({ value: p.id, label: p.label })), { value: 'custom', label: 'Custom' }],
      onChange: (v) => {
        const p = PRESET_BY_ID.get(v);
        if (!p) return;
        this.edit<BodyEntity>(ids, `Material: ${p.label}`, () => ({
          material: { preset: p.id, density: p.density, friction: p.friction, restitution: p.restitution, color: p.color, metalness: p.metalness, roughness: p.roughness, opacity: p.opacity, },
        }));
      },
    });
    const matEdit = (label: string, patch: (m: BodyEntity['material']) => Partial<BodyEntity['material']>) =>
      this.edit<BodyEntity>(ids, label, (b) => ({ material: { ...b.material, preset: 'custom', ...patch(b.material) } }));

    const density = sliderField({ min: 5, max: 25000, log: true, unit: 'kg/m³', digits: 0, ...this.grouped('Edit density'), onChange: (v) => matEdit('Edit density', () => ({ density: Math.round(v) })) });
    const friction = sliderField({ min: 0, max: 2, step: 0.01, digits: 2, ...this.grouped('Edit friction'), onChange: (v) => matEdit('Edit friction', () => ({ friction: v })) });
    const rest = sliderField({ min: 0, max: 1, step: 0.01, digits: 2, ...this.grouped('Edit restitution'), onChange: (v) => matEdit('Edit restitution', () => ({ restitution: v })) });

    const massVal = h('span', { class: 'readout' });
    const massRow = row('Mass', massVal, 'Density × volume, from the engine once simulating');
    this.updaters.push(() => {
      const b = first();
      if (b.bodyType !== 'dynamic') { massVal.textContent = b.bodyType === 'static' ? 'static (immovable)' : 'kinematic (scripted)'; return; }
      const liveMass = app.sim.client.active ? app.sim.client.info.mass[b.id] : undefined;
      const m = liveMass ?? cur().reduce((s, x) => s + x.material.density * shapeVolume(x.shape), 0);
      massVal.textContent = `${fmt(m, m < 10 ? 3 : m < 1000 ? 2 : 0)} kg`;
      massVal.title = `${fmt(shapeVolume(b.shape), 4)} m³ × ${b.material.density} kg/m³`;
    });

    out.push(section('Physics', [
      rowStack('Type', typeSeg.el),
      row('Material', bind(presetSel, (b) => b.material.preset)),
      row('Density', bind(density, (b) => b.material.density)),
      row('Friction', bind(friction, (b) => b.material.friction)),
      row('Bounciness', bind(rest, (b) => b.material.restitution), 'Coefficient of restitution (1 = perfectly elastic)'),
      massRow,
      num('Lin. damping', (b) => b.linearDamping, (_b, v) => ({ linearDamping: v }), { step: 0.01, min: 0, digits: 3, unit: '1/s' }),
      num('Ang. damping', (b) => b.angularDamping, (_b, v) => ({ angularDamping: v }), { step: 0.01, min: 0, digits: 3, unit: '1/s' }),
      num('Gravity scale', (b) => b.gravityScale, (_b, v) => ({ gravityScale: v }), { step: 0.1, digits: 2, hint: '0 = weightless, negative = floats up' }),
      row('Lock move', bind(checkChips({ items: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }], onChange: (v) => this.edit<BodyEntity>(ids, 'Lock translation', () => ({ lockPosition: v as [boolean, boolean, boolean] })) }), (b) => [...b.lockPosition])),
      row('Lock rotate', bind(checkChips({ items: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }], onChange: (v) => this.edit<BodyEntity>(ids, 'Lock rotation', () => ({ lockRotation: v as [boolean, boolean, boolean] })) }), (b) => [...b.lockRotation])),
      rowStack('Options', h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', width: '100%', paddingBottom: '4px' } },
        bind(toggleField({ label: 'Continuous collision (fast bodies)', onChange: (v) => this.edit<BodyEntity>(ids, 'Toggle CCD', () => ({ ccd: v })) }), (b) => b.ccd),
        bind(toggleField({ label: 'Allow sleeping', onChange: (v) => this.edit<BodyEntity>(ids, 'Toggle sleeping', () => ({ canSleep: v })) }), (b) => b.canSleep),
        bind(toggleField({ label: 'Ghost (no collisions, keeps mass)', onChange: (v) => this.edit<BodyEntity>(ids, 'Toggle ghost', () => ({ ghost: v })) }), (b) => b.ghost))),
    ], { id: 'physics' }));

    // ---- motion -------------------------------------------------------------------------------
    const vel = vec3Field({ step: 0.1, unit: 'm/s', ...this.grouped('Edit velocity'), onChange: (v) => this.edit<BodyEntity>(ids, 'Edit velocity', () => ({ velocity: v })) });
    const ang = vec3Field({ step: 0.1, unit: 'rad/s', ...this.grouped('Edit spin'), onChange: (v) => this.edit<BodyEntity>(ids, 'Edit spin', () => ({ angularVelocity: v })) });
    out.push(section('Initial motion', [
      h('p', { class: 'hint-text' }, 'Dynamic bodies start with this velocity when the simulation begins. Kinematic bodies move with it continuously.'),
      rowStack('Velocity (m/s)', bind({ el: vel.el, set: (v: Vec3, m?: boolean) => vel.set(v, m) }, (b) => b.velocity)),
      rowStack('Spin (rad/s)', bind({ el: ang.el, set: (v: Vec3, m?: boolean) => ang.set(v, m) }, (b) => b.angularVelocity)),
    ], { id: 'motion', open: false }));

    // ---- forces -------------------------------------------------------------------------------
    out.push(this.thrustSection(ids, cur, mixed));

    // ---- appearance ---------------------------------------------------------------------------
    const color = colorField({ ...this.grouped('Edit colour'), onChange: (v) => matEdit('Edit colour', () => ({ color: v })) });
    const metal = sliderField({ min: 0, max: 1, step: 0.01, digits: 2, ...this.grouped('Edit metalness'), onChange: (v) => matEdit('Edit metalness', () => ({ metalness: v })) });
    const rough = sliderField({ min: 0, max: 1, step: 0.01, digits: 2, ...this.grouped('Edit roughness'), onChange: (v) => matEdit('Edit roughness', () => ({ roughness: v })) });
    const opac = sliderField({ min: 0.05, max: 1, step: 0.01, digits: 2, ...this.grouped('Edit opacity'), onChange: (v) => matEdit('Edit opacity', () => ({ opacity: v })) });
    out.push(section('Appearance', [
      row('Colour', bind(color, (b) => b.material.color)),
      row('Metalness', bind(metal, (b) => b.material.metalness)),
      row('Roughness', bind(rough, (b) => b.material.roughness)),
      row('Opacity', bind(opac, (b) => b.material.opacity)),
    ], { id: 'appearance', open: false }));

    // ---- live readout -------------------------------------------------------------------------
    if (live && !multi) out.push(this.liveBodySection(ids[0]));
    return out;
  }


  // ------------------------------------------------------------------------------------------
  // soft bodies
  // ------------------------------------------------------------------------------------------

  private softInspector(sel: SoftEntity[]): HTMLElement[] {
    const { app } = this;
    const ids = sel.map((e) => e.id);
    const multi = sel.length > 1;
    const cur = (): SoftEntity[] => ids.map((id) => app.store.soft(id)).filter((e): e is SoftEntity => !!e);
    const first = (): SoftEntity => cur()[0];
    const same = <T>(get: (e: SoftEntity) => T) => { const l = cur(); return !l.some((e) => JSON.stringify(get(e)) !== JSON.stringify(get(l[0]))); };
    const type = sel[0].type;
    const allSameType = sel.every((e) => e.type === type);
    const bind = <T>(f: Field<T>, get: (e: SoftEntity) => T) => {
      this.updaters.push(() => { if (cur().length) f.set(get(first()), multi && !same(get)); });
      return f.el;
    };
    const edit = (label: string, fn: (e: SoftEntity) => Partial<SoftEntity>) => this.edit<SoftEntity>(ids, label, fn);
    const out: HTMLElement[] = [this.header(sel)];

    // ---- transform ---------------------------------------------------------------------------
    if (!multi) {
      const id = ids[0];
      const pos = vec3Field({ step: 0.05, ...this.grouped('Move'), onChange: (v) => app.editor.setPose(id, v, first().rotation) });
      const rot = vec3Field({ step: 1, digits: 2, ...this.grouped('Rotate'), onChange: (v) => app.editor.setPose(id, first().position, qfromEuler([v[0] * DEG, v[1] * DEG, v[2] * DEG])) });
      this.updaters.push(() => {
        const e = first();
        pos.set(e.position);
        if (!(document.activeElement && (document.activeElement as HTMLElement).closest('.vec3') === rot.el)) {
          const eu = qtoEuler(e.rotation);
          rot.set([eu[0] * RAD, eu[1] * RAD, eu[2] * RAD]);
        }
      });
      const dim = (label: string, axis: number, min = 0.1) => {
        const f = numberField({ step: 0.05, min, unit: 'm', ...this.grouped('Resize'), onChange: (v) => edit('Resize', (e) => {
          const next: Vec3 = [...e.size] as Vec3;
          if (e.type === 'balloon') { next[0] = next[1] = next[2] = v; } else next[axis] = v;
          return { size: next };
        }) });
        this.updaters.push(() => f.set(first().size[axis]));
        return row(label, f.el);
      };
      const sizes = type === 'jelly' ? [dim('Width', 0), dim('Height', 1), dim('Depth', 2)]
        : type === 'balloon' ? [dim('Diameter', 0)]
        : type === 'cloth' ? [dim('Width', 0), dim('Depth', 2)]
        : [dim('Length', 0)];
      out.push(section('Transform', [rowStack('Position (m)', pos.el), rowStack('Rotation (°)', rot.el), ...sizes], { id: 'soft-transform' }));
    }

    // ---- soft-body parameters ----------------------------------------------------------------
    const resMax = { jelly: 8, balloon: 3, cloth: 28, cable: 80 }[type];
    const resMin = { jelly: 3, balloon: 1, cloth: 6, cable: 6 }[type];
    const res = sliderField({ min: resMin, max: resMax, step: 1, digits: 0, ...this.grouped('Resolution'), onChange: (v) => edit('Resolution', () => ({ resolution: Math.round(v) })) });
    const particles = h('span', { class: 'readout', style: { fontSize: '11.5px', color: 'var(--text-3)' } });
    this.updaters.push(() => {
      const e = first(); const n = e.resolution;
      const count = e.type === 'jelly' ? n ** 3 : e.type === 'cloth' ? n * n : e.type === 'cable' ? n : 10 * 4 ** (n - 1) * 2 + 2;
      particles.textContent = `≈ ${count} particles${count > 700 ? ' — heavy' : ''}`;
    });
    const mass = numberField({ step: 0.1, min: 0.01, unit: 'kg', digits: 2, ...this.grouped('Mass'), onChange: (v) => edit('Mass', () => ({ mass: v })) });
    const stiff = sliderField({ min: 3, max: 300, log: true, unit: 'Hz', digits: 0, ...this.grouped('Stiffness'), onChange: (v) => edit('Stiffness', () => ({ stiffness: Math.round(v) })) });
    const damp = sliderField({ min: 0, max: 1.5, step: 0.01, digits: 2, ...this.grouped('Damping'), onChange: (v) => edit('Damping', () => ({ damping: v })) });
    const pinOptions: { value: SoftPin; label: string }[] = !allSameType ? [{ value: 'none', label: 'Free' }]
      : type === 'cloth' ? [{ value: 'none', label: 'Free (falls)' }, { value: 'edge', label: 'Pin one edge' }, { value: 'corners', label: 'Pin two corners' }, { value: 'corners4', label: 'Pin all four corners' }]
      : type === 'cable' ? [{ value: 'ends', label: 'Pin both ends' }, { value: 'one-end', label: 'Pin one end' }, { value: 'none', label: 'Free' }]
      : [{ value: 'none', label: 'Free' }];
    const pin = selectField<SoftPin>({ options: pinOptions, onChange: (v) => edit('Pinning', () => ({ pin: v })) });
    const canTear = toggleField({ label: 'Can tear', onChange: (v) => edit('Toggle tearing', (e) => ({ tearStrain: v ? (e.tearStrain > 0 ? e.tearStrain : 0.3) : 0 })) });
    const tear = sliderField({ min: 0.05, max: 1.5, step: 0.01, digits: 2, ...this.grouped('Tear strain'), onChange: (v) => edit('Tear strain', () => ({ tearStrain: v })) });
    const tearRow = row('Tear strain', tear.el, 'Edges tear when stretched beyond this fraction of their rest length');
    const selfC = toggleField({ label: 'Self-collisions (slower)', onChange: (v) => edit('Self-collision', () => ({ selfCollide: v })) });
    const grav = numberField({ step: 0.1, digits: 2, ...this.grouped('Gravity scale'), onChange: (v) => edit('Gravity scale', () => ({ gravityScale: v })) });
    const damping = numberField({ step: 0.01, min: 0, digits: 3, unit: '1/s', ...this.grouped('Air drag'), onChange: (v) => edit('Air drag', () => ({ linearDamping: v })) });
    this.updaters.push(() => {
      const e = first();
      res.set(e.resolution); mass.set(e.mass); stiff.set(e.stiffness); damp.set(e.damping);
      if (allSameType) pin.set(e.pin);
      canTear.set(e.tearStrain > 0, multi && !same((x) => x.tearStrain > 0));
      if (e.tearStrain > 0) tear.set(e.tearStrain);
      tearRow.style.display = e.tearStrain > 0 ? '' : 'none';
      selfC.set(e.selfCollide); grav.set(e.gravityScale); damping.set(e.linearDamping);
    });
    const pinRow = type === 'jelly' || type === 'balloon' ? [] : [row('Pinning', pin.el, 'Pinned particles are fixed in space')];
    out.push(section('Soft body', [
      row('Resolution', res.el, 'Particles per side / per cable. More looks smoother but costs more'), h('div', { style: { padding: '0 0 4px 100px' } }, particles),
      row('Mass', mass.el), row('Stiffness', stiff.el, 'Natural frequency of the material: ~7 Hz is very squishy, 40+ Hz nearly rigid'), row('Damping', damp.el, '0 = bouncy, 1 = heavily damped'),
      ...pinRow,
      canTear.el, tearRow,
      ...(type === 'cable' ? [] : [selfC.el]),
      row('Gravity scale', grav.el), row('Air drag', damping.el),
      h('p', { class: 'hint-text' }, 'Soft bodies are simulated as lattices of particles by the engine’s soft-body solver; drag them with the mouse while running. Changing a parameter while running rebuilds the soft body at its starting pose.'),
    ], { id: 'soft-body' }));

    // ---- appearance --------------------------------------------------------------------------
    const color = colorField({ ...this.grouped('Edit colour'), onChange: (v) => edit('Edit colour', () => ({ color: v })) });
    const rough = sliderField({ min: 0, max: 1, step: 0.01, digits: 2, ...this.grouped('Edit roughness'), onChange: (v) => edit('Edit roughness', () => ({ roughness: v })) });
    const opac = sliderField({ min: 0.05, max: 1, step: 0.01, digits: 2, ...this.grouped('Edit opacity'), onChange: (v) => edit('Edit opacity', () => ({ opacity: v })) });
    out.push(section('Appearance', [
      row('Colour', bind(color, (e) => e.color)), row('Roughness', bind(rough, (e) => e.roughness)), row('Opacity', bind(opac, (e) => e.opacity)),
    ], { id: 'soft-appearance', open: false }));

    // ---- live --------------------------------------------------------------------------------
    if (app.sim.active && !multi) {
      const dl = h('dl', { class: 'readout' });
      const r: Record<string, HTMLElement> = {};
      for (const [k, label] of [['particles', 'Particles'], ['pieces', 'Extent'], ['low', 'Lowest point'], ['high', 'Highest point']] as const) { const dd = h('dd', null, '—'); r[k] = dd; dl.append(h('dt', null, label), dd); }
      this.live.push(() => {
        const pos = app.sim.client.softOf(ids[0]);
        if (!pos || !pos.length) return;
        let lo = Infinity, hi = -Infinity, xl = Infinity, xh = -Infinity, zl = Infinity, zh = -Infinity;
        for (let i = 0; i < pos.length; i += 3) { xl = Math.min(xl, pos[i]); xh = Math.max(xh, pos[i]); lo = Math.min(lo, pos[i + 1]); hi = Math.max(hi, pos[i + 1]); zl = Math.min(zl, pos[i + 2]); zh = Math.max(zh, pos[i + 2]); }
        r.particles.textContent = String(pos.length / 3);
        r.pieces.textContent = `${fmt(xh - xl, 2)} × ${fmt(hi - lo, 2)} × ${fmt(zh - zl, 2)} m`;
        r.low.textContent = `${fmt(lo, 3)} m`;
        r.high.textContent = `${fmt(hi, 3)} m`;
      });
      out.push(section('Live', [dl], { id: 'live', badge: 'LIVE' }));
    }
    return out;
  }

  private sizeFields(id: string): HTMLElement[] {
    const { app } = this;
    const get = () => app.store.body(id);
    const type = get()!.shape.type;
    const setSize = (axis: number, v: number) => {
      const b = get(); if (!b) return;
      const next: Vec3 = [...b.shape.size] as Vec3;
      next[axis] = v;
      if ((type === 'cylinder' || type === 'cone' || type === 'capsule') && axis === 2) next[0] = v;
      if (type === 'sphere') { next[0] = next[1] = next[2] = v; }
      app.store.update(id, { shape: { ...b.shape, size: normalizeSize(type, next, b.shape.size) } } as Partial<BodyEntity>, 'Resize');
    };
    const mk = (label: string, axis: number, hint?: string) => {
      const f = numberField({ step: 0.05, min: 0.02, unit: 'm', ...this.grouped('Resize'), onChange: (v) => setSize(axis, v) });
      this.updaters.push(() => { const b = get(); if (b) f.set(b.shape.size[axis]); });
      return row(label, f.el, hint);
    };
    const rows: HTMLElement[] = [];
    switch (type) {
      case 'sphere': rows.push(mk('Diameter', 0)); break;
      case 'cylinder': case 'cone': case 'capsule': rows.push(mk('Diameter', 0), mk('Height', 1)); break;
      case 'prism': {
        rows.push(mk('Width', 0), mk('Height', 1), mk('Depth', 2));
        const sides = sliderField({ min: 3, max: 32, step: 1, digits: 0, ...this.grouped('Prism sides'), onChange: (v) => { const b = get(); if (b) app.store.update(id, { shape: { ...b.shape, sides: Math.round(v) } } as Partial<BodyEntity>, 'Prism sides'); } });
        this.updaters.push(() => { const b = get(); if (b) sides.set(b.shape.sides ?? 6); });
        rows.push(row('Sides', sides.el));
        break;
      }
      default: rows.push(mk('Width', 0), mk('Height', 1), mk('Depth', 2));
    }
    rows.unshift(row('Shape', h('span', { class: 'readout' }, SHAPE_LABELS[type])));
    return rows;
  }

  private thrustSection(ids: string[], cur: () => BodyEntity[], mixed: <T>(g: (b: BodyEntity) => T) => boolean): HTMLElement {
    const { app } = this;
    const first = () => cur()[0];
    const wrap = h('div');
    const enabled = toggleField({ label: 'Apply a force / torque (thruster, fan, rocket)', onChange: (v) => this.edit<BodyEntity>(ids, 'Toggle thruster', (b) => ({
      thrust: v ? (b.thrust ?? { force: [0, 40 * Math.max(1, app.sim.client.info.mass[b.id] ?? 20), 0], torque: [0, 0, 0], mode: 'always', key: '' }) : null,
    })) });
    const setT = (fn: (t: NonNullable<BodyEntity['thrust']>) => Partial<NonNullable<BodyEntity['thrust']>>, label: string) =>
      this.edit<BodyEntity>(ids, label, (b) => (b.thrust ? { thrust: { ...b.thrust, ...fn(b.thrust) } } : {}));
    const force = vec3Field({ step: 10, unit: 'N', digits: 1, ...this.grouped('Edit thrust'), onChange: (v) => setT(() => ({ force: v }), 'Edit thrust') });
    const torque = vec3Field({ step: 5, unit: 'N·m', digits: 1, ...this.grouped('Edit torque'), onChange: (v) => setT(() => ({ torque: v }), 'Edit torque') });
    const mode = segmented<'always' | 'key'>({ options: [{ value: 'always', label: 'Always on' }, { value: 'key', label: 'While key held' }], onChange: (v) => setT(() => ({ mode: v }), 'Thrust mode') });
    const key = keyField({ onChange: (c) => setT(() => ({ key: c, mode: c ? 'key' : 'always' }), 'Thrust key'), placeholder: 'Pick key' });
    const details = h('div', null,
      h('p', { class: 'hint-text' }, 'Force and torque act in the body’s local frame, every simulation step, at its centre of mass.'),
      rowStack('Force (N, local)', force.el), rowStack('Torque (N·m, local)', torque.el), rowStack('Trigger', mode.el), row('Key', key.el));
    this.updaters.push(() => {
      const b = first();
      enabled.set(!!b.thrust, mixed((x) => !!x.thrust));
      details.style.display = b.thrust ? '' : 'none';
      if (b.thrust) { force.set(b.thrust.force); torque.set(b.thrust.torque); mode.set(b.thrust.mode); key.set(b.thrust.key); }
    });
    wrap.append(enabled.el, details);
    return section('Forces', [wrap], { id: 'forces', open: false });
  }

  private liveBodySection(id: string): HTMLElement {
    const { app } = this;
    const dl = h('dl', { class: 'readout' });
    const rows: Record<string, HTMLElement> = {};
    for (const [k, label] of [['state', 'State'], ['pos', 'Height'], ['speed', 'Speed'], ['vel', 'Velocity'], ['ang', 'Spin'], ['ke', 'Kinetic energy'], ['mom', 'Momentum'], ['force', 'Net force'], ['accel', 'Acceleration']] as const) {
      const dd = h('dd', null, '—');
      rows[k] = dd;
      dl.append(h('dt', null, label), dd);
    }
    this.live.push(() => {
      const b = app.liveBody(id);
      const pose = app.sim.poseOf(id);
      if (!b || !pose) return;
      const v = vlen(b.vel);
      rows.state.textContent = b.state === 2 ? 'fell out of world' : b.state === 1 ? 'asleep' : 'awake';
      rows.pos.textContent = `${fmt(pose.position[1], 3)} m`;
      rows.speed.textContent = `${fmt(v, 3)} m/s`;
      rows.vel.textContent = b.vel.map((x) => fmt(x, 2)).join(', ');
      rows.ang.textContent = `${fmt(vlen(b.ang), 3)} rad/s`;
      rows.ke.textContent = `${fmt(b.ke, 2)} J`;
      rows.mom.textContent = `${fmt(v * b.mass, 2)} kg·m/s`;
      rows.force.textContent = `${fmt(vlen(b.force), 1)} N`;
      rows.accel.textContent = b.mass > 0 ? `${fmt(vlen(b.force) / b.mass, 2)} m/s² (${fmt(vlen(b.force) / b.mass / 9.81, 2)} g)` : '—';
    });
    return section('Live', [dl], { id: 'live', badge: 'LIVE' });
  }

  // ------------------------------------------------------------------------------------------
  // joints
  // ------------------------------------------------------------------------------------------

  private jointInspector(j0: JointEntity): HTMLElement[] {
    const { app } = this;
    const id = j0.id;
    const get = () => app.store.joint(id)!;
    const out: HTMLElement[] = [this.header([j0])];
    const bind = <T>(f: Field<T>, g: (j: JointEntity) => T) => { this.updaters.push(() => { if (app.store.joint(id)) f.set(g(get())); }); return f.el; };
    const edit = (label: string, fn: (j: JointEntity) => Partial<JointEntity>) => app.store.update(id, fn(get()), label);
    const grouped = (label: string) => this.grouped(label);
    const isUnit = j0.type === 'hinge' || j0.type === 'slider';
    const isTether = j0.type === 'spring' || j0.type === 'rope';
    const unit = j0.type === 'hinge' ? '°' : 'm';
    const toUI = (v: number) => (j0.type === 'hinge' ? v * RAD : v);
    const fromUI = (v: number) => (j0.type === 'hinge' ? v * DEG : v);

    // ---- connection -----------------------------------------------------------------------------
    const nameOf = (bid: string | null) => (bid ? app.store.body(bid)?.name ?? '?' : 'World');
    const link = (side: 'A' | 'B') => {
      const b = h('button', { class: 'btn small', type: 'button', title: 'Select this body' });
      b.addEventListener('click', () => { const bid = side === 'A' ? get().bodyA : get().bodyB; if (bid) app.store.setSelection([bid]); });
      this.updaters.push(() => { const bid = side === 'A' ? get().bodyA : get().bodyB; b.textContent = nameOf(bid); b.disabled = !bid; });
      return b;
    };
    const swap = button('Swap A ↔ B', () => {
      const j = get();
      app.store.update(id, { bodyA: j.bodyB, bodyB: j.bodyA, anchorA: j.anchorB, anchorB: j.anchorA }, 'Swap joint ends');
    }, { cls: 'small', title: 'Swap which body is the parent. Anchors swap with it; for hinges / sliders re-check the axis.' });
    swap.disabled = !isTether;
    out.push(section('Connection', [
      row('Type', h('span', { class: 'readout' }, JOINT_TYPE_LABELS[j0.type])),
      row('Body A', link('A')), row('Body B', link('B')),
      isTether ? row('', swap) : h('span'),
      row('Collide', bind(toggleField({ label: 'Connected bodies collide', onChange: (v) => edit('Toggle joint collisions', () => ({ collideConnected: v })) }), (j) => j.collideConnected)),
    ], { id: 'joint-conn' }));

    // ---- anchors & axis -----------------------------------------------------------------------
    const anchorA = vec3Field({ step: 0.05, unit: 'm', ...grouped('Move joint anchor'), onChange: (v) => edit('Move joint anchor', () => ({ anchorA: v })) });
    const rows: HTMLElement[] = [
      h('p', { class: 'hint-text' }, j0.bodyA ? 'Anchor in body A’s local frame.' : 'Anchor in world coordinates.'),
      rowStack('Anchor A (m)', bind(anchorA, (j) => j.anchorA)),
    ];
    if (isTether) {
      const anchorB = vec3Field({ step: 0.05, unit: 'm', ...grouped('Move joint anchor'), onChange: (v) => edit('Move joint anchor', () => ({ anchorB: v })) });
      rows.push(rowStack('Anchor B (m)', bind(anchorB, (j) => j.anchorB)));
      const endSeg = segmented<'A' | 'B'>({ options: [{ value: 'A', label: 'End A' }, { value: 'B', label: 'End B' }], value: app.jointEnd, onChange: (v) => app.setJointEnd(v) });
      this.updaters.push(() => endSeg.set(app.jointEnd));
      rows.push(row('Gizmo end', endSeg.el, 'Which end the move gizmo drags'));
    }
    if (isUnit) {
      const axis = vec3Field({ step: 0.1, digits: 3, ...grouped('Edit axis'), onChange: (v) => { const l = vlen(v) || 1; edit('Edit axis', () => ({ axis: [v[0] / l, v[1] / l, v[2] / l] })); } });
      rows.push(rowStack('Axis (unit vector)', bind(axis, (j) => j.axis), 'Local to body A (world if A is the world)'));
      const axes = h('div', { class: 'chips' });
      for (const [label, w] of [['X', [1, 0, 0]], ['Y', [0, 1, 0]], ['Z', [0, 0, 1]]] as [string, Vec3][]) {
        const b = h('button', { class: 'chip', type: 'button', title: `Align the axis with world ${label}` }, `World ${label}`);
        b.addEventListener('click', () => edit('Set joint axis', (j) => ({ axis: app.editor.worldAxisToLocal(j.bodyA, w) })));
        axes.appendChild(b);
      }
      rows.push(row('Align to', axes));
    }
    out.push(section('Anchors', rows, { id: 'joint-anchor' }));

    // ---- limits -------------------------------------------------------------------------------
    if (isUnit) {
      const lim = toggleField({ label: 'Limit the range of motion', onChange: (v) => edit('Toggle limits', (j) => ({ limit: { ...j.limit, enabled: v } })) });
      const mn = numberField({ step: j0.type === 'hinge' ? 5 : 0.05, unit, digits: 2, ...grouped('Edit limit'), onChange: (v) => edit('Edit limit', (j) => ({ limit: { ...j.limit, min: fromUI(v) } })) });
      const mx = numberField({ step: j0.type === 'hinge' ? 5 : 0.05, unit, digits: 2, ...grouped('Edit limit'), onChange: (v) => edit('Edit limit', (j) => ({ limit: { ...j.limit, max: fromUI(v) } })) });
      this.updaters.push(() => { const j = get(); lim.set(j.limit.enabled); mn.set(toUI(j.limit.min)); mx.set(toUI(j.limit.max)); });
      out.push(section('Limits', [lim.el, h('p', { class: 'hint-text' }, `Measured from the pose when the simulation starts (positive ${j0.type === 'hinge' ? 'rotation follows the right-hand rule about the axis' : 'travel is along the axis'}).`), row('Min', mn.el), row('Max', mx.el)], { id: 'joint-limits' }));
      out.push(this.motorSection(id, j0.type));
    }

    // ---- spring / rope ------------------------------------------------------------------------
    if (j0.type === 'spring') {
      const setS = (label: string, p: Partial<JointEntity['spring']>) => edit(label, (j) => ({ spring: { ...j.spring, ...p } }));
      const rest = numberField({ step: 0.05, min: 0, unit: 'm', ...grouped('Edit rest length'), onChange: (v) => setS('Edit rest length', { restLength: v }) });
      const k = sliderField({ min: 1, max: 1e6, log: true, unit: 'N/m', digits: 0, ...grouped('Edit stiffness'), onChange: (v) => setS('Edit stiffness', { stiffness: Math.round(v) }) });
      const c = sliderField({ min: 0.01, max: 1e5, log: true, unit: 'N·s/m', digits: 2, ...grouped('Edit damping'), onChange: (v) => setS('Edit damping', { damping: v }) });
      const br = numberField({ step: 100, min: 0, unit: 'N', digits: 0, ...grouped('Edit break force'), onChange: (v) => setS('Edit break force', { breakForce: v }) });
      this.updaters.push(() => { const s = get().spring; rest.set(s.restLength); k.set(s.stiffness); c.set(Math.max(0.01, s.damping)); br.set(s.breakForce); });
      const crit = h('span', { class: 'readout', style: { fontSize: '11.5px', color: 'var(--text-3)' } });
      this.updaters.push(() => {
        const s = get().spring;
        const ma = get().bodyB ? app.sim.client.info.mass[get().bodyB!] ?? 0 : 0;
        crit.textContent = ma > 0 ? `Critical damping ≈ ${fmt(2 * Math.sqrt(s.stiffness * ma), 1)} N·s/m · period ≈ ${fmt((2 * Math.PI) * Math.sqrt(ma / s.stiffness), 2)} s` : '';
      });
      out.push(section('Spring', [
        row('Rest length', rest.el), row('Stiffness k', k.el), row('Damping c', c.el), crit,
        row('Break force', br.el, 'The spring snaps when its force exceeds this. 0 = unbreakable'),
        h('p', { class: 'hint-text' }, 'Force = k·(length − rest) + c·(relative speed). Very stiff springs act like rigid struts and can be used to build trusses; give them a break force to make them fail.'),
      ], { id: 'joint-spring' }));
    }
    if (j0.type === 'rope') {
      const len = numberField({ step: 0.05, min: 0.05, unit: 'm', ...grouped('Edit rope length'), onChange: (v) => edit('Edit rope length', () => ({ ropeLength: v })) });
      this.updaters.push(() => len.set(get().ropeLength));
      out.push(section('Rope', [row('Max length', len.el, 'The ends can come closer, but never further apart than this'),
        button('Match current distance', () => {
          const f = app.joints.frameOf(get(), { a: new Vector3(), b: new Vector3(), axis: new Vector3() });
          if (f) edit('Rope length', () => ({ ropeLength: Math.max(0.05, f.a.distanceTo(f.b)) }));
        }, { cls: 'small' })], { id: 'joint-rope' }));
    }

    // ---- live ---------------------------------------------------------------------------------
    if (app.sim.active) {
      const dl = h('dl', { class: 'readout' });
      const r: Record<string, HTMLElement> = {};
      const defs: [string, string][] = j0.type === 'hinge' ? [['value', 'Angle'], ['speed', 'Speed']]
        : j0.type === 'slider' ? [['value', 'Position'], ['speed', 'Speed']]
        : j0.type === 'spring' ? [['value', 'Length'], ['speed', 'Rate'], ['force', 'Force']]
        : j0.type === 'rope' ? [['value', 'Distance']] : [];
      for (const [k, label] of defs) { const dd = h('dd', null, '—'); r[k] = dd; dl.append(h('dt', null, label), dd); }
      this.live.push(() => {
        const s = app.liveJoint(id);
        if (!s) return;
        if (s.broken) { for (const k of Object.keys(r)) r[k].textContent = 'broken'; return; }
        if (r.value) r.value.textContent = j0.type === 'hinge' ? `${fmt(s.value * RAD, 1)}°` : `${fmt(s.value, 3)} m`;
        if (r.speed) r.speed.textContent = j0.type === 'hinge' ? `${fmt(s.speed, 2)} rad/s (${fmt((s.speed * 60) / (2 * Math.PI), 1)} rpm)` : `${fmt(s.speed, 3)} m/s`;
        if (r.force) r.force.textContent = `${fmt(s.force, 1)} N ${s.force > 0 ? '(tension)' : '(compression)'}`;
      });
      if (defs.length) out.push(section('Live', [dl], { id: 'live', badge: 'LIVE' }));
    }
    return out;
  }

  private motorSection(id: string, type: 'hinge' | 'slider' | string): HTMLElement {
    const { app } = this;
    const get = () => app.store.joint(id)!;
    const hinge = type === 'hinge';
    const uv = hinge ? 'rad/s' : 'm/s';
    const up = hinge ? '°' : 'm';
    const setM = (label: string, p: Partial<JointEntity['motor']>) => app.store.update(id, { motor: { ...get().motor, ...p } } as Partial<JointEntity>, label);
    const mode = segmented<MotorMode>({
      options: [
        { value: 'off', label: 'Off', title: 'Joint moves freely' },
        { value: 'velocity', label: 'Velocity', title: 'Drive toward a target speed (wheels, conveyors, winches)' },
        { value: 'position', label: 'Position', title: 'Spring toward a target position (servos, suspension, steering)' },
      ],
      onChange: (v) => setM('Motor mode', { mode: v }),
    });
    const tv = numberField({ step: 0.5, unit: uv, digits: 2, ...this.grouped('Edit motor'), onChange: (v) => setM('Edit motor', { targetVelocity: v }) });
    const tp = numberField({ step: hinge ? 5 : 0.05, unit: up, digits: 2, ...this.grouped('Edit motor'), onChange: (v) => setM('Edit motor', { targetPosition: hinge ? v * DEG : v }) });
    const stiff = sliderField({ min: 1, max: 1e7, log: true, unit: hinge ? 'N·m/rad' : 'N/m', digits: 0, ...this.grouped('Edit motor'), onChange: (v) => setM('Edit motor', { stiffness: Math.round(v) }) });
    const damp = sliderField({ min: 0.1, max: 1e6, log: true, unit: hinge ? 'N·m·s/rad' : 'N·s/m', digits: 1, ...this.grouped('Edit motor'), onChange: (v) => setM('Edit motor', { damping: v }) });
    const maxF = sliderField({ min: 1, max: 1e7, log: true, unit: hinge ? 'N·m' : 'N', digits: 0, ...this.grouped('Edit motor'), onChange: (v) => setM('Edit motor', { maxForce: Math.round(v) }) });
    const kp = keyField({ onChange: (c) => setM('Motor key', { keyPos: c }), placeholder: 'None' });
    const kn = keyField({ onChange: (c) => setM('Motor key', { keyNeg: c }), placeholder: 'None' });
    const slew = numberField({ step: 0.5, min: 0, unit: hinge ? 'rad/s' : 'm/s', digits: 2, ...this.grouped('Edit motor'), onChange: (v) => setM('Edit motor', { slewRate: v }) });
    const brake = toggleField({ label: 'Hold position when no key is pressed', onChange: (v) => setM('Motor brake', { brake: v }) });

    const rowVel = row('Target speed', tv.el, 'Speed reached at full input');
    const rowPos = row('Target', tp.el, 'With keys bound this is the deflection at full input');
    const rowStiff = row('Stiffness', stiff.el);
    const rowDamp = row('Damping', damp.el, 'Velocity mode: how hard it pushes toward the target speed');
    const rowSlew = row('Slew rate', slew.el, 'How fast the target moves while a key is held');
    const rowBrake = brake.el;
    this.updaters.push(() => {
      const m = get().motor;
      mode.set(m.mode);
      tv.set(m.targetVelocity); tp.set(hinge ? m.targetPosition * RAD : m.targetPosition);
      stiff.set(m.stiffness); damp.set(m.damping); maxF.set(m.maxForce);
      kp.set(m.keyPos); kn.set(m.keyNeg); slew.set(m.slewRate); brake.set(m.brake);
      const off = m.mode === 'off';
      rowVel.style.display = m.mode === 'velocity' ? '' : 'none';
      rowPos.style.display = m.mode === 'position' ? '' : 'none';
      rowStiff.style.display = m.mode === 'position' ? '' : 'none';
      rowSlew.style.display = m.mode === 'position' ? '' : 'none';
      rowBrake.style.display = m.mode === 'velocity' ? '' : 'none';
      rowDamp.style.display = off ? 'none' : '';
      for (const el of [rowMax, rowKp, rowKn]) el.style.display = off ? 'none' : '';
    });
    const rowMax = row('Max force', maxF.el, 'Largest force / torque the motor can apply');
    const rowKp = row('Key (+)', kp.el, hinge ? 'Positive rotation follows the right-hand rule about the axis' : 'Positive = along the axis');
    const rowKn = row('Key (−)', kn.el);
    return section('Motor', [
      rowStack('Mode', mode.el), rowVel, rowPos, rowStiff, rowDamp, rowMax, rowKp, rowKn, rowSlew, rowBrake,
      h('p', { class: 'hint-text' }, 'Bind keys to drive the motor while the simulation runs: velocity mode for wheels and winches, position mode for steering and servos. Without keys the motor is always on.'),
    ], { id: 'joint-motor' });
  }
}
