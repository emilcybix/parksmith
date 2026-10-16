import { afterEach, describe, expect, it, vi } from 'vitest';
import { BIOME_IDS, type BiomeId } from '../../biomes/types';
import { GAME_CONFIG } from '../../config';
import { buildFirstDayRoute } from '../../onboarding/routeInFrame';
import { hashState } from '../../save/hash';
import { ParkSession } from '../../session/ParkSession';
import { hash32 } from '../../weather/random';
import { entranceFrame } from '../frame';
import { propFootprintSize } from '../parse';
import { mapPreviewOf, renderMapPreview } from '../preview';
import { PROP_KIND_BY_ID } from '../props';
import { FACINGS, GROUND_WATER, type Facing, type MapEntrance, type MapLayout } from '../types';
import { validateMapDefinition } from '../validate';
import { CELLS, SIZE, clearedArea, indexOf, openArea, RESERVED_APRON, RESERVED_HALO, type MapDraft } from './draft';
import {
  GENERATOR_VERSION, MAP_DENSITIES, MAX_SEED, PROP_BOX_WEIGHT, createDraft, generateMap, generatedMapHash, propWeightPerChunk,
  recipeOf, repairDraft, type GeneratedMap, type MapDensity, type MapRecipe,
} from './index';
import { GOLDEN_CORPUS_KEYS, corpusDigestOf, recipeOfGoldenKey } from './goldenCorpus';
import { weightPerCell } from './weights';

/**
 * ADVERSARIAL REVIEW, Phase 24 step 2: generator determinism and safety. `it.fails` marks a confirmed finding (the test
 * asserts what the spec asks for and fails today). Environment knobs: REVIEW_FUZZ_SEEDS (default 120 per biome and
 * density; the review ran 2000) and REVIEW_REPORT=1 (prints the tables).
 */
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined>; cpuUsage(): { user: number; system: number } } }).process;
const FUZZ_SEEDS = Number(env.env.REVIEW_FUZZ_SEEDS ?? 120);
const REPORT = env.env.REVIEW_REPORT === '1';
const cpuMs = (): number => { const u = env.cpuUsage(); return (u.user + u.system) / 1000; };
const gen = GAME_CONFIG.maps.generator;

/** Everything the generator returns, not only what the golden hash covers (name, blurb, rows, stats). */
const fullHash = (map: GeneratedMap): string => hashState({
  definition: map.definition,
  recipe: map.recipe,
  stats: map.stats,
  layout: { id: map.layout.id, name: map.layout.name, entrance: map.layout.entrance, ground: [...map.layout.ground], props: map.layout.props, seed: map.layout.seed, groundKey: map.layout.groundKey },
});

const CORPUS: MapRecipe[] = [];
for (const biome of BIOME_IDS) {
  for (const density of MAP_DENSITIES) {
    for (const seed of [0, 7, 2 ** 31 - 1, 2 ** 31, MAX_SEED]) {
      CORPUS.push(recipeOf(biome, seed, { density, water: seed % 2 === 0 }));
    }
  }
}

afterEach(() => { vi.restoreAllMocks(); });

