/**
 * Sound (package FX, FX-10 … FX-15), driven through the real UI in a real Chromium: the lazily started audio context
 * (checked in a browser with the strict autoplay policy, where a premature context would log a warning), the Sound
 * panel, mute, real collisions that make sound, offline renders of the very graphs the engine plays (measured: the
 * frequency of the clang, how long wood rings, the fundamental of an engine at 1 000 and 5 000 rpm), rolling and
 * sliding voices, motorised joints, wind, spatialisation, the time scale, the event sounds and the interface sounds.
 * Screenshots (E2E_SHOTS=1) go to e2e/out/audio-*.png.
 */
import { chromium } from 'playwright-core';
import { assert, chromePath, newPage, shot, simTime } from '../helpers.mjs';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const noErrors = (page) => assert(page.errors.length === 0, `no console errors: ${page.errors.join(' | ')}`);
const play = (page) => page.evaluate(() => window.physicslab.sim.play());
const pause = (page) => page.evaluate(() => window.physicslab.sim.pause());
/**
 * Any real click inside the page is a user gesture; this one lands on empty sky in the select tool. Returns once the
 * context runs and the engine has prepared its common sounds (a slow software-GL page needs a while for that).
 */
const gesture = async (page) => {
  await page.mouse.click(330, 160);
  await page.waitForFunction(() => window.physicslab.audio.state === 'running', null, { timeout: 15000 });
  await page.waitForFunction(() => window.physicslab.audioDirector.stats.warming === 0, null, { timeout: 90000 });
};
const stats = (page) => page.evaluate(() => window.physicslab.audioDirector.stats);
const recent = (page) => page.evaluate(() => window.physicslab.audio.recent.map((r) => ({ ...r })));
const keysOf = (page) => page.evaluate(() => window.physicslab.audio.cachedKeys());
const loops = (page) => page.evaluate(() => window.physicslab.audioDirector.describeLoops());
const hasKey = (keys, prefix) => keys.some((k) => k.startsWith(prefix));

/** Sound-related console output (warnings included) and requests for audio files, collected on a page. */
function watchAudioNoise(page) {
  const noise = [];
  page.on('console', (m) => {
    if (/audiocontext|autoplay|user gesture|web audio/i.test(m.text())) noise.push(`${m.type()}: ${m.text()}`);
  });
  page.on('request', (r) => {
    if (/\.(mp3|wav|ogg|m4a|aac|flac|opus)(\?|$)/i.test(r.url()) || r.resourceType() === 'media')
      noise.push(`request: ${r.url()}`);
  });
  return noise;
}

/** Load a scene built with the Builder in the page: `build(b)` runs there with a `Builder`. */
const loadScene = (page, name, build, view) =>
  page.evaluate(
    async ({ name, src, view }) => {
      const { Builder } = await import('/src/model/builder.ts');
      const b = new Builder(name);
      new Function(`return (${src})`)()(b);
      const a = window.physicslab;
      a.loadDocument(b.done());
      if (view) a.viewport.setView(view);
    },
    { name, src: build.toString(), view },
  );

// -- FX-10: the context starts lazily, on a user gesture -------------------------------------------------------------

test('audio: no AudioContext until a user gesture, then it starts inside that gesture — and the strict autoplay policy logs nothing', async () => {
  // A browser with the standard autoplay policy (the test browser lifts it), so a premature context would warn.
  const probe = await newPage();
  const origin = new URL(probe.url()).origin;
  await probe.close();
  const browser = await chromium.launch({
    executablePath: chromePath(),
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--no-sandbox',
      '--autoplay-policy=document-user-activation-required',
    ],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    const messages = [];
    page.on('console', (m) => messages.push(`${m.type()}: ${m.text()}`));
    page.on('pageerror', (e) => messages.push(`pageerror: ${e.message}`));
    await page.addInitScript(() => {
      localStorage.clear();
      // Record every context that is created, and whether that happened inside a trusted input event.
      window.__ctxs = [];
      const Orig = window.AudioContext;
      window.AudioContext = class extends Orig {
        constructor(...a) {
          super(...a);
          window.__ctxs.push({ event: window.event?.type ?? null, trusted: window.event?.isTrusted ?? false });
        }
      };
    });
    await page.goto(`${origin}/?nowelcome&scene=pit`);
    await page.waitForFunction(() => !!window.physicslab && window.physicslab.viewport, null, { timeout: 30000 });
    await page.waitForTimeout(700);
    let s = await page.evaluate(() => ({ state: window.physicslab.audio.state, ctxs: window.__ctxs.length }));
    assert(s.state === 'idle' && s.ctxs === 0, `nothing created before any gesture ${JSON.stringify(s)}`);
    // Moving the mouse and scrolling are not gestures.
    await page.mouse.move(400, 300);
    await page.mouse.wheel(0, 40);
    await page.waitForTimeout(250);
    s = await page.evaluate(() => ({ state: window.physicslab.audio.state, ctxs: window.__ctxs.length }));
    assert(s.state === 'idle' && s.ctxs === 0, `still nothing after moving and scrolling ${JSON.stringify(s)}`);
    // A click is a gesture: the context is created inside the pointer event.
    await page.mouse.click(330, 160);
    await page.waitForFunction(() => window.physicslab.audio.state === 'running', null, { timeout: 15000 });
    s = await page.evaluate(() => ({ ctxs: window.__ctxs }));
    assert(
      s.ctxs.length === 1 && s.ctxs[0].trusted && /^(pointerdown|pointerup|keydown|touchend)$/.test(s.ctxs[0].event),
      `exactly one context, created inside a user input event ${JSON.stringify(s.ctxs)}`,
    );
    // Run the simulation: collisions make sound; mute and unmute (the context suspends and resumes on its own).
    await page.click('.tbtn.play');
    await page.waitForFunction(() => window.physicslab.audioDirector.stats.started > 3, null, { timeout: 90000 });
    await page.keyboard.press('Shift+M');
    await page.waitForFunction(() => window.physicslab.audio.context.state === 'suspended', null, { timeout: 10000 });
    await page.keyboard.press('Shift+M');
    await page.waitForFunction(() => window.physicslab.audio.context.state === 'running', null, { timeout: 10000 });
    assert((await page.evaluate(() => window.__ctxs.length)) === 1, 'muting and unmuting reuse the one context');
    const bad = messages.filter(
      (m) =>
        /audiocontext|autoplay|user gesture|not allowed to start|error/i.test(m) && !/GL Driver|ReadPixels/i.test(m),
    );
    assert(bad.length === 0, `no autoplay warnings or errors: ${bad.join(' | ')}`);
  } finally {
    await browser.close();
  }
});

