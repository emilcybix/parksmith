import { describe, expect, it } from 'vitest';
import { BIOME_IDS } from '../biomes/types';
import { generateMap, recipeOf } from './generator';
import { MAPS } from './content';
import { layoutOfMapId, propFootprintSize } from './parse';
import { MAP_PREVIEW_CELL_PX, mapFactsOf, mapPreviewOf, previewHash, renderMapPreview } from './preview';
import { PROP_KIND_BY_ID } from './props';

/**
 * Previews (Phase 24 step 2): pure, deterministic, PNG-free. The pinned hashes are FNV-1a 32 over the RGBA bytes. A change
 * of a biome ground colour, a prop colour or a mask changes them, on purpose (re-pin with the change). Re-pinned when props
 * close to their ground got the contrasting ink (review: snow drifts on snow were invisible); Meadow has no props and kept its pin.
 */
const PINS = {
  meadow: '45bc167d',
  'seaside-cove': '48596ac9',
  'red-rock-canyon': 'b27a5169',
  gen_seaside_1234: 'f12198bb',
  gen_jungle_deadbeef: 'a8bb2ebf',
  gen_seaside_1234_2px: '291399c9',
};

const pixel = (image: { width: number; data: Uint8ClampedArray }, x: number, y: number): number => {
  const at = (y * image.width + x) * 4;
  return (image.data[at] << 16) | (image.data[at + 1] << 8) | image.data[at + 2];
};

