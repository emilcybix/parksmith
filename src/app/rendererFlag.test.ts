import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The renderer flags are read once from the URL and never persisted, so a broken experimental
 * renderer can never stick. Each case re-imports the module against its own URL.
 */
const flagsFor = async (search: string) => {
  vi.resetModules();
  vi.stubGlobal('window', { location: { search } });
  const flags = await import('./rendererFlag');
  return { kind: flags.RENDERER_KIND, light: flags.LIGHT_PRESET, override: flags.LIGHT_OVERRIDE, time: flags.TIME_OVERRIDE, zoom: flags.ZOOM_OVERRIDE, soft: flags.ALLOW_SOFTWARE_GPU, min: flags.VOXEL_GPU_MIN };
};

afterEach(() => vi.unstubAllGlobals());

describe('renderer flags', () => {
  it('parses every switch and rejects junk', async () => {
    expect(await flagsFor('')).toEqual({ kind: 'voxel', light: 'day', override: null, time: null, zoom: null, soft: false, min: false });
    expect(await flagsFor('?renderer=voxel&light=night&zoom=3&voxelAllowSoftware=1&voxelGpu=min'))
      .toEqual({ kind: 'voxel', light: 'night', override: 'night', time: null, zoom: 3, soft: true, min: true });
    // Only the exact word opts out of the main renderer; anything else, junk included, gets voxel.
    expect((await flagsFor('?renderer=classic')).kind).toBe('classic');
    expect((await flagsFor('?renderer=CLASSIC')).kind).toBe('voxel');
    expect((await flagsFor('?renderer=voxel')).kind).toBe('voxel');
    expect((await flagsFor('?renderer=nonsense')).kind).toBe('voxel');
    expect((await flagsFor('?light=noon')).light).toBe('day');
    expect((await flagsFor('?light=dusk')).light).toBe('dusk');
    for (const bad of ['0', '-2', '1.5', 'abc', '1e2', '', '99999999999999999999']) {
      expect((await flagsFor(`?zoom=${bad}`)).zoom, bad).toBeNull();
    }
    expect((await flagsFor('?zoom=07')).zoom).toBe(7);
    expect((await flagsFor('?voxelAllowSoftware=true')).soft).toBe(false);
  });

  it('reads &time= as a fraction or as hours, and light= stays an explicit override', async () => {
    expect((await flagsFor('?time=0.75')).time).toBe(0.75);
    expect((await flagsFor('?time=0')).time).toBe(0);
    expect((await flagsFor('?time=18')).time).toBe(0.75);
    expect((await flagsFor('?time=18:30')).time).toBeCloseTo(18.5 / 24, 12);
    expect((await flagsFor('?time=1')).time, '1 means 01:00, not the end of the day').toBeCloseTo(1 / 24, 12);
    expect((await flagsFor('?time=.5')).time).toBe(0.5);
    for (const bad of ['', 'noon', '24', '25', '18:60', '1.5', '-1', '1e2', '18:5', '0.', '1.0']) {
      expect((await flagsFor(`?time=${bad}`)).time, bad).toBeNull();
    }
    expect((await flagsFor('?light=dusk&time=3')).override).toBe('dusk');
    expect((await flagsFor('?light=bogus')).override).toBeNull();
  });

  it('never throws on a hostile location', async () => {
    vi.resetModules();
    vi.stubGlobal('window', { get location() { throw new Error('blocked'); } });
    const flags = await import('./rendererFlag');
    expect(flags.RENDERER_KIND).toBe('voxel');
  });
});

describe('weather flags', () => {
  const weatherFor = async (search: string) => {
    vi.resetModules();
    vi.stubGlobal('window', { location: { search } });
    const flags = await import('./rendererFlag');
    return { weather: flags.WEATHER_FLAGS, voxel: flags.VOXEL_WEATHER };
  };

  it('reads the presentation pins and ignores junk', async () => {
    expect((await weatherFor('')).weather).toEqual({});
    expect((await weatherFor('?weather=storm')).weather).toEqual({ pin: { kind: 'storm', intensity: 0.8 } });
    expect((await weatherFor('?weather=rain&wintensity=0.3&wclock=7&wmotion=run&wflash=1')).weather)
      .toEqual({ pin: { kind: 'rain', intensity: 0.3 }, fixedClockSeconds: 7, runWhilePaused: true, flashPin: 1 });
    expect((await weatherFor('?weather=blizzard')).weather).toEqual({});
    expect((await weatherFor('?wintensity=0.3')).weather).toEqual({});
    expect((await weatherFor('?voxelWeather=off')).voxel).toBe('off');
    expect((await weatherFor('?voxelWeather=rain')).voxel).toBe('rain');
    expect((await weatherFor('?voxelWeather=full')).voxel).toBeNull();
  });
});

describe('see-through flag', () => {
  const lookFor = async (search: string) => {
    vi.resetModules();
    vi.stubGlobal('window', { location: { search } });
    return (await import('./rendererFlag')).VOXEL_SEE_THROUGH;
  };

  it('defaults to the translucent look, and reads dither and off exactly', async () => {
    expect(await lookFor('')).toBe('alpha');
    expect(await lookFor('?voxelSeeThrough=alpha')).toBe('alpha');
    expect(await lookFor('?voxelSeeThrough=dither')).toBe('dither');
    expect(await lookFor('?voxelSeeThrough=off')).toBe('off');
    expect(await lookFor('?voxelSeeThrough=OFF')).toBe('alpha');
    expect(await lookFor('?voxelSeeThrough=')).toBe('alpha');
    expect(await lookFor('?voxelSeeThrough=garbage')).toBe('alpha');
  });
});

describe('renderer setting (voxel leftovers)', () => {
  it('the URL flag wins, else the setting', async () => {
    const { rendererKindOf } = await import('./rendererFlag');
    expect(rendererKindOf('classic', 'voxel')).toBe('classic');
    expect(rendererKindOf('voxel', 'classic')).toBe('voxel');
    expect(rendererKindOf(null, 'classic')).toBe('classic');
    expect(rendererKindOf('junk', 'voxel')).toBe('voxel');
  });
});