test('audio: keys that are not user activations (Escape) do not start the context; the first activating event does', async () => {
  const page = await newPage();
  await page.evaluate(() => {
    // The browser's activation record, faked: Playwright's own evaluate calls count as gestures, a real Escape does not.
    window.__activation = { hasBeenActive: false };
    Object.defineProperty(navigator, 'userActivation', { configurable: true, get: () => window.__activation });
  });
  await page.keyboard.press('Escape');
  await page.mouse.click(330, 160); // not yet "active" as far as the engine is told
  await page.waitForTimeout(300);
  assert(
    (await page.evaluate(() => window.physicslab.audio.state)) === 'idle',
    'no context without a recorded activation',
  );
  await page.evaluate(() => (window.__activation.hasBeenActive = true));
  await page.keyboard.press('KeyA');
  await page.waitForFunction(() => window.physicslab.audio.state === 'running', null, { timeout: 15000 });
  noErrors(page);
});

test('audio: with sound switched off no context is ever created; the panel switch turns it on', async () => {
  const page = await newPage();
  const noise = watchAudioNoise(page);
  await page.evaluate(() => window.physicslab.audioDirector.setSettings({ enabled: false }));
  await page.mouse.click(330, 160);
  await page.waitForTimeout(400);
  let s = await page.evaluate(() => ({
    state: window.physicslab.audio.state,
    ctx: window.physicslab.audio.context,
    watched: window.physicslab.audioDirector.stats.contactsWatched,
  }));
  assert(s.state === 'idle' && s.ctx === null, `no context while sound is off ${JSON.stringify(s)}`);
  assert(s.watched === false, 'the physics is asked for no contact events for sound');
  await page.click('#tab-fx');
  await page.waitForSelector('.fx-panel .section-head:has-text("Sound")');
  await page.click('.fx-panel label.switch:has-text("Sound")');
  await page.waitForFunction(() => window.physicslab.audio.state === 'running', null, { timeout: 15000 });
  s = await page.evaluate(() => window.physicslab.prefs.value.audio.enabled);
  assert(s === true, 'switched on from the panel (that click is the gesture)');
  assert(noise.length === 0, `no audio noise: ${noise.join(' | ')}`);
  noErrors(page);
});

// -- FX-10: the Sound panel, mute, persistence -----------------------------------------------------------------------

test('audio: Sound panel — volumes, switches, mute (Shift+M leaves Measure on M), top-bar speaker; settings persist', async () => {
  const page = await newPage();
  await gesture(page);
  await page.click('#tab-fx');
  await page.waitForSelector('.fx-panel .section-head:has-text("Sound")');
  await page.evaluate(() => {
    for (const h of document.querySelectorAll('.fx-panel .section-head')) {
      const t = h.textContent.trim().toLowerCase();
      if (t.startsWith('visual') || t === 'effects' || t === 'preview') h.click(); // fold the particle sections away
    }
  });
  await page.waitForTimeout(400);
  await shot(page, 'audio-panel');
  const audio = () => page.evaluate(() => window.physicslab.prefs.value.audio);
  let a = await audio();
  assert(a.enabled && !a.muted && a.master > 0.5 && a.spatial && a.uiSounds, `defaults ${JSON.stringify(a)}`);

  // Sliders: the master volume and the "Rolling & sliding" volume.
  const setRange = (label, pos) =>
    page.evaluate(
      ({ label, pos }) => {
        const row = [...document.querySelectorAll('.fx-panel .row')].find(
          (r) => r.querySelector('.row-label')?.textContent === label,
        );
        const range = row.querySelector('input[type=range]');
        range.value = String(pos);
        range.dispatchEvent(new Event('input', { bubbles: true }));
      },
      { label, pos },
    );
  await setRange('Master volume', 500);
  await setRange('Rolling', 250);
  a = await audio();
  assert(
    Math.abs(a.master - 0.5) < 0.011 && Math.abs(a.volume.rolling - 0.25) < 0.011,
    `sliders ${a.master} ${a.volume.rolling}`,
  );

  // The volumes reach the bus gains (master 0.5 → −12 dB).
  await page.waitForTimeout(300);
  const g = await page.evaluate(() => window.physicslab.audio.volumeOf('rolling'));
  assert(Math.abs(g - 0.25 * 0.0625) < 1e-6, `bus volume ${g}`);

  // Switches: the Doppler shift, then 3D positioning off and on.
  await page.click('.fx-panel label.switch:has-text("Doppler shift")');
  await page.click('.fx-panel label.switch:has-text("3D positioning")');
  a = await audio();
  assert(a.doppler === true && a.spatial === false, 'doppler on, 3D positioning off');
  await page.click('.fx-panel label.switch:has-text("3D positioning")');

  // M is the Measure tool's key and stays so; Shift+M mutes. (A click in the viewport takes the focus off the sliders.)
  await page.mouse.click(330, 160);
  await page.keyboard.press('KeyM');
  assert(
    (await page.evaluate(() => window.physicslab.prefs.value.tool)) === 'measure',
    'M still selects the Measure tool',
  );
  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+M');
  a = await audio();
  assert(a.muted === true, 'Shift+M mutes');
  assert((await page.evaluate(() => window.physicslab.prefs.value.tool)) !== 'measure', 'Shift+M did not switch tools');
  assert((await page.getAttribute('.sound-btn', 'aria-pressed')) === 'true', 'the speaker button shows the mute');
  await page.waitForTimeout(400); // the switch animation
  await shot(page, 'audio-muted');
  // The speaker button unmutes again; the mute switch of the panel follows.
  await page.click('.sound-btn');
  a = await audio();
  assert(a.muted === false, 'the speaker button unmutes');
  assert((await page.getAttribute('.sound-btn', 'aria-pressed')) === 'false', 'and shows it');
  assert(
    (await page.evaluate(() => document.querySelector('.sound-btn').title)).includes('Shift+M'),
    'the tooltip names the shortcut',
  );

  // The command palette finds the commands.
  await page.keyboard.press('Control+KeyK');
  await page.keyboard.type('mute');
  await page.waitForSelector('.palette .palette-item');
  const labels = await page.locator('.palette-item .palette-label').allTextContents();
  assert(
    labels.some((l) => /mute sound/i.test(l)),
    `the palette lists Mute sound (${labels.join(', ')})`,
  );
  await page.keyboard.press('Escape');

  // Persisted across a reload.
  await page.click('.fx-panel label.switch:has-text("Interface sounds")');
  await page.reload();
  await page.waitForFunction(() => !!window.physicslab && window.physicslab.viewport);
  a = await audio();
  assert(
    Math.abs(a.master - 0.5) < 0.011 &&
      Math.abs(a.volume.rolling - 0.25) < 0.011 &&
      a.doppler === true &&
      a.uiSounds === false,
    `after reload ${JSON.stringify(a)}`,
  );
  noErrors(page);
});

