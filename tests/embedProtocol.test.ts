/** DT-22 / DT-21 pure helpers: embed options, postMessage validation, iframe snippet, clipboard fallback, Open Graph. */
import { describe, expect, it } from 'vitest';
import { buildEmbedUrl, normalizeOrigin, readEmbedOptions } from '../src/app/embed/options';
import { envelope, extractSharePayload, originAllowed, parseMessage } from '../src/app/embed/protocol';
import { buildIframeSnippet, clampPx } from '../src/app/embed/snippet';
import { buildOpenGraphTags } from '../src/app/share/openGraph';
import { copyImageAndLink } from '../src/app/share/thumbnail';

describe('embed options', () => {
  it('is off without embed=1 and parses every option', () => {
    expect(readEmbedOptions('?scene=car')).toBeNull();
    expect(readEmbedOptions('?embed=0')).toBeNull();
    expect(readEmbedOptions('?embed=1')).toEqual({
      scene: null,
      autoplay: false,
      controls: true,
      camera: 'orbit',
      interact: false,
      view: null,
      origins: [],
    });
    expect(
      readEmbedOptions(
        '?embed=1&scene=wreck&autoplay=1&controls=0&camera=fixed&interact=1&view=1,2,3,4,5,6&origin=https://a.example/x,bad,javascript:alert(1),http://b.example:8080',
      ),
    ).toEqual({
      scene: 'wreck',
      autoplay: true,
      controls: false,
      camera: 'fixed',
      interact: true,
      view: [1, 2, 3, 4, 5, 6],
      origins: ['https://a.example', 'http://b.example:8080'],
    });
    expect(normalizeOrigin('ftp://x.example')).toBeNull();
  });

  it('builds a URL that reads back to the same options', () => {
    const url = buildEmbedUrl('https://lab.example/app/?junk=1#old', {
      payload: 's=AbC_-1',
      autoplay: true,
      controls: false,
      camera: 'fixed',
      interact: true,
      view: [1.234, 2, 3, 4, 5, 6],
      origins: ['https://host.example'],
    });
    expect(url.endsWith('#s=AbC_-1')).toBe(true);
    expect(url).not.toContain('junk');
    expect(readEmbedOptions(new URL(url).search)).toMatchObject({
      autoplay: true,
      controls: false,
      camera: 'fixed',
      interact: true,
      origins: ['https://host.example'],
    });
    expect(buildEmbedUrl('https://lab.example/', { scene: 'car' })).toBe('https://lab.example/?embed=1&scene=car');
  });
});

