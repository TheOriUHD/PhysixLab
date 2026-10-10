/**
 * End-to-end tests of peer-to-peer collaboration (DT-23): two pages of the same browser context, one hosting and
 * one joining — over BroadcastChannel (room code) and over WebRTC with the copy/paste connection codes.
 */
import { assert, currentBrowser, newPage, pose, shot } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

let appUrl = null;
/** The app URL (learned from a throw-away page of the shared helper). */
async function baseUrl() {
  if (!appUrl) {
    const probe = await newPage('&scene=');
    appUrl = probe.url();
    await probe.close();
  }
  return appUrl;
}

/** A page in the given browser context (pages of one context share BroadcastChannel). */
async function pageIn(ctx) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(90000); // the software-GL browser is slow, especially with two pages on a busy machine
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  await page.goto(await baseUrl());
  await page.waitForFunction(() => !!window.physicslab && window.physicslab.viewport, null, { timeout: 30000 });
  await page.waitForTimeout(400);
  page.errors = errors;
  return page;
}

/** Two pages of one fresh browser context. */
async function pair() {
  const ctx = await currentBrowser().newContext({ viewport: { width: 1600, height: 900 } });
  return [await pageIn(ctx), await pageIn(ctx)];
}

const openDialog = async (page, name) => {
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.palette .palette-input');
  await page.keyboard.type('Collaborate');
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await page.waitForSelector('#collab-name');
  await page.fill('#collab-name', name);
};
const bodies = (page) =>
  page.evaluate(() => window.physicslab.store.bodies().map((b) => ({ id: b.id, name: b.name, type: b.shape.type })));
const waitBodies = (page, n, timeout = 60000) =>
  page.waitForFunction((n) => window.physicslab.store.bodies().length === n, n, { timeout });
const simMode = (page) => page.evaluate(() => window.physicslab.sim.mode);

test('collab: BroadcastChannel session - edits sync both ways, selection cursor, host-authoritative simulation', async () => {
  const [A, B] = await pair();
  await A.evaluate(() => window.physicslab.newScene());
  await A.click('.viewport-canvas', { position: { x: 700, y: 400 } });
  await A.keyboard.press('1'); // a box: armed, then placed at the pointer
  await A.keyboard.press('Enter');
  assert((await bodies(A)).length === 1, 'host has one box');

  await openDialog(A, 'Alice');
  await A.click('#collab-host');
  await A.waitForSelector('#collab-room-code');
  const room = (await A.textContent('#collab-room-code')).trim();
  assert(/^[A-Z0-9]{8}$/.test(room), `room code shown (${room})`);
  await A.keyboard.press('Escape');

  // The guest has its own, different scene first - joining replaces it.
  await B.evaluate(() => window.physicslab.newScene());
  await openDialog(B, 'Bob');
  await B.fill('#collab-room', room);
  await B.click('#collab-join');
  await waitBodies(B, 1);
  const [ba] = await bodies(A);
  const [bb] = await bodies(B);
  assert(ba.id === bb.id, 'the guest received the host box (same id)');
  await B.waitForFunction(() => window.physicslabCollab.session.status === 'live');
  await B.keyboard.press('Escape');
  await A.waitForFunction(() => window.physicslabCollab.session.peers.length === 1);

  // Guest adds a sphere through the real UI -> appears on the host.
  await B.click('.viewport-canvas', { position: { x: 900, y: 500 } });
  await B.keyboard.press('2');
  await B.keyboard.press('Enter');
  await waitBodies(A, 2);
  const sphere = (await bodies(B)).find((b) => b.type === 'sphere');
  assert(
    sphere && (await bodies(A)).some((b) => b.id === sphere.id),
    'sphere created on B exists on A with the same id',
  );

  // Host renames the box -> guest sees it. Concurrent edits to different fields both survive.
  await A.evaluate((id) => window.physicslab.store.update(id, { name: 'Renamed by Alice' }), ba.id);
  await B.evaluate((id) => window.physicslab.store.update(id, { position: [2, 3, 1] }), ba.id);
  await B.waitForFunction((id) => window.physicslab.store.body(id).name === 'Renamed by Alice', ba.id, {
    timeout: 60000,
  });
  await A.waitForFunction((id) => window.physicslab.store.body(id).position[0] === 2, ba.id, { timeout: 60000 });
  const sa = JSON.stringify(await A.evaluate(() => window.physicslab.store.toDocument().entities));
  const sb = JSON.stringify(await B.evaluate(() => window.physicslab.store.toDocument().entities));
  assert(sa === sb, 'documents are identical on both pages');

  // Bob selected the sphere (after adding it): Alice sees a coloured outline labelled "Bob".
  await A.waitForSelector('.collab-outline', { timeout: 60000 });
  const label = await A.textContent('.collab-outline .collab-label');
  assert(label === 'Bob', `selection cursor labelled with the peer's name (got ${label})`);
  const entity = await A.getAttribute('.collab-outline', 'data-entity');
  assert(entity === sphere.id, 'the outline is on the peer-selected object');
  await shot(A, 'collab-cursor');

  // Host-authoritative simulation.
  // Lift the sphere (the host edits, the guest receives it) so that it has something to fall.
  await A.evaluate((id) => window.physicslab.store.update(id, { position: [0.75, 6, 1.5] }), sphere.id);
  await B.waitForFunction((id) => window.physicslab.store.body(id).position[1] === 6, sphere.id);
  // Only the foreground tab renders frames: bring each page forward before reading its simulation.
  await B.bringToFront();
  const y0 = (await pose(B, sphere.id)).position[1];
  await A.evaluate(() => window.physicslab.sim.play());
  await B.waitForFunction(() => window.physicslab.sim.mode === 'running', null, { timeout: 60000 });
  await B.waitForFunction(([id, y0]) => window.physicslab.sim.poseOf(id).position[1] < y0 - 0.05, [sphere.id, y0], {
    timeout: 60000,
  });
  await A.bringToFront();
  await A.waitForFunction(([id, y0]) => window.physicslab.sim.poseOf(id).position[1] < y0 - 0.05, [sphere.id, y0]);
  const ya = (await pose(A, sphere.id)).position[1];
  const yb = await B.evaluate((id) => window.physicslab.sim.poseOf(id).position[1], sphere.id);
  assert(
    ya < y0 && yb < y0,
    `both pages simulate the fall (A ${ya.toFixed(2)}, B ${yb.toFixed(2)} < ${y0.toFixed(2)})`,
  );
  await B.evaluate(() => window.physicslab.sim.pause()); // a guest cannot pause the host's run
  await B.waitForTimeout(300);
  assert((await simMode(B)) === 'running', 'guest pause is overridden by the host');
  await A.evaluate(() => window.physicslab.sim.pause());
  await B.waitForFunction(() => window.physicslab.sim.mode === 'paused', null, { timeout: 60000 });
  await A.evaluate(() => window.physicslab.sim.reset());
  await B.waitForFunction(() => window.physicslab.sim.mode === 'edit', null, { timeout: 60000 });

  // Leaving.
  await B.evaluate(() => window.physicslabCollab.leave());
  await A.waitForFunction(() => window.physicslabCollab.session.peers.length === 0, null, { timeout: 60000 });
  assert(A.errors.length === 0, `no page errors on A: ${A.errors.join(' | ')}`);
  assert(B.errors.length === 0, `no page errors on B: ${B.errors.join(' | ')}`);
});