// -- FX-10 / FX-11: real collisions make sound ----------------------------------------------------------------------------

test('audio: collisions play material sounds scaled by the impact, measured at the output; mute silences them; no sample files', async () => {
  const page = await newPage();
  const noise = watchAudioNoise(page);
  await loadScene(
    page,
    'Impact balls',
    (b) => {
      const mats = ['steel', 'wood', 'glass', 'rubber', 'concrete'];
      mats.forEach((m, i) =>
        b.body(`${m} ball`, 'sphere', [0.5, 0.5, 0.5], [i * 1.4 - 2.8, 1.2 + i * 0.6, 0], { material: m }),
      );
      // A hard drop: a glass ball from 30 m shatters on the ground.
      b.body('Glass bomb', 'sphere', [0.4, 0.4, 0.4], [0, 30, 3], { material: 'glass' });
    },
    { position: [0, 3, 12], target: [0, 1, 0] },
  );
  await gesture(page);
  await play(page);
  await page.waitForFunction(() => window.physicslab.audio.recent.length >= 5, null, { timeout: 90000 });
  // Sample the measured output level while the rings die away.
  let peak = 0;
  for (let i = 0; i < 40; i++) {
    peak = Math.max(peak, await page.evaluate(() => window.physicslab.audio.level()));
    await page.waitForTimeout(25);
  }
  assert(peak > 0.003, `sound reaches the output (peak RMS ${peak.toFixed(4)})`);
  await simTime(page, 3);
  await page.waitForFunction(() => window.physicslab.audio.cachedKeys().some((k) => k.endsWith('|x')), null, {
    timeout: 120000,
  });
  const keys = await keysOf(page);
  for (const m of ['steel', 'wood', 'glass', 'rubber', 'concrete'])
    assert(hasKey(keys, `i|${m}|`), `${m} impact sound rendered (${keys.filter((k) => k.startsWith('i|')).join(' ')})`);
  assert(hasKey(keys, 'i|ground|'), 'the ground thumps under them');
  assert(
    keys.some((k) => k.startsWith('i|glass|') && k.endsWith('|x')),
    'the glass bomb breaks: its ring is cut short',
  );
  await page.waitForFunction(() => window.physicslab.audio.cachedKeys().some((k) => k.startsWith('e|b|glass|')), null, {
    timeout: 30000,
  });
  const levels = await recent(page);
  assert(
    levels.every((r) => r.category === 'impacts' || r.category === 'ui' || r.category === 'rolling'),
    'categories',
  );
  const gains = levels.filter((r) => r.key.startsWith('i|steel|')).map((r) => r.gain);
  assert(gains.length > 0 && Math.max(...gains) > 0.01, `steel impact gain ${gains}`);

  // Mute: silent within a moment, and the physics stops being asked for contacts.
  await page.keyboard.press('Shift+M');
  await page.waitForFunction(() => window.physicslab.audio.context.state === 'suspended', null, { timeout: 10000 });
  assert((await page.evaluate(() => window.physicslab.audio.level())) === 0, 'muted output is silent');
  assert((await stats(page)).contactsWatched === false, 'no contact events while muted');
  const started = (await stats(page)).started;
  await page.waitForTimeout(500);
  assert((await stats(page)).started === started, 'no new voices while muted');
  await page.keyboard.press('Shift+M');
  await page.waitForFunction(() => window.physicslab.audioDirector.stats.contactsWatched === true, null, {
    timeout: 10000,
  });

  assert(noise.length === 0, `no sample files were requested: ${noise.join(' | ')}`);
  noErrors(page);
});

// -- FX-11: the synthesised waveforms, rendered offline in the browser and measured ------------------------------------------

/** Run `fn(helpers)` in the page with the audio modules imported. */
const inPage = (page, fn) =>
  page.evaluate(async (src) => {
    const off = await import('/src/audio/offline.ts');
    const impact = await import('/src/audio/impact.ts');
    const dsp = await import('/src/audio/dsp.ts');
    const motor = await import('/src/audio/motor.ts');
    const roll = await import('/src/audio/rolling.ts');
    const spatial = await import('/src/audio/spatial.ts');
    const db = (x) => 20 * Math.log10(Math.max(x, 1e-9));
    const peakOf = (c) => c.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const plan = (o) =>
      impact.planImpact({
        speed: 4,
        impulse: 60,
        matA: 'steel',
        matB: 'ground',
        sizeA: 0.4,
        sizeB: 99,
        massA: 20,
        massB: 0,
        ...o,
      });
    return new Function(`return (${src})`)()({ off, impact, dsp, motor, roll, spatial, db, peakOf, plan });
  }, fn.toString());

