/**
 * ED-22 — dialogs of the user prefab library: save selection, edit (name, tags, variables, variants, nested
 * prefabs), insert with values, export pack, import pack. Plain DOM on top of `openModal`; every action goes
 * through `PrefabLibrary` / `prefabActions` so the dialogs hold no logic of their own beyond form handling.
 */
import type { App } from '../../app/app';
import { insertUserPrefab, prefabLibrary, saveSelectionAsPrefab } from '../../app/edit/prefabActions';
import {
  PREFAB_LIMITS,
  PrefabPackError,
  cleanTags,
  nestingProblem,
  resolveVariableValues,
  yawQuat,
  type BindProp,
  type NestedRef,
  type PrefabVariable,
  type PrefabVariant,
  type StoredPrefab,
  type VariableKind,
  type VariableValue,
} from '../../model/edit/userPrefab';
import { uid } from '../../model/factory';
import { formatBytes } from '../../model/limits';
import { MATERIAL_PRESETS } from '../../model/materials';
import { isBody, isSoft } from '../../model/types';
import { clear, h } from '../dom';
import { openModal } from '../modal';

const PROP_LABELS: Record<BindProp, string> = {
  scale: 'Scale',
  'size.x': 'Width (x)',
  'size.y': 'Height (y)',
  'size.z': 'Depth (z)',
  material: 'Material',
  color: 'Colour',
};
const PROPS_OF: Record<VariableKind, BindProp[]> = {
  number: ['scale', 'size.x', 'size.y', 'size.z'],
  material: ['material'],
  color: ['color'],
};

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function textInput(value: string, placeholder = ''): HTMLInputElement {
  const i = h('input', { type: 'text', class: 'plain', value, placeholder, spellcheck: false });
  i.addEventListener('keydown', (e) => e.stopPropagation());
  return i;
}

function numInput(
  value: number | undefined,
  o: { min?: number; max?: number; step?: number; placeholder?: string } = {},
) {
  const i = h('input', {
    type: 'number',
    class: 'plain ed-pf-num',
    value: value === undefined ? '' : String(value),
    step: o.step ?? 'any',
    placeholder: o.placeholder ?? '',
  });
  if (o.min !== undefined) i.min = String(o.min);
  if (o.max !== undefined) i.max = String(o.max);
  i.addEventListener('keydown', (e) => e.stopPropagation());
  return i;
}

function select<T extends string>(options: [T, string][], value: T): HTMLSelectElement {
  const s = h('select', { class: 'ed-pf-select' });
  for (const [v, label] of options) s.appendChild(h('option', { value: v }, label));
  s.value = value;
  return s;
}

const parseTags = (s: string): string[] => cleanTags(s.split(','));
const optNum = (i: HTMLInputElement): number | undefined => (i.value.trim() === '' ? undefined : Number(i.value));

// ── save ────────────────────────────────────────────────────────────────────────────────────────────

/** Ask for a name and tags, then store the selection as a prefab. */
export function saveSelectionDialog(app: App): Promise<StoredPrefab | null> {
  return new Promise((resolve) => {
    const first = app.store.get(app.store.selection[0] ?? '');
    const name = textInput(app.store.selection.length === 1 && first ? first.name : 'My prefab');
    const tags = textInput('', 'e.g. furniture, wood');
    const count = app.store.selection.length;
    let done = false;
    const finish = (v: StoredPrefab | null) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    const ok = h('button', { class: 'btn primary', type: 'button' }, 'Save prefab');
    const cancel = h('button', { class: 'btn', type: 'button' }, 'Cancel');
    const submit = async () => {
      if (!name.value.trim()) return name.focus();
      ok.disabled = true;
      finish(await saveSelectionAsPrefab(app, name.value, parseTags(tags.value)));
    };
    ok.addEventListener('click', () => void submit());
    cancel.addEventListener('click', () => finish(null));
    for (const i of [name, tags]) i.addEventListener('keydown', (e) => e.key === 'Enter' && void submit());
    const m = openModal({
      title: 'Save selection as prefab',
      width: '440px',
      body: [
        h(
          'p',
          { class: 'sub', style: { marginBottom: '10px' } },
          `${count} selected object${count === 1 ? '' : 's'} (with group members and the joints between them) become a reusable prefab in “My prefabs”.`,
        ),
        h('label', { class: 'ed-pf-label' }, 'Name'),
        name,
        h('label', { class: 'ed-pf-label' }, 'Tags (comma separated)'),
        tags,
      ],
      footer: [cancel, ok],
      onClose: () => finish(null),
    });
    setTimeout(() => {
      name.focus();
      name.select();
    }, 30);
  });
}

