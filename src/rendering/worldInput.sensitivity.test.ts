import { afterEach, describe, expect, it } from 'vitest';
import { resetSettings, updateSettings } from '../settings/settingsStore';
import { CAMERA_SPEED_FACTORS } from '../settings/schema';
import { bindWorldInput, KEY_PAN_CSS_PER_MS, settingsSensitivity } from './worldInput';

/** Camera sensitivity: key-pan speed and wheel-zoom step scale with the settings, live. */

type Listener = (event: any) => void;

const makeBinding = () => {
  const canvasListeners = new Map<string, Listener>();
  const keyListeners = new Map<string, Listener>();
  const pans: Array<[number, number]> = [];
  const zooms: number[] = [];
  const canvas = {
    addEventListener: (type: string, listener: Listener) => { canvasListeners.set(type, listener); },
    removeEventListener: () => undefined,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    setPointerCapture: () => undefined,
  };
  const keySource = {
    addEventListener: (type: string, listener: Listener) => { keyListeners.set(type, listener); },
    removeEventListener: () => undefined,
  };
  const view = {
    cssSize: () => ({ width: 100, height: 100 }),
    cssToWorld: (x: number, y: number) => ({ x, y }),
    panByCss: (dx: number, dy: number) => { pans.push([dx, dy]); },
    zoomAtCss: (_x: number, _y: number, event: { deltaY: number }) => { zooms.push(event.deltaY); },
  };
  const input = bindWorldInput(canvas as never, view, () => true, () => null, keySource as never);
  return { input, pans, zooms, wheel: (deltaY: number) => canvasListeners.get('wheel')!({ clientX: 1, clientY: 1, deltaY, deltaMode: 0, preventDefault: () => undefined }), press: (key: string) => keyListeners.get('keydown')!({ key }) };
};

afterEach(() => resetSettings());

describe('camera sensitivity from settings', () => {
  it('defaults reproduce the legacy key speed and an untouched wheel', () => {
    const { input, pans, zooms, wheel, press } = makeBinding();
    press('d');
    input.keyPan(100);
    expect(pans).toEqual([[-(KEY_PAN_CSS_PER_MS * 100), 0]]);
    wheel(120);
    expect(zooms).toEqual([120]);
  });

  it('key pan speed follows the setting live, per frame', () => {
    const { input, pans, press } = makeBinding();
    press('a');
    for (const speed of ['slow', 'normal', 'fast'] as const) {
      pans.length = 0;
      updateSettings({ cameraKeySpeed: speed });
      input.keyPan(100);
      expect(pans[0][0]).toBeCloseTo(KEY_PAN_CSS_PER_MS * 100 * CAMERA_SPEED_FACTORS[speed]);
    }
  });

  it('wheel zoom delta scales with the setting and keeps the line/page mode', () => {
    const { zooms, wheel } = makeBinding();
    updateSettings({ cameraZoomStep: 'slow' });
    wheel(100);
    updateSettings({ cameraZoomStep: 'fast' });
    wheel(100);
    expect(zooms).toEqual([100 * CAMERA_SPEED_FACTORS.slow, 100 * CAMERA_SPEED_FACTORS.fast]);
  });

  it('the key and wheel settings are independent', () => {
    updateSettings({ cameraKeySpeed: 'fast' });
    expect(settingsSensitivity()).toEqual({ keyPan: CAMERA_SPEED_FACTORS.fast, wheel: 1 });
  });
});