describe('postMessage validation', () => {
  const ok = (data: unknown) => {
    const r = parseMessage(data);
    if (r.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(r)}`);
    return r.parsed;
  };
  it('ignores anything that is not ours', () => {
    for (const d of [null, 'play', 42, [], {}, { type: 'other', cmd: 'play' }, { type: 'physixlab', event: 'ready' }])
      expect(parseMessage(d).kind).toBe('ignore');
  });
  it('accepts the documented commands', () => {
    expect(ok({ type: 'physixlab', cmd: 'play', id: 'a' })).toEqual({ id: 'a', command: { cmd: 'play' } });
    expect(ok({ type: 'physixlab', v: 1, cmd: 'step' }).command).toEqual({ cmd: 'step', count: 1 });
    expect(ok({ type: 'physixlab', cmd: 'step', count: 30 }).command).toEqual({ cmd: 'step', count: 30 });
    expect(ok({ type: 'physixlab', cmd: 'setCamera', position: [1, 2, 3] }).command).toMatchObject({
      position: [1, 2, 3],
    });
    expect(ok({ type: 'physixlab', cmd: 'setCamera', reset: true }).command).toMatchObject({ reset: true });
    expect(ok({ type: 'physixlab', cmd: 'loadScene', template: 'car' }).command).toEqual({
      cmd: 'loadScene',
      template: 'car',
    });
    expect(ok({ type: 'physixlab', cmd: 'loadScene', share: '#s=abc' }).command).toEqual({
      cmd: 'loadScene',
      share: '#s=abc',
    });
    expect(ok({ type: 'physixlab', cmd: 'loadScene', document: { version: 1 } }).command.cmd).toBe('loadScene');
  });
  it('rejects malformed messages with a reason (and keeps the id for the reply)', () => {
    const bad = (d: unknown) => {
      const r = parseMessage(d);
      expect(r.kind).toBe('invalid');
      return r as { kind: 'invalid'; id?: string; message: string };
    };
    const unknown = bad({ type: 'physixlab', cmd: 'explode', id: 'q' });
    expect(unknown.id).toBe('q');
    expect(unknown.message).toContain('explode');
    expect(bad({ type: 'physixlab', cmd: 'play', v: 2 }).message).toMatch(/version/);
    expect(bad({ type: 'physixlab', cmd: 'play', id: 5 }).message).toMatch(/id/);
    expect(bad({ type: 'physixlab', cmd: 'play', id: 'x'.repeat(65) }).message).toMatch(/id/);
    for (const count of [0, -1, 1.5, 601, '3', NaN]) bad({ type: 'physixlab', cmd: 'step', count });
    bad({ type: 'physixlab', cmd: 'setCamera' });
    bad({ type: 'physixlab', cmd: 'setCamera', position: [1, 2] });
    bad({ type: 'physixlab', cmd: 'setCamera', position: [1, 2, Infinity] });
    bad({ type: 'physixlab', cmd: 'setCamera', position: [1, 2, 1e9] });
    bad({ type: 'physixlab', cmd: 'setCamera', reset: 'yes' });
    bad({ type: 'physixlab', cmd: 'loadScene' });
    bad({ type: 'physixlab', cmd: 'loadScene', template: 'car', share: '#s=a' });
    bad({ type: 'physixlab', cmd: 'loadScene', template: '../etc' });
    bad({ type: 'physixlab', cmd: 'loadScene', document: [] });
    bad({ type: 'physixlab', cmd: 'loadScene', share: 12 });
  });
  it('origin allow-list: any parent without one, exact match with one', () => {
    expect(originAllowed('https://x.example', [])).toBe(true);
    expect(originAllowed('null', [])).toBe(true);
    expect(originAllowed('https://x.example', ['https://x.example'])).toBe(true);
    expect(originAllowed('https://x.example.evil.test', ['https://x.example'])).toBe(false);
    expect(originAllowed('null', ['https://x.example'])).toBe(false);
  });
  it('envelopes carry the type, version and id; share payloads are extracted from links and hashes', () => {
    expect(envelope({ event: 'error', code: 'c', message: 'm' }, 'i')).toEqual({
      type: 'physixlab',
      v: 1,
      event: 'error',
      code: 'c',
      message: 'm',
      id: 'i',
    });
    expect(extractSharePayload('https://x.example/app/#s=Ab_-9')).toBe('s=Ab_-9');
    expect(extractSharePayload('#scene=QQ')).toBe('scene=QQ');
    expect(extractSharePayload('s=Zz')).toBe('s=Zz');
    expect(extractSharePayload('https://x.example/')).toBeNull();
  });
});

describe('snippet, Open Graph, clipboard', () => {
  it('builds an escaped iframe snippet with clamped size', () => {
    const s = buildIframeSnippet({
      url: 'https://x.example/?embed=1&autoplay=1#s=a"b',
      width: 640,
      height: 400,
      title: 'A "quoted" <scene>',
    });
    expect(s).toContain('src="https://x.example/?embed=1&amp;autoplay=1#s=a&quot;b"');
    expect(s).toContain('width="640" height="400"');
    expect(s).toContain('title="A &quot;quoted&quot; &lt;scene&gt;"');
    expect(clampPx(5, 400)).toBe(120);
    expect(clampPx(99999, 400)).toBe(4000);
    expect(clampPx(NaN, 400)).toBe(400);
  });
  it('builds Open Graph tags with escaping', () => {
    const t = buildOpenGraphTags({
      title: 'Tom & "Jerry"',
      url: 'https://x.example/#s=a',
      imageUrl: 'https://x.example/p.png',
      imageWidth: 640,
      imageHeight: 360,
    });
    expect(t).toContain('<meta property="og:title" content="Tom &amp; &quot;Jerry&quot;">');
    expect(t).toContain('<meta property="og:image" content="https://x.example/p.png">');
    expect(t).toContain('og:image:width" content="640"');
    expect(t).toContain('twitter:card" content="summary_large_image"');
  });
  it('copies image + link as one item, falls back to the link, and reports failure honestly', async () => {
    class Item {
      constructor(public items: Record<string, Blob>) {}
    }
    const written: Item[][] = [];
    const texts: string[] = [];
    const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
    const good = {
      write: (i: Item[]) => (written.push(i), Promise.resolve()),
      writeText: (t: string) => (texts.push(t), Promise.resolve()),
    };
    expect(await copyImageAndLink(png, 'https://x.example/#s=a', good, Item)).toBe('image+link');
    expect(Object.keys(written[0][0].items).sort()).toEqual(['image/png', 'text/plain']);
    expect(await written[0][0].items['text/plain'].text()).toBe('https://x.example/#s=a');
    // no ClipboardItem support: text only
    expect(await copyImageAndLink(png, 'u', good, undefined)).toBe('link');
    expect(texts).toEqual(['u']);
    // image write refused, plain text via write() accepted
    let n = 0;
    const picky = { write: () => (n++ === 0 ? Promise.reject(new Error('no')) : Promise.resolve()) };
    expect(await copyImageAndLink(png, 'u', picky, Item)).toBe('link');
    // everything refused
    const none = { write: () => Promise.reject(new Error('x')), writeText: () => Promise.reject(new Error('x')) };
    expect(await copyImageAndLink(png, 'u', none, Item)).toBe('none');
    expect(await copyImageAndLink(png, 'u', undefined, Item)).toBe('none');
  });
});
