import { describe, expect, it } from 'vitest';
import {
  GestureTracker,
  PlatformState,
  WheelClassifier,
  defaultPointer,
  detectOs,
  fillMods,
  keyCapLabel,
  modNames,
  resolvePointer,
  type WheelLike,
} from '../src/app/input/platform';

const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const WIN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';

const wheel = (p: Partial<WheelLike>): WheelLike => ({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, ...p });

describe('operating system detection', () => {
  it('tells macOS, Windows, Linux, iOS and Android apart', () => {
    expect(detectOs({ platform: 'MacIntel', userAgent: MAC_UA, maxTouchPoints: 0 })).toBe('mac');
    expect(detectOs({ platform: 'Win32', userAgent: WIN_UA })).toBe('windows');
    expect(detectOs({ platform: 'Linux x86_64', userAgent: LINUX_UA })).toBe('linux');
    expect(detectOs({ platform: 'iPhone', userAgent: IPHONE_UA, maxTouchPoints: 5 })).toBe('ios');
    expect(detectOs({ platform: 'Linux armv8l', userAgent: ANDROID_UA, maxTouchPoints: 5 })).toBe('android');
  });

  it('treats an iPad that claims to be a Mac as iOS, and prefers userAgentData', () => {
    expect(detectOs({ platform: 'MacIntel', userAgent: MAC_UA, maxTouchPoints: 5 })).toBe('ios');
    expect(detectOs({ platform: 'Win32', userAgent: WIN_UA, uaDataPlatform: 'macOS' })).toBe('mac');
    expect(detectOs({})).toBe('other');
  });

  it('guesses the pointing device before any wheel event', () => {
    expect(defaultPointer('mac')).toBe('trackpad');
    expect(defaultPointer('windows')).toBe('mouse');
    expect(defaultPointer('linux')).toBe('mouse');
    expect(defaultPointer('ios')).toBe('touch');
    expect(defaultPointer('android')).toBe('touch');
    expect(defaultPointer('windows', { coarse: true, hover: false })).toBe('touch');
  });

  it('lets the user override the detected device', () => {
    expect(resolvePointer('auto', 'trackpad')).toBe('trackpad');
    expect(resolvePointer('mouse', 'trackpad')).toBe('mouse');
    expect(resolvePointer('touch', 'mouse')).toBe('touch');
  });
});

