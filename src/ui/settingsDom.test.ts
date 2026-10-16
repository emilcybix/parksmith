import { afterEach, describe, expect, it } from 'vitest';
import { resetSettings, updateSettings } from '../settings';
import { applySettingsToDom, startSettingsDom, uiLayoutVars, type DomRoot, type ViewportSource } from './settingsDom';

const fakeRoot = (): DomRoot & { vars: Record<string, string>; attrs: Record<string, string> } => {
  const vars: Record<string, string> = {};
  const attrs: Record<string, string> = {};
  return { vars, attrs, style: { setProperty: (name, value) => { vars[name] = value; } }, setAttribute: (name, value) => { attrs[name] = value; } };
};

const fakeViewport = (innerWidth: number, innerHeight: number) => {
  const listeners = new Set<() => void>();
  const viewport: ViewportSource & { resize(w: number, h: number): void; listenerCount(): number } = {
    innerWidth,
    innerHeight,
    addEventListener: (_type, listener) => { listeners.add(listener); },
    removeEventListener: (_type, listener) => { listeners.delete(listener); },
    resize(w, h) { viewport.innerWidth = w; viewport.innerHeight = h; for (const listener of [...listeners]) listener(); },
    listenerCount: () => listeners.size,
  };
  return viewport;
};

afterEach(() => resetSettings());

describe('uiLayoutVars', () => {
  it('leaves scale 100 and 85 alone and reports the zoomed viewport', () => {
    expect(uiLayoutVars(100, 1280, 720)).toEqual({ zoom: 1, width: 1280, height: 720 });
    const small = uiLayoutVars(85, 1280, 720);
    expect(small.zoom).toBe(0.85);
    expect(small.width).toBeCloseTo(1505.88, 1);
  });

  it('caps scaling up to what fits, so the layout never gets less than the HUD minimum', () => {
    const vars = uiLayoutVars(130, 1280, 720);
    expect(vars.zoom).toBeCloseTo(1.043, 3);
    expect(vars.width).toBeGreaterThanOrEqual(1100 - 1e-6);
    expect(vars.height).toBeGreaterThanOrEqual(690 - 1e-6);
    expect(uiLayoutVars(130, 1920, 1080).zoom).toBe(1.3);
  });
});

describe('applySettingsToDom', () => {
  it('writes the CSS variables and the motion attribute', () => {
    const root = fakeRoot();
    applySettingsToDom(root, { uiScale: 115 } as never, { innerWidth: 1920, innerHeight: 1080 }, true);
    expect(root.vars['--ui-zoom']).toBe('1.15');
    expect(root.vars['--ui-vw']).toBe(`${Math.round((1920 / 1.15) * 1000) / 1000}px`);
    expect(root.attrs['data-motion']).toBe('reduce');
    applySettingsToDom(root, { uiScale: 100 } as never, { innerWidth: 1280, innerHeight: 720 }, false);
    expect(root.attrs['data-motion']).toBe('full');
    expect(root.vars['--ui-vw']).toBe('1280px');
  });
});

describe('startSettingsDom', () => {
  it('applies at once, follows settings and resizes, and stops cleanly', () => {
    const root = fakeRoot();
    const viewport = fakeViewport(1920, 1080);
    const stop = startSettingsDom(root, viewport);
    expect(root.vars['--ui-zoom']).toBe('1');
    updateSettings({ uiScale: 130 });
    expect(root.vars['--ui-zoom']).toBe('1.3');
    viewport.resize(1280, 720);
    expect(Number(root.vars['--ui-zoom'])).toBeCloseTo(1.043, 3);
    updateSettings({ reducedMotion: 'on' });
    expect(root.attrs['data-motion']).toBe('reduce');
    updateSettings({ reducedMotion: 'off' });
    expect(root.attrs['data-motion']).toBe('full');
    stop();
    expect(viewport.listenerCount()).toBe(0);
    updateSettings({ uiScale: 85 });
    expect(Number(root.vars['--ui-zoom'])).toBeCloseTo(1.043, 3);
  });
});
