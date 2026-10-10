/**
 * ED-12: the parameter form of an array (kind tabs + the fields of the chosen kind). Shared by the Array panel
 * (new arrays, live preview) and the inspector section of a linked array (re-editing). It only edits an
 * `ArraySpec`; what happens with the spec is the caller's `onChange`.
 */
import {
  ARRAY_KINDS,
  ARRAY_KIND_LABELS,
  MAX_ARRAY_INSTANCES,
  defaultSpec,
  type ArrayKind,
  type ArraySpec,
} from '../model/edit/arraySpec';
import type { PathEntity } from '../model/types';
import { numberField, row, rowStack, segmented, selectField, toggleField, vec3Field, type Field } from './controls';
import { h } from './dom';

export interface ArrayFormOptions {
  spec: ArraySpec;
  /** Paths offered by the "Path" picker of an along-path array. */
  paths: () => PathEntity[];
  onChange: (spec: ArraySpec) => void;
  /** A kind tab was chosen. Default: switch to that kind's default parameters (and call `onChange`). */
  onKind?: (kind: ArrayKind) => void;
}

export interface ArrayForm {
  el: HTMLElement;
  /** Show `spec` (rebuilds the fields when its kind differs from the one shown). */
  sync(spec: ArraySpec): void;
}

const count = (
  label: string,
  value: number,
  onChange: (v: number) => void,
  title?: string,
  max = MAX_ARRAY_INSTANCES,
): Field<number> =>
  numberField({ label, value, step: 1, min: 1, max, digits: 0, onChange: (v) => onChange(Math.round(v)), title });