describe('wheel event classification', () => {
  it('a Ctrl + wheel with small fractional deltas is a pinch', () => {
    const c = new WheelClassifier();
    expect(c.push(wheel({ ctrlKey: true, deltaY: -2.4 }), 0)).toBe('pinch');
    expect(c.push(wheel({ ctrlKey: true, deltaY: 3.1 }), 16)).toBe('pinch');
    expect(c.device('mouse')).toBe('trackpad');
  });

  it('Ctrl + a whole 100 px notch is a zoom from a mouse', () => {
    const c = new WheelClassifier();
    expect(c.push(wheel({ ctrlKey: true, deltaY: 100 }), 0)).toBe('pinch');
    c.push(wheel({ ctrlKey: true, deltaY: 100 }), 400);
    expect(c.device('trackpad')).toBe('mouse');
  });

  it('two-axis, fractional pixel deltas in a burst are a trackpad swipe', () => {
    const c = new WheelClassifier();
    let kind = c.push(wheel({ deltaX: 3.5, deltaY: -7.25 }), 0);
    for (let i = 1; i < 6; i++) kind = c.push(wheel({ deltaX: 2.5 - i * 0.2, deltaY: -6.1 + i * 0.4 }), i * 16);
    expect(kind).toBe('trackpad');
  });

  it('a stream of small whole-pixel steps (Chrome on a Mac trackpad) is a trackpad', () => {
    const c = new WheelClassifier();
    let kind = 'mouse';
    for (let i = 0; i < 8; i++) kind = c.push(wheel({ deltaY: 4 + i, wheelDeltaY: -3 * (4 + i) }), i * 16);
    expect(kind).toBe('trackpad');
  });

  it('a macOS mouse (small fractional ticks, one at a time) is a mouse, a trackpad swipe in the same units is not', () => {
    const mouse = new WheelClassifier();
    for (let i = 0; i < 4; i++) mouse.push(wheel({ deltaY: 4.000244140625, wheelDeltaY: -12 }), i * 350);
    expect(mouse.device('trackpad')).toBe('mouse');
    const pad = new WheelClassifier();
    for (let i = 0; i < 10; i++) pad.push(wheel({ deltaY: 4.000244140625 + i * 0.5, wheelDeltaY: -12 }), i * 16);
    expect(pad.device('mouse')).toBe('trackpad');
  });

  it('isolated 120-unit notches and line-mode deltas are a mouse wheel', () => {
    const a = new WheelClassifier();
    expect(a.push(wheel({ deltaY: 100, wheelDeltaY: -120 }), 0)).toBe('mouse');
    expect(a.push(wheel({ deltaY: 100, wheelDeltaY: -120 }), 500)).toBe('mouse');
    const b = new WheelClassifier();
    expect(b.push(wheel({ deltaY: 3, deltaMode: 1 }), 0)).toBe('mouse');
  });

  it('a mouse after a trackpad wins back the device within a few notches', () => {
    const c = new WheelClassifier();
    for (let i = 0; i < 8; i++) c.push(wheel({ deltaX: 1.5, deltaY: 5.5 }), i * 16);
    expect(c.device('mouse')).toBe('trackpad');
    for (let i = 0; i < 5; i++) c.push(wheel({ deltaY: 100, wheelDeltaY: -120 }), 1000 + i * 300);
    expect(c.device('trackpad')).toBe('mouse');
  });

  it('the platform state follows the evidence and the override', () => {
    const p = new PlatformState(
      { platform: 'MacIntel', userAgent: MAC_UA, maxTouchPoints: 0 },
      { coarse: false, hover: true },
    );
    expect(p.os).toBe('mac');
    expect(p.pointer('auto')).toBe('trackpad'); // a Mac is assumed to have a trackpad
    for (let i = 0; i < 4; i++) p.noteWheel(wheel({ deltaY: 100, wheelDeltaY: -120 }), i * 400);
    expect(p.pointer('auto')).toBe('mouse');
    expect(p.pointer('trackpad')).toBe('trackpad');
    expect(p.describe('auto')).toContain('macOS');
  });
});

describe('Safari gesture events', () => {
  it('turns the total scale of gesturechange into steps', () => {
    const g = new GestureTracker();
    g.start();
    expect(g.change(1.1, 4).factor).toBeCloseTo(1.1);
    const second = g.change(1.21, 10);
    expect(second.factor).toBeCloseTo(1.1);
    expect(second.rotation).toBeCloseTo(6);
    expect(g.change(NaN).factor).toBe(1);
    g.end();
    expect(g.active).toBe(false);
  });
});

describe('modifier names and key caps', () => {
  it('prints Cmd / Option on Apple platforms and Ctrl / Alt elsewhere', () => {
    expect(modNames('mac')).toMatchObject({ mod: 'Cmd', alt: 'Option' });
    expect(modNames('ios').mod).toBe('Cmd');
    expect(modNames('windows')).toMatchObject({ mod: 'Ctrl', alt: 'Alt' });
    expect(modNames('linux').alt).toBe('Alt');
    expect(fillMods('{alt} + drag, {mod} + swipe', 'mac')).toBe('Option + drag, Cmd + swipe');
    expect(fillMods('{alt} + drag, {mod} + swipe', 'windows')).toBe('Alt + drag, Ctrl + swipe');
  });

  it('labels key codes the way they are printed on the key', () => {
    expect(keyCapLabel('KeyW', 'windows')).toBe('W');
    expect(keyCapLabel('Digit3', 'mac')).toBe('3');
    expect(keyCapLabel('ArrowUp', 'mac')).toBe('↑');
    expect(keyCapLabel('AltLeft', 'mac')).toBe('Option');
    expect(keyCapLabel('AltRight', 'linux')).toBe('Alt');
    expect(keyCapLabel('Numpad7', 'linux')).toBe('Num 7');
    expect(keyCapLabel('BracketLeft', 'linux')).toBe('[');
    expect(keyCapLabel('PadSouth', 'linux')).toBe('South');
  });
});
