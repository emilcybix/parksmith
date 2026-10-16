import { Container, Graphics } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { BIOMES, BIOME_BY_ID } from '../game/biomes/content';
import { MAPS } from '../game/maps/content';
import { PROP_KIND_BY_ID } from '../game/maps/props';
import { GROUND_ALT, GROUND_BASE, GROUND_WATER } from '../game/maps/types';
import { FOUNDING_SCENARIOS } from '../game/scenarios/content';
import { ParkSession } from '../game/session/ParkSession';
import { seedDevPark } from '../game/session/devPark';
import type { Cell } from '../game/types';
import baseline from './__fixtures__/classic-phase24-baseline.json';
import { countGraphicsDrawCalls } from './drawCallCounter';
import { drawPropArt, propArtIsOriented } from './classicPropArt';
import { entranceFocus } from './entranceFraming';
import { fingerprintNode } from './sceneFingerprint';
import { SEE_THROUGH } from './seeThrough';
import { createViewFrame, type ViewRotation } from './viewRotation';
import { WorldRenderer } from './WorldRenderer';

/**
 * Phase 24, classic renderer: the Meadow default is byte-identical to the pre-change scene graph (pinned from the
 * baseline captured BEFORE any Phase 24 change), terrain and path colours follow the biome, props are pooled
 * displays that appear on sync, vanish on a clear and re-sort on a view turn, nothing is rebuilt per frame, and the
 * entrance framing comes from the map.
 */

type Internals = {
  terrainCache: Map<number, Graphics>;
  propDisplays: Map<number, { container: Graphics; sortKey: number; along: 0 | 1 }>;
  seeThroughFader: { activeCount: number };
  mounted: boolean;
  drawTerrain(): void;
  camera: Container;
  app: { screen: { width: number; height: number } };
};
const inside = (renderer: WorldRenderer): Internals => renderer as unknown as Internals;

/** SHA-256 (the baseline was captured with it), first 16 hex digits. Pure, so the test needs no Node typings. */
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const sha = (text: string): string => {
  const bytes = new TextEncoder().encode(text);
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((bytes.length * 8) / 2 ** 32));
  view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  return h.map((x) => x.toString(16).padStart(8, '0')).join('').slice(0, 16);
};
const LAYERS = ['terrain', 'construction', 'train', 'cloud', 'influence', 'selection', 'hint', 'coasterDraft', 'preview'];

const capture = (session: ParkSession): Record<string, Record<string, string>> => {
  const renderer = new WorldRenderer(session);
  renderer.syncWorld();
  const out: Record<string, Record<string, string>> = {};
  for (const rotation of [0, 1, 2, 3] as ViewRotation[]) {
    renderer.setViewRotation(rotation, true);
    renderer.syncWorld();
    inside(renderer).drawTerrain();
    const record: Record<string, string> = {};
    renderer.cameraLayers().forEach((layer, index) => {
      record[LAYERS[index] ?? `layer${index}`] = sha(layer.children.map((child) => fingerprintNode(child as Container)).sort().join('~'));
    });
    const probe = renderer.sceneProbe;
    record.pathDisplay = probe.pathDisplay ? sha(fingerprintNode(probe.pathDisplay)) : 'none';
    record.entranceDisplay = probe.entranceDisplay ? sha(fingerprintNode(probe.entranceDisplay)) : 'none';
    renderer.setGridVisible(true);
    record.terrainWithGrid = sha(renderer.cameraLayers()[0].children.map((child) => fingerprintNode(child as Container)).join('~'));
    renderer.setGridVisible(false);
    out[`v${rotation}`] = record;
  }
  renderer.destroy();
  return out;
};

const fillColours = (graphic: Graphics): number[] => {
  const context = graphic as unknown as { context: { instructions: { action: string; data?: { style?: { color?: number } } }[] } };
  return context.context.instructions.filter((i) => i.action === 'fill').map((i) => i.data?.style?.color ?? -1);
};

