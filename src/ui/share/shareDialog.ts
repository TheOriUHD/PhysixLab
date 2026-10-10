/**
 * The share dialog (DT-21): the link with its size, a thumbnail of the viewport, "copy image + link", a QR code of
 * the link and the Open Graph tags for hosts that render previews. Loaded lazily by the `file.shareDialog` command.
 */
import type { App } from '../../app/app';
import { buildOpenGraphTags } from '../../app/share/openGraph';
import type { ShareResult } from '../../app/share/link';
import { encodeQrBest, fitsInQr, maxBytes, qrToSvg } from '../../app/share/qr';
import { captureThumbnail, copyImageAndLink, type Thumbnail } from '../../app/share/thumbnail';
import { button } from '../controls';
import { h } from '../dom';
import { openModal } from '../modal';

function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const fileSafe = (s: string): string => s.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'scene';

export async function showShareDialog(app: App): Promise<void> {
  let info: ShareResult;
  try {
    info = await app.persistence.shareInfo();
  } catch (e) {
    app.toast((e as Error).message, 'error');
    return;
  }
  const name = app.store.name;
  const thumb: Thumbnail | null = await captureThumbnail(app, 640);
  let thumbUrl: string | null = null;

  const body = h('div', { class: 'share-dialog' });
  const left = h('div');
  if (thumb) {
    thumbUrl = URL.createObjectURL(thumb.blob);
    left.append(
      h('img', {
        class: 'share-thumb',
        src: thumbUrl,
        alt: `Preview of ${name}`,
        width: thumb.width,
        height: thumb.height,
      }),
    );
  } else
    left.append(
      h('div', { class: 'share-facts' }, 'The viewport could not be captured, so there is no preview image.'),
    );

  const saved = Math.max(0, Math.round((1 - info.chars / info.v1Chars) * 100));
  const kb = (info.url.length / 1000).toFixed(1);
  const facts =
    `${kb} kB link (${info.chars} characters)` +
    (info.format === 'v2' && saved > 0 ? `, ${saved} % shorter than the previous format` : '') +
    (thumb ? ` · preview ${thumb.width}×${thumb.height} px, ${(thumb.blob.size / 1000).toFixed(0)} kB` : '');
  left.append(h('div', { class: 'share-facts' }, facts));

  const right = h('div');
  const actions = h('div', { class: 'share-actions' });
  body.append(left, right);

  const copy = async (text: string, done: string) => {
    try {
      await navigator.clipboard.writeText(text);
      app.toast(done, 'success');
    } catch {
      app.toast('The browser blocked copying. Select the text and copy it by hand.', 'warn');
    }
  };

  if (info.tooLarge) {
    body.append(
      h(
        'div',
        { class: 'share-warn' },
        `This scene is too large for a link (${kb} kB; the limit is about 32 kB). Save it as a file instead, files have no size limit.`,
      ),
    );
    actions.append(
      button('Download scene file', () => app.persistence.exportFile(), { icon: 'download', cls: 'primary' }),
    );
  } else {
    // ---- QR code -------------------------------------------------------------------------------------------
    if (fitsInQr(info.url)) {
      const qr = encodeQrBest(info.url);
      const box = h('div', { class: 'share-qr' });
      box.innerHTML = qrToSvg(qr, 2); // our own generated SVG: modules only, no user text
      right.append(
        box,
        h(
          'div',
          { class: 'share-facts' },
          `QR code: version ${qr.version}, error correction ${qr.ecl}, ${qr.size}×${qr.size} modules`,
        ),
      );
      actions.append(
        button(
          'Download QR (SVG)',
          () => download(`${fileSafe(name)}-qr.svg`, new Blob([qrToSvg(qr, 4)], { type: 'image/svg+xml' })),
          {
            icon: 'download',
            title: 'A vector QR code with the standard quiet zone',
          },
        ),
      );
    } else {
      right.append(
        h(
          'div',
          { class: 'share-warn' },
          `This link is ${new TextEncoder().encode(info.url).length} bytes; a QR code holds at most ${maxBytes('L')}. ` +
            'Send the link as text, or download the scene as a file and share that instead.',
        ),
      );
      actions.append(button('Download scene file', () => app.persistence.exportFile(), { icon: 'download' }));
    }

    const url = h('input', {
      class: 'plain share-url',
      type: 'text',
      readOnly: true,
      value: info.url,
      'aria-label': 'Share link',
    });
    url.addEventListener('focus', () => url.select());
    body.append(url);
    actions.prepend(
      button('Copy link', () => void copy(info.url, `Share link copied (${kb} kB).`), { icon: 'copy', cls: 'primary' }),
      button('Copy image + link', () => void copyBoth(), {
        icon: 'camera',
        title: 'One clipboard item with the PNG and the link as text',
      }),
    );
    const copyBoth = async () => {
      const r = await copyImageAndLink(thumb?.blob ?? null, info.url);
      if (r === 'image+link')
        app.toast('Copied the preview image together with the link. Paste it into a chat or a document.', 'success');
      else if (r === 'link')
        app.toast(
          'This browser cannot put an image on the clipboard, so only the link was copied. Use "Download image" for the picture.',
          'warn',
        );
      else app.toast('The browser blocked copying. Select the link and copy it by hand.', 'warn');
    };
    if (thumb)
      actions.append(
        button('Download image', () => download(`${fileSafe(name)}.png`, thumb.blob), { icon: 'download' }),
      );
    actions.append(
      button(
        'Copy Open Graph tags',
        () =>
          void copy(
            buildOpenGraphTags({
              title: name,
              url: info.url,
              imageUrl: 'https://YOUR-HOST/preview.png',
              imageWidth: thumb?.width,
              imageHeight: thumb?.height,
            }),
            'Open Graph tags copied. Put the downloaded image on your host and replace YOUR-HOST (see docs/EMBED.md).',
          ),
        { title: 'Meta tags for a page that shows a preview card of this scene' },
      ),
    );
  }
  actions.append(
    button(
      'Embed…',
      () => {
        m.close();
        void import('../embed/embedDialog').then((mod) => mod.showEmbedDialog(app));
      },
      { icon: 'frame', title: 'Generate an iframe snippet' },
    ),
  );
  body.append(actions);

  const m = openModal({
    title: 'Share scene',
    body: [body],
    width: '720px',
    onClose: () => {
      if (thumbUrl) URL.revokeObjectURL(thumbUrl);
    },
  });
}
