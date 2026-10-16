import { hashString } from '../save/hash';
import { hash32 } from '../weather/random';
import { propFootprintSize } from './parse';
import { PROP_KIND_BY_ID, type PropKindDefinition } from './props';
import { GROUND_ALT, GROUND_WATER, type Facing, type MapLayout, type PropPlacement } from './types';

/**
 * Map previews (Phase 24 step 2): a pure, deterministic top-down image of a MapLayout built from the biome's ground
 * colours and the prop kinds' colours (a prop colour too close to the ground under it is drawn in a contrasting ink, so
 * every obstacle shows). No WebGL, no DOM, no floating point, no randomness (the water sparkle is a
 * positional hash). North is up. The UI draws the RGBA with putImageData; Phase 22/23 (scenario list, The Map) call
 * `mapPreviewOf(layout)` or `renderMapPreview(layout, { cellPx: 2 })`.
 */

export const MAP_PREVIEW_CELL_PX = 4;

export interface MapPreviewImage {
  readonly width: number;
  readonly height: number;
  /** RGBA, row-major. Never mutate. */
  readonly data: Uint8ClampedArray;
  /** FNV-1a 32 of `data`, 8 hex characters. */
  readonly hash: string;
}

export interface MapFacts {
  /** The map edge the gate is on. */
  readonly gateEdge: 'north' | 'east' | 'south' | 'west';
  /** Props standing on the land at the start. */
  readonly obstacles: number;
  /** Water tiles. */
  readonly water: number;
}

const GATE = 0xff6f91;
/** Phase 21: the owned area's rail and the colour the land for sale is dimmed toward (the voxel land overlay's). */
const FENCE = 0xf3e2b3;
const DIM = 0x152033;
/** 3/8 of the way from `rgb` to DIM, per channel, in integers. */
const dim = (rgb: number): number => {
  const mix = (shift: number): number => {
    const a = (rgb >> shift) & 255;
    const b = (DIM >> shift) & 255;
    return (a * 5 + b * 3) >> 3;
  };
  return (mix(16) << 16) | (mix(8) << 8) | mix(0);
};
const GATE_CORE = 0xfff8ec;

/** 4x4 masks: 'C' colour, 'A' accent, 'D' colour x 3/4, '.' ground. */
const TALL = ['.CC.', 'CCCC', '.CC.', '.AA.'];
const MID = ['....', '.CC.', 'CCAC', '.CC.'];
const LOW = ['....', '....', '.CC.', 'CAAC'];
const PERMANENT = ['DDDD', 'DCCD', 'DCCD', 'DDDD'];
const LOG = ['....', 'CCCC', 'CCCC', '....'];
const BIG = [
  'DDDDDDDD', 'DCCCCCCD', 'DCCCCCCD', 'DCCAACCD', 'DCCAACCD', 'DCCCCCCD', 'DCCCCCCD', 'DDDDDDDD',
];

