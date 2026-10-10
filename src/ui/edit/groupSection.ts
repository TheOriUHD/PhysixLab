/**
 * The "Scale & weld" inspector section of a selected group: scale about the pivot (uniform factor, or one factor
 * per group axis), weld the group's bodies into one rigid assembly and undo that, merge into one compound body.
 */
import type { Vec3 } from '../../core/math';
import { mergeCommand, mergeGroupIntoCompound, MERGE_NEEDS } from '../../app/edit/compoundAdapter';
import { groupBodies, scaleGroup, unweldGroup, weldCount, weldGroup } from '../../app/edit/groupOps';
import type { GroupEntity } from '../../model/types';
import { button, numberField, rowStack, section, vec3Field } from '../controls';
import { h } from '../dom';
import type { InspectorContext } from '../inspector/shared';

export function groupScaleSection(ctx: InspectorContext, g: GroupEntity): HTMLElement[] {
  const { app } = ctx;
  const { store } = app;
  const off = () => app.sim.active;
  const reportScale = (approximate: boolean) => {
    if (approximate)
      app.toast(
        'Some members are turned against the group’s axes, so this non-uniform scale is approximate for them. A uniform factor is always exact.',
        'warn',
      );
  };

  let uniform = 1;
  const uni = numberField({
    value: 1,
    step: 0.1,
    min: 0.05,
    max: 50,
    digits: 3,
    unit: '×',
    onChange: (v) => (uniform = v),
  });
  const applyUni = button(
    'Scale',
    () => reportScale(scaleGroup(store, g.id, [uniform, uniform, uniform]).approximate),
    {
      icon: 'scale',
      title:
        'Scale every member about the group pivot by this factor: positions, sizes, masses, joint anchors, spring lengths',
    },
  );

  let axes: Vec3 = [1, 1, 1];
  const per = vec3Field({ step: 0.1, min: 0.05, max: 50, digits: 3, onChange: (v) => (axes = v) });
  per.set([1, 1, 1]);
  const applyAxes = button('Scale per axis', () => reportScale(scaleGroup(store, g.id, axes).approximate), {
    title:
      'Factors along the group’s own axes. Exact for members aligned with the group; members turned by another angle are approximated',
  });

  const weldInfo = h('span', { class: 'readout' });
  const weld = button(
    'Weld',
    () => {
      const n = weldGroup(store, g.id);
      app.toast(
        n ? `${n} fixed joint${n === 1 ? '' : 's'} added` : 'Nothing to weld: the bodies are already welded',
        n ? 'success' : 'info',
      );
    },
    {
      icon: 'weld',
      title: 'Join the bodies in this group with fixed joints (a spanning tree: n bodies need n−1 joints)',
    },
  );
  const unweld = button(
    'Unweld',
    () => {
      const n = unweldGroup(store, g.id);
      app.toast(n ? `${n} weld joint${n === 1 ? '' : 's'} removed` : 'This group has no weld joints', 'info');
    },
    { title: 'Remove the joints made by Weld group (other joints stay)' },
  );

  const merge = button(
    'Merge into compound',
    () => {
      if (!mergeGroupIntoCompound(app, g.id)) app.toast('Could not merge this group into a compound', 'warn');
    },
    { icon: 'box' },
  );

  const refresh = () => {
    const n = weldCount(store, g.id);
    const bodies = groupBodies(store, g.id).length;
    weldInfo.textContent = n
      ? `${n} weld joint${n === 1 ? '' : 's'}`
      : `${bodies} ${bodies === 1 ? 'body' : 'bodies'}, not welded`;
    const locked = off();
    applyUni.disabled = applyAxes.disabled = locked;
    weld.disabled = locked || bodies < 2;
    unweld.disabled = locked || n === 0;
    const cmd = mergeCommand();
    merge.disabled = locked || !cmd || bodies < 2;
    merge.title = cmd ? 'Combine the bodies of this group into one compound body' : MERGE_NEEDS;
  };
  ctx.updaters.push(refresh);
  refresh();

  const line = (...c: HTMLElement[]) =>
    h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } }, ...c);
  uni.el.style.flex = '1';
  return [
    section(
      'Scale & weld',
      [
        rowStack('Scale group', line(uni.el, applyUni), 'Scales members about the group pivot (one undo step)'),
        rowStack('Per axis', [per.el, line(applyAxes)]),
        rowStack('Weld', [line(weld, unweld), line(weldInfo)]),
        rowStack('Compound', line(merge)),
      ],
      { id: 'ed-hierarchy-group' },
    ),
  ];
}