test('audio: material impact sounds rendered offline — clang, knock, chime, thud; size, impulse and partner damping (FX-11)', async () => {
  const page = await newPage();
  const r = await inPage(page, async ({ off, dsp, plan, peakOf, db }) => {
    const out = {};
    for (const m of ['steel', 'wood', 'glass', 'rubber', 'concrete', 'foam']) {
      const rendered = await off.renderImpactOffline(plan({ matA: m }).slice(0, 1));
      const c = rendered.channels[0];
      out[m] = {
        f: dsp.dominantFrequency(c, rendered.sampleRate, 100, 12000, 32768),
        ring: dsp.ringTime(c, rendered.sampleRate),
        centroid: dsp.spectralCentroid(c, rendered.sampleRate),
        peak: peakOf(c),
        sr: rendered.sampleRate,
      };
    }
    const beam = await off.renderImpactOffline(plan({ sizeA: 4 }).slice(0, 1));
    const ball = await off.renderImpactOffline(plan({ sizeA: 0.4 }).slice(0, 1));
    out.sizeLow = dsp.dominantFrequency(beam.channels[0], beam.sampleRate, 60, 8000, 32768);
    out.sizeHigh = dsp.dominantFrequency(ball.channels[0], ball.sampleRate, 60, 8000, 32768);
    out.byImpulse = [];
    for (const impulse of [5, 50, 500, 5000]) {
      const x = await off.renderImpactOffline(plan({ impulse }));
      out.byImpulse.push(db(peakOf(x.channels[0])));
    }
    out.onFoam = dsp.ringTime(
      (await off.renderImpactOffline(plan({ matB: 'foam', sizeB: 1, massB: 20 }).slice(0, 1))).channels[0],
      44100,
    );
    out.onSteel = dsp.ringTime(
      (await off.renderImpactOffline(plan({ matB: 'steel', sizeB: 1, massB: 20 }).slice(0, 1))).channels[0],
      44100,
    );
    return out;
  });
  assert(
    r.steel.peak > 0.05 && r.glass.peak > 0.05 && r.wood.peak > 0.02,
    `audible: ${JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.peak])))}`,
  );
  assert(r.steel.ring > 0.4 && r.glass.ring > 0.3, `metal and glass ring (${r.steel.ring} / ${r.glass.ring})`);
  assert(
    r.wood.ring < 0.2 && r.concrete.ring < 0.12 && r.rubber.ring < 0.1,
    `wood, stone and rubber are short (${r.wood.ring} / ${r.concrete.ring} / ${r.rubber.ring})`,
  );
  assert(r.steel.ring > 4 * r.wood.ring, 'steel rings several times longer than wood');
  assert(
    r.glass.centroid > r.steel.centroid &&
      r.steel.centroid > r.wood.centroid &&
      r.steel.centroid > 1.5 * r.rubber.centroid,
    `brightness: glass > steel > wood, rubber dull ${JSON.stringify([r.glass.centroid, r.steel.centroid, r.wood.centroid, r.rubber.centroid])}`,
  );
  assert(r.glass.f > 1800 && r.steel.f > 500 && r.steel.f < 1300, `fundamentals glass ${r.glass.f} steel ${r.steel.f}`);
  assert(r.sizeLow < r.sizeHigh / 2, `a 4 m beam clangs lower than a 0.4 m ball (${r.sizeLow} vs ${r.sizeHigh} Hz)`);
  assert(
    r.byImpulse[0] < r.byImpulse[1] && r.byImpulse[1] < r.byImpulse[2] && r.byImpulse[2] < r.byImpulse[3],
    `louder with the impulse ${r.byImpulse.map((x) => x.toFixed(1))} dB`,
  );
  assert(r.onFoam < r.onSteel * 0.7, `steel on foam is damped (${r.onFoam} vs ${r.onSteel} s)`);
  noErrors(page);
});

// -- FX-13: engine, motor and wind -----------------------------------------------------------------------------------------

test('audio: engine and motor voices rendered offline — pitch follows rpm, brightness and level follow load, blade-pass chop, wind (FX-13)', async () => {
  const page = await newPage();
  const r = await inPage(page, async ({ off, dsp, peakOf }) => {
    const sr = 44100;
    const f = async (kind, rpm, load) =>
      (await off.renderMotorOffline(kind, rpm, load, 1.2)).channels[0].subarray(sr * 0.2);
    const out = {};
    // Combustion: the firing frequency is rpm/60 × 3 → 50 Hz at 1 000 rpm and 250 Hz at 5 000 rpm.
    const lo = await f('combustion', 1000, 0.5);
    const hi = await f('combustion', 5000, 0.5);
    out.combLo = dsp.dominantFrequency(lo, sr, 30, 90, 32768);
    out.combHi = dsp.dominantFrequency(hi, sr, 150, 400, 32768);
    out.combLoRms = dsp.rms(lo);
    out.combHiRms = dsp.rms(hi);
    // Load opens the filter and raises the level.
    const light = await f('combustion', 3000, 0.05);
    const heavy = await f('combustion', 3000, 1);
    out.loadCentroid = [dsp.spectralCentroid(light, sr, 16384), dsp.spectralCentroid(heavy, sr, 16384)];
    out.loadRms = [dsp.rms(light), dsp.rms(heavy)];
    // Electric whine climbs with speed.
    out.electric = [];
    for (const rpm of [150, 600, 2400])
      out.electric.push(dsp.dominantFrequency(await f('electric', rpm, 0.5), sr, 100, 4000, 32768));
    // Rotor: the loudness is chopped at the blade-pass frequency (300 rpm, two blades → 10 Hz).
    // The envelope in 25 ms windows (40 Hz) keeps the oscillators' own ripple out of the picture.
    const W = 1102;
    const envelope = (x) => {
      const env = new Float32Array(Math.floor(x.length / W));
      for (let i = 0; i < env.length; i++) {
        let s = 0;
        for (let j = 0; j < W; j++) s += Math.abs(x[i * W + j]);
        env[i] = s / W;
      }
      const mean = env.reduce((a, b) => a + b, 0) / env.length;
      return env.map((v) => v - mean);
    };
    // Prominence of the strongest peak between 3 and 19 Hz over the median of that band.
    const prominence = (env) => {
      const mag = dsp.spectrum(env, 512);
      const lo = Math.round((3 * 512) / (sr / W));
      const hi = Math.round((19 * 512) / (sr / W));
      const band = Array.from(mag.slice(lo, hi)).sort((a, b) => a - b);
      return band[band.length - 1] / Math.max(1e-9, band[Math.floor(band.length / 2)]);
    };
    const rotor = (await off.renderMotorOffline('rotor', 300, 0.6, 4)).channels[0].subarray(sr * 0.5);
    out.chop = dsp.dominantFrequency(envelope(rotor), sr / W, 3, 19, 512);
    out.chopProminence = prominence(envelope(rotor));
    const fast = (await off.renderMotorOffline('rotor', 3000, 0.6, 4)).channels[0].subarray(sr * 0.5);
    out.noChopProminence = prominence(envelope(fast));
    // A jet roars louder with thrust.
    out.jet = [
      dsp.rms((await off.renderMotorOffline('jet', 0, 0.2, 1)).channels[0]),
      dsp.rms((await off.renderMotorOffline('jet', 0, 1, 1)).channels[0]),
    ];
    // Wind.
    const w = [];
    for (const v of [4, 15, 30, 45]) {
      const x = (await off.renderWindOffline(v, 1)).channels[0];
      w.push({ rms: dsp.rms(x), centroid: dsp.spectralCentroid(x, sr, 16384), peak: peakOf(x) });
    }
    out.wind = w;
    out.stopped = dsp.rms((await off.renderMotorOffline('combustion', 0, 1, 0.5)).channels[0]);
    return out;
  });
  assert(Math.abs(r.combLo - 50) < 6, `combustion at 1 000 rpm fires at ≈ 50 Hz (${r.combLo})`);
  assert(Math.abs(r.combHi - 250) < 25, `combustion at 5 000 rpm fires at ≈ 250 Hz (${r.combHi})`);
  assert(r.combHi > 4 * r.combLo, 'pitch rose with rpm');
  assert(r.combHiRms > r.combLoRms, 'and so did the level');
  assert(
    r.loadCentroid[1] > r.loadCentroid[0] * 1.2 && r.loadRms[1] > r.loadRms[0] * 1.3,
    `load: brighter and louder ${JSON.stringify([r.loadCentroid, r.loadRms])}`,
  );
  assert(r.electric[0] < r.electric[1] && r.electric[1] < r.electric[2], `the electric whine climbs ${r.electric}`);
  assert(Math.abs(r.chop - 10) < 1, `the rotor is chopped at the blade-pass frequency ≈ 10 Hz (${r.chop})`);
  assert(
    r.chopProminence > 2 * r.noChopProminence && r.chopProminence > 8,
    `a slow rotor is strongly chopped, a fast one is a steady buzz (${r.chopProminence.toFixed(1)} vs ${r.noChopProminence.toFixed(1)})`,
  );
  assert(r.jet[1] > 2 * r.jet[0], `the jet roars louder with thrust ${r.jet}`);
  assert(
    r.wind[0].rms < r.wind[1].rms && r.wind[1].rms < r.wind[2].rms && r.wind[2].rms < r.wind[3].rms,
    `wind gets louder with speed ${r.wind.map((w) => w.rms.toFixed(4))}`,
  );
  assert(r.wind[3].centroid > r.wind[1].centroid, 'and brighter');
  assert(r.stopped < 1e-4, `a stopped engine is silent (${r.stopped})`);
  noErrors(page);
});