describe('map previews', () => {
  it('pins the hash of Meadow, the new Seaside Cove, Red Rock Canyon and two generated maps (and the 2 px variant)', () => {
    expect(renderMapPreview(layoutOfMapId('meadow')).hash).toBe(PINS.meadow);
    expect(renderMapPreview(layoutOfMapId('seaside-cove')).hash).toBe(PINS['seaside-cove']);
    expect(renderMapPreview(layoutOfMapId('red-rock-canyon')).hash).toBe(PINS['red-rock-canyon']);
    expect(renderMapPreview(generateMap(recipeOf('seaside', 1234)).layout).hash).toBe(PINS.gen_seaside_1234);
    expect(renderMapPreview(generateMap(recipeOf('jungle', 0xdeadbeef)).layout).hash).toBe(PINS.gen_jungle_deadbeef);
    expect(renderMapPreview(generateMap(recipeOf('seaside', 1234)).layout, { cellPx: 2 }).hash).toBe(PINS.gen_seaside_1234_2px);
  });

  it('is 128 x 128 RGBA at 4 px per cell and 64 x 64 at 2 px; opaque; hash matches previewHash', () => {
    const layout = layoutOfMapId('brookside-meadow');
    const big = renderMapPreview(layout);
    const small = renderMapPreview(layout, { cellPx: 2 });
    expect([big.width, big.height, big.data.length]).toEqual([128, 128, 128 * 128 * 4]);
    expect([small.width, small.height, small.data.length]).toEqual([64, 64, 64 * 64 * 4]);
    expect(MAP_PREVIEW_CELL_PX).toBe(4);
    for (let at = 3; at < big.data.length; at += 4) if (big.data[at] !== 255) throw new Error('not opaque');
    expect(previewHash(big.data)).toBe(big.hash);
    // The 2 px image is the top-left pixel of each 2 x 2 block of the 4 px image.
    for (const [x, y] of [[0, 0], [10, 7], [33, 40], [63, 63]]) expect(pixel(small, x, y)).toBe(pixel(big, x * 2, y * 2));
  });

  it('renders the same pixels every time, from any layout instance of the same map', () => {
    const recipe = recipeOf('winter', 5);
    expect(renderMapPreview(generateMap(recipe).layout).hash).toBe(renderMapPreview(generateMap(recipe).layout).hash);
    expect(renderMapPreview(generateMap(recipeOf('winter', 6)).layout).hash).not.toBe(renderMapPreview(generateMap(recipe).layout).hash);
  });

  it('draws the gate (a pink block with a white core), the biome ground checker and water', () => {
    const layout = layoutOfMapId('seaside-cove');
    const image = renderMapPreview(layout);
    const { x, y } = layout.entrance;
    expect(pixel(image, x * 4, y * 4)).toBe(0xff6f91);
    expect(pixel(image, x * 4 + 1, y * 4 + 1)).toBe(0xfff8ec);
    expect(pixel(image, x * 4 + 3, y * 4 + 3)).toBe(0xff6f91);
    // A base cell away from props: the checker alternates by (x + y) parity.
    const base = layout.biome.ground.base;
    expect(pixel(image, 10 * 4, 10 * 4)).toBe(base.rgb);
    expect(pixel(image, 11 * 4, 10 * 4)).toBe(base.secondary);
    // Water uses the biome water colour.
    const wet = layout.ground.indexOf(2);
    expect([layout.biome.ground.water.rgb, layout.biome.ground.water.secondary]).toContain(pixel(image, (wet % 32) * 4, Math.floor(wet / 32) * 4 + 1));
  });

  it('props: a permanent 1x1 gets the dark border mask, and a water-surface pier stands on water in the biome colours', () => {
    const layout = layoutOfMapId('seaside-cove');
    const pier = layout.props.find((prop) => prop.kind === 'boardwalk-pier')!;
    const kind = PROP_KIND_BY_ID.get('boardwalk-pier')!;
    expect(kind.surface).toBe('water');
    const image = renderMapPreview(layout);
    const dark = (((kind.color >> 16) & 255) * 3 >> 2) << 16 | (((kind.color >> 8) & 255) * 3 >> 2) << 8 | ((kind.color & 255) * 3 >> 2);
    expect(pixel(image, pier.x * 4, pier.y * 4)).toBe(dark);
    expect(pixel(image, pier.x * 4 + 1, pier.y * 4 + 1)).toBe(kind.color);
    expect(layout.ground[pier.y * 32 + pier.x]).toBe(2);
  });

  it('draws only the props it is given: clearing a prop changes the picture', () => {
    const layout = layoutOfMapId('brookside-meadow');
    const full = renderMapPreview(layout);
    const without = renderMapPreview(layout, { props: layout.props.slice(1) });
    expect(without.hash).not.toBe(full.hash);
    expect(renderMapPreview(layout, { props: layout.props }).hash).toBe(full.hash);
  });

  it('a 2x1 log lies along its axis, a 2x2 prop fills 8 x 8 pixels', () => {
    const layout = layoutOfMapId('brookside-meadow');
    const log = layout.props.find((prop) => prop.kind === 'mossy-log')!;
    const image = renderMapPreview(layout, { props: [log] });
    const ground = layout.biome.ground.base;
    const [w, d] = log.rotation % 2 === 0 ? [2, 1] : [1, 2];
    for (let cy = 0; cy < d; cy += 1) {
      for (let cx = 0; cx < w; cx += 1) {
        const px = (log.x + cx) * 4;
        const py = (log.y + cy) * 4;
        const inside = log.rotation % 2 === 0 ? pixel(image, px + 1, py + 1) : pixel(image, px + 1, py + 1);
        expect([ground.rgb, ground.secondary]).not.toContain(inside);
      }
    }
    const spire = generateMap(recipeOf('desert-canyon', 1234)).layout.props.find((prop) => prop.kind === 'rock-spire');
    if (spire) {
      const desert = generateMap(recipeOf('desert-canyon', 1234)).layout;
      const big = renderMapPreview(desert, { props: [spire] });
      // The 2 x 2 accent core: the spire's accent is the red rock floor colour, so it is drawn in the contrasting ink.
      const core = pixel(big, spire.x * 4 + 3, spire.y * 4 + 3);
      const { base, alt } = desert.biome.ground;
      expect([base.rgb, base.secondary, alt.rgb, alt.secondary]).not.toContain(core);
      expect(core).toBe(pixel(big, spire.x * 4 + 4, spire.y * 4 + 4));
    }
  });

  it('caches by ground key and props: a hit returns the same object, a different map a different one, LRU of 64', () => {
    const layout = generateMap(recipeOf('meadow', 99)).layout;
    const first = mapPreviewOf(layout);
    expect(mapPreviewOf(layout)).toBe(first);
    expect(mapPreviewOf(generateMap(recipeOf('meadow', 99)).layout)).toBe(first);
    expect(mapPreviewOf(generateMap(recipeOf('meadow', 100)).layout)).not.toBe(first);
    expect(first.hash).toBe(renderMapPreview(layout).hash);
    // Push 70 other maps through: the first falls out of the LRU and is re-rendered (equal content, a new object).
    for (let seed = 1_000; seed < 1_070; seed += 1) mapPreviewOf(generateMap(recipeOf('meadow', seed)).layout);
    const again = mapPreviewOf(layout);
    expect(again).not.toBe(first);
    expect(again.hash).toBe(first.hash);
  });

  it('is cheap: below 5 ms per 128 px preview (median far below), generation not included', () => {
    const layouts = (['meadow', 'seaside', 'winter', 'jungle'] as const).map((biome) => generateMap(recipeOf(biome, 11, { density: 'high' })).layout);
    renderMapPreview(layouts[0]);
    const times: number[] = [];
    for (let run = 0; run < 200; run += 1) {
      const started = performance.now();
      renderMapPreview(layouts[run % 4]);
      times.push(performance.now() - started);
    }
    const sorted = [...times].sort((a, b) => a - b);
    expect(sorted[100], 'median').toBeLessThan(2);
    expect(sorted[197], 'p99').toBeLessThan(5);
  });

  it('mapFactsOf: the gate edge follows the facing, obstacles are the props, water counts water tiles', () => {
    expect(mapFactsOf(layoutOfMapId('meadow'))).toEqual({ gateEdge: 'south', obstacles: 0, water: 0 });
    expect(mapFactsOf(layoutOfMapId('seaside-cove'))).toEqual({ gateEdge: 'west', obstacles: 76, water: 311 });
    expect(mapFactsOf(layoutOfMapId('red-rock-canyon')).gateEdge).toBe('north');
    expect(mapFactsOf(layoutOfMapId('emerald-ruins')).gateEdge).toBe('east');
  });

  it('shows every obstacle: each prop changes at least 2 of its pixels by an RGB distance >= 60 (snow drifts on snow, red boulders on red ground)', () => {
    const layouts = [
      ...MAPS.map((map) => layoutOfMapId(map.id)),
      ...BIOME_IDS.flatMap((biome) => [1234, 7, 0xdeadbeef].map((seed) => generateMap(recipeOf(biome, seed)).layout)),
    ];
    const invisible: string[] = [];
    for (const layout of layouts) {
      const full = renderMapPreview(layout);
      const bare = renderMapPreview(layout, { props: [] });
      for (const prop of layout.props) {
        const [w, d] = propFootprintSize(PROP_KIND_BY_ID.get(prop.kind)!, prop.rotation);
        let strong = 0;
        for (let y = prop.y * 4; y < (prop.y + d) * 4; y += 1) {
          for (let x = prop.x * 4; x < (prop.x + w) * 4; x += 1) {
            const at = (y * full.width + x) * 4;
            const dr = full.data[at] - bare.data[at];
            const dg = full.data[at + 1] - bare.data[at + 1];
            const db = full.data[at + 2] - bare.data[at + 2];
            if (dr * dr + dg * dg + db * db >= 60 * 60) strong += 1;
          }
        }
        if (strong < 2) invisible.push(`${layout.id} ${prop.kind}@${prop.x},${prop.y}`);
      }
    }
    expect(invisible).toEqual([]);
  });
});
