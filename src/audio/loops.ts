/**
 * The sustained voices: rolling / sliding noise, engines and motors, wind and the air bed. Each is a small WebAudio
 * graph built on a `BaseAudioContext` (live or offline) whose parameters are moved every frame from the pure mappings
 * (`rolling.ts`, `motor.ts`, `ambience.ts`):
 *
 *     RollingVoice   noise → low-pass (rumble) ┐
 *                    noise → band-pass (scrape) ┴→ out
 *     MotorVoice     pulse osc + partner osc → resonant low-pass ┐
 *                    noise → band-pass → blade-pass chop ────────┴→ out
 *     WindVoice      pink noise → band-pass → gusts → out
 *     BedVoice       pink noise → low-pass → out
 *
 * `update(params, t, pitch)` moves everything to the new parameters along short exponential approaches; `pitch` is the
 * product of the time-scale bend and the Doppler ratio. A voice's `out` node is connected by its owner to a spatial
 * chain or straight to a bus.
 */
import { clamp } from './mapping';
import type { BedParams, WindParams } from './ambience';
import type { NoiseBank } from './graph';
import { ramp } from './graph';
import { pulseHarmonics, type MotorKind, type MotorParams } from './motor';
import type { RollParams } from './rolling';

/** Time constants of the parameter approaches, seconds. */
const FAST = 0.03;
const SLOW = 0.08;
/** Time constant of the level fade-in of a new voice. */
const FADE_IN = 0.04;

export interface LoopVoice {
  readonly out: GainNode;
  /** The live values of the voice's audio parameters (for the status panel and the tests). */
  inspect(): Record<string, number>;
  /** Fade out over `fade` seconds and stop the sources. */
  stop(fade: number): void;
  /** Disconnect everything (after `stop`). */
  dispose(): void;
}

abstract class BaseLoop implements LoopVoice {
  readonly out: GainNode;
  protected readonly sources: (AudioScheduledSourceNode | AudioBufferSourceNode)[] = [];
  protected readonly nodes: AudioNode[] = [];
  private stopped = false;

  abstract inspect(): Record<string, number>;

  constructor(protected readonly ctx: BaseAudioContext) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.nodes.push(this.out);
  }

  /** Register a node for disposal; returns it. */
  protected track<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  protected noise(bank: NoiseBank, color: 'white' | 'pink' | 'brown'): AudioBufferSourceNode {
    const s = bank.source(color);
    this.sources.push(s);
    this.nodes.push(s);
    return s;
  }

  stop(fade: number): void {
    if (this.stopped) return;
    this.stopped = true;
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.linearRampToValueAtTime(0, t + Math.max(0.005, fade));
    const end = t + Math.max(0.005, fade) + 0.02;
    for (const s of this.sources) {
      try {
        s.stop(end);
      } catch {
        /* never started or already stopped */
      }
    }
  }

  dispose(): void {
    for (const n of this.nodes) n.disconnect();
  }
}

// -- rolling and sliding ------------------------------------------------------------------------------------------------

export class RollingVoice extends BaseLoop {
  private readonly rumble: GainNode;
  private readonly rumbleLp: BiquadFilterNode;
  private readonly rumbleSrc: AudioBufferSourceNode;
  private readonly scrape: GainNode;
  private readonly scrapeBp: BiquadFilterNode;
  private readonly scrapeSrc: AudioBufferSourceNode;

  constructor(ctx: BaseAudioContext, bank: NoiseBank) {
    super(ctx);
    this.rumbleSrc = this.noise(bank, 'brown');
    this.rumbleLp = this.track(ctx.createBiquadFilter());
    this.rumbleLp.type = 'lowpass';
    this.rumbleLp.Q.value = 0.9;
    this.rumble = this.track(ctx.createGain());
    this.rumble.gain.value = 0;
    this.rumbleSrc.connect(this.rumbleLp);
    this.rumbleLp.connect(this.rumble);
    this.rumble.connect(this.out);

    this.scrapeSrc = this.noise(bank, 'white');
    this.scrapeBp = this.track(ctx.createBiquadFilter());
    this.scrapeBp.type = 'bandpass';
    this.scrape = this.track(ctx.createGain());
    this.scrape.gain.value = 0;
    this.scrapeSrc.connect(this.scrapeBp);
    this.scrapeBp.connect(this.scrape);
    this.scrape.connect(this.out);
    this.out.gain.value = 1;
  }

  inspect(): Record<string, number> {
    return {
      rumbleGain: this.rumble.gain.value,
      rumbleCutoff: this.rumbleLp.frequency.value,
      scrapeGain: this.scrape.gain.value,
      scrapeFreq: this.scrapeBp.frequency.value,
      scrapeQ: this.scrapeBp.Q.value,
      rate: this.rumbleSrc.playbackRate.value,
    };
  }

