/**
 * Share dialog (DT-21) and Embed dialog (DT-22) as commands in the File menu. The dialogs, the QR encoder and the
 * thumbnail code are loaded on first use, so none of them is in the start-up bundle. `file.share` (one-click copy)
 * is untouched.
 */
import { registerCommand, registerMenuEntry } from '../../app/registry';

registerCommand({
  id: 'file.shareDialog',
  label: 'Share with preview and QR code…',
  category: 'File',
  icon: 'share',
  description: 'Link, preview image, "copy image + link", QR code and Open Graph tags',
  keywords: ['qr', 'image', 'thumbnail', 'preview', 'link', 'opengraph', 'png'],
  run: async ({ app }) => {
    const { showShareDialog } = await import('../share/shareDialog');
    await showShareDialog(app);
  },
});

registerCommand({
  id: 'file.embed',
  label: 'Embed in a web page…',
  category: 'File',
  icon: 'frame',
  description: 'Generate an iframe snippet of this scene with a live preview',
  keywords: ['iframe', 'viewer', 'website', 'blog', 'html', 'postmessage'],
  run: async ({ app }) => {
    const { showEmbedDialog } = await import('../embed/embedDialog');
    await showEmbedDialog(app);
  },
});

registerMenuEntry({
  id: 'menu.file.shareDialog',
  menu: 'file',
  group: 'io',
  order: 325,
  command: 'file.shareDialog',
  icon: 'share',
});
registerMenuEntry({
  id: 'menu.file.embed',
  menu: 'file',
  group: 'io',
  order: 330,
  command: 'file.embed',
  icon: 'frame',
});
