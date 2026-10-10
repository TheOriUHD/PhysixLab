/** Camera panel: cinematic shots — a camera on a path with timed keys, preview, scrub, loop and record. */
import type { App } from '../../app/app';
import { shotRecorders } from '../../app/camera/shotPlayer';
import { addKey, newShot, removeKey, setDuration, updateKey } from '../../app/camera/shots';
import type { CameraShot, ShotEase } from '../../model/types';
import { button, numberField, row, section, selectField, toggleField } from '../controls';
import { h } from '../dom';
import { icon } from '../icons';
import { promptText } from '../modal';
import { registerCameraSection } from './sections';

const EASE_LABELS: { value: ShotEase; label: string }[] = [
  { value: 'inOut', label: 'Ease in-out' },
  { value: 'linear', label: 'Linear' },
  { value: 'in', label: 'Ease in' },
  { value: 'out', label: 'Ease out' },
];

registerCameraSection({
  id: 'shots',
  order: 40,
  build(app: App) {
    const player = app.cameraRig.player;
    let selected: string | null = null;
    const root = h('div', { class: 'cam-shots' });
    const list = h('div', { class: 'cam-shot-list', role: 'list' });
    const detail = h('div', { class: 'cam-shot-detail' });
    const help = h(
      'p',
      { class: 'hint-text' },
      'A shot flies the camera along a path (Add › Path). Keys set where on the path it is, the lens and the easing at a time; look along the path, at a body or at a point.',
    );

    const commit = (shot: CameraShot, label: string) =>
      app.store.setCameras(
        { ...app.store.cameras, shots: app.store.cameras.shots.map((s) => (s.id === shot.id ? shot : s)) },
        label,
      );

    const create = () => {
      const paths = app.store.paths();
      const sel = app.store.selection.map((id) => app.store.path(id)).find(Boolean) ?? paths[0];
      if (!sel) {
        app.toast('Add a path first (Add › Path): the camera flies along it', 'warn');
        return;
      }
      const n = app.store.cameras.shots.length + 1;
      const shot = newShot(sel.id, `Shot ${n}`, app.cameraRig.settings.fov);
      app.store.setCameras(
        { ...app.store.cameras, shots: [...app.store.cameras.shots, shot].slice(0, 16) },
        'Add camera shot',
      );
      selected = shot.id;
      renderAll();
    };

    const renderList = () => {
      list.replaceChildren();
      for (const s of app.store.cameras.shots) {
        const open = h(
          'button',
          { class: `cam-shot-row${s.id === selected ? ' on' : ''}`, type: 'button', title: 'Select shot' },
          icon('path'),
          h('span', null, s.name),
        );
        open.addEventListener('click', () => {
          selected = s.id;
          renderAll();
        });
        const play = h(
          'button',
          { class: 'icon-btn', type: 'button', title: 'Preview this shot', 'aria-label': `Play ${s.name}` },
          icon('play'),
        );
        play.addEventListener('click', () => {
          selected = s.id;
          if (player.open(s.id)) player.play();
          renderAll();
        });
        const del = h(
          'button',
          { class: 'icon-btn', type: 'button', title: 'Delete shot', 'aria-label': `Delete ${s.name}` },
          icon('trash'),
        );
        del.addEventListener('click', () => {
          if (player.shotId === s.id) player.close();
          app.store.setCameras(
            { ...app.store.cameras, shots: app.store.cameras.shots.filter((x) => x.id !== s.id) },
            'Delete camera shot',
          );
          if (selected === s.id) selected = null;
          renderAll();
        });
        list.appendChild(h('div', { class: 'cam-shot-item', role: 'listitem' }, open, play, del));
      }
    };

    let scrub: HTMLInputElement | null = null;
    let timeOut: HTMLElement | null = null;
    let playBtn: HTMLButtonElement | null = null;

    const renderDetail = () => {
      detail.replaceChildren();
      scrub = timeOut = null;
      playBtn = null;
      const shot = app.store.cameras.shots.find((s) => s.id === selected);
      if (!shot) return;
      const paths = app.store.paths();
      const name = h('input', {
        class: 'plain',
        type: 'text',
        value: shot.name,
        maxLength: 60,
        spellcheck: false,
        'aria-label': 'Shot name',
      });
      name.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') name.blur();
      });
      name.addEventListener('change', () =>
        commit({ ...shot, name: name.value.trim() || shot.name }, 'Rename camera shot'),
      );
      const pathSel = selectField<string>({
        options: paths.length
          ? paths.map((p) => ({ value: p.id, label: p.name }))
          : [{ value: '', label: 'No paths in the scene' }],
        value: shot.pathId,
        onChange: (v) => commit({ ...shot, pathId: v }, 'Change shot path'),
      });
      if (!paths.some((p) => p.id === shot.pathId)) pathSel.el.classList.add('missing');
      const dur = numberField({
        value: shot.duration,
        min: 0.5,
        max: 3600,
        step: 0.5,
        unit: 's',
        digits: 1,
        onChange: (v) => commit(setDuration(shot, v), 'Change shot duration'),
      });
      const loop = toggleField({
        label: 'Loop',
        value: shot.loop,
        onChange: (v) => commit({ ...shot, loop: v }, 'Change shot loop'),
      });
      const lookSel = selectField<'tangent' | 'body' | 'point'>({
        options: [
          { value: 'tangent', label: 'Along the path' },
          { value: 'body', label: 'At a body' },
          { value: 'point', label: 'At a point' },
        ],
        value: shot.look.mode,
        onChange: (v) => commit({ ...shot, look: { ...shot.look, mode: v } }, 'Change shot look-at'),
      });
      const lookExtra: HTMLElement[] = [];
      if (shot.look.mode === 'body') {
        const bodies = app.store.bodies();
        const sel = selectField<string>({
          options: bodies.length
            ? bodies.map((b) => ({ value: b.id, label: b.name }))
            : [{ value: '', label: 'No bodies' }],
          value: shot.look.bodyId || bodies[0]?.id || '',
          onChange: (v) => commit({ ...shot, look: { ...shot.look, bodyId: v } }, 'Change shot target'),
        });
        if (!shot.look.bodyId && bodies[0])
          queueMicrotask(() => commit({ ...shot, look: { ...shot.look, bodyId: bodies[0].id } }, 'Change shot target'));
        lookExtra.push(row('Target body', sel.el));
      } else if (shot.look.mode === 'point') {
        lookExtra.push(
          row(
            'Point',
            button(
              `${shot.look.point.map((v) => v.toFixed(1)).join(', ')} — use view target`,
              () => {
                const t = app.viewport.controls.target;
                commit({ ...shot, look: { ...shot.look, point: [t.x, t.y, t.z] } }, 'Change shot target');
              },
              { cls: 'small' },
            ),
          ),
        );
      }

      // transport
      const active = player.shotId === shot.id;
      playBtn = button(
        active && player.playing ? 'Pause' : 'Play',
        () => {
          if (!player.open(shot.id) && !active) return;
          if (player.shotId === shot.id && player.playing) player.pause();
          else player.play();
        },
        { icon: active && player.playing ? 'pause' : 'play', cls: 'small primary' },
      );
      scrub = h('input', {
        class: 'slider cam-scrub',
        type: 'range',
        min: '0',
        max: String(shot.duration),
        step: '0.01',
        value: String(active ? player.t : 0),
        'aria-label': 'Shot time',
      });
      scrub.addEventListener('input', () => {
        const at = Number(scrub?.value); // read before opening: opening rebuilds this panel
        if (!player.open(shot.id) && player.shotId !== shot.id) return;
        player.pause();
        player.seek(at);
      });
      timeOut = h(
        'span',
        { class: 'cam-time' },
        `${(active ? player.t : 0).toFixed(2)} / ${shot.duration.toFixed(1)} s`,
      );
      const speed = selectField<string>({
        options: ['0.25', '0.5', '1', '2'].map((v) => ({ value: v, label: `${v}×` })),
        value: String(player.speed),
        onChange: (v) => (player.speed = Number(v)),
      });
      const rec = shotRecorders.list().filter((r) => r.available())[0];
      const recBtn = rec
        ? button(
            player.recording ? 'Stop recording' : 'Record',
            () => {
              if (player.recording) void player.stopRecord();
              else if (player.open(shot.id)) void player.record(rec.id);
            },
            {
              icon: 'download',
              cls: `small${player.recording ? ' danger' : ''}`,
              title: `Play the shot once from the start and save it as ${rec.label}`,
            },
          )
        : null;
      const close = button('Close preview', () => player.close(), {
        cls: 'small',
        title: 'Return the camera to where it was',
      });
      close.style.display = active ? '' : 'none';

      // keys
      const keys = h('div', { class: 'cam-keys', role: 'list' });
      shot.keys.forEach((k, i) => {
        const t = numberField({
          value: k.t,
          min: 0,
          max: shot.duration,
          step: 0.1,
          unit: 's',
          digits: 2,
          onChange: (v) => commit(updateKey(shot, i, { t: v }), 'Edit shot key'),
        });
        const u = numberField({
          value: k.u * 100,
          min: 0,
          max: 100,
          step: 1,
          unit: '%',
          digits: 1,
          onChange: (v) => commit(updateKey(shot, i, { u: v / 100 }), 'Edit shot key'),
        });
        const f = numberField({
          value: k.fov,
          min: 5,
          max: 120,
          step: 1,
          unit: '°',
          digits: 0,
          onChange: (v) => commit(updateKey(shot, i, { fov: v }), 'Edit shot key'),
        });
        const e = selectField<ShotEase>({
          options: EASE_LABELS,
          value: k.ease,
          onChange: (v) => commit(updateKey(shot, i, { ease: v }), 'Edit shot key'),
        });
        const goto = h(
          'button',
          { class: 'icon-btn', type: 'button', title: 'Jump to this key', 'aria-label': `Jump to key ${i + 1}` },
          icon('frame'),
        );
        goto.addEventListener('click', () => {
          if (!player.open(shot.id) && player.shotId !== shot.id) return;
          player.pause();
          player.seek(k.t);
        });
        const del = h(
          'button',
          { class: 'icon-btn', type: 'button', title: 'Delete key', 'aria-label': `Delete key ${i + 1}` },
          icon('trash'),
        );
        del.disabled = shot.keys.length <= 2;
        del.addEventListener('click', () => commit(removeKey(shot, i), 'Delete shot key'));
        keys.appendChild(
          h(
            'div',
            { class: 'cam-key', role: 'listitem' },
            h('span', { class: 'cam-key-n' }, String(i + 1)),
            t.el,
            u.el,
            f.el,
            e.el,
            goto,
            del,
          ),
        );
      });
      const addK = button(
        'Add key at playhead',
        () => {
          const at = player.shotId === shot.id ? player.t : shot.duration / 2;
          commit(addKey(shot, at), 'Add shot key');
        },
        { icon: 'plus', cls: 'small', title: 'Insert a key that keeps the shot unchanged; then edit it' },
      );

      detail.append(
        row('Name', name),
        row('Path', pathSel.el, 'The spline the camera rides'),
        row('Duration', dur.el),
        loop.el,
        row('Look', lookSel.el),
        ...lookExtra,
        h('div', { class: 'cam-transport' }, playBtn, scrub, timeOut),
        h('div', { class: 'cam-transport-bar' }, row('Speed', speed.el), recBtn, close),
        h(
          'div',
          { class: 'cam-key-head' },
          h('span', null, '#'),
          h('span', null, 'Time'),
          h('span', null, 'Path'),
          h('span', null, 'Lens'),
          h('span', null, 'Easing'),
        ),
        keys,
        addK,
      );
    };

    const renderAll = () => {
      renderList();
      renderDetail();
    };
    app.store.on('meta', renderAll);
    player.on('change', () => {
      // transport state changed: refresh the buttons without rebuilding fields under the user's cursor
      if (
        document.activeElement &&
        root.contains(document.activeElement) &&
        document.activeElement instanceof HTMLInputElement &&
        document.activeElement.type !== 'range'
      )
        return;
      renderDetail();
    });
    app.on('frame', () => {
      if (!scrub || !timeOut || player.shotId !== selected || !player.playing) return;
      const s = player.shot;
      if (!s) return;
      scrub.value = String(player.t);
      timeOut.textContent = `${player.t.toFixed(2)} / ${s.duration.toFixed(1)} s`;
    });
    renderAll();
    const add = button('New shot', create, { icon: 'plus', title: 'A camera shot along the selected path' });
    root.append(add, help, list, detail);
    return { el: section('Cinematic shots', [root], { id: 'cam-shots', open: false }), refresh: renderAll };
  },
});
void promptText;