  /**
   * `first`: a voice that has just been given to a body jumps to its filter settings and fades its levels in (a step in
   * the level of a noise is a click).
   */
  update(p: RollParams, t: number, pitch = 1, first = false): void {
    const tau = first ? 0 : FAST;
    const gtau = first ? FADE_IN : FAST;
    // Levels are balanced against the impacts: a rolling ball is a background texture, not the loudest thing in the mix.
    ramp(this.rumble.gain, p.rumbleGain * 0.95, t, gtau);
    ramp(this.rumbleLp.frequency, clamp(p.rumbleCutoff * pitch, 40, 8000), t, tau);
    ramp(this.scrape.gain, p.scrapeGain * 1.6, t, gtau);
    ramp(this.scrapeBp.frequency, clamp(p.scrapeFreq * pitch, 100, 12000), t, tau);
    ramp(this.scrapeBp.Q, clamp(p.scrapeQ, 0.3, 12), t, tau);
    ramp(this.rumbleSrc.playbackRate, pitch, t, SLOW);
    ramp(this.scrapeSrc.playbackRate, pitch, t, SLOW);
  }
}

// -- engines and motors ------------------------------------------------------------------------------------------------

const waveCache = new WeakMap<BaseAudioContext, Map<MotorKind, PeriodicWave>>();

/** The oscillator waveform of a kind (pulse trains for the combustion engine, smoother shapes for the rest). */
function waveFor(ctx: BaseAudioContext, kind: MotorKind): PeriodicWave {
  let per = waveCache.get(ctx);
  if (!per) waveCache.set(ctx, (per = new Map<MotorKind, PeriodicWave>()));
  let w = per.get(kind);
  if (!w) {
    const duty = kind === 'combustion' ? 0.14 : kind === 'electric' ? 0.3 : 0.5;
    const count = kind === 'combustion' ? 40 : 14;
    const { real, imag } = pulseHarmonics(count, duty);
    // Electric and rotor voices fall off faster: scale the harmonics by 1/n.
    if (kind !== 'combustion') for (let n = 1; n < real.length; n++) real[n] /= n;
    w = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    per.set(kind, w);
  }
  return w;
}

export class MotorVoice extends BaseLoop {
  private readonly osc1: OscillatorNode;
  private readonly osc2: OscillatorNode;
  private readonly g1: GainNode;
  private readonly g2: GainNode;
  private readonly lp: BiquadFilterNode;
  private readonly noiseBp: BiquadFilterNode;
  private readonly noiseGain: GainNode;
  private readonly chop: GainNode;
  private readonly lfo: OscillatorNode;
  private readonly lfoDepth: GainNode;
  private readonly noiseSrc: AudioBufferSourceNode;

  constructor(
    ctx: BaseAudioContext,
    bank: NoiseBank,
    readonly kind: MotorKind,
  ) {
    super(ctx);
    this.osc1 = ctx.createOscillator();
    this.osc1.setPeriodicWave(waveFor(ctx, kind));
    this.osc1.frequency.value = 50;
    this.osc2 = ctx.createOscillator();
    this.osc2.type = kind === 'electric' ? 'triangle' : 'sine';
    this.osc2.frequency.value = 100;
    this.sources.push(this.osc1, this.osc2);
    this.nodes.push(this.osc1, this.osc2);
    this.g1 = this.track(ctx.createGain());
    this.g2 = this.track(ctx.createGain());
    this.lp = this.track(ctx.createBiquadFilter());
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 400;
    this.osc1.connect(this.g1);
    this.osc2.connect(this.g2);
    this.g1.connect(this.lp);
    this.g2.connect(this.lp);

    // The noise layer; the blade-pass oscillator chops the sum (depth 0 leaves it steady).
    this.noiseSrc = this.noise(bank, kind === 'jet' ? 'white' : 'pink');
    this.noiseBp = this.track(ctx.createBiquadFilter());
    this.noiseBp.type = kind === 'jet' ? 'lowpass' : 'bandpass';
    this.noiseBp.Q.value = 0.7;
    this.noiseGain = this.track(ctx.createGain());
    this.noiseGain.gain.value = 0;
    this.chop = this.track(ctx.createGain());
    this.chop.gain.value = 1;
    this.lfo = ctx.createOscillator();
    this.lfo.frequency.value = 1;
    this.lfoDepth = this.track(ctx.createGain());
    this.lfoDepth.gain.value = 0;
    this.sources.push(this.lfo);
    this.nodes.push(this.lfo);
    this.lfo.connect(this.lfoDepth);
    this.lfoDepth.connect(this.chop.gain);
    this.noiseSrc.connect(this.noiseBp);
    this.noiseBp.connect(this.noiseGain);
    this.noiseGain.connect(this.chop);
    // The chop acts on the whole voice, oscillators and noise: a slow rotor goes "wop wop wop".
    this.lp.connect(this.chop);
    this.chop.connect(this.out);

    this.osc1.start();
    this.osc2.start();
    this.lfo.start();
  }

  inspect(): Record<string, number> {
    return {
      f1: this.osc1.frequency.value,
      f2: this.osc2.frequency.value,
      cutoff: this.lp.frequency.value,
      q: this.lp.Q.value,
      noiseGain: this.noiseGain.gain.value,
      lfoRate: this.lfo.frequency.value,
      lfoDepth: this.lfoDepth.gain.value * 2,
      gain: this.out.gain.value,
    };
  }

