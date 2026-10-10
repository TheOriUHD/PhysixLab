/** Opening a scene from text (a dropped file or the clipboard), with the same safeguards as File → Import. */
import type { App } from '../../app/app';
import { newReport } from '../../model/errors';
import { parseDocument } from '../../model/serialize';
import { confirmReplace } from '../sceneActions';

export async function importSceneText(
  app: App,
  text: string,
  source: 'file' | 'paste',
  alreadyConfirmed = false,
): Promise<void> {
  try {
    const report = newReport();
    const doc = parseDocument(text, report);
    const open = () => {
      app.loadDocument(doc, 'frame', { kind: source });
      app.toast(source === 'paste' ? `Pasted scene “${doc.name}”` : `Imported “${doc.name}”`, 'success');
      for (const w of report.warnings.slice(0, 2)) app.toast(w, 'warn');
      if (report.warnings.length > 2) app.toast(`…and ${report.warnings.length - 2} more repairs.`, 'warn');
    };
    if (alreadyConfirmed) open();
    else await confirmReplace(app, open);
  } catch (e) {
    app.toast((e as Error).message, 'error');
  }
}