const instructionCount = (graphic: Graphics): number => (
  (graphic as unknown as { context: { instructions: unknown[] } }).context.instructions.length
);

const markMounted = (renderer: WorldRenderer): void => { inside(renderer).mounted = true; };

describe('classic default identity (Meadow, the baseline of the pre-Phase-24 scene graph)', () => {
  it('draws the same scene graph for a new sandbox, the dev park and every scenario in all four views', () => {
    const expected = baseline.parks as Record<string, unknown>;
    const actual: Record<string, unknown> = {};
    actual.sandbox = capture(new ParkSession(null));
    const dev = new ParkSession(null);
    seedDevPark(dev);
    dev.syncWithWorld();
    actual.devPark = capture(dev);
    for (const scenario of FOUNDING_SCENARIOS) actual[`scenario:${scenario.id}`] = capture(new ParkSession(scenario));
    expect(actual).toEqual(expected);
  }, 120_000);
});

describe('classic terrain and paths per biome', () => {
  it('colours every ground kind from the biome, as an even and an odd diamond', () => {
    for (const map of MAPS) {
      const session = new ParkSession(null, [], { mapId: map.id });
      const renderer = new WorldRenderer(session);
      inside(renderer).drawTerrain();
      const [terrain] = [...inside(renderer).terrainCache.values()];
      const colours = new Set(fillColours(terrain));
      const ground = session.world.biome.ground;
      const kinds = new Set<number>();
      for (const kind of session.world.map.ground) kinds.add(kind);
      const wanted = new Set<number>();
      const table = { [GROUND_BASE]: ground.base, [GROUND_ALT]: ground.alt, [GROUND_WATER]: ground.water };
      for (const kind of kinds) {
        const pair = table[kind as 0 | 1 | 2];
        wanted.add(pair.rgb);
        wanted.add(pair.secondary);
      }
      // Every colour the ground needs is there, and nothing but the biome's three pairs.
      for (const colour of wanted) expect(colours.has(colour), `${map.id} 0x${colour.toString(16)}`).toBe(true);
      const allowed = new Set([ground.base.rgb, ground.base.secondary, ground.alt.rgb, ground.alt.secondary, ground.water.rgb, ground.water.secondary]);
      for (const colour of colours) expect(allowed.has(colour), `${map.id} stray 0x${colour.toString(16)}`).toBe(true);
      renderer.destroy();
    }
  });

  it('every biome keeps a distinct ground: no two biomes share the same base diamond pair', () => {
    const pairs = BIOMES.map((biome) => `${biome.ground.base.rgb}/${biome.ground.base.secondary}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('Seaside reads as candy: a saturated ground, and sand, sea and path each clearly apart from it (the refresh)', () => {
    const ground = BIOME_BY_ID.get('seaside')!.ground;
    const channels = (rgb: number): number[] => [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255];
    const distance = (a: number, b: number): number => Math.hypot(...channels(a).map((value, index) => value - channels(b)[index]));
    const saturation = (rgb: number): number => {
      const [r, g, b] = channels(rgb);
      return (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(r, g, b);
    };
    expect(saturation(ground.base.rgb), 'the old ground was a washed-out mint (0.31)').toBeGreaterThan(0.45);
    for (const other of [ground.alt.rgb, ground.water.rgb, ground.paving.rgb]) expect(distance(ground.base.rgb, other)).toBeGreaterThan(60);
    expect(distance(ground.alt.rgb, ground.water.rgb)).toBeGreaterThan(100);
    expect(distance(ground.base.rgb, ground.base.secondary), 'the checker stays gentle').toBeLessThan(30);
    expect(distance(ground.base.rgb, ground.base.secondary), 'but visible').toBeGreaterThan(8);
  });

  it('draws paths in the biome paving and curb colours (Meadow: the candy path it always had)', () => {
    const meadow = new WorldRenderer(new ParkSession(null));
    const path = (renderer: WorldRenderer): number[] => {
      renderer.syncWorld();
      return fillColours(renderer.sceneProbe.pathDisplay as Graphics);
    };
    expect(new Set(path(meadow))).toEqual(new Set([0xf1d49a, 0xfff0c7]));
    for (const biome of BIOMES) {
      const map = MAPS.find((candidate) => candidate.biome === biome.id)!;
      const session = new ParkSession(null, [], { mapId: map.id });
      const renderer = new WorldRenderer(session);
      expect(new Set(path(renderer)), biome.id).toEqual(new Set([biome.ground.paving.rgb, biome.ground.classic.pathDot]));
    }
  });

  it('keeps the cached terrain across a swap onto the same map and redraws it for another', () => {
    const renderer = new WorldRenderer(new ParkSession(null, [], { mapId: 'red-rock-canyon' }));
    markMounted(renderer);
    renderer.setSession(new ParkSession(null, [], { mapId: 'red-rock-canyon' }));
    const cached = [...inside(renderer).terrainCache.values()];
    expect(cached).toHaveLength(1);
    // An undo swap: a new session on the same land, the same Graphics.
    renderer.setSession(new ParkSession(null, [], { mapId: 'red-rock-canyon' }));
    expect([...inside(renderer).terrainCache.values()][0]).toBe(cached[0]);
    expect(cached[0].destroyed).toBe(false);
    // Another biome: the cache is dropped and redrawn from the other ground.
    renderer.setSession(new ParkSession(null, [], { mapId: 'frosted-hollow' }));
    const next = [...inside(renderer).terrainCache.values()];
    expect(next).toHaveLength(1);
    expect(next[0]).not.toBe(cached[0]);
    expect(cached[0].destroyed).toBe(true);
    expect(fillColours(next[0])).toContain(0xf2f7fc);
  });
});

describe('classic backdrop colour', () => {
  const backdropAfter = (mapId: 'meadow' | 'frosted-hollow' | 'red-rock-canyon'): number => {
    const renderer = new WorldRenderer(new ParkSession(null));
    const background = { color: 0 };
    (renderer as unknown as { app: unknown }).app = { renderer: { background }, screen: { width: 1, height: 1 } };
    markMounted(renderer);
    renderer.setSession(new ParkSession(null, [], { mapId }));
    return background.color;
  };

  it('Meadow keeps the page colour it always had; other biomes take a tone of their ground, darker for a pale one', () => {
    expect(backdropAfter('meadow')).toBe(0x9ed789);
    const snow = backdropAfter('frosted-hollow');
    expect(snow, 'a pale ground gets a slightly darker backdrop so its edge reads').toBeLessThan(0xf2f7fc);
    expect(snow & 0xff).toBeGreaterThan(0xc0);
    expect(backdropAfter('red-rock-canyon')).not.toBe(0x9ed789);
  });
});

describe('classic props', () => {
  const MAPLE = 'maple-ridge' as const;

  const clearableCell = (session: ParkSession): Cell => {
    for (const prop of session.world.props.values()) {
      if (PROP_KIND_BY_ID.get(prop.kind)?.clearCost !== null) return { x: prop.x, y: prop.y };
    }
    throw new Error('no clearable prop');
  };

  it('creates one pooled display per prop on sync, none for a prop-free park', () => {
    const meadow = new WorldRenderer(new ParkSession(null));
    meadow.syncWorld();
    expect(meadow.propDisplayCount).toBe(0);
    for (const map of MAPS) {
      const session = new ParkSession(null, [], { mapId: map.id });
      const renderer = new WorldRenderer(session);
      renderer.syncWorld();
      expect(renderer.propDisplayCount, map.id).toBe(session.world.props.size);
      // Every display is a Graphics that actually drew something.
      for (const display of inside(renderer).propDisplays.values()) expect(instructionCount(display.container)).toBeGreaterThan(0);
    }
  });

  it('draws every prop kind of the data on both axes: something is drawn, it rises above the ground and stays near its footprint', () => {
    for (const kind of PROP_KIND_BY_ID.values()) {
      for (const along of [0, 1] as const) {
        const graphic = drawPropArt(new Graphics(), kind, along);
        expect(instructionCount(graphic), `${kind.id} draws`).toBeGreaterThan(0);
        const bounds = graphic.getLocalBounds();
        expect(bounds.minY, `${kind.id} rises above the ground`).toBeLessThan(-6);
        expect(bounds.maxY, `${kind.id} stays on its tile`).toBeLessThanOrEqual(kind.footprint[0] * 16 + kind.footprint[1] * 16);
        const reach = (kind.footprint[0] + kind.footprint[1]) * 32;
        expect(bounds.maxX - bounds.minX, `${kind.id} is not wider than its footprint`).toBeLessThanOrEqual(reach + 8);
        expect(bounds.minY, `${kind.id} is not absurdly tall`).toBeGreaterThan(-130);
        graphic.destroy();
      }
    }
  });

  it('every kind has its own art: none falls through to the plain block of a kind without art', () => {
    for (const kind of PROP_KIND_BY_ID.values()) {
      const fallback = { ...kind, id: 'no-such-kind' } as unknown as typeof kind;
      const own = fingerprintNode(drawPropArt(new Graphics(), kind, 0));
      const plain = fingerprintNode(drawPropArt(new Graphics(), fallback, 0));
      expect(own, `${kind.id} has art`).not.toEqual(plain);
    }
  });

  it('the pier is a low timber deck and the tide rock a small rock (the Seaside refresh kinds)', () => {
    const pier = drawPropArt(new Graphics(), PROP_KIND_BY_ID.get('boardwalk-pier')!, 0).getLocalBounds();
    const rock = drawPropArt(new Graphics(), PROP_KIND_BY_ID.get('tide-rock')!, 0).getLocalBounds();
    expect(pier.minY, 'a pier stays low').toBeGreaterThan(-30);
    expect(rock.minY, 'a tide rock is low').toBeGreaterThan(-32);
    expect(rock.maxX - rock.minX).toBeLessThanOrEqual(40);
  });

  it('a 2x1 prop lies along the other axis when asked to (and only those kinds are oriented)', () => {
    for (const kind of PROP_KIND_BY_ID.values()) {
      const a = fingerprintNode(drawPropArt(new Graphics(), kind, 0));
      const b = fingerprintNode(drawPropArt(new Graphics(), kind, 1));
      expect(a === b, `${kind.id}: oriented iff the footprint is not square`).toBe(!propArtIsOriented(kind));
    }
  });

  it('removes exactly the display of a cleared prop and keeps the others (no rebuild of the rest)', () => {
    const session = new ParkSession(null, [], { mapId: MAPLE });
    session.world.addMoney(1_000_000, 'test');
    const renderer = new WorldRenderer(session);
    renderer.syncWorld();
    const before = new Map([...inside(renderer).propDisplays].map(([id, display]) => [id, display.container]));
    const cell = clearableCell(session);
    const victim = session.world.propAt(cell)!;
    expect(session.world.bulldoze(cell).removed).toBe(true);
    renderer.syncWorld();
    expect(renderer.propDisplayCount).toBe(before.size - 1);
    expect(inside(renderer).propDisplays.has(victim.id)).toBe(false);
    expect(before.get(victim.id)!.destroyed).toBe(true);
    for (const [id, display] of inside(renderer).propDisplays) expect(display.container, `prop ${id} kept`).toBe(before.get(id));
  });

  it('draws nothing more per frame, with a prop-heavy map and 60 steady frames', () => {
    const session = new ParkSession(null, [], { mapId: MAPLE });
    const renderer = new WorldRenderer(session);
    renderer.syncWorld();
    renderer.update(16, 16);
    renderer.update(16, 32);
    const calls = countGraphicsDrawCalls(() => {
      for (let frame = 0; frame < 60; frame += 1) renderer.update(16, 48 + frame * 16);
      renderer.syncWorld();
      renderer.syncWorld();
    });
    expect(calls, 'a steady frame or a sync with no change rebuilt geometry').toBe(0);
  });

  it('re-sorts and moves the props on a view turn and redraws only the 2x1 art whose axis flips', () => {
    const session = new ParkSession(null, [], { mapId: MAPLE });
    const renderer = new WorldRenderer(session);
    renderer.syncWorld();
    const displays = [...inside(renderer).propDisplays.values()];
    const keysBefore = displays.map((display) => display.sortKey);
    const logIds = [...session.world.props.values()].filter((prop) => PROP_KIND_BY_ID.get(prop.kind)?.footprint[0] !== PROP_KIND_BY_ID.get(prop.kind)?.footprint[1]).map((prop) => prop.id);
    expect(logIds.length, 'Maple Ridge has fallen logs').toBeGreaterThan(0);
    const logFingerprint = (id: number): string => fingerprintNode(inside(renderer).propDisplays.get(id)!.container);
    const logBefore = logFingerprint(logIds[0]);
    const treeId = [...session.world.props.values()].find((prop) => !logIds.includes(prop.id))!.id;
    const treeGraphic = inside(renderer).propDisplays.get(treeId)!.container;
    const treeShape = fillColours(treeGraphic).join(',');
    renderer.setViewRotation(1, true);
    renderer.syncWorld();
    expect([...inside(renderer).propDisplays.values()].map((display) => display.sortKey)).not.toEqual(keysBefore);
    expect(inside(renderer).propDisplays.get(treeId)!.container, 'the same display object').toBe(treeGraphic);
    expect(fillColours(treeGraphic).join(','), 'a round prop is not redrawn').toBe(treeShape);
    expect(logFingerprint(logIds[0]), 'a log lies along the other axis').not.toBe(logBefore);
    renderer.setViewRotation(2, true);
    renderer.syncWorld();
    renderer.setViewRotation(1, true);
    expect(inside(renderer).propDisplays.size).toBe(session.world.props.size);
  });

  it('fades a prop that stands in front of the build site, and puts it back', () => {
    const session = new ParkSession(null, [], { mapId: MAPLE });
    const renderer = new WorldRenderer(session);
    renderer.syncWorld();
    let hovered: Cell | null = null;
    Object.defineProperty(renderer, 'hoveredCell', { get: () => hovered });
    const props = [...session.world.props.values()];
    const target = props.find((prop) => PROP_KIND_BY_ID.get(prop.kind)?.height === 'tall' && prop.x >= 2 && prop.y >= 2)!;
    // Hover the cell two behind the tree (up-left on screen): the tree sorts in front and overlaps it.
    hovered = { x: target.x - 1, y: target.y - 1 };
    renderer.setSeeThrough({ armed: true, peek: false });
    for (let i = 0; i < 40; i += 1) renderer.update(16, i * 16);
    const graphic = inside(renderer).propDisplays.get(target.id)!.container;
    expect(graphic.alpha).toBeCloseTo(SEE_THROUGH.CLASSIC_ALPHA, 5);
    renderer.setSeeThrough({ armed: false, peek: false });
    for (let i = 0; i < 40; i += 1) renderer.update(16, 640 + i * 16);
    expect(graphic.alpha).toBe(1);
    expect(inside(renderer).seeThroughFader.activeCount).toBe(0);
  });

  it('drops a faded prop from the fader when it is cleared', () => {
    const session = new ParkSession(null, [], { mapId: MAPLE });
    session.world.addMoney(1_000_000, 'test');
    const renderer = new WorldRenderer(session);
    renderer.syncWorld();
    const cell = clearableCell(session);
    let hovered: Cell | null = { x: cell.x - 1, y: cell.y - 1 };
    Object.defineProperty(renderer, 'hoveredCell', { get: () => hovered });
    renderer.setSeeThrough({ armed: true, peek: false });
    for (let i = 0; i < 40; i += 1) renderer.update(16, i * 16);
    session.world.bulldoze(cell);
    renderer.syncWorld();
    hovered = null;
    for (let i = 0; i < 40; i += 1) renderer.update(16, 640 + i * 16);
    expect(inside(renderer).seeThroughFader.activeCount).toBe(0);
  });

  it('destroys every prop display with its GraphicsContext on a session swap', () => {
    const renderer = new WorldRenderer(new ParkSession(null, [], { mapId: MAPLE }));
    renderer.syncWorld();
    markMounted(renderer);
    const old = [...inside(renderer).propDisplays.values()].map((display) => display.container);
    const contexts = old.map((graphic) => (graphic as unknown as { context: { destroyed: boolean } }).context);
    expect(old.length).toBeGreaterThan(10);
    renderer.setSession(new ParkSession(null));
    expect(renderer.propDisplayCount).toBe(0);
    for (const graphic of old) expect(graphic.destroyed).toBe(true);
    for (const context of contexts) expect(context.destroyed, 'GPU buffers released').toBe(true);
  });
});

describe('classic entrance framing from the map', () => {
  const frame = (renderer: WorldRenderer, width = 1440, height = 800): { x: number; y: number } => {
    const internals = inside(renderer);
    internals.app = { screen: { width, height } } as Internals['app'];
    internals.camera.scale.set(0.72);
    renderer.focusEntrance();
    return { x: internals.camera.position.x, y: internals.camera.position.y };
  };

  it('Meadow in view 0 frames the cell (15.5, 20) at 18% of the screen height, exactly as before', () => {
    const renderer = new WorldRenderer(new ParkSession(null));
    const camera = frame(renderer);
    const destinationX = (15.5 - 20) * 32;
    const destinationY = (15.5 + 20) * 16;
    expect(camera.x).toBe(1440 / 2 - destinationX * 0.72);
    expect(camera.y).toBe(800 * 0.18 - destinationY * 0.72);
  });

  it('a gate on the north edge anchors in the view that turns it to the bottom, and centres the midpoint elsewhere', () => {
    const session = new ParkSession(null, [], { mapId: 'red-rock-canyon' });
    expect(session.world.entrance.y).toBe(0);
    const renderer = new WorldRenderer(session);
    for (const rotation of [0, 1, 2, 3] as ViewRotation[]) {
      renderer.setViewRotation(rotation, true);
      const focus = entranceFocus(createViewFrame(rotation, 32, 32), session.world.entrance);
      expect(focus.mode, `view ${rotation}`).toBe(rotation === 2 ? 'anchor' : 'midpoint');
      const camera = frame(renderer);
      expect(Number.isFinite(camera.x) && Number.isFinite(camera.y)).toBe(true);
    }
  });

  it('keeps the gate and the park heart on screen for every gate of every map and every view', () => {
    for (const map of MAPS) {
      const session = new ParkSession(null, [], { mapId: map.id });
      const renderer = new WorldRenderer(session);
      for (const rotation of [0, 1, 2, 3] as ViewRotation[]) {
        renderer.setViewRotation(rotation, true);
        const camera = frame(renderer);
        const project = (x: number, y: number): { x: number; y: number } => {
          const probe = renderer as unknown as { project(x: number, y: number): { x: number; y: number } };
          const point = probe.project(x, y);
          return { x: camera.x + point.x * 0.72, y: camera.y + point.y * 0.72 };
        };
        const gate = project(session.world.entrance.x, session.world.entrance.y);
        // Phase 21: the heart is the middle of the owned land (15.5, 15.5 on every 32 x 32 map).
        const heart = project(session.world.heart.x, session.world.heart.y);
        for (const [name, point] of [['gate', gate], ['heart', heart]] as const) {
          expect(point.x, `${map.id} v${rotation} ${name} x`).toBeGreaterThan(0);
          expect(point.x, `${map.id} v${rotation} ${name} x`).toBeLessThan(1440);
          expect(point.y, `${map.id} v${rotation} ${name} y`).toBeGreaterThan(0);
          expect(point.y, `${map.id} v${rotation} ${name} y`).toBeLessThan(800);
        }
      }
    }
  });
});
