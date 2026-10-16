import { describe, expect, it, vi } from 'vitest';
import { BIOME_IDS } from '../../biomes/types';
import { GAME_CONFIG } from '../../config';
import { buildFirstDayRoute } from '../../onboarding/routeInFrame';
import { ParkSession } from '../../session/ParkSession';
import { validateMapDefinition } from '../validate';
import { entranceFrame } from '../frame';
import { GROUND_WATER } from '../types';
import type { Noise } from './noise';

/**
 * Adversarial review (Phase 24 step 2): the repair pass must terminate and meet its targets under HOSTILE noise, not
 * only under the real hash. The noise module is replaced by modes that drive every feature to its extreme (all
 * hashes 0, all hashes max, a checkerboard, stripes, a seed-independent constant). For each mode and every biome,
 * density and water option the generator must return a valid map (or throw MapGeneratorBug, never hang) and the
 * First Day route must build.
 */
type Mode = 'real' | 'zero' | 'max' | 'checker' | 'stripes' | 'xor';
const state: { mode: Mode } = { mode: 'real' };

vi.mock('./noise', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./noise')>();
  const hostile = (salt: number): Noise => {
    const real = actual.makeNoise(salt);
    const h = (tag: number, a: number, b: number): number => {
      switch (state.mode) {
        case 'zero': return 0;
        case 'max': return 0xffff_ffff;
        case 'checker': return ((a + b) & 1) === 0 ? 0 : 0xffff_ffff;
        case 'stripes': return (a & 1) === 0 ? 0x0000_ffff : 0xffff_0000;
        case 'xor': return ((a ^ b ^ tag) & 1) === 0 ? 0x7fff_ffff : 0x8000_0000;
        default: return real.h(tag, a, b);
      }
    };
    const value = (tag: number, x: number, y: number, shift: number): number => (state.mode === 'real' ? real.value(tag, x, y, shift) : h(tag, x >> shift, y >> shift) >>> 16);
    return {
      h,
      value,
      fbm: (tag, x, y, octaves) => (state.mode === 'real' ? real.fbm(tag, x, y, octaves) : value(tag, x, y, 2)),
      meander: (tag, t, shift, amp) => (state.mode === 'real' ? real.meander(tag, t, shift, amp) : ((value(tag, t, 0, shift) - 32768) * amp) >> 15),
      pick: (tag, n) => h(tag, 0, 0) % n,
      range: (tag, lo, hi) => lo + (h(tag, 0, 0) % (hi - lo + 1)),
    };
  };
  return { ...actual, makeNoise: hostile };
});

const { generateMap, recipeOf, MAP_DENSITIES, MapGeneratorBug } = await import('./index');

const MODES: Mode[] = ['zero', 'max', 'checker', 'stripes', 'xor'];

describe('generator under hostile noise (review)', () => {
  it.each(MODES)('mode %s: every biome, density and water option terminates with a valid, reachable map and a First Day route', (mode) => {
    state.mode = mode;
    const failures: string[] = [];
    const repairs: number[] = [];
    try {
      for (const biome of BIOME_IDS) {
        for (const density of MAP_DENSITIES) {
          for (const water of [true, false]) {
            const label = `${mode} ${biome} ${density} ${water ? 'wet' : 'dry'}`;
            let map: ReturnType<typeof generateMap>;
            try {
              map = generateMap(recipeOf(biome, 1234, { density, water }));
            } catch (error) {
              failures.push(`${label}: ${error instanceof MapGeneratorBug ? 'MapGeneratorBug ' : ''}${String((error as Error).message).slice(0, 200)}`);
              continue;
            }
            repairs.push(map.stats.repair.r1 + map.stats.repair.r2 * 100 + map.stats.repair.r3 * 10000);
            if (validateMapDefinition(map.definition).length > 0) failures.push(`${label}: validator`);
            if (map.stats.open < GAME_CONFIG.maps.generator.minimumOpenArea) failures.push(`${label}: open ${map.stats.open}`);
            if (map.stats.cleared < GAME_CONFIG.maps.generator.minimumClearedArea) failures.push(`${label}: cleared ${map.stats.cleared}`);
            if (map.stats.repair.r1 > GAME_CONFIG.maps.generator.maxCarves || map.stats.repair.r2 > GAME_CONFIG.maps.generator.maxCarves) failures.push(`${label}: carves`);
            let wet = 0;
            for (const byte of map.layout.ground) if (byte === GROUND_WATER) wet += 1;
            if (wet > Math.floor((1024 * 3) / 10)) failures.push(`${label}: water ${wet} above the 30 % cap`);
            const frame = entranceFrame(map.layout.entrance);
            for (let d = 0; d <= 12; d += 1) {
              for (let l = -3; l <= 4; l += 1) {
                const c = frame.toWorld(l, d);
                if (c.x >= 0 && c.y >= 0 && c.x < 32 && c.y < 32 && map.layout.ground[c.y * 32 + c.x] === GROUND_WATER) failures.push(`${label}: water in the halo at ${c.x},${c.y}`);
              }
            }
            try {
              buildFirstDayRoute(new ParkSession(null, [], { layout: map.layout }));
            } catch (error) {
              failures.push(`${label}: First Day ${String((error as Error).message).slice(0, 120)}`);
            }
          }
        }
      }
    } finally {
      state.mode = 'real';
    }
    expect(failures).toEqual([]);
    if ((globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env.REVIEW_REPORT === "1") console.log(mode, repairs.join(" "));
  }, 120_000);
});