  update(p: MotorParams, t: number, pitch = 1, first = false): void {
    const tau = first ? 0 : FAST;
    const gtau = first ? FADE_IN : FAST; // levels fade in on the first update; frequencies jump
    ramp(this.osc1.frequency, clamp(p.f1 * pitch, 5, 6000), t, tau);
    ramp(this.osc2.frequency, clamp(p.f2 * pitch, 5, 9000), t, tau);
    ramp(this.g1.gain, p.g1, t, gtau);
    ramp(this.g2.gain, p.g2, t, gtau);
    ramp(this.lp.frequency, clamp(p.cutoff * pitch, 60, 12000), t, tau);
    ramp(this.lp.Q, clamp(p.q, 0.3, 14), t, tau);
    ramp(this.noiseGain.gain, p.noiseGain * 0.9, t, gtau);
    ramp(this.noiseBp.frequency, clamp(p.noiseCutoff * pitch, 60, 12000), t, tau);
    // Blade-pass chop: the gain swings between 1 − depth and 1 (centre 1 − depth/2, swing ±depth/2).
    ramp(this.chop.gain, 1 - p.lfoDepth / 2, t, tau);
    ramp(this.lfoDepth.gain, p.lfoDepth / 2, t, tau);
    ramp(this.lfo.frequency, clamp(p.lfoRate * pitch, 0.1, 400), t, tau);
    ramp(this.noiseSrc.playbackRate, pitch, t, SLOW);
    ramp(this.out.gain, p.gain * 0.25, t, gtau);
  }
}

// -- ambience ---------------------------------------------------------------------------------------------------------------

export class WindVoice extends BaseLoop {
  private readonly bp: BiquadFilterNode;
  private readonly gust: GainNode;
  private readonly lfo: OscillatorNode;
  private readonly lfoDepth: GainNode;

  constructor(ctx: BaseAudioContext, bank: NoiseBank) {
    super(ctx);
    const src = this.noise(bank, 'pink');
    this.bp = this.track(ctx.createBiquadFilter());
    this.bp.type = 'bandpass';
    this.bp.frequency.value = 400;
    this.gust = this.track(ctx.createGain());
    this.gust.gain.value = 1;
    this.lfo = ctx.createOscillator();
    this.lfo.frequency.value = 0.3;
    this.lfoDepth = this.track(ctx.createGain());
    this.lfoDepth.gain.value = 0;
    this.sources.push(this.lfo);
    this.nodes.push(this.lfo);
    src.connect(this.bp);
    this.bp.connect(this.gust);
    this.lfo.connect(this.lfoDepth);
    this.lfoDepth.connect(this.gust.gain);
    this.gust.connect(this.out);
    this.lfo.start();
  }

  inspect(): Record<string, number> {
    return {
      cutoff: this.bp.frequency.value,
      q: this.bp.Q.value,
      gustRate: this.lfo.frequency.value,
      gain: this.out.gain.value,
    };
  }

  update(p: WindParams, t: number, first = false): void {
    const tau = first ? 0 : SLOW;
    const gtau = first ? FADE_IN * 4 : SLOW; // the ambience swells in
    ramp(this.bp.frequency, p.cutoff, t, tau);
    ramp(this.bp.Q, p.q, t, tau);
    ramp(this.lfo.frequency, p.gustRate, t, tau);
    ramp(this.gust.gain, 1 - p.gustDepth / 2, t, tau);
    ramp(this.lfoDepth.gain, p.gustDepth / 2, t, tau);
    // Pink noise through a band-pass is quiet: bring it up to a usable level.
    ramp(this.out.gain, p.gain * 1.6, t, gtau);
  }
}

export class BedVoice extends BaseLoop {
  private readonly lp: BiquadFilterNode;
  private readonly breath: OscillatorNode;
  private readonly breathDepth: GainNode;
  private readonly level: GainNode;

  constructor(ctx: BaseAudioContext, bank: NoiseBank) {
    super(ctx);
    const src = this.noise(bank, 'pink');
    this.lp = this.track(ctx.createBiquadFilter());
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 700;
    this.level = this.track(ctx.createGain());
    this.level.gain.value = 0.8;
    // A slow swell, a few seconds from peak to peak, so the bed is not a flat hiss.
    this.breath = ctx.createOscillator();
    this.breath.frequency.value = 0.11;
    this.breathDepth = this.track(ctx.createGain());
    this.breathDepth.gain.value = 0.2;
    this.sources.push(this.breath);
    this.nodes.push(this.breath);
    src.connect(this.lp);
    this.lp.connect(this.level);
    this.breath.connect(this.breathDepth);
    this.breathDepth.connect(this.level.gain);
    this.level.connect(this.out);
    this.breath.start();
  }

  inspect(): Record<string, number> {
    return { cutoff: this.lp.frequency.value, gain: this.out.gain.value };
  }

  update(p: BedParams, t: number, first = false): void {
    const tau = first ? 0 : SLOW;
    const gtau = first ? FADE_IN * 4 : SLOW;
    ramp(this.lp.frequency, p.cutoff, t, tau);
    ramp(this.out.gain, p.gain * 2, t, gtau);
  }
}
