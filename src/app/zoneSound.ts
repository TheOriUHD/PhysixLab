/**
 * The sounds of the `sound` zone action: small synthesised effects (Web Audio), so a scene needs no audio files and the
 * app stays a static page. Each preset is a few oscillators or a noise burst shaped by an envelope; `volume` scales the
 * level and `pitch` multiplies every frequency. The audio context is created on the first sound (the simulation was
 * started by a click, which browsers accept as the user gesture) and sounds can be muted from the Zones panel; the
 * choice is remembered in `localStorage` when that is available.
 */
import { ZONE_SOUNDS } from '../model/zones';

const MUTE_KEY = 'physixlab.zones.muted';

let audio: AudioContext | null = null;
let muted = read();
/** Sounds requested since the page loaded (also while muted) — what the tests look at, headless audio being silent. */
const requested: { sound: string; volume: number; pitch: number }[] = [];

function read(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export const zoneSound = {
  get muted(): boolean {
    return muted;
  },
  setMuted(on: boolean): void {
    muted = on;
    try {
      localStorage.setItem(MUTE_KEY, on ? '1' : '0');
    } catch {
      /* storage unavailable: the choice lasts for this session */
    }
  },
  /** Every sound asked for so far (newest last, at most 50). */
  get requested(): readonly { sound: string; volume: number; pitch: number }[] {
    return requested;
  },
  names: ZONE_SOUNDS.map((s) => s.id),
  play,
};

function context(): AudioContext | null {
  if (audio) return audio;
  const Ctor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    audio = new Ctor();
  } catch {
    return null;
  }
  return audio;
}

/** Play a preset by id. Unknown ids play the beep. Returns false if nothing could be played (muted, no audio). */
function play(sound: string, volume = 0.6, pitch = 1): boolean {
  requested.push({ sound, volume, pitch });
  if (requested.length > 50) requested.shift();
  if (muted) return false;
  const ac = context();
  if (!ac) return false;
  if (ac.state === 'suspended') void ac.resume();
  const master = ac.createGain();
  master.gain.value = Math.max(0, Math.min(1, volume)) * 0.35;
  master.connect(ac.destination);
  const t0 = ac.currentTime + 0.005;

  const tone = (freq: number, at: number, dur: number, type: OscillatorType, level = 1, endFreq?: number): void => {
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq * pitch, t0 + at);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq * pitch), t0 + at + dur);
    g.gain.setValueAtTime(0.0001, t0 + at);
    g.gain.exponentialRampToValueAtTime(level, t0 + at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
    osc.connect(g).connect(master);
    osc.start(t0 + at);
    osc.stop(t0 + at + dur + 0.02);
  };
  const noise = (at: number, dur: number, from: number, to: number, level = 1): void => {
    const n = Math.max(1, Math.floor(ac.sampleRate * dur));
    const buf = ac.createBuffer(1, n, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource();
    src.buffer = buf;
    const f = ac.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(from * pitch, t0 + at);
    f.frequency.exponentialRampToValueAtTime(to * pitch, t0 + at + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(level, t0 + at);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t0 + at);
  };

  switch (sound) {
    case 'chime':
      tone(1046.5, 0, 0.7, 'sine', 0.8);
      tone(1568, 0, 0.5, 'sine', 0.4);
      break;
    case 'success':
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, i * 0.09, 0.22, 'triangle', 0.7));
      break;
    case 'fail':
      tone(330, 0, 0.45, 'sawtooth', 0.45, 110);
      break;
    case 'coin':
      tone(988, 0, 0.07, 'square', 0.35);
      tone(1319, 0.07, 0.4, 'square', 0.35);
      break;
    case 'boing':
      tone(180, 0, 0.45, 'sine', 0.9, 620);
      tone(620, 0.2, 0.3, 'sine', 0.5, 220);
      break;
    case 'whoosh':
      noise(0, 0.45, 300, 4000, 0.9);
      break;
    case 'thud':
      tone(110, 0, 0.28, 'sine', 1, 38);
      noise(0, 0.08, 200, 80, 0.4);
      break;
    case 'buzz':
      tone(120, 0, 0.35, 'sawtooth', 0.4);
      tone(121.5, 0, 0.35, 'sawtooth', 0.4);
      break;
    case 'click':
      noise(0, 0.025, 2500, 1500, 0.8);
      break;
    default:
      tone(880, 0, 0.14, 'sine', 0.8);
  }
  return true;
}
