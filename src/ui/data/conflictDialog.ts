import { openModal } from '../modal';
import { h } from '../dom';
import { button } from './widgets';

export type ConflictChoice = 'disk' | 'mine' | 'both' | 'later';

/** "The file changed in the folder" — three honest choices; closing the dialog decides nothing ('later'). */
export function chooseConflict(file: string, modified: Date): Promise<ConflictChoice> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (c: ConflictChoice) => {
      if (done) return;
      done = true;
      m.close();
      resolve(c);
    };
    const m = openModal({
      title: 'File changed in the sync folder',
      width: '520px',
      onClose: () => finish('later'),
      body: [
        h(
          'p',
          null,
          `“${file}” was changed outside PhysicsLab (${modified.toLocaleString()}), for example on another computer. Your open scene and the file now differ.`,
        ),
        h('p', { class: 'hint-text' }, 'Nothing is overwritten until you choose.'),
      ],
      footer: [
        button('Load the folder version', () => finish('disk'), { cls: 'primary' }),
        button('Keep both', () => finish('both'), { title: 'Save the folder version as a copy, then save mine' }),
        button('Keep mine (overwrite)', () => finish('mine')),
        button('Decide later', () => finish('later')),
      ],
    });
  });
}