// ── insert with values ──────────────────────────────────────────────────────────────────────────────

/** Choose a variant, variable values and a rotation, then insert. */
export function insertWithValuesDialog(app: App, id: string, variantId?: string): void {
  const lib = prefabLibrary(app);
  const p = lib.get(id);
  if (!p) return;
  const variantSel = select<string>(
    [['', 'Base prefab'], ...p.variants.map((v): [string, string] => [v.id, v.name])],
    variantId ?? '',
  );
  const values: Record<string, VariableValue> = {};
  const fields = h('div', { class: 'ed-pf-fields' });
  const rot = numInput(0, { step: 15 });
  const renderFields = () => {
    clear(fields);
    const variant = p.variants.find((v) => v.id === variantSel.value);
    const start = resolveVariableValues(p.variables, variant?.overrides.variableValues);
    for (const v of p.variables) {
      values[v.name] = start[v.name];
      let control: HTMLElement;
      if (v.kind === 'number') {
        const num = numInput(Number(start[v.name]), { min: v.min, max: v.max, step: 0.1 });
        const range = h('input', { type: 'range', class: 'ed-pf-range', step: 'any' });
        range.min = String(v.min ?? 0);
        range.max = String(v.max ?? Math.max(10, Number(v.default) * 4));
        range.value = num.value;
        const set = (x: string) => {
          const n = Number(x);
          if (Number.isFinite(n)) values[v.name] = n;
        };
        range.addEventListener('input', () => {
          num.value = range.value;
          set(range.value);
        });
        num.addEventListener('input', () => {
          range.value = num.value;
          set(num.value);
        });
        control = h('div', { class: 'ed-pf-pair' }, range, num);
      } else if (v.kind === 'material') {
        const s = select<string>(
          MATERIAL_PRESETS.map((m): [string, string] => [m.id, m.label]),
          String(start[v.name]),
        );
        s.addEventListener('change', () => (values[v.name] = s.value));
        control = s;
      } else {
        const c = h('input', { type: 'color', class: 'ed-pf-color', value: String(start[v.name]).slice(0, 7) });
        c.addEventListener('input', () => (values[v.name] = c.value));
        control = c;
      }
      fields.appendChild(h('div', { class: 'ed-pf-row' }, h('span', { class: 'ed-pf-rowlabel' }, v.name), control));
    }
    if (!p.variables.length)
      fields.appendChild(
        h('p', { class: 'hint-text' }, 'This prefab has no variables. Add some with “Edit variables & variants…”.'),
      );
  };
  variantSel.addEventListener('change', renderFields);
  renderFields();
  const ok = h('button', { class: 'btn primary', type: 'button' }, 'Insert');
  const cancel = h('button', { class: 'btn', type: 'button' }, 'Cancel');
  const m = openModal({
    title: `Insert “${p.name}”`,
    width: '460px',
    body: [
      p.variants.length
        ? h('div', { class: 'ed-pf-row' }, h('span', { class: 'ed-pf-rowlabel' }, 'Variant'), variantSel)
        : h('span'),
      fields,
      h('div', { class: 'ed-pf-row' }, h('span', { class: 'ed-pf-rowlabel' }, 'Rotate (°)'), rot),
    ],
    footer: [cancel, ok],
  });
  cancel.addEventListener('click', () => m.close());
  ok.addEventListener('click', () => {
    m.close();
    const deg = Number(rot.value);
    insertUserPrefab(app, id, {
      variantId: variantSel.value || undefined,
      variableValues: values,
      rotation: Number.isFinite(deg) && deg !== 0 ? yawQuat(deg) : undefined,
    });
  });
}

// ── edit ────────────────────────────────────────────────────────────────────────────────────────────

interface Draft {
  name: string;
  tags: string;
  variables: PrefabVariable[];
  variants: PrefabVariant[];
  nested: NestedRef[];
}

