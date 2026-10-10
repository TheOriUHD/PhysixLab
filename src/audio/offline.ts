/**
 * Offline rendering: build the very same WebAudio graphs the engine uses on an `OfflineAudioContext` and get the
 * samples back. The end-to-end tests render an impact, an engine at 1 000 and 5 000 rpm, a sliding scrape, the wind,
 * a sound to the left and to the right of the camera, and measure what comes out (frequency, level, brightness,
 * channel balance) in a real browser engine; it is also a way to export a sound.
 *
 * The functions here are used from `page.evaluate` through `import('/src/audio/offline.ts')`.
 */
import { renderRecipe } from './dsp';
import { buildOneShot, NoiseBank, SpatialChain } from './graph';
import { impactRecipe, type ImpactVoice } from './impact';
import { soundEvent, type SoundEventParams } from './events';
import { hashString } from './mapping';
import { MotorVoice, RollingVoice, WindVoice } from './loops';
import { motorParams, newMotorParams, type MotorKind } from './motor';
import { newRollParams, rollParams, type RollInput } from './rolling';
import { newWindParams, windParams } from './ambience';
import type { SpatialResult } from './spatial';

export interface Rendered {
  /** One array per channel (stereo: left, right). */
  channels: Float32Array[];
  sampleRate: number;
}

/** Render `seconds` of whatever `build` connects to the destination. */
export async function renderOffline(
  seconds: number,
  build: (ctx: OfflineAudioContext, dest: AudioNode, bank: NoiseBank) => void,
  sampleRate = 44100,
): Promise<Rendered> {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
  const bank = new NoiseBank(ctx);
  build(ctx, ctx.destination, bank);
  const out = await ctx.startRendering();
  return {
    channels: Array.from({ length: out.numberOfChannels }, (_, c) => out.getChannelData(c).slice()),
    sampleRate,
  };
}

const CENTRED: Pick<SpatialResult, 'gain' | 'pan' | 'cutoff' | 'rate'> = { gain: 1, pan: 0, cutoff: 20000, rate: 1 };

/** Impact voices (from `planImpact`) as heard at a spatial state. */
export function renderImpactOffline(
  voices: readonly ImpactVoice[],
  sp: Pick<SpatialResult, 'gain' | 'pan' | 'cutoff' | 'rate'> = CENTRED,
  seconds = 1.5,
): Promise<Rendered> {
  return renderOffline(seconds, (ctx, dest) => {
    for (const v of voices) {
      const data = renderRecipe(impactRecipe(v.spec), ctx.sampleRate, hashString(v.key));
      const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
      buf.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
      buildOneShot(ctx, dest, buf, { gain: v.gain * sp.gain, rate: v.rate * sp.rate, pan: sp.pan, cutoff: sp.cutoff });
    }
  });
}

/** A registered sound event as heard at a spatial state. */
export function renderEventOffline(
  id: string,
  params: SoundEventParams = {},
  sp: Pick<SpatialResult, 'gain' | 'pan' | 'cutoff' | 'rate'> = CENTRED,
  seconds = 1.5,
): Promise<Rendered> {
  const def = soundEvent(id);
  if (!def) return Promise.reject(new Error(`no sound event "${id}"`));
  return renderOffline(
    seconds,
    (ctx, dest) => {
      const data = renderRecipe(def.recipe(params), ctx.sampleRate, hashString(def.key(params)));
      const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
      buf.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
      buildOneShot(ctx, dest, buf, {
        gain: def.gain(params) * sp.gain,
        rate: (def.rate?.(params) ?? 1) * sp.rate,
        pan: sp.pan,
        cutoff: sp.cutoff,
      });
    },
    44100,
  );
}

/** A motor voice held at one rpm and load. */
export function renderMotorOffline(
  kind: MotorKind,
  rpm: number,
  load: number,
  seconds = 1,
  pitch = 1,
): Promise<Rendered> {
  return renderOffline(seconds, (ctx, dest, bank) => {
    const voice = new MotorVoice(ctx, bank, kind);
    voice.out.connect(dest);
    voice.update(motorParams(kind, rpm, load, newMotorParams()), 0, pitch, true);
  });
}

/** A rolling / sliding voice held at one state. */
export function renderRollingOffline(input: RollInput, seconds = 1, pitch = 1): Promise<Rendered> {
  return renderOffline(seconds, (ctx, dest, bank) => {
    const voice = new RollingVoice(ctx, bank);
    voice.out.connect(dest);
    voice.update(rollParams(input, newRollParams()), 0, pitch, true);
  });
}

/** The wind at one air speed (through a spatial chain, so the output is stereo like the live one). */
export function renderWindOffline(airSpeed: number, seconds = 1): Promise<Rendered> {
  return renderOffline(seconds, (ctx, dest, bank) => {
    const voice = new WindVoice(ctx, bank);
    const chain = new SpatialChain(ctx, dest);
    voice.out.connect(chain.input);
    chain.set(CENTRED, 0);
    voice.update(windParams(airSpeed, 1, newWindParams()), 0, true);
  });
}