export function buildArrayForm(o: ArrayFormOptions): ArrayForm {
  let cur = o.spec;
  let setters: ((s: ArraySpec) => void)[] = [];
  const body = h('div', { class: 'ed-array-fields' });
  const emit = (next: ArraySpec) => {
    cur = next;
    o.onChange(cur);
  };

  const tabs = segmented<ArrayKind>({
    value: cur.kind,
    options: ARRAY_KINDS.map((k) => ({
      value: k,
      label: ARRAY_KIND_LABELS[k],
      title: {
        linear: 'Copies in a straight line',
        grid: 'Copies in a 1D, 2D or 3D grid',
        radial: 'Copies around an axis (full circle or an arc)',
        path: 'Copies at equal spacing along a path',
      }[k],
    })),
    onChange: (k) => {
      if (o.onKind) o.onKind(k);
      else emit(defaultSpec(k));
    },
  });
  tabs.el.classList.add('ed-array-tabs');

  const pathSignature = (): string =>
    o
      .paths()
      .map((x) => `${x.id}:${x.name}`)
      .join('|');
  let shownPaths = '';
  const render = () => {
    setters = [];
    shownPaths = pathSignature();
    const add = <T>(f: Field<T>, get: (s: ArraySpec) => T): HTMLElement => {
      setters.push((s) => f.set(get(s)));
      return f.el;
    };
    const rows: HTMLElement[] = [];
    const s = cur;
    switch (s.kind) {
      case 'linear': {
        const l = (): typeof s => cur as typeof s;
        rows.push(
          row(
            'Copies',
            add(
              count('', s.count, (v) => emit({ ...l(), count: v }), 'Total number of copies including the original'),
              (x) => (x as typeof s).count,
            ),
          ),
          rowStack(
            'Step',
            add(
              vec3Field({ step: 0.1, unit: 'm', onChange: (v) => emit({ ...l(), offset: v }) }),
              (x) => (x as typeof s).offset,
            ),
            'Distance between neighbouring copies (world axes, metres)',
          ),
          rowStack(
            'Turn per step',
            add(
              vec3Field({ step: 5, unit: '°', onChange: (v) => emit({ ...l(), stepRotation: v }) }),
              (x) => (x as typeof s).stepRotation,
            ),
            'Extra rotation of each copy relative to the previous one (degrees, about its own centre)',
          ),
          row(
            'Scale per step',
            add(
              numberField({
                value: s.stepScale,
                step: 0.05,
                min: 0.05,
                max: 20,
                digits: 3,
                onChange: (v) => emit({ ...l(), stepScale: v }),
                title: '1 = same size; 1.1 = each copy 10 % larger than the previous one',
              }),
              (x) => (x as typeof s).stepScale,
            ),
          ),
        );
        break;
      }
      case 'grid': {
        const g = (): typeof s => cur as typeof s;
        const axis = (i: 0 | 1 | 2, name: string) =>
          count(name, s.counts[i], (v) => {
            const counts = [...g().counts] as [number, number, number];
            counts[i] = v;
            emit({ ...g(), counts });
          });
        const fx = axis(0, 'X'),
          fy = axis(1, 'Y'),
          fz = axis(2, 'Z');
        setters.push((x) => {
          const c = (x as typeof s).counts;
          fx.set(c[0]);
          fy.set(c[1]);
          fz.set(c[2]);
        });
        rows.push(
          rowStack(
            'Copies per axis',
            h('div', { class: 'vec3' }, fx.el, fy.el, fz.el),
            'Cells along X, Y and Z including the original',
          ),
          rowStack(
            'Spacing',
            add(
              vec3Field({ step: 0.1, unit: 'm', onChange: (v) => emit({ ...g(), spacing: v }) }),
              (x) => (x as typeof s).spacing,
            ),
            'Distance between neighbouring cells',
          ),
        );
        break;
      }
      case 'radial': {
        const r = (): typeof s => cur as typeof s;
        rows.push(
          row(
            'Copies',
            add(
              count('', s.count, (v) => emit({ ...r(), count: v }), 'Total number of copies including the original'),
              (x) => (x as typeof s).count,
            ),
          ),
          row(
            'Angle',
            add(
              numberField({
                value: s.angle,
                step: 15,
                min: -3600,
                max: 3600,
                digits: 1,
                unit: '°',
                onChange: (v) => emit({ ...r(), angle: v }),
                title: '360° = full circle (no copy on top of the original); less = an arc with both ends occupied',
              }),
              (x) => (x as typeof s).angle,
            ),
          ),
          rowStack(
            'Axis',
            add(vec3Field({ step: 0.1, onChange: (v) => emit({ ...r(), axis: v }) }), (x) => (x as typeof s).axis),
            'Direction of the rotation axis (world)',
          ),
          rowStack(
            'Centre',
            add(
              vec3Field({ step: 0.1, unit: 'm', onChange: (v) => emit({ ...r(), center: v }) }),
              (x) => (x as typeof s).center,
            ),
            'A point on the axis (world)',
          ),
          row(
            'Turn with circle',
            add(
              toggleField({
                value: s.orient,
                onChange: (v) => emit({ ...r(), orient: v }),
                title: 'On: every copy is rotated about the axis (spokes). Off: copies keep the original orientation',
              }),
              (x) => (x as typeof s).orient,
            ),
          ),
        );
        break;
      }
      case 'path': {
        const p = (): typeof s => cur as typeof s;
        const paths = o.paths();
        const options = [
          { value: '', label: paths.length ? '— choose a path —' : '— no path in the scene —' },
          ...paths.map((x) => ({ value: x.id, label: x.name })),
        ];
        const sel = selectField<string>({ options, value: s.pathId, onChange: (v) => emit({ ...p(), pathId: v }) });
        rows.push(
          row(
            'Path',
            add(sel, (x) => (x as typeof s).pathId),
          ),
          row(
            'Copies',
            add(
              count(
                '',
                s.count,
                (v) => emit({ ...p(), count: v }),
                'Number of copies placed on the path (the original stays where it is)',
              ),
              (x) => (x as typeof s).count,
            ),
          ),
          row(
            'Face along path',
            add(
              toggleField({
                value: s.orient,
                onChange: (v) => emit({ ...p(), orient: v }),
                title: "Turn every copy so the original's forward axis follows the path",
              }),
              (x) => (x as typeof s).orient,
            ),
          ),
          row(
            'Forward axis',
            add(
              selectField<'x' | 'y' | 'z'>({
                options: [
                  { value: 'x', label: 'X' },
                  { value: 'y', label: 'Y' },
                  { value: 'z', label: 'Z' },
                ],
                value: s.forward,
                onChange: (v) => emit({ ...p(), forward: v }),
              }),
              (x) => (x as typeof s).forward,
            ),
          ),
          rowStack(
            'Offset',
            add(
              vec3Field({ step: 0.1, unit: 'm', onChange: (v) => emit({ ...p(), offset: v }) }),
              (x) => (x as typeof s).offset,
            ),
            'Shift from the path (in the path-aligned frame when copies face along the path)',
          ),
        );
        break;
      }
    }
    body.replaceChildren(...rows);
    setters.forEach((set) => set(cur));
  };

  const el = h('div', { class: 'ed-array-form' }, tabs.el, body);
  render();
  return {
    el,
    sync(spec) {
      const rebuild = spec.kind !== cur.kind || (spec.kind === 'path' && pathSignature() !== shownPaths);
      cur = spec;
      tabs.set(spec.kind);
      if (rebuild) render();
      else setters.forEach((set) => set(cur));
    },
  };
}