/** Edit name, tags, variables (with bindings), variants and nested prefabs of a stored prefab. */
export function editPrefabDialog(app: App, id: string): void {
  const lib = prefabLibrary(app);
  const src = lib.get(id);
  if (!src) return;
  const draft: Draft = {
    name: src.name,
    tags: src.tags.join(', '),
    variables: structuredClone(src.variables),
    variants: structuredClone(src.variants),
    nested: structuredClone(src.nested),
  };
  const targets = src.entities.filter((e) => isBody(e) || isSoft(e));
  const status = h('p', { class: 'ed-pf-error' });
  const body = h('div', { class: 'ed-pf-edit' });

  const del = (title: string, onClick: () => void) => {
    const b = h('button', { class: 'icon-btn', type: 'button', title }, '×');
    b.addEventListener('click', onClick);
    return b;
  };
  const sectionHead = (title: string, hint: string, add: HTMLElement) =>
    h('div', { class: 'ed-pf-head' }, h('div', null, h('h4', null, title), h('p', { class: 'hint-text' }, hint)), add);
  const addBtn = (label: string, fn: () => void) => {
    const b = h('button', { class: 'btn small', type: 'button' }, label);
    b.addEventListener('click', fn);
    return b;
  };

  const render = () => {
    clear(body);
    // name & tags
    const name = textInput(draft.name);
    name.addEventListener('input', () => (draft.name = name.value));
    const tags = textInput(draft.tags, 'comma separated');
    tags.addEventListener('input', () => (draft.tags = tags.value));
    body.append(h('label', { class: 'ed-pf-label' }, 'Name'), name, h('label', { class: 'ed-pf-label' }, 'Tags'), tags);

    // variables
    body.appendChild(
      sectionHead(
        'Variables',
        'A variable is set when you insert the prefab and drives the geometry or material of the objects it is bound to.',
        addBtn('Add variable', () => {
          if (draft.variables.length >= PREFAB_LIMITS.maxVariables) return;
          let n = draft.variables.length + 1;
          while (draft.variables.some((v) => v.name === `variable ${n}`)) n++;
          draft.variables.push({
            name: `variable ${n}`,
            kind: 'number',
            default: 1,
            min: 0.1,
            max: 10,
            bindings: [{ prop: 'scale' }],
          });
          render();
        }),
      ),
    );
    if (!draft.variables.length)
      body.appendChild(h('p', { class: 'hint-text' }, 'None. Example: “height” bound to Height (y) of every body.'));
    draft.variables.forEach((v, vi) => {
      const nm = textInput(v.name);
      nm.addEventListener('input', () => (v.name = nm.value));
      const kind = select<VariableKind>(
        [
          ['number', 'Number'],
          ['material', 'Material'],
          ['color', 'Colour'],
        ],
        v.kind,
      );
      kind.addEventListener('change', () => {
        v.kind = kind.value as VariableKind;
        v.default = v.kind === 'number' ? 1 : v.kind === 'material' ? MATERIAL_PRESETS[0].id : '#888888';
        v.bindings = [{ prop: PROPS_OF[v.kind][0] }];
        render();
      });
      const rowEls: HTMLElement[] = [];
      if (v.kind === 'number') {
        const def = numInput(Number(v.default), { step: 0.1 });
        def.addEventListener('input', () => (v.default = Number(def.value)));
        const mn = numInput(v.min, { placeholder: 'min' });
        mn.addEventListener('input', () => (v.min = optNum(mn)));
        const mx = numInput(v.max, { placeholder: 'max' });
        mx.addEventListener('input', () => (v.max = optNum(mx)));
        rowEls.push(h('span', { class: 'hint-text' }, 'default'), def, mn, mx);
      } else if (v.kind === 'material') {
        const s = select<string>(
          MATERIAL_PRESETS.map((m): [string, string] => [m.id, m.label]),
          String(v.default),
        );
        s.addEventListener('change', () => (v.default = s.value));
        rowEls.push(s);
      } else {
        const c = h('input', { type: 'color', class: 'ed-pf-color', value: String(v.default).slice(0, 7) });
        c.addEventListener('input', () => (v.default = c.value));
        rowEls.push(c);
      }
      const binds = v.bindings.map((b, bi) => {
        const prop = select<BindProp>(
          PROPS_OF[v.kind].map((p): [BindProp, string] => [p, PROP_LABELS[p]]),
          b.prop,
        );
        prop.addEventListener('change', () => (b.prop = prop.value as BindProp));
        const candidates = v.kind === 'color' ? targets : targets.filter(isBody);
        const who = select<string>(
          [['', 'every object'], ...candidates.map((e): [string, string] => [e.id, e.name])],
          b.entityId ?? '',
        );
        who.addEventListener('change', () => (b.entityId = who.value || undefined));
        return h(
          'div',
          { class: 'ed-pf-bind' },
          h('span', { class: 'hint-text' }, 'drives'),
          prop,
          h('span', { class: 'hint-text' }, 'of'),
          who,
          del('Remove binding', () => {
            v.bindings.splice(bi, 1);
            render();
          }),
        );
      });
      body.appendChild(
        h(
          'div',
          { class: 'ed-pf-card', dataset: { variable: String(vi) } },
          h(
            'div',
            { class: 'ed-pf-line' },
            nm,
            kind,
            del('Remove variable', () => {
              draft.variables.splice(vi, 1);
              render();
            }),
          ),
          h('div', { class: 'ed-pf-line' }, ...rowEls),
          ...binds,
          addBtn('Add binding', () => {
            if (v.bindings.length >= PREFAB_LIMITS.maxBindings) return;
            v.bindings.push({ prop: PROPS_OF[v.kind][0] });
            render();
          }),
        ),
      );
    });

    // variants
    body.appendChild(
      sectionHead(
        'Variants',
        'A named set of overrides: material, colour, overall size and variable values. Insert one from the prefab’s menu.',
        addBtn('Add variant', () => {
          if (draft.variants.length >= PREFAB_LIMITS.maxVariants) return;
          draft.variants.push({ id: uid('pv'), name: `Variant ${draft.variants.length + 1}`, overrides: {} });
          render();
        }),
      ),
    );
    if (!draft.variants.length) body.appendChild(h('p', { class: 'hint-text' }, 'None. Example: “Steel, 2× size”.'));
    draft.variants.forEach((v, i) => {
      const nm = textInput(v.name);
      nm.addEventListener('input', () => (v.name = nm.value));
      const mat = select<string>(
        [['', 'Keep material'], ...MATERIAL_PRESETS.map((m): [string, string] => [m.id, m.label])],
        v.overrides.materialPreset ?? '',
      );
      mat.addEventListener('change', () => {
        if (mat.value) v.overrides.materialPreset = mat.value;
        else delete v.overrides.materialPreset;
      });
      const useColor = h('input', { type: 'checkbox', title: 'Override the colour' });
      useColor.checked = v.overrides.color !== undefined;
      const color = h('input', {
        type: 'color',
        class: 'ed-pf-color',
        value: (v.overrides.color ?? '#888888').slice(0, 7),
      });
      const syncColor = () => {
        if (useColor.checked) v.overrides.color = color.value;
        else delete v.overrides.color;
      };
      useColor.addEventListener('change', syncColor);
      color.addEventListener('input', () => {
        useColor.checked = true;
        syncColor();
      });
      const scale = numInput(v.overrides.sizeScale, { min: 0.01, max: 100, step: 0.1, placeholder: 'size ×' });
      scale.addEventListener('input', () => {
        const n = optNum(scale);
        if (n === undefined) delete v.overrides.sizeScale;
        else v.overrides.sizeScale = n;
      });
      body.appendChild(
        h(
          'div',
          { class: 'ed-pf-card', dataset: { variant: String(i) } },
          h(
            'div',
            { class: 'ed-pf-line' },
            nm,
            del('Remove variant', () => {
              draft.variants.splice(i, 1);
              render();
            }),
          ),
          h('div', { class: 'ed-pf-line' }, mat, useColor, color, scale),
        ),
      );
    });

    // nested
    body.appendChild(
      sectionHead(
        'Nested prefabs',
        'Other prefabs inserted together with this one, at an offset from its centre.',
        addBtn('Add nested prefab…', () => {
          const other = lib.list().filter((p) => p.id !== id && !nestingProblem(lib.get, id, p.id));
          if (!other.length) {
            status.textContent = 'There is no other prefab that could be nested here (a prefab cannot contain itself).';
            return;
          }
          status.textContent = '';
          if (draft.nested.length >= PREFAB_LIMITS.maxNested) return;
          draft.nested.push({ id: uid('pn'), prefabId: other[0].id, position: [2, 0, 0], yaw: 0 });
          render();
        }),
      ),
    );
    if (!draft.nested.length) body.appendChild(h('p', { class: 'hint-text' }, 'None.'));
    draft.nested.forEach((n, i) => {
      const pick = select<string>(
        lib
          .list()
          .filter((p) => p.id !== id)
          .map((p): [string, string] => [p.id, p.name]),
        n.prefabId,
      );
      pick.addEventListener('change', () => (n.prefabId = pick.value));
      const axis = (k: 0 | 1 | 2, label: string) => {
        const e = numInput(n.position[k], { step: 0.5, placeholder: label });
        e.title = `Offset ${label} (m)`;
        e.addEventListener('input', () => (n.position[k] = Number(e.value) || 0));
        return e;
      };
      const yaw = numInput(n.yaw, { step: 15, placeholder: 'yaw°' });
      yaw.title = 'Rotation about the vertical axis (degrees)';
      yaw.addEventListener('input', () => (n.yaw = Number(yaw.value) || 0));
      body.appendChild(
        h(
          'div',
          { class: 'ed-pf-card', dataset: { nested: String(i) } },
          h(
            'div',
            { class: 'ed-pf-line' },
            pick,
            del('Remove nested prefab', () => {
              draft.nested.splice(i, 1);
              render();
            }),
          ),
          h('div', { class: 'ed-pf-line' }, axis(0, 'x'), axis(1, 'y'), axis(2, 'z'), yaw),
        ),
      );
    });
  };
  render();

  const save = h('button', { class: 'btn primary', type: 'button' }, 'Save changes');
  const cancel = h('button', { class: 'btn', type: 'button' }, 'Cancel');
  const m = openModal({
    title: `Edit “${src.name}”`,
    width: '640px',
    body: [body, status],
    footer: [cancel, save],
  });
  cancel.addEventListener('click', () => m.close());
  const commit = async () => {
    if (!draft.name.trim()) {
      status.textContent = 'The prefab needs a name.';
      return;
    }
    try {
      await lib.update(id, {
        name: draft.name.trim(),
        tags: parseTags(draft.tags),
        variables: draft.variables,
        variants: draft.variants,
        nested: draft.nested,
      });
      m.close();
      app.toast(`Saved “${draft.name.trim()}”`, 'success');
    } catch (e) {
      status.textContent = message(e);
    }
  };
  save.addEventListener('click', () => void commit());
}