test('audio: rolling rumble and sliding scrape rendered offline follow speed and load (FX-12)', async () => {
  const page = await newPage();
  const r = await inPage(page, async ({ off, dsp }) => {
    const sr = 44100;
    const run = async (o) =>
      (
        await off.renderRollingOffline(
          { cls: 'metal', speed: 4, slip: 0, load: 1500, size: 0.5, rounded: true, ...o },
          1,
        )
      ).channels[0];
    const rollSlow = await run({ speed: 1 });
    const rollFast = await run({ speed: 8 });
    const rolling = await run({});
    const sliding = await run({ rounded: false, slip: 4 });
    const heavy = await run({ load: 20000 });
    const light = await run({ load: 20 });
    return {
      slow: dsp.rms(rollSlow),
      fast: dsp.rms(rollFast),
      slowC: dsp.spectralCentroid(rollSlow, sr, 16384),
      fastC: dsp.spectralCentroid(rollFast, sr, 16384),
      rolling: dsp.spectralCentroid(rolling, sr, 16384),
      sliding: dsp.spectralCentroid(sliding, sr, 16384),
      slidingRms: dsp.rms(sliding),
      heavy: dsp.rms(heavy),
      light: dsp.rms(light),
    };
  });
  assert(r.fast > r.slow * 1.5, `rolling is louder faster (${r.slow} → ${r.fast})`);
  assert(r.fastC > r.slowC, `and brighter (${r.slowC} → ${r.fastC})`);
  assert(r.sliding > 3 * r.rolling, `a scrape is a higher noise than a rumble (${r.rolling} vs ${r.sliding} Hz)`);
  assert(r.slidingRms > 0.01, `the scrape is audible (${r.slidingRms})`);
  assert(r.heavy > 1.5 * r.light, `a heavier body is louder (${r.light} → ${r.heavy})`);
  noErrors(page);
});

// -- FX-12 / FX-13 live: voices that follow the simulation --------------------------------------------------------------------

