/**
 * The built-in inspector sections, as registrations (`src/app/registry/inspectorSections.ts`): one panel per kind of
 * selection (body, soft body, light, group, path, joint), then the "Organise" row (group membership), the
 * Components section, and — only when nothing else applies — the summary of a mixed selection.
 *
 * The orders leave room between them (100 / 200 / 300 / 900): a package inserts its own section anywhere.
 */
import type { InspectorSectionDef } from '../../app/registry/inspectorSections';
import type { Entity } from '../../model/types';
import { isBody, isGroup, isJoint, isLight, isPath, isSoft } from '../../model/types';
import { section } from '../controls';
import { h } from '../dom';
import { groupInspector, lightInspector, membershipRow, pathInspector } from './aux';
import { bodyInspector } from './body';
import { componentsSection } from './components';
import { jointInspector } from './joint';
import { jointSelectionInspector } from './jointTypes';
import type { InspectorContext } from './shared';
import { softInspector } from './soft';

/** Mixed selections (bodies + joints, several groups …): counts only, no shared properties. */
function summary(ctx: InspectorContext, sel: Entity[]): HTMLElement[] {
  const count = (f: (e: Entity) => boolean) => sel.filter(f).length;
  const parts = [
    [count((e) => isBody(e) || isSoft(e)), 'body', 'bodies'],
    [count(isJoint), 'joint', 'joints'],
    [count(isGroup), 'group', 'groups'],
    [count(isLight), 'light', 'lights'],
    [count(isPath), 'path', 'paths'],
  ] as const;
  const text = parts
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`)
    .join(', ');
  return [
    ctx.header(sel),
    h(
      'div',
      { class: 'empty-state' },
      h('h4', null, `${sel.length} objects selected`),
      h(
        'p',
        null,
        `${text}. Select objects of one kind to edit shared properties (bodies, soft bodies or lights), or a single group, path or joint to edit its settings.`,
      ),
    ),
  ];
}

export const BUILTIN_INSPECTOR_SECTIONS: readonly InspectorSectionDef[] = [
  {
    id: 'body',
    order: 100,
    appliesTo: (sel) => sel.every(isBody),
    build: (ctx, sel) => bodyInspector(ctx, sel.filter(isBody)),
  },
  {
    id: 'soft',
    order: 100,
    appliesTo: (sel) => sel.every(isSoft),
    build: (ctx, sel) => softInspector(ctx, sel.filter(isSoft)),
  },
  {
    id: 'light',
    order: 100,
    appliesTo: (sel) => sel.every(isLight),
    build: (ctx, sel) => lightInspector(ctx, sel.filter(isLight)),
  },
  {
    id: 'group',
    order: 100,
    appliesTo: (sel) => sel.length === 1 && isGroup(sel[0]),
    build: (ctx, sel) => (isGroup(sel[0]) ? groupInspector(ctx, sel[0]) : []),
  },
  {
    id: 'path',
    order: 100,
    appliesTo: (sel) => sel.length === 1 && isPath(sel[0]),
    build: (ctx, sel) => (isPath(sel[0]) ? pathInspector(ctx, sel[0]) : []),
  },
  {
    id: 'joint',
    order: 100,
    appliesTo: (sel) => sel.length === 1 && isJoint(sel[0]),
    build: (ctx, sel) => (isJoint(sel[0]) ? jointInspector(ctx, sel[0]) : []),
  },
  {
    // -- JT-A: several joints: copy settings, mirror
    id: 'joints',
    order: 100,
    appliesTo: (sel) => sel.length > 1 && sel.every(isJoint),
    build: (ctx, sel) => jointSelectionInspector(ctx, sel.filter(isJoint)),
  },
  {
    // Bodies and soft bodies can be put into a group.
    id: 'organise',
    order: 200,
    appliesTo: (sel) => sel.every(isBody) || sel.every(isSoft),
    build: (ctx, sel) => {
      const row = membershipRow(
        ctx,
        sel.map((e) => e.id),
      );
      return row ? [section('Organise', [row], { id: 'organise' })] : [];
    },
  },
  {
    // Components are edited one owner at a time.
    id: 'components',
    order: 300,
    appliesTo: (sel) => sel.length === 1 && (isBody(sel[0]) || isJoint(sel[0])),
    build: (ctx, sel) => {
      const sec = componentsSection(ctx, sel[0].id);
      return sec ? [sec] : [];
    },
  },
  { id: 'summary', order: 900, fallback: true, appliesTo: () => true, build: summary },
];