// ── export / import ─────────────────────────────────────────────────────────────────────────────────

function download(name: string, text: string): void {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** Choose prefabs (all ticked by default) and download them as one pack. */
export function exportDialog(app: App, preselected?: readonly string[]): void {
  const lib = prefabLibrary(app);
  const all = lib.list();
  if (!all.length) {
    app.toast('There are no prefabs to export yet.', 'warn');
    return;
  }
  const boxes = all.map((p) => {
    const c = h('input', { type: 'checkbox', dataset: { id: p.id } });
    c.checked = preselected ? preselected.includes(p.id) : true;
    return [p, c] as const;
  });
  const ok = h('button', { class: 'btn primary', type: 'button' }, 'Export pack');
  const cancel = h('button', { class: 'btn', type: 'button' }, 'Cancel');
  const m = openModal({
    title: 'Export prefab pack',
    width: '460px',
    body: [
      h(
        'p',
        { class: 'sub', style: { marginBottom: '8px' } },
        'Prefabs nested inside a chosen prefab are included automatically.',
      ),
      h(
        'div',
        { class: 'ed-pf-checks' },
        ...boxes.map(([p, c]) => h('label', { class: 'ed-pf-check' }, c, h('span', null, p.name))),
      ),
    ],
    footer: [cancel, ok],
  });
  cancel.addEventListener('click', () => m.close());
  ok.addEventListener('click', () => {
    const ids = boxes.filter(([, c]) => c.checked).map(([p]) => p.id);
    if (!ids.length) return;
    download('physicslab-prefabs.json', lib.exportText(ids));
    m.close();
    app.toast(`Exported ${ids.length} prefab${ids.length === 1 ? '' : 's'}`, 'success');
  });
}

/** Import a pack file into the library. */
export async function importPackFile(app: App, file: File): Promise<void> {
  try {
    // Refuse before reading: file.text() would load the whole file only for the importer to reject it.
    if (file.size > PREFAB_LIMITS.maxPackChars)
      throw new PrefabPackError(
        `This file is larger than ${formatBytes(PREFAB_LIMITS.maxPackChars)}, the biggest prefab pack PhysicsLab opens.`,
      );
    const { added, warnings } = await prefabLibrary(app).importText(await file.text());
    app.toast(`Imported ${added.length} prefab${added.length === 1 ? '' : 's'}`, 'success');
    for (const w of warnings.slice(0, 3)) app.toast(w, 'warn');
  } catch (e) {
    app.toast(e instanceof PrefabPackError ? e.message : `Could not import the pack: ${message(e)}`, 'error');
  }
}

/** The one hidden chooser input, created on first use and reused (a cancelled chooser leaves nothing behind). */
let packInput: HTMLInputElement | null = null;

/** Open the file chooser and import the picked pack. */
export function importPackDialog(app: App): void {
  if (!packInput || !packInput.isConnected) {
    packInput?.remove();
    packInput = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
    document.body.appendChild(packInput);
  }
  const input = packInput;
  const cleanup = () => {
    input.removeEventListener('change', onChange);
    input.removeEventListener('cancel', cleanup);
  };
  const onChange = () => {
    const f = input.files?.[0];
    cleanup();
    input.value = '';
    if (f) void importPackFile(app, f);
  };
  input.addEventListener('change', onChange);
  input.addEventListener('cancel', cleanup);
  input.value = '';
  input.click();
}