test('audio: a motorised joint and a rolling ball get voices that follow the simulation; pitch follows the time scale (FX-12, FX-13, FX-10)', async () => {
  const page = await newPage();
  await loadScene(
    page,
    'Voices',
    (b) => {
      const base = b.body('Base', 'box', [0.6, 0.6, 0.6], [4, 1.4, -2], { bodyType: 'static', material: 'steel' });
      const wheel = b.body('Flywheel', 'cylinder', [0.5, 0.12, 0.5], [4, 1.4, -1.8], {
        material: 'steel',
        rotation: [0.7071, 0, 0, 0.7071],
      });
      b.joint('hinge', base, wheel, [4, 1.4, -1.8], [0, 0, 1], {
        motor: {
          mode: 'velocity',
          targetVelocity: 4,
          targetPosition: 0,
          stiffness: 0,
          damping: 60,
          maxForce: 400,
          keyPos: '',
          keyNeg: '',
          slewRate: 1,
          brake: false,
        },
      });
      b.body('Rolling ball', 'sphere', [0.5, 0.5, 0.5], [-6, 0.25, 2], { material: 'steel', velocity: [6, 0, 0] });
    },
    { position: [0, 3, 12], target: [0, 1, 0] },
  );
  await gesture(page);
  await play(page);
  await page.waitForFunction(
    () => {
      const l = window.physicslab.audioDirector.describeLoops();
      return Object.keys(l.motors).length >= 1 && Object.keys(l.rolling).length >= 1;
    },
    null,
    { timeout: 90000 },
  );
  await page.waitForFunction(
    () => window.physicslab.liveJoint(window.physicslab.store.joints()[0].id)?.speed > 3.5,
    null,
    { timeout: 90000 },
  );
  await page.waitForTimeout(400);
  let l = await loops(page);
  const motorKey = Object.keys(l.motors)[0];
  assert(motorKey.startsWith('electric:j:'), `the motorised hinge has an electric voice (${motorKey})`);
  assert(
    l.motors[motorKey].f1 > 100 && l.motors[motorKey].gain > 0.01,
    `it is sounding ${JSON.stringify(l.motors[motorKey])}`,
  );
  assert(l.bed !== null && l.bed.gain > 0, 'the quiet air bed runs while simulating');
  // Rolling ball: rumble. Sliding crate: scrape (read while they are still moving).
  const names = await page.evaluate(() =>
    Object.fromEntries(window.physicslab.store.bodies().map((b) => [b.name, b.id])),
  );
  await page
    .waitForFunction(
      ({ ball }) => {
        const r = window.physicslab.audioDirector.describeLoops().rolling[ball];
        return r && r.rumbleGain > 0.01;
      },
      { ball: names['Rolling ball'] },
      { timeout: 60000 },
    )
    .catch(() => undefined);
  l = await loops(page);
  const ball = l.rolling[names['Rolling ball']];
  assert(
    ball && ball.rumbleGain > 0.01 && ball.scrapeGain < ball.rumbleGain,
    `the rolling ball rumbles ${JSON.stringify(ball)}`,
  );
  // The motor's pitch follows its speed: ask for three times the speed and wait until it has got there.
  const f1Slow = (await loops(page)).motors[motorKey].f1;
  await page.evaluate(() => {
    const a = window.physicslab;
    const j = a.store.joints()[0];
    a.store.updateMany([[j.id, { motor: { ...j.motor, targetVelocity: 14 } }]], 'faster');
  });
  await page.waitForFunction(
    () => {
      const a = window.physicslab;
      const j = a.store.joints()[0];
      return a.liveJoint(j.id)?.speed > 13.7;
    },
    null,
    { timeout: 120000 },
  );
  await page.waitForTimeout(300);
  const f1Fast = Math.max(...Object.values((await loops(page)).motors).map((m) => m.f1));
  assert(f1Fast > f1Slow * 1.4, `pitch rises with motor speed (${f1Slow.toFixed(0)} → ${f1Fast.toFixed(0)} Hz)`);
  // Slow motion lowers the pitch of the running voice (0.5× → 0.73).
  await page.evaluate(() => (window.physicslab.sim.timeScale = 0.5));
  await page.waitForFunction(() => Math.abs(window.physicslab.audio.pitch - 0.73) < 0.02, null, { timeout: 10000 });
  await page.waitForTimeout(500);
  const f1Half = Math.max(...Object.values((await loops(page)).motors).map((m) => m.f1));
  assert(
    f1Half < f1Fast * 0.85 && f1Half > f1Fast * 0.6,
    `the voice drops in pitch in slow motion (${f1Fast.toFixed(0)} → ${f1Half.toFixed(0)} Hz, expected ≈ ×0.73)`,
  );
  // One-shots follow the time scale too.
  const shotRate = await page.evaluate(async () => {
    const a = window.physicslab.audio;
    a.playEvent('launch', null, { level: 0.6 });
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    await frame();
    await frame();
    return a.recent.at(-1);
  });
  assert(
    shotRate.key.startsWith('e|la|') && Math.abs(shotRate.rate - 0.73) < 0.03,
    `a one-shot plays at the slowed pitch (${shotRate.rate})`,
  );
  await page.evaluate(() => (window.physicslab.sim.timeScale = 1));
  // Pausing silences the sustained voices.
  await pause(page);
  await page.waitForFunction(
    () => window.physicslab.audioDirector.stats.motors === 0 && window.physicslab.audioDirector.stats.rolling === 0,
    null,
    { timeout: 10000 },
  );
  noErrors(page);
});

test('audio: a sliding box scrapes (the voice is driven by the slip speed, not the speed)', async () => {
  const page = await newPage();
  await loadScene(
    page,
    'Scrape',
    (b) => {
      b.body('Sliding crate', 'box', [0.8, 0.5, 0.8], [-6, 0.25, 0], { material: 'concrete', velocity: [9, 0, 0] });
    },
    { position: [0, 3, 12], target: [0, 1, 0] },
  );
  await gesture(page);
  await play(page);
  await page.waitForFunction(
    () => Object.values(window.physicslab.audioDirector.describeLoops().rolling).some((r) => r.scrapeGain > 0.01),
    null,
    { timeout: 60000 },
  );
  const r = Object.values((await loops(page)).rolling)[0];
  assert(r.scrapeGain > 0.01 && r.rumbleGain < 0.005, `a box scrapes and does not rumble ${JSON.stringify(r)}`);
  assert(r.scrapeFreq > 300 && r.scrapeFreq < 3000, `concrete rasps in the mid range (${r.scrapeFreq} Hz)`);
  noErrors(page);
});

test('audio: wind rushes past a camera following a fast body, and the air goes away in zero gravity (FX-13)', async () => {
  const page = await newPage();
  await loadScene(
    page,
    'Falling fast',
    (b) => {
      b.body('Bullet', 'sphere', [0.4, 0.4, 0.4], [-60, 300, 0], { material: 'steel', velocity: [45, 0, 0] });
    },
    { position: [0, 300, 12], target: [0, 300, 0] },
  );
  await gesture(page);
  const id = await page.evaluate(() => window.physicslab.store.bodies()[0].id);
  await page.evaluate((id) => {
    const a = window.physicslab;
    a.store.setSelection([id]);
    a.prefs.set({ followSelection: true });
  }, id);
  await play(page);
  await page.waitForFunction(() => window.physicslab.audioDirector.describeLoops().wind !== null, null, {
    timeout: 90000,
  });
  const w = (await loops(page)).wind;
  assert(w.gain > 0.01 && w.cutoff > 800, `wind blows ${JSON.stringify(w)}`);
  await shot(page, 'audio-wind');
  // No gravity, no air: the wind and the bed fade out.
  await page.evaluate(() => window.physicslab.store.updateSettings({ gravity: [0, 0, 0] }, 'zero g'));
  await page.waitForFunction(
    () =>
      window.physicslab.audioDirector.describeLoops().wind === null &&
      window.physicslab.audioDirector.describeLoops().bed === null,
    null,
    { timeout: 30000 },
  );
  noErrors(page);
});

// -- FX-14: spatialisation ---------------------------------------------------------------------------------------------------