describe('determinism under hostile globals (review)', () => {
  const baseline = CORPUS.map((recipe) => fullHash(generateMap(recipe)));

  it('Math.random, Date.now, new Date and performance.now all throw: the generator never touches them and the output is identical', () => {
    const boom = (): never => { throw new Error('the generator touched a forbidden global'); };
    vi.spyOn(Math, 'random').mockImplementation(boom);
    vi.spyOn(Date, 'now').mockImplementation(boom);
    vi.spyOn(performance, 'now').mockImplementation(boom);
    const RealDate = Date;
    vi.stubGlobal('Date', new Proxy(RealDate, { construct: boom }));
    try {
      expect(CORPUS.map((recipe) => fullHash(generateMap(recipe)))).toEqual(baseline);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('after heavy use of the guest RNG, the weather chain and Math.random, in a shuffled order, every recipe gives the identical map', () => {
    const session = new ParkSession(null, [], { layout: generateMap(recipeOf('jungle', 99)).layout });
    buildFirstDayRoute(session);
    session.guests.spawnGuests(60);
    for (let tick = 0; tick < 300; tick += 1) session.step(GAME_CONFIG.fixedStepMs);
    for (let i = 0; i < 10_000; i += 1) Math.random();
    const order = CORPUS.map((_, i) => i).sort((a, b) => hash32(a, 5) - hash32(b, 5));
    const shuffled = new Array<string>(CORPUS.length);
    for (const i of order) {
      shuffled[i] = fullHash(generateMap(CORPUS[i]));
      session.step(GAME_CONFIG.fixedStepMs); // interleave the simulation between generations
    }
    expect(shuffled).toEqual(baseline);
  });

  it('a generated map is deeply frozen enough that a caller cannot poison a later call (mutating the result does not change the next one)', () => {
    const recipe = recipeOf('seaside', 1234);
    const first = generateMap(recipe);
    const before = fullHash(first);
    try { (first.layout.ground as Uint8Array)[5] = 2; } catch { /* frozen is fine */ }
    try { (first.definition.rows as string[])[0] = 'x'.repeat(32); } catch { /* frozen is fine */ }
    expect(fullHash(generateMap(recipe))).toBe(before);
  });
});

describe('extreme and adjacent seeds (review)', () => {
  it('seeds 0, 1, 2^31-1, 2^31, 2^32-2 and 2^32-1 are valid, distinct maps in every biome (no sign or wrap aliasing)', () => {
    for (const biome of BIOME_IDS) {
      const hashes = [0, 1, 2 ** 31 - 1, 2 ** 31, MAX_SEED - 1, MAX_SEED].map((seed) => generatedMapHash(generateMap(recipeOf(biome, seed))));
      expect(new Set(hashes).size, biome).toBe(hashes.length);
    }
  });

  it('typed seeds 0..299 (what a person types) give 300 distinct maps per biome', () => {
    for (const biome of BIOME_IDS) {
      const seen = new Set<string>();
      for (let seed = 0; seed < 300; seed += 1) seen.add(generatedMapHash(generateMap(recipeOf(biome, seed))));
      expect(seen.size, biome).toBe(300);
    }
  }, 60_000);

  it('-0 is accepted as seed 0 and gives the seed-0 map (harmless; JSON writes it as 0)', () => {
    expect(generatedMapHash(generateMap(recipeOf('meadow', -0)))).toBe(generatedMapHash(generateMap(recipeOf('meadow', 0))));
  });
});

/** Independent reachability over the emitted layout (never the generator's own bookkeeping). */
const reach = (layout: MapLayout, blocking: (kind: string) => boolean): number => {
  const blocked = new Uint8Array(CELLS);
  for (let i = 0; i < CELLS; i += 1) if (layout.ground[i] === GROUND_WATER) blocked[i] = 1;
  for (const prop of layout.props) {
    if (!blocking(prop.kind)) continue;
    const [w, d] = propFootprintSize(PROP_KIND_BY_ID.get(prop.kind)!, prop.rotation);
    for (let dy = 0; dy < d; dy += 1) for (let dx = 0; dx < w; dx += 1) blocked[(prop.y + dy) * SIZE + prop.x + dx] = 1;
  }
  const start = layout.entrance.y * SIZE + layout.entrance.x;
  if (blocked[start]) return 0;
  const seen = new Uint8Array(CELLS);
  seen[start] = 1;
  const stack = [start];
  let count = 0;
  while (stack.length > 0) {
    const i = stack.pop()!;
    count += 1;
    const x = i % SIZE;
    for (const n of [x > 0 ? i - 1 : -1, x < SIZE - 1 ? i + 1 : -1, i - SIZE, i + SIZE]) {
      if (n < 0 || n >= CELLS || seen[n] || blocked[n]) continue;
      seen[n] = 1;
      stack.push(n);
    }
  }
  return count;
};

const invariantProblems = (map: GeneratedMap): string[] => {
  const out: string[] = [];
  const { layout, recipe } = map;
  if (validateMapDefinition(map.definition).length > 0) out.push('validator');
  const open = reach(layout, () => true);
  const cleared = reach(layout, (kind) => PROP_KIND_BY_ID.get(kind as never)!.clearCost === null);
  if (open < gen.minimumOpenArea) out.push(`open ${open}`);
  if (cleared < gen.minimumClearedArea) out.push(`cleared ${cleared}`);
  if (open !== map.stats.open || cleared !== map.stats.cleared) out.push('stats disagree with an independent flood fill');
  const frame = entranceFrame(layout.entrance);
  const occupied = new Uint8Array(CELLS);
  for (const prop of layout.props) {
    const kind = PROP_KIND_BY_ID.get(prop.kind)!;
    if (kind.biome !== recipe.biomeId) out.push(`foreign prop ${prop.kind}`);
    const [w, d] = propFootprintSize(kind, prop.rotation);
    for (let dy = 0; dy < d; dy += 1) for (let dx = 0; dx < w; dx += 1) occupied[(prop.y + dy) * SIZE + prop.x + dx] = 1;
  }
  // Halo: d 0..12, l -3..4 has no prop and no water; the gate cell is base.
  for (let d = 0; d <= 12; d += 1) {
    for (let l = -3; l <= 4; l += 1) {
      const c = frame.toWorld(l, d);
      if (c.x < 0 || c.y < 0 || c.x >= SIZE || c.y >= SIZE) continue;
      const i = c.y * SIZE + c.x;
      if (occupied[i] || layout.ground[i] === GROUND_WATER) { out.push(`halo ${l},${d}`); break; }
    }
  }
  // Water is never 8-adjacent to the apron (l -2..3, d 0..11).
  for (let d = 0; d < GAME_CONFIG.maps.firstDayApron.depth; d += 1) {
    for (let l = GAME_CONFIG.maps.firstDayApron.lateral[0]; l <= GAME_CONFIG.maps.firstDayApron.lateral[1]; l += 1) {
      const c = frame.toWorld(l, d);
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        const x = c.x + dx; const y = c.y + dy;
        if (x >= 0 && y >= 0 && x < SIZE && y < SIZE && layout.ground[y * SIZE + x] === GROUND_WATER) out.push(`water next to the apron at ${x},${y}`);
      }
    }
  }
  if (layout.props.length > gen.maxGeneratedProps) out.push('prop count');
  const weights = propWeightPerChunk(layout, layout.props);
  if (Math.max(...weights) > gen.chunkPropWeightCap) out.push('chunk weight');
  if (weights.reduce((a, b) => a + b, 0) > gen.mapPropWeightCap) out.push('map weight');
  if (map.stats.maxPropCellsPerChunk > GAME_CONFIG.maps.maxPropCellsPerChunk) out.push('chunk cells');
  let water = 0;
  for (const byte of layout.ground) if (byte === GROUND_WATER) water += 1;
  if (!recipe.water && water > 0) out.push('dry map has water');
  if (JSON.stringify(map.stats).includes('null') || !Object.values(map.stats).every((v) => typeof v === 'object' || Number.isFinite(v))) out.push('non-finite stats');
  if (JSON.stringify(map.definition).includes('NaN')) out.push('NaN');
  return out;
};

describe(`generator fuzz on review seed streams (${FUZZ_SEEDS} seeds x 6 biomes x 3 densities x 2 streams)`, () => {
  describe.each(BIOME_IDS)('%s', (biome: BiomeId) => {
    it('every invariant holds on an independent flood fill, every 25th map builds the First Day route, CPU time < 20 ms', () => {
      const problems: string[] = [];
      const slow: { recipe: MapRecipe; ms: number }[] = [];
      let r3 = 0;
      for (const density of MAP_DENSITIES as readonly MapDensity[]) {
        for (let i = 0; i < FUZZ_SEEDS; i += 1) {
          // Two streams: small typed seeds (0, 1, 2, ...) and hashed seeds the builders' fuzz does not use.
          for (const seed of [i, hash32(i, 0xbeef)]) {
            const recipe = recipeOf(biome, seed, { density, water: (i & 3) !== 3 });
            const started = cpuMs();
            const map = generateMap(recipe);
            const ms = cpuMs() - started;
            if (ms >= 20) slow.push({ recipe, ms });
            r3 += map.stats.repair.r3;
            for (const problem of invariantProblems(map)) problems.push(`${biome} ${density} seed ${seed}: ${problem}`);
            if (i % 25 === 0) {
              try { buildFirstDayRoute(new ParkSession(null, [], { layout: map.layout })); } catch (error) { problems.push(`${biome} ${density} seed ${seed}: First Day ${(error as Error).message}`); }
            }
          }
        }
      }
      // A slow map is re-measured alone (best of 3): only a real >= 20 ms map is a failure.
      const reallySlow = slow.filter(({ recipe }) => {
        let best = Infinity;
        for (let run = 0; run < 3; run += 1) { const t = cpuMs(); generateMap(recipe); best = Math.min(best, cpuMs() - t); }
        return best >= 20;
      });
      if (REPORT) console.log(`${biome}: problems ${problems.length}, R3 ${r3}, slow ${slow.length}, really slow ${reallySlow.length}`);
      expect(problems.slice(0, 20)).toEqual([]);
      expect(reallySlow.map(({ recipe, ms }) => `${recipe.seed} ${recipe.density} ${ms.toFixed(1)} ms`)).toEqual([]);
    }, 900_000);
  });
});

/** All four borders, every allowed gate position 6..25. */
const ALL_GATES: MapEntrance[] = FACINGS.flatMap((facing: Facing) => Array.from({ length: 20 }, (_, k) => {
  const along = 6 + k;
  switch (facing) {
    case 'north': return { x: along, y: SIZE - 1, facing };
    case 'south': return { x: along, y: 0, facing };
    case 'east': return { x: 0, y: along, facing };
    default: return { x: SIZE - 1, y: along, facing };
  }
}));

const forceProp = (draft: MapDraft, kind: 'stone-wall' | 'oak-tree', x: number, y: number): void => {
  const index = indexOf(x, y);
  if (draft.occupancy[index] !== 0 || draft.reserved[index] !== 0) return;
  draft.props.push({ kind, x, y, rotation: 0 });
  draft.occupancy[index] = draft.props.length;
  draft.chunkCells[(y >> 3) * 4 + (x >> 3)] += 1;
  draft.chunkWeight[(y >> 3) * 4 + (x >> 3)] += weightPerCell(kind);
  draft.totalWeight += weightPerCell(kind);
  draft.count += 1;
};

describe('repair pass at every gate position (review)', () => {
  const patterns: Record<string, (draft: MapDraft) => void> = {
    'water everywhere outside the halo': (draft) => { for (let i = 0; i < CELLS; i += 1) if (!draft.reserved[i]) draft.ground[i] = GROUND_WATER; },
    'a water maze of 1-cell rooms (hundreds of components)': (draft) => {
      for (let i = 0; i < CELLS; i += 1) { const x = i % SIZE; const y = (i - x) / SIZE; if (!draft.reserved[i] && (x % 2 === 1 || y % 2 === 1)) draft.ground[i] = GROUND_WATER; }
    },
    'permanent walls on every free cell': (draft) => { for (let i = 0; i < CELLS; i += 1) forceProp(draft, 'stone-wall', i % SIZE, Math.floor(i / SIZE)); },
    'walls ring the halo, water beyond': (draft) => {
      for (let i = 0; i < CELLS; i += 1) {
        if (draft.reserved[i]) continue;
        const x = i % SIZE; const y = (i - x) / SIZE;
        const nearHalo = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => { const nx = x + dx; const ny = y + dy; return nx >= 0 && ny >= 0 && nx < SIZE && ny < SIZE && draft.reserved[ny * SIZE + nx] !== 0; });
        if (nearHalo) forceProp(draft, 'stone-wall', x, y); else draft.ground[i] = GROUND_WATER;
      }
    },
    'clearable trees on every free cell': (draft) => { for (let i = 0; i < CELLS; i += 1) forceProp(draft, 'oak-tree', i % SIZE, Math.floor(i / SIZE)); },
  };

  it.each(Object.keys(patterns))('%s: terminates within its caps and meets both targets for all 80 gate positions', (name) => {
    const failures: string[] = [];
    for (const gate of ALL_GATES) {
      const draft = createDraft(gate);
      patterns[name](draft);
      const { steps, log } = repairDraft(draft, { open: gen.minimumOpenArea, cleared: gen.minimumClearedArea });
      const label = `${gate.facing} ${gate.x},${gate.y}`;
      if (openArea(draft) < gen.minimumOpenArea) failures.push(`${label} open ${openArea(draft)}`);
      if (clearedArea(draft) < gen.minimumClearedArea) failures.push(`${label} cleared ${clearedArea(draft)}`);
      if (steps.r1 > gen.maxCarves || steps.r2 > gen.maxCarves || log.length > 2 * gen.maxCarves + 1) failures.push(`${label} unbounded`);
      for (const step of log) if (step.obstaclesAfter > step.obstaclesBefore) failures.push(`${label} ${step.phase} added obstacles`);
      for (let i = 0; i < CELLS; i += 1) {
        if ((draft.reserved[i] & (RESERVED_APRON | RESERVED_HALO)) !== 0 && (draft.occupancy[i] !== 0 || draft.ground[i] === GROUND_WATER)) { failures.push(`${label} halo touched`); break; }
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);
});

describe('golden VERSION policy (review)', () => {
  /** The 22 recipes the golden test pins. */
  const GOLDEN_KEYS = [
    ...BIOME_IDS.flatMap((biome) => [1, 1234, 3735928559].map((seed) => `${biome}:${seed}:normal:wet`)),
    'seaside:1234:low:wet', 'seaside:1234:high:wet', 'seaside:1234:normal:dry', 'meadow:1234:normal:dry',
  ];
  const goldenRecipe = (key: string): MapRecipe => {
    const [biome, seed, density, water] = key.split(':');
    return recipeOf(biome as BiomeId, Number(seed), { density: density as MapDensity, water: water === 'wet' });
  };
  /** The 22 single pins plus the corpus digest the golden test pins (the fix for the finding below). */
  const pins = (): string[] => [
    ...GOLDEN_KEYS.map((key) => generatedMapHash(generateMap(goldenRecipe(key)))),
    corpusDigestOf(GOLDEN_CORPUS_KEYS.map((key) => generatedMapHash(generateMap(recipeOfGoldenKey(key))))),
  ];
  /** A corpus where the change is visible: 100 hashed seeds x 6 biomes at high density. */
  const corpus = BIOME_IDS.flatMap((biome) => Array.from({ length: 100 }, (_, i) => recipeOf(biome, hash32(i, 31337), { density: 'high' })));
  const withConfig = <T>(key: keyof typeof gen, value: number, run: () => T): T => {
    const target = gen as unknown as Record<string, number>;
    const old = target[key];
    target[key] = value;
    try { return run(); } finally { target[key] = old; }
  };

  const CHANGES = [
    ['minimumOpenArea', 450],
    ['maxGeneratedProps', 299],
    ['chunkPropWeightCap', 1_399],
    ['mapPropWeightCap', 8_599],
    ['maxCarves', 2],
  ] as const;
  const controlCorpus = [...corpus, ...GOLDEN_CORPUS_KEYS.map(recipeOfGoldenKey)];

  it.each(CHANGES)('%s -> %d really changes generator output (control for the finding below)', (key, value) => {
    const base = controlCorpus.map((recipe) => generatedMapHash(generateMap(recipe)));
    const changed = withConfig(key, value, () => controlCorpus.filter((recipe, i) => generatedMapHash(generateMap(recipe)) !== base[i]).length);
    expect(changed).toBeGreaterThan(0);
    expect(GENERATOR_VERSION).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it.each(CHANGES)('FIXED: changing %s to %d changes output for some seeds, so a golden pin (the corpus digest) changes', (key, value) => {
    const base = pins();
    const after = withConfig(key, value, pins);
    expect(after).not.toEqual(base);
  }, 60_000);
});

describe('voxel chunk honesty of the generator caps (review)', () => {
  /** The renderer puts ALL boxes of a prop in the chunk of its front-most footprint cell (staticWorld.homeChunkOfProp). */
  const rendererChunkWeights = (layout: MapLayout): number[] => {
    const chunks = new Array<number>(16).fill(0);
    for (const prop of layout.props) {
      const [w, d] = propFootprintSize(PROP_KIND_BY_ID.get(prop.kind)!, prop.rotation);
      chunks[(Math.min(31, prop.y + d - 1) >> 3) * 4 + (Math.min(31, prop.x + w - 1) >> 3)] += PROP_BOX_WEIGHT[prop.kind];
    }
    return chunks;
  };

  it.fails('FINDING: the per-chunk weight cap bounds the chunk the renderer actually fills (the generator splits a 2x1/2x2 prop across chunks, the renderer does not)', () => {
    const over: string[] = [];
    for (const biome of ['seaside', 'meadow'] as const) {
      for (const density of MAP_DENSITIES) {
        for (let i = 0; i < 300; i += 1) {
          const map = generateMap(recipeOf(biome, hash32(i, 4711), { density }));
          const worst = Math.max(...rendererChunkWeights(map.layout));
          if (worst > gen.chunkPropWeightCap) over.push(`${biome} ${density} seed ${map.recipe.seed}: ${worst}`);
        }
      }
    }
    if (REPORT) console.log(over.join('\n'));
    expect(over).toEqual([]);
  }, 120_000);
});

describe('previews (review)', () => {
  it('deterministic and cheap: the same hash after the cache is bypassed, < 5 ms median for a 4 px render', () => {
    const layouts = BIOME_IDS.map((biome) => generateMap(recipeOf(biome, 4242, { density: 'high' })).layout);
    const times: number[] = [];
    for (const layout of layouts) {
      for (let run = 0; run < 5; run += 1) {
        const t = cpuMs();
        const image = renderMapPreview(layout);
        times.push(cpuMs() - t);
        expect(image.hash).toBe(mapPreviewOf(layout).hash);
      }
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length / 2)]).toBeLessThan(5);
  });

  it.fails('FINDING: the preview cache key ignores the entrance, so two layouts with the same id, ground and props but another gate share one stale image', () => {
    const layout = generateMap(recipeOf('meadow', 5150)).layout;
    const first = mapPreviewOf(layout);
    const { entrance } = layout;
    const moved: MapLayout = { ...layout, entrance: { ...entrance, x: entrance.facing === 'north' || entrance.facing === 'south' ? entrance.x + 1 : entrance.x, y: entrance.facing === 'east' || entrance.facing === 'west' ? entrance.y + 1 : entrance.y } };
    expect(renderMapPreview(moved).hash).not.toBe(first.hash); // the true image differs
    expect(mapPreviewOf(moved).hash).toBe(renderMapPreview(moved).hash); // the cache returns the old one
  });
});

describe('restore never regenerates: the stored ground wins too (review)', () => {
  it('a hand-edited ground row (water poured into the map) is kept, the recipe stays, and the name is the generated one', () => {
    const map = generateMap(recipeOf('meadow', 31337));
    const session = new ParkSession(null, [], { layout: map.layout });
    const state = JSON.parse(JSON.stringify(session.serialize())) as ReturnType<ParkSession['serialize']>;
    const taken = new Set<number>();
    for (const prop of state.map.props) taken.add(prop.y * 32 + prop.x);
    // Flip the first free base cell far from the gate to alt ground, and drop every remaining prop.
    const rows = [...state.map.ground];
    const y = state.map.entrance.y === 0 ? 31 : 0;
    rows[y] = rows[y].replace(/\./, ',');
    state.map.ground = rows;
    state.map.props = [];
    const restored = ParkSession.fromState(state);
    expect(restored.map.recipe).toEqual(map.recipe);
    expect(restored.world.props.size).toBe(0);
    expect(restored.serialize().map.ground).toEqual(rows);
    expect(restored.serialize().map.ground).not.toEqual(JSON.parse(JSON.stringify(session.serialize())).map.ground);
  });
});
