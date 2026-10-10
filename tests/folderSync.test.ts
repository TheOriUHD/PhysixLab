import { describe, expect, it } from 'vitest';
import {
  FolderSync,
  fileNameFor,
  type DirHandleLike,
  type FileHandleLike,
  type SyncEvent,
} from '../src/app/storage/folderSync';
import { createBody, newDocument } from '../src/model/factory';
import { parseDocument, serializeDocument } from '../src/model/serialize';

/** In-memory directory implementing the subset of FileSystemDirectoryHandle that FolderSync uses. */
function fakeDir() {
  const files = new Map<string, { text: string; modified: number }>();
  let clock = 1000;
  const handle = (name: string): FileHandleLike => ({
    kind: 'file',
    name,
    getFile: () => {
      const f = files.get(name);
      if (!f) return Promise.reject(new Error('NotFoundError'));
      return Promise.resolve({ lastModified: f.modified, text: () => Promise.resolve(f.text) });
    },
    createWritable: () => {
      let buf = '';
      return Promise.resolve({
        write: (d: string) => {
          buf += d;
          return Promise.resolve();
        },
        close: () => {
          files.set(name, { text: buf, modified: ++clock });
          return Promise.resolve();
        },
      });
    },
  });
  const dir: DirHandleLike = {
    kind: 'directory',
    name: 'Cloud',
    async *values() {
      await Promise.resolve();
      for (const n of [...files.keys()]) yield handle(n);
    },
    getFileHandle: (name, opts) => {
      if (!files.has(name) && !opts?.create) return Promise.reject(new Error('NotFoundError'));
      if (!files.has(name)) files.set(name, { text: '', modified: ++clock });
      return Promise.resolve(handle(name));
    },
  };
  return { dir, files, touch: (n: string, text: string) => files.set(n, { text, modified: ++clock }) };
}

describe('folder sync (DT-13)', () => {
  it('writes scenes as <name>.physicslab.json and lists / reads them back', async () => {
    const { dir, files } = fakeDir();
    const sync = new FolderSync(dir);
    const doc = newDocument('My: scene/1');
    doc.entities = [createBody({ name: 'box' })];
    expect(await sync.saveScene(doc)).toBe('saved');
    expect([...files.keys()]).toEqual(['My_ scene_1.physicslab.json']);
    expect((await sync.listScenes()).map((f) => f.name)).toEqual(['My_ scene_1.physicslab.json']);
    expect((await sync.readScene('My_ scene_1.physicslab.json')).entities[0].name).toBe('box');
    expect(fileNameFor('')).toBe('scene.physicslab.json');
  });

  it('detects an external edit and reports a conflict instead of overwriting', async () => {
    const { dir, files, touch } = fakeDir();
    const sync = new FolderSync(dir);
    const events: SyncEvent[] = [];
    sync.onEvent = (e) => events.push(e);
    const doc = newDocument('Shared');
    await sync.saveScene(doc);
    const file = 'Shared.physicslab.json';
    // another device changes the file
    const other = newDocument('Shared');
    other.entities = [createBody({ name: 'from elsewhere' })];
    touch(file, serializeDocument(other, 1));
    expect(await sync.externalChanges()).toEqual([file]);
    const mine = newDocument('Shared');
    mine.entities = [createBody({ name: 'mine' })];
    expect(await sync.saveScene(mine)).toBe('conflict');
    expect(events.at(-1)).toMatchObject({ kind: 'conflict', file });
    expect(parseDocument(files.get(file)!.text).entities[0].name).toBe('from elsewhere'); // untouched
    // explicit overwrite
    expect(await sync.saveScene(mine, { overwrite: true })).toBe('saved');
    expect(parseDocument(files.get(file)!.text).entities[0].name).toBe('mine');
    expect(await sync.externalChanges()).toEqual([]);
  });

  it('saving unchanged content again does not rewrite the file', async () => {
    const { dir, files } = fakeDir();
    const sync = new FolderSync(dir);
    const doc = newDocument('Same');
    await sync.saveScene(doc);
    const m1 = files.get('Same.physicslab.json')!.modified;
    await sync.saveScene(doc);
    expect(files.get('Same.physicslab.json')!.modified).toBe(m1);
  });

  it('reading a file marks it as known, so a later external edit is a conflict', async () => {
    const { dir, touch } = fakeDir();
    const sync = new FolderSync(dir);
    touch('A.physicslab.json', serializeDocument(newDocument('A'), 1));
    await sync.readScene('A.physicslab.json');
    expect(await sync.externalChanges()).toEqual([]);
    touch('A.physicslab.json', serializeDocument(newDocument('A changed'), 1));
    expect(await sync.externalChanges()).toEqual(['A.physicslab.json']);
  });
});