test('audio: sounds are positioned relative to the camera — pan, distance, air; Doppler is optional (FX-14)', async () => {
  const page = await newPage();
  await gesture(page);
  await page.evaluate(() => window.physicslab.viewport.setView({ position: [0, 2, 10], target: [0, 2, 0] }));
  await page.waitForTimeout(400);
  // A sound whose buffer is not ready waits a frame or two: look at the log after two rendered frames.
  const play3 = (id, p, v) =>
    page.evaluate(
      async ({ id, p, v }) => {
        const a = window.physicslab.audio;
        a.playEvent(id, p, { level: 0.6 }, v);
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        await frame();
        await frame();
        return a.recent.at(-1);
      },
      { id, p, v },
    );
  const right = await play3('launch', [8, 2, 0]);
  const left = await play3('launch', [-8, 2, 0]);
  const near = await play3('launch', [0, 2, 4]);
  const far = await play3('launch', [0, 2, -60]);
  const behind = await play3('launch', [0, 2, 25]);
  assert(right.pan > 0.5 && left.pan < -0.5, `pan follows the side (${right.pan.toFixed(2)} / ${left.pan.toFixed(2)})`);
  assert(far.gain < near.gain * 0.2, `distance attenuates (${near.gain.toFixed(3)} → ${far.gain.toFixed(3)})`);
  assert(
    far.cutoff < near.cutoff && behind.cutoff < far.cutoff * 1.5,
    `air and head shading dull far and rear sounds (${near.cutoff.toFixed(0)}, ${far.cutoff.toFixed(0)}, ${behind.cutoff.toFixed(0)} Hz)`,
  );
  assert(right.rate === left.rate && right.rate === 1, 'no Doppler by default');

  // The same positions through the real audio graph, offline: the right channel carries the sound on the right.
  const lr = await inPage(page, async ({ off, spatial, dsp }) => {
    const l = spatial.listenerFromMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 2, 10, 1], spatial.newListener());
    const sp = spatial.spatialize(l, 8, 2, 0, spatial.newSpatialResult());
    const r = await off.renderEventOffline('launch', { level: 0.6 }, sp);
    return { l: dsp.rms(r.channels[0]), r: dsp.rms(r.channels[1]), pan: sp.pan };
  });
  assert(lr.r > 3 * lr.l, `a sound on the right is in the right channel (${lr.l.toFixed(4)} vs ${lr.r.toFixed(4)})`);

  // Doppler: a source rushing towards the camera rises in pitch, one leaving falls.
  await page.evaluate(() => window.physicslab.audioDirector.setSettings({ doppler: true }));
  const towards = await play3('launch', [0, 2, -40], [0, 0, 30]);
  const away = await play3('launch', [0, 2, -40], [0, 0, -30]);
  assert(
    towards.rate > 1.05 && away.rate < 0.95,
    `Doppler shift (${towards.rate.toFixed(3)} / ${away.rate.toFixed(3)})`,
  );

  // 3D positioning off: everything centred at full level.
  await page.evaluate(() => window.physicslab.audioDirector.setSettings({ spatial: false, doppler: false }));
  const flat = await play3('launch', [60, 2, 0]);
  assert(flat.pan === 0 && flat.gain > near.gain * 0.99, `flat when positioning is off (${flat.pan}, ${flat.gain})`);
  noErrors(page);
});

// -- FX-15: event sounds ---------------------------------------------------------------------------------------------------------

test('audio: the blast tool, a shot, a spawn, a breaking spring and a trampoline each play their sound (FX-15)', async () => {
  const page = await newPage();
  await loadScene(
    page,
    'Events',
    (b) => {
      b.body('Trampoline', 'box', [3, 0.3, 3], [-3, 0.15, 0], {
        bodyType: 'static',
        material: 'rubber',
        tags: ['trampoline'],
      });
      b.body('Bouncer', 'sphere', [0.5, 0.5, 0.5], [-3, 3, 0], { material: 'plastic' });
      const anchor = b.body('Anchor', 'box', [0.4, 0.4, 0.4], [4, 6, 0], { bodyType: 'static' });
      const weight = b.body('Weight', 'sphere', [0.8, 0.8, 0.8], [4, 4, 0], { material: 'steel' });
      b.tether('spring', anchor, [4, 6, 0], weight, [4, 4, 0], {
        spring: { restLength: 2, stiffness: 300, damping: 5, breakForce: 200 },
      });
      b.body('Target', 'box', [1, 1, 1], [8, 0.5, 0], { material: 'concrete' });
    },
    { position: [2, 4, 14], target: [2, 2, 0] },
  );
  await gesture(page);
  await page.evaluate(() => {
    const a = window.physicslab;
    a.prefs.set({ shootSpeed: 25 });
  });
  await play(page);
  await page.waitForFunction(
    () => {
      const k = window.physicslab.audio.cachedKeys();
      return k.some((x) => x.startsWith('e|sn|')) && k.some((x) => x.startsWith('e|tr|'));
    },
    null,
    { timeout: 120000 },
  );
  let keys = await keysOf(page);
  assert(hasKey(keys, 'e|sn|'), 'the spring snapped with a twang');
  assert(hasKey(keys, 'e|tr|'), 'the ball boinged on the trampoline');
  // The Blast tool: a real click on the target.
  await page.evaluate(() => window.physicslab.setTool('blast'));
  const at = await page.evaluate(() => {
    const a = window.physicslab;
    const v = a.bodies.get(a.store.bodies().find((b) => b.name === 'Target').id);
    const p = v.position.clone().project(a.camera);
    const r = a.viewport.dom.getBoundingClientRect();
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
  });
  await page.mouse.click(at.x, at.y);
  await page.waitForFunction(() => window.physicslab.audio.cachedKeys().some((x) => x.startsWith('e|x|')), null, {
    timeout: 30000,
  });
  // The Fire tool: the report of the shot.
  await page.evaluate(() => window.physicslab.setTool('shoot'));
  await page.mouse.click(at.x, at.y);
  await page.waitForFunction(() => window.physicslab.audio.cachedKeys().some((x) => x.startsWith('e|la|')), null, {
    timeout: 30000,
  });
  // A body added to the running world pops in.
  await page.evaluate(() => {
    window.physicslab.setTool('select');
    window.physicslab.addShape('sphere', [0, 5, 0]);
  });
  await page.waitForFunction(() => window.physicslab.audio.cachedKeys().some((x) => x.startsWith('e|sp|')), null, {
    timeout: 30000,
  });
  keys = await keysOf(page);
  for (const [p, what] of [
    ['e|x|', 'explosion'],
    ['e|la|', 'launch'],
    ['e|sp|', 'spawn'],
  ])
    assert(hasKey(keys, p), `${what} sound rendered`);
  const lastExplosion = (await recent(page)).filter((r) => r.key.startsWith('e|x|')).at(-1);
  assert(
    lastExplosion.category === 'impacts' && lastExplosion.gain > 0.05,
    `the blast is loud ${JSON.stringify(lastExplosion)}`,
  );
  noErrors(page);
});

