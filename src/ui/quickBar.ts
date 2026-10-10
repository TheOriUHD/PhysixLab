/**
 * The quick-properties bar (UI-2): a compact strip at the bottom of the viewport for the selection — name, type,
 * mass, material, and the key actions (lock, hide, duplicate, delete, open the inspector). It edits through the
 * store, so every change is undoable and the inspector shows the same values.
 */
import type { App } from '../app/app';
import { massEstimate } from '../model/compound';
import { MATERIAL_PRESETS, PRESET_BY_ID } from '../model/materials';
import type { BodyEntity, Entity } from '../model/types';
import { isBody, isJoint } from '../model/types';
import { numberField, selectField, segmented, fmt } from './controls';
import { h } from './dom';
import { icon } from './icons';

const KEY = 'physicslab:quickbar';
const listeners = new Set<() => void>();
export function quickBarEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}
export function setQuickBarEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
  listeners.forEach((f) => f());
}

export function mountQuickBar(app: App, host: HTMLElement): HTMLElement {
  const { store, editor } = app;
  const root = h('div', { class: 'quickbar floating', role: 'toolbar', 'aria-label': 'Quick properties' });
  root.style.display = 'none';
  host.appendChild(root);
  // Typing in the bar must not trigger the editor shortcuts.
  root.addEventListener('keydown', (e) => e.stopPropagation());

  let builtFor = '';
  const sel = (): Entity[] => store.selection.map((id) => store.get(id)).filter((e): e is Entity => !!e);
  const edit = (label: string, fn: (b: BodyEntity) => Partial<BodyEntity>) => {
    const ids = sel()
      .filter(isBody)
      .map((b) => b.id);
    store.updateMany(
      ids.map((id) => [id, fn(store.get(id) as BodyEntity)] as [string, Partial<Entity>]),
      label,
    );
  };
  let refreshers: (() => void)[] = [];

  const btn = (ic: string, title: string, fn: () => void): HTMLButtonElement => {
    const b = h('button', { class: 'icon-btn', type: 'button', title, 'aria-label': title }, icon(ic));
    b.addEventListener('click', fn);
    return b;
  };

  const build = (s: Entity[]) => {
    refreshers = [];
    const ids = s.map((e) => e.id);
    const bodies = s.filter(isBody);
    const kids: HTMLElement[] = [];
    const first = s[0];
    kids.push(
      h(
        'span',
        { class: 'qb-name', title: s.length > 1 ? `${s.length} objects selected` : first.name },
        s.length > 1 ? `${s.length} objects` : first.name,
      ),
    );
    if (bodies.length === s.length) {
      const type = segmented<BodyEntity['bodyType']>({
        compact: true,
        options: [
          { value: 'dynamic', label: 'Dynamic', title: 'Moves under physics' },
          { value: 'static', label: 'Static', title: 'Never moves' },
          { value: 'kinematic', label: 'Kinematic', title: 'Moves along a scripted path' },
        ],
        onChange: (v) => edit(`Set ${v}`, () => ({ bodyType: v })),
      });
      kids.push(type.el);
      refreshers.push(() => {
        const t = new Set(
          sel()
            .filter(isBody)
            .map((b) => b.bodyType),
        );
        if (t.size === 1) type.set([...t][0]);
        else type.buttons.forEach((b) => b.classList.remove('on'));
      });
      const mass = numberField({
        label: 'm',
        unit: 'kg',
        step: 0.1,
        min: 0.001,
        digits: 3,
        title: 'Mass (kg). Typing a value overrides density × volume.',
        onChange: (v) => edit('Set mass', () => ({ massOverride: v })),
        onStart: () => store.begin('Set mass'),
        onEnd: () => store.end(),
      });
      const massWrap = h('div', { class: 'qb-field qb-mass' }, mass.el);
      kids.push(massWrap);
      refreshers.push(() => {
        const bs = sel().filter(isBody);
        const dyn = bs.filter((b) => b.bodyType === 'dynamic');
        massWrap.style.display = dyn.length ? '' : 'none';
        const ms = dyn.map((b) => massEstimate(b));
        if (!ms.length) return;
        const live = app.sim.client.active ? dyn.map((b) => app.sim.client.info.mass[b.id] ?? massEstimate(b)) : ms;
        const same = live.every((m) => Math.abs(m - (live[0])) < 1e-9);
        if (document.activeElement?.closest('.qb-mass')) return;
        mass.set(live[0], !same);
        massWrap.title = `Mass ${fmt(live[0], 3)} kg`;
      });
      const mat = selectField<string>({
        options: [
          ...MATERIAL_PRESETS.map((p) => ({ value: p.id, label: p.label })),
          { value: 'custom', label: 'Custom' },
        ],
        onChange: (v) => {
          const p = PRESET_BY_ID.get(v);
          if (!p) return;
          edit(`Material: ${p.label}`, () => ({
            material: {
              preset: p.id,
              density: p.density,
              friction: p.friction,
              restitution: p.restitution,
              color: p.color,
              metalness: p.metalness,
              roughness: p.roughness,
              opacity: p.opacity,
            },
          }));
        },
      });
      kids.push(h('div', { class: 'qb-field qb-mat', title: 'Material' }, mat.el));
      refreshers.push(() => {
        const m = new Set(
          sel()
            .filter(isBody)
            .map((b) => b.material.preset),
        );
        if (m.size === 1) mat.set([...m][0]);
        else mat.set('custom', true);
      });
    }
    kids.push(h('span', { class: 'qb-sep' }));
    const nonJoint = s.filter((e) => !isJoint(e));
    const lock = btn('unlock', 'Lock (L)', () => editor.toggleFlag(ids, 'locked'));
    lock.style.display = nonJoint.length ? '' : 'none';
    const hide = btn('eye', 'Hide (H)', () => editor.toggleFlag(ids, 'hidden'));
    refreshers.push(() => {
      const cur = sel();
      const locked = cur.filter((e) => !isJoint(e)).every((e) => e.locked);
      lock.replaceChildren(icon(locked ? 'lock' : 'unlock'));
      lock.classList.toggle('on', locked);
      hide.replaceChildren(icon(cur.every((e) => e.hidden) ? 'eyeOff' : 'eye'));
    });
    kids.push(
      lock,
      hide,
      btn('copy', 'Duplicate (Ctrl+D)', () => editor.duplicateSelection()),
      btn('trash', 'Delete (Del)', () => editor.deleteSelection()),
      btn('frame', 'Frame selection (F)', () => app.frameSelection()),
    );
    root.replaceChildren(...kids);
  };

  const refresh = () => {
    const s = sel();
    const on = quickBarEnabled() && s.length > 0;
    root.style.display = on ? '' : 'none';
    if (!on) {
      builtFor = '';
      return;
    }
    const key = `${s.map((e) => e.id).join(',')}:${s.map((e) => e.kind + (isBody(e) ? e.bodyType : '')).join(',')}`;
    if (key !== builtFor) {
      builtFor = key;
      build(s);
    }
    const editable = app.sim.mode === 'edit';
    root.classList.toggle('qb-sim', !editable);
    refreshers.forEach((f) => f());
  };
  store.on('selection', refresh);
  store.on('change', refresh);
  app.sim.on('mode', () => {
    builtFor = '';
    refresh();
  });
  listeners.add(refresh);
  let lastLive = 0;
  app.on('frame', () => {
    const now = performance.now();
    if (now - lastLive > 200 && root.style.display !== 'none' && app.sim.client.active) {
      lastLive = now;
      refreshers.forEach((f) => f());
    }
  });
  refresh();
  return root;
}
