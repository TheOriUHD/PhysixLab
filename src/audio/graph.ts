/**
 * The WebAudio building blocks shared by the live engine and by offline rendering: smooth parameter changes, the
 * looping noise bank, the spatial chain (pan → distance gain → air filter) and the one-shot player.
 *
 * Everything takes a `BaseAudioContext`, so the same graph runs in a real-time `AudioContext` (the app) and in an
 * `OfflineAudioContext` (the end-to-end tests render a sound to samples and measure it).
 */
import { renderNoiseLoop, type NoiseColor } from './dsp';
import type { SpatialResult } from './spatial';

/**
 * Move a parameter to `value` along an exponential approach with time constant `tau` seconds, starting at `t`.
 * Cancels what was scheduled after `t` so a parameter updated every frame keeps a short timeline.
 */
export function ramp(param: AudioParam, value: number, t: number, tau = 0.03): void {
  param.cancelScheduledValues(t);
  if (tau <= 0) param.setValueAtTime(value, t);
  else param.setTargetAtTime(value, t, tau);
}

/** Length of the looped noise buffers, seconds. */
const NOISE_SECONDS = 4;
const NOISE_SEEDS: Record<NoiseColor, number> = { white: 0x5eed1, pink: 0x5eed2, brown: 0x5eed3 };

/** The looping coloured-noise buffers of one context, rendered on first use (one per colour, ~700 kB each). */
export class NoiseBank {
  private readonly buffers = new Map<NoiseColor, AudioBuffer>();
  private offset = 0;

  constructor(private readonly ctx: BaseAudioContext) {}

  get(color: NoiseColor): AudioBuffer {
    let b = this.buffers.get(color);
    if (!b) {
      const data = renderNoiseLoop(color, NOISE_SECONDS, this.ctx.sampleRate, NOISE_SEEDS[color]);
      b = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
      b.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
      this.buffers.set(color, b);
    }
    return b;
  }

  /** A looping source of the given colour starting at a different place in the buffer each time. */
  source(color: NoiseColor): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = this.get(color);
    src.loop = true;
    // A golden-ratio walk spreads the start points, so voices sharing a buffer are not in phase.
    this.offset = (this.offset + 0.618034) % 1;
    src.start(0, this.offset * NOISE_SECONDS * 0.9);
    return src;
  }

  get size(): number {
    return this.buffers.size;
  }
}

/** Whether a low-pass at this cutoff would be audible; above it the filter node is left out. */
export const FILTER_BYPASS_HZ = 16000;

/**
 * Pan → distance gain → air filter, the last stage before a category bus. Voices connect to `input`; `apply` moves
 * the three parameters to a `SpatialResult` smoothly.
 */
export class SpatialChain {
  readonly input: GainNode;
  private readonly gain: GainNode;
  private readonly pan: StereoPannerNode | null;
  private readonly lp: BiquadFilterNode;

  constructor(ctx: BaseAudioContext, dest: AudioNode) {
    this.input = ctx.createGain();
    this.pan = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 20000;
    this.lp.Q.value = 0.5;
    this.gain = ctx.createGain();
    this.input.connect(this.lp);
    this.lp.connect(this.gain);
    if (this.pan) {
      this.gain.connect(this.pan);
      this.pan.connect(dest);
    } else this.gain.connect(dest);
  }

  /** Jump to a state without smoothing (the first update of a new voice). */
  set(sp: Pick<SpatialResult, 'gain' | 'pan' | 'cutoff'>, t: number): void {
    ramp(this.gain.gain, sp.gain, t, 0);
    ramp(this.lp.frequency, sp.cutoff, t, 0);
    if (this.pan) ramp(this.pan.pan, sp.pan, t, 0);
  }

  apply(sp: Pick<SpatialResult, 'gain' | 'pan' | 'cutoff'>, t: number, tau = 0.04): void {
    ramp(this.gain.gain, sp.gain, t, tau);
    ramp(this.lp.frequency, sp.cutoff, t, tau);
    if (this.pan) ramp(this.pan.pan, sp.pan, t, tau);
  }

  dispose(): void {
    this.input.disconnect();
    this.lp.disconnect();
    this.gain.disconnect();
    this.pan?.disconnect();
  }
}

export interface OneShotOptions {
  /** Linear gain before the spatial stage. */
  gain: number;
  /** Playback rate (pitch). */
  rate: number;
  pan: number;
  /** Air-filter cutoff, Hz; at or above `FILTER_BYPASS_HZ` no filter is created. */
  cutoff: number;
  /** Start time on the context clock (default: now). */
  when?: number;
}

export interface OneShot {
  source: AudioBufferSourceNode;
  /** Fade out and stop `fade` seconds from now. */
  stop(fade: number): void;
  /** Disconnect everything (call once the source has ended). */
  dispose(): void;
}

/** Play a buffer once through gain → (air filter) → (pan) → `dest`. */
export function buildOneShot(ctx: BaseAudioContext, dest: AudioNode, buffer: AudioBuffer, o: OneShotOptions): OneShot {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = o.rate;
  const gain = ctx.createGain();
  gain.gain.value = o.gain;
  const nodes: AudioNode[] = [source, gain];
  let tail: AudioNode = gain;
  source.connect(gain);
  if (o.cutoff < FILTER_BYPASS_HZ) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = o.cutoff;
    lp.Q.value = 0.5;
    tail.connect(lp);
    tail = lp;
    nodes.push(lp);
  }
  if (Math.abs(o.pan) > 0.01 && typeof ctx.createStereoPanner === 'function') {
    const p = ctx.createStereoPanner();
    p.pan.value = o.pan;
    tail.connect(p);
    tail = p;
    nodes.push(p);
  }
  tail.connect(dest);
  source.start(o.when ?? ctx.currentTime);
  return {
    source,
    stop(fade) {
      const t = ctx.currentTime;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(0, t + Math.max(0.004, fade));
      try {
        source.stop(t + Math.max(0.004, fade) + 0.01);
      } catch {
        /* already stopped */
      }
    },
    dispose() {
      for (const n of nodes) n.disconnect();
    },
  };
}

/** Samples of a rendered `AudioBuffer` as plain arrays, one per channel. */
export function channelsOf(buf: AudioBuffer): Float32Array[] {
  return Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c).slice());
}