test('audio: components can ask for a sound — ignite, bounce and a named sound event reach the engine (FX-15 hooks)', async () => {
  const page = await newPage();
  await loadScene(page, 'Hooks', (b) => b.body('Emitter', 'box', [1, 1, 1], [0, 0.5, 0], { material: 'steel' }), {
    position: [0, 3, 8],
    target: [0, 1, 0],
  });
  await gesture(page);
  await play(page);
  await simTime(page, 0.2);
  const owner = await page.evaluate(() => window.physicslab.store.bodies()[0].id);
  await page.evaluate((owner) => {
    const emit = (name, data) =>
      window.physicslab.sim.client.emit('event', {
        kind: 'component',
        t: 0,
        owner,
        component: 'c',
        type: 'x',
        name,
        data,
      });
    emit('ignite', { thrust: 100 });
    emit('bounce', { speed: 9 });
    emit('sound', { id: 'break', params: { material: 'glass', size: 0.5, level: 0.8 } });
    emit('sound', { id: 'no-such-sound' });
  }, owner);
  await page.waitForTimeout(300);
  const keys = await keysOf(page);
  assert(
    hasKey(keys, 'e|la|') && hasKey(keys, 'e|tr|') && hasKey(keys, 'e|b|glass|'),
    `component events played sounds (${keys.filter((k) => k.startsWith('e|')).join(' ')})`,
  );
  noErrors(page);
});

// -- FX-14: interface sounds -------------------------------------------------------------------------------------------------------

test('audio: interface sounds — select, place, delete, error, success are subtle, rate-limited and switchable (FX-14)', async () => {
  const page = await newPage();
  await gesture(page);
  await page.waitForTimeout(300);
  const wait = () => page.waitForTimeout(450);
  const id = await page.evaluate(() => window.physicslab.store.bodies()[0].id);
  await page.evaluate((id) => {
    window.physicslab.store.setSelection([]);
    window.physicslab.store.setSelection([id]);
  }, id);
  await wait();
  assert((await keysOf(page)).includes('u|ui.select'), 'selecting ticks');
  await page.evaluate(() => window.physicslab.addShape('box'));
  await wait();
  assert((await keysOf(page)).includes('u|ui.place'), 'placing chimes');
  await page.evaluate(() => window.physicslab.store.remove(window.physicslab.store.selection));
  await wait();
  assert((await keysOf(page)).includes('u|ui.delete'), 'deleting sounds');
  await page.evaluate(() => window.physicslab.toast('Something went wrong', 'error'));
  await wait();
  await page.evaluate(() => window.physicslab.toast('Saved', 'success'));
  await wait();
  const k = await keysOf(page);
  assert(k.includes('u|ui.error') && k.includes('u|ui.success'), 'error and success sounds');
  const sounds = (await recent(page)).filter((r) => r.category === 'ui');
  assert(
    sounds.length >= 5 && sounds.every((r) => r.pan === 0 && r.gain < 0.12),
    `interface sounds are quiet and centred ${JSON.stringify(sounds.map((s) => [s.key, +s.gain.toFixed(3)]))}`,
  );

  // Rate limiting: a selection that flips thirty times in a blink makes one tick, not thirty.
  const before = (await recent(page)).filter((r) => r.key === 'u|ui.select').length;
  await page.evaluate(() => {
    const a = window.physicslab;
    const first = a.store.bodies()[0].id;
    for (let i = 0; i < 30; i++) a.store.setSelection(i % 2 ? [] : [first]);
  });
  await wait();
  const after = (await recent(page)).filter((r) => r.key === 'u|ui.select').length;
  assert(after - before <= 2, `a burst of selections is rate-limited (${after - before} ticks)`);

  // Switch them off in the panel: nothing more plays.
  await page.click('#tab-fx');
  await page.click('.fx-panel label.switch:has-text("Interface sounds")');
  const n = (await stats(page)).started;
  await page.evaluate(() => {
    window.physicslab.toast('Another failure', 'error');
    window.physicslab.addShape('box');
  });
  await wait();
  assert((await stats(page)).started === n, 'interface sounds can be switched off');
  noErrors(page);
});

// -- FX-10: voice limiting under load ------------------------------------------------------------------------------------------------

test('audio: voice limiting — 300 balls landing keep within the voice budget, steal quiet voices and never disturb the frame loop', async () => {
  const page = await newPage('&scene=pit');
  await gesture(page);
  await page.evaluate(() => window.physicslab.viewport.setView({ position: [0, 8.5, 5.5], target: [0, 0.2, 0] }));
  await play(page);
  await page.waitForFunction(() => window.physicslab.audioDirector.stats.started > 300, null, { timeout: 120000 });
  let max = 0;
  let maxImpacts = 0;
  for (let i = 0; i < 25; i++) {
    const s = await stats(page);
    max = Math.max(max, s.voices);
    maxImpacts = Math.max(maxImpacts, s.byCategory.impacts);
    await page.waitForTimeout(80);
  }
  const s = await stats(page);
  assert(max <= 36, `total voices stay within the budget (${max})`);
  assert(maxImpacts <= 24, `impact voices stay within their category budget (${maxImpacts})`);
  assert(s.rejected + s.stolen > 0, `the limiter had to act (${s.rejected} rejected, ${s.stolen} stolen)`);
  assert(s.buffers < 280, `the buffer cache is bounded (${s.buffers})`);
  await page.evaluate(() => window.physicslab.sim.reset());
  await page.waitForFunction(() => window.physicslab.audioDirector.stats.voices === 0, null, { timeout: 10000 });
  noErrors(page);
});
