/**
 * The Embed dialog (DT-22): options for the viewer, the iframe snippet they produce, a live preview and a copy
 * button. Loaded lazily by the `file.embed` command.
 */
import type { App } from '../../app/app';
import { buildEmbedUrl, type EmbedOptions } from '../../app/embed/options';
import { buildIframeSnippet, clampPx } from '../../app/embed/snippet';
import type { ShareResult } from '../../app/share/link';
import { selectField, toggleField } from '../controls';
import { h } from '../dom';
import { button } from '../controls';
import { openModal } from '../modal';

export async function showEmbedDialog(app: App): Promise<void> {
  let info: ShareResult;
  try {
    info = await app.persistence.shareInfo();
  } catch (e) {
    app.toast((e as Error).message, 'error');
    return;
  }
  const view = app.viewport.getView();
  const base = `${location.origin}${location.pathname}`;
  const payload = info.tooLarge ? null : new URL(info.url).hash.slice(1);

  const state = {
    width: 640,
    height: 400,
    autoplay: true,
    controls: true,
    camera: 'orbit' as EmbedOptions['camera'],
    interact: false,
    useView: true,
  };
  const code = h('textarea', { class: 'embed-code', readOnly: true, spellcheck: false, 'aria-label': 'Embed code' });
  const previewBox = h('div', { class: 'embed-preview' });
  const note = h('div', { class: 'embed-note' });
  let frame: HTMLIFrameElement | null = null;
  let timer = 0;

  const viewerUrl = () =>
    buildEmbedUrl(base, {
      payload,
      autoplay: state.autoplay,
      controls: state.controls,
      camera: state.camera,
      interact: state.interact,
      view: state.useView ? ([...view.position, ...view.target] as NonNullable<EmbedOptions['view']>) : null,
    });

  const refresh = () => {
    const url = viewerUrl();
    code.value = buildIframeSnippet({ url, width: state.width, height: state.height, title: app.store.name });
    window.clearTimeout(timer);
    // Booting a second viewer is heavy (worker + WebGL): wait until the user stops changing options.
    timer = window.setTimeout(() => {
      if (!payload) return;
      frame?.remove();
      const w = clampPx(state.width, 640);
      const hh = clampPx(state.height, 400);
      frame = h('iframe', { src: url, width: w, height: hh, title: 'Preview', loading: 'eager' });
      // Show the real size, scaled down to what the dialog has room for.
      const k = Math.min(1, (previewBox.clientWidth || 520) / w, 340 / hh);
      frame.style.transform = `scale(${k})`;
      const scaler = h(
        'div',
        { class: 'embed-scale', style: { width: `${Math.round(w * k)}px`, height: `${Math.round(hh * k)}px` } },
        frame,
      );
      previewBox.replaceChildren(scaler);
    }, 450);
  };

  const num = (key: 'width' | 'height', label: string) => {
    const input = h('input', { type: 'number', class: 'plain', min: 120, max: 4000, step: 10, value: state[key] });
    input.addEventListener('input', () => {
      state[key] = clampPx(Number(input.value), state[key]);
      refresh();
    });
    return h('label', null, h('span', null, label), input);
  };
  const toggle = (key: 'autoplay' | 'controls' | 'interact' | 'useView', label: string, title: string) => {
    const f = toggleField({ label, value: state[key], title, onChange: (v) => ((state[key] = v), refresh()) });
    return f.el;
  };
  const cam = selectField<EmbedOptions['camera']>({
    options: [
      { value: 'orbit', label: 'Viewer can orbit and zoom' },
      { value: 'fixed', label: 'Camera locked' },
    ],
    value: state.camera,
    onChange: (v) => ((state.camera = v), refresh()),
  });

  const opts = h(
    'div',
    { class: 'embed-opts' },
    num('width', 'Width (px)'),
    num('height', 'Height (px)'),
    toggle('autoplay', 'Start playing', 'Run the simulation as soon as the viewer has loaded'),
    toggle('controls', 'Show play / reset bar', 'The slim bar with play, pause, reset and camera reset'),
    toggle(
      'interact',
      'Allow grabbing bodies',
      'Viewers can drag bodies while the simulation runs; they still cannot edit the scene',
    ),
    cam.el,
  );
  const copy = button(
    'Copy embed code',
    () => {
      navigator.clipboard.writeText(code.value).then(
        () => app.toast('Embed code copied.', 'success'),
        () => {
          code.select();
          app.toast('The browser blocked copying: the code is selected, press Ctrl/⌘+C.', 'warn');
        },
      );
    },
    { icon: 'copy', cls: 'primary' },
  );
  const body = h('div', { class: 'embed-dialog' }, opts, previewBox, code, note, copy);

  if (!payload) {
    note.textContent =
      'This scene is too large for a link, so it cannot be embedded this way. Save it as a file and host it, or simplify the scene.';
    copy.disabled = true;
    code.value = '';
  } else {
    note.textContent =
      'The scene travels inside the link, so the embed shows this version even if you change the scene later. ' +
      'The page that embeds it can control playback through postMessage (see docs/EMBED.md).';
  }
  const m = openModal({
    title: 'Embed in a web page',
    body: [body],
    width: '860px',
    onClose: () => {
      window.clearTimeout(timer);
      frame?.remove(); // stops the preview viewer and its physics worker
    },
  });
  refresh();
  void m;
}