test('collab: WebRTC session with copy/paste connection codes (offer -> answer -> connected, edits sync)', async () => {
  const [A, B] = await pair();
  await A.evaluate(() => window.physicslab.newScene());
  await A.click('.viewport-canvas', { position: { x: 700, y: 400 } });
  await A.keyboard.press('1');
  await A.keyboard.press('Enter');
  await openDialog(A, 'Alice');
  await A.click('#collab-host');
  await A.waitForSelector('#collab-invite');
  await A.click('#collab-invite');
  await A.waitForFunction(() => document.querySelector('#collab-offer')?.value.startsWith('PLRTC1.'), null, {
    timeout: 60000,
  });
  const offer = await A.inputValue('#collab-offer');

  await openDialog(B, 'Bob');
  await B.evaluate(() => (document.querySelector('#collab-webrtc').open = true));
  await B.fill('#collab-offer-in', offer);
  await B.click('#collab-answer-btn');
  await B.waitForFunction(() => document.querySelector('#collab-answer')?.value.startsWith('PLRTC1.'), null, {
    timeout: 60000,
  });
  const answer = await B.inputValue('#collab-answer');

  await A.fill('#collab-answer-in', answer);
  await A.click('#collab-connect');
  await waitBodies(B, 1, 90000);
  await B.waitForFunction(() => window.physicslabCollab.session?.status === 'live', null, { timeout: 60000 });
  await A.waitForFunction(() => window.physicslabCollab.session.peers.some((p) => p.name === 'Bob'), null, {
    timeout: 60000,
  });

  const [ba] = await bodies(A);
  await B.evaluate((id) => window.physicslab.store.update(id, { name: 'Renamed over WebRTC' }), ba.id);
  await A.waitForFunction((id) => window.physicslab.store.body(id).name === 'Renamed over WebRTC', ba.id, {
    timeout: 60000,
  });
  await A.evaluate(() => window.physicslab.sim.play());
  await B.waitForFunction(() => window.physicslab.sim.mode === 'running', null, { timeout: 60000 });
  await A.evaluate(() => window.physicslab.sim.reset());
  await B.waitForFunction(() => window.physicslab.sim.mode === 'edit', null, { timeout: 60000 });
  assert(A.errors.length === 0, `no page errors on A: ${A.errors.join(' | ')}`);
  assert(B.errors.length === 0, `no page errors on B: ${B.errors.join(' | ')}`);
});

test('collab: a bad connection code is refused with a clear message', async () => {
  const B = await newPage('&scene=');
  await openDialog(B, 'Bob');
  await B.evaluate(() => (document.querySelector('#collab-webrtc').open = true));
  await B.fill('#collab-offer-in', 'hello world');
  await B.click('#collab-answer-btn');
  await B.waitForSelector('.toast:has-text("connection code")', { timeout: 5000 });
});