export const previewHash = (data: Uint8ClampedArray): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < data.length; index += 1) {
    hash ^= data[index];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

const darker = (rgb: number): number => {
  const r = ((rgb >> 16) & 255) * 3 >> 2;
  const g = ((rgb >> 8) & 255) * 3 >> 2;
  const b = (rgb & 255) * 3 >> 2;
  return (r << 16) | (g << 8) | b;
};

const distanceSq = (a: number, b: number): number => {
  const dr = ((a >> 16) & 255) - ((b >> 16) & 255);
  const dg = ((a >> 8) & 255) - ((b >> 8) & 255);
  const db = (a & 255) - (b & 255);
  return dr * dr + dg * dg + db * db;
};

/** Integer mix of `rgb` toward `target` by `quarters` / 4. */
const mixToward = (rgb: number, target: number, quarters: number): number => {
  const channel = (shift: number): number => {
    const from = (rgb >> shift) & 255;
    const to = (target >> shift) & 255;
    return (from * (4 - quarters) + to * quarters) >> 2;
  };
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
};

/** A prop pixel must stand out from the ground under it by at least this RGB distance (squared). */
const MIN_PROP_CONTRAST_SQ = 72 * 72;
const INK_DARK = 0x2f3a5c;
const INK_LIGHT = 0xffffff;

/**
 * The colour a prop pixel is drawn in: its own colour when it stands out from every ground colour under the prop,
 * else the first of "half / three quarters toward a slate ink, then toward white" that does (a snow drift on snow
 * becomes a blue-grey mound, a red boulder on red alt ground a dark one). Pure integer maths.
 */
const contrasting = (rgb: number, grounds: readonly number[]): number => {
  const nearest = (candidate: number): number => Math.min(...grounds.map((ground) => distanceSq(candidate, ground)));
  if (nearest(rgb) >= MIN_PROP_CONTRAST_SQ) return rgb;
  let best = rgb;
  let bestDistance = nearest(rgb);
  for (const [ink, quarters] of [[INK_DARK, 2], [INK_DARK, 3], [INK_LIGHT, 2], [INK_LIGHT, 3]] as const) {
    const candidate = mixToward(rgb, ink, quarters);
    const distance = nearest(candidate);
    if (distance >= MIN_PROP_CONTRAST_SQ) return candidate;
    if (distance > bestDistance) { best = candidate; bestDistance = distance; }
  }
  return best;
};

const maskFor = (kind: PropKindDefinition): readonly string[] => {
  if (kind.footprint[0] === 2 && kind.footprint[1] === 2) return BIG;
  if (kind.footprint[0] * kind.footprint[1] === 2) return LOG;
  if (kind.clearCost === null) return PERMANENT;
  return kind.height === 'tall' ? TALL : kind.height === 'mid' ? MID : LOW;
};

export interface PreviewOptions {
  readonly cellPx?: 2 | 4;
  /** The props to draw (default: the layout's start props); pass the live set to show what was cleared. */
  readonly props?: readonly PropPlacement[];
}

/** Full renders at 4 px per cell; 2 px takes the top-left pixel of each 2x2 block, so it is always a pure function of the 4 px image. */
export const renderMapPreview = (layout: MapLayout, options: PreviewOptions = {}): MapPreviewImage => {
  const cell = MAP_PREVIEW_CELL_PX;
  const width = layout.width * cell;
  const height = layout.height * cell;
  const pixels = new Uint32Array(width * height);
  const { ground } = layout.biome;
  const put = (px: number, py: number, rgb: number): void => {
    if (px >= 0 && py >= 0 && px < width && py < height) pixels[py * width + px] = rgb;
  };
  for (let y = 0; y < layout.height; y += 1) {
    for (let x = 0; x < layout.width; x += 1) {
      const kind = layout.ground[y * layout.width + x];
      const colour = kind === GROUND_WATER ? ground.water : kind === GROUND_ALT ? ground.alt : ground.base;
      const rgb = (x + y) % 2 === 0 || kind === GROUND_WATER ? colour.rgb : colour.secondary;
      for (let dy = 0; dy < cell; dy += 1) for (let dx = 0; dx < cell; dx += 1) put(x * cell + dx, y * cell + dy, rgb);
      if (kind === GROUND_WATER && (hash32(7, x, y) & 3) === 0) put(x * cell + 2, y * cell + 2, colour.secondary);
    }
  }
  // Phase 21: on an estate the ground for sale is dimmed (3/8 toward the dim colour) and the owned area is fenced with a
  // 2 px rail (2 px so the 2 px preview, which keeps the top-left pixel of each block, still shows it), both under the
  // props, so every obstacle keeps its full contrast.
  const owned = layout.ownedArea;
  if (owned !== undefined) {
    const ox0 = owned.x0 * cell;
    const oy0 = owned.y0 * cell;
    const ox1 = (owned.x1 + 1) * cell - 1;
    const oy1 = (owned.y1 + 1) * cell - 1;
    for (let py = 0; py < height; py += 1) {
      for (let px = 0; px < width; px += 1) {
        const inside = px >= ox0 && px <= ox1 && py >= oy0 && py <= oy1;
        if (!inside) pixels[py * width + px] = dim(pixels[py * width + px]);
        else if (px - ox0 < 2 || ox1 - px < 2 || py - oy0 < 2 || oy1 - py < 2) pixels[py * width + px] = FENCE;
      }
    }
  }
  for (const prop of options.props ?? layout.props) {
    const kind = PROP_KIND_BY_ID.get(prop.kind);
    if (!kind) continue;
    const mask = maskFor(kind);
    const [w, d] = propFootprintSize(kind, prop.rotation);
    const alongY = kind.footprint[0] !== kind.footprint[1] && prop.rotation % 2 === 1;
    // Every ground colour under the footprint (both checker shades): a prop close to its ground gets a contrasting ink.
    const grounds: number[] = [];
    for (let cy = 0; cy < d; cy += 1) {
      for (let cx = 0; cx < w; cx += 1) {
        const at = (prop.y + cy) * layout.width + prop.x + cx;
        const groundKind = layout.ground[at];
        const colour = groundKind === GROUND_WATER ? ground.water : groundKind === GROUND_ALT ? ground.alt : ground.base;
        // Phase 21: the ground for sale is drawn dimmed, so the ink must contrast with the dimmed colours.
        const forSale = owned !== undefined && (prop.x + cx < owned.x0 || prop.x + cx > owned.x1 || prop.y + cy < owned.y0 || prop.y + cy > owned.y1);
        grounds.push(forSale ? dim(colour.rgb) : colour.rgb, forSale ? dim(colour.secondary) : colour.secondary);
      }
    }
    const colours: Record<string, number> = {
      C: contrasting(kind.color, grounds), A: contrasting(kind.accent, grounds), D: contrasting(darker(kind.color), grounds),
    };
    const size = mask.length;
    for (let my = 0; my < size; my += 1) {
      for (let mx = 0; mx < size; mx += 1) {
        const char = alongY ? mask[mx][my] : mask[my][mx];
        const colour = colours[char];
        if (colour === undefined) continue;
        // Big props use an 8x8 mask over a 2x2 footprint; logs use the 4x4 mask per cell along their axis.
        if (size === 8) put(prop.x * cell + mx, prop.y * cell + my, colour);
      }
    }
    if (size === 4) {
      for (let cy = 0; cy < d; cy += 1) {
        for (let cx = 0; cx < w; cx += 1) {
          for (let my = 0; my < 4; my += 1) {
            for (let mx = 0; mx < 4; mx += 1) {
              const char = alongY ? mask[mx][my] : mask[my][mx];
              const colour = colours[char];
              if (colour !== undefined) put((prop.x + cx) * cell + mx, (prop.y + cy) * cell + my, colour);
            }
          }
        }
      }
    }
  }
  for (let dy = 0; dy < cell; dy += 1) {
    for (let dx = 0; dx < cell; dx += 1) {
      const core = dx >= 1 && dx <= 2 && dy >= 1 && dy <= 2;
      put(layout.entrance.x * cell + dx, layout.entrance.y * cell + dy, core ? GATE_CORE : GATE);
    }
  }
  const step = options.cellPx === 2 ? 2 : 1;
  const outWidth = width / step;
  const outHeight = height / step;
  const data = new Uint8ClampedArray(outWidth * outHeight * 4);
  for (let y = 0; y < outHeight; y += 1) {
    for (let x = 0; x < outWidth; x += 1) {
      const rgb = pixels[y * step * width + x * step];
      const at = (y * outWidth + x) * 4;
      data[at] = (rgb >> 16) & 255;
      data[at + 1] = (rgb >> 8) & 255;
      data[at + 2] = rgb & 255;
      data[at + 3] = 255;
    }
  }
  return Object.freeze({ width: outWidth, height: outHeight, data, hash: previewHash(data) });
};

const CACHE_LIMIT = 64;
const cache = new Map<string, MapPreviewImage>();

const propsSignature = (props: readonly PropPlacement[]): string => (
  hashString(props.map((prop) => `${prop.id}:${prop.kind}:${prop.x},${prop.y},${prop.rotation}`).join('|'))
);

/** The cached preview of a layout (4 px per cell, 2 px on a map larger than 32 x 32) (keyed by ground, recipe id and props; LRU of 64; a hit returns the same object). */
export const mapPreviewOf = (layout: MapLayout): MapPreviewImage => {
  const owned = layout.ownedArea;
  const key = `${layout.groundKey}|${propsSignature(layout.props)}${owned === undefined ? '' : `|${owned.x0},${owned.y0},${owned.x1},${owned.y1}`}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  // Phase 21: a map larger than 32 x 32 previews at 2 px per cell, so every preview stays about 128 px across.
  const image = renderMapPreview(layout, layout.width > 32 || layout.height > 32 ? { cellPx: 2 } : {});
  cache.set(key, image);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return image;
};

const GATE_EDGE: Readonly<Record<Facing, MapFacts['gateEdge']>> = { north: 'south', south: 'north', east: 'west', west: 'east' };

/** The facts the picker and the scenario list show next to a preview (the gate edge follows the facing). */
export const mapFactsOf = (layout: MapLayout): MapFacts => {
  let water = 0;
  for (const cell of layout.ground) if (cell === GROUND_WATER) water += 1;
  return { gateEdge: GATE_EDGE[layout.entrance.facing], obstacles: layout.props.length, water };
};
