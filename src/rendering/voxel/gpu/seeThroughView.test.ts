import { describe, expect, it } from 'vitest';
import { SEE_THROUGH, type SeeThroughFocus } from '../../seeThrough';
import { BAYER_4X4 } from '../contracts/gbuffer';
import { depthKey, depthRangeFor, projectX, projectY } from '../contracts/space';
import { VOXEL_PROGRAM_NAMES } from './programs';
import { preprocessGlsl } from './glslTestKit';
import {
  createFrontRect,
  createSeeThroughFrame,
  createSeeThroughValues,
  depthKeyOfWindowDepth,
  FRONT_CAPACITY,
  FRONT_INK_TEXELS,
  frontRectFor,
  heldInFrontLayer,
  keptInMainBuffer,
  occluderWeight,
  seeThroughCoverage,
  seeThroughValuesFor,
  seeThroughView,
  SeeThroughUniformSync,
  windowDepthOfKey,
  writeSeeThroughUniforms,
  type SeeThroughUniformValues,
} from './seeThroughView';
import { voxelProgramSource } from './programs';

/**
 * The see-through volume as pure maths (the GLSL in shaders/world.ts is its twin; the last tests pin
 * the two together), the soft edge, the endpoints that decide popping, and the uniform write rules.
 */

const focus = (overrides: Partial<SeeThroughFocus> = {}): SeeThroughFocus => ({
  minX: 10, minY: 10, maxX: 10, maxY: 10, mode: 'place', peek: false, heightVoxels: 20, ...overrides,
});

const valuesOf = (overrides: Partial<SeeThroughFocus> = {}): SeeThroughUniformValues => seeThroughValuesFor(focus(overrides), createSeeThroughValues());

/** Coverage at the texel and key a voxel point projects to. */
const coverageAt = (values: SeeThroughUniformValues, x: number, y: number, z: number, strength = 1): number =>
  seeThroughCoverage(projectX(x, y), projectY(x, y, z), depthKey(x, y, z), values, strength);

describe('the cutaway volume', () => {
  it('projects the footprint box: the rectangle spans the diamond and the build height', () => {
    // Cell (10, 10): voxels 320..352 on both axes, height 20.
    const values = valuesOf();
    expect([values.ax - values.aw, values.ax + values.aw], 'sx from X0 - Y1 to X1 - Y0').toEqual([-32, 32]);
    expect([values.ay - values.ah, values.ay + values.ah], 'sy from the far corner minus H to the near corner').toEqual([300, 352]);
  });

  it('grows with the footprint (a 3 x 2 ride) and keeps every corner of the box inside', () => {
    const values = valuesOf({ minX: 4, minY: 7, maxX: 6, maxY: 8, heightVoxels: 30 });
    for (const x of [4 * 32, 7 * 32]) {
      for (const [vx, vy] of [[4 * 32, 7 * 32], [7 * 32, 7 * 32], [4 * 32, 9 * 32], [7 * 32, 9 * 32]]) {
        for (const z of [0, 30]) {
          const sx = projectX(vx, vy);
          const sy = projectY(vx, vy, z);
          expect(Math.abs(sx - values.ax), `corner ${vx},${vy},${z} (x ${x}) in x`).toBeLessThanOrEqual(values.aw);
          expect(Math.abs(sy - values.ay), `corner ${vx},${vy},${z} in y`).toBeLessThanOrEqual(values.ah);
        }
      }
    }
  });

  it('puts the cut key where something is nearer than the build site, per mode', () => {
    const front = 11 * 32 * 2;
    expect(valuesOf({ mode: 'place', heightVoxels: 20 }).cutKey, 'place: half the height past the near corner').toBe(front + 10);
    expect(valuesOf({ mode: 'bulldoze', heightVoxels: 20 }).cutKey, 'bulldoze: the object\'s own top').toBe(front + 20);
    expect(valuesOf({ mode: 'cell', heightVoxels: 0 }).cutKey, 'cell: just past the paving').toBe(front + 2);
    expect(valuesOf({ mode: 'cell', peek: true, heightVoxels: 0 }).cutKey, 'peek: one cell of depth earlier').toBe(front + 2 - SEE_THROUGH.PEEK_DEPTH_SLACK);
  });

  it('uses the wide margin only for peek', () => {
    expect(valuesOf().margin).toBe(SEE_THROUGH.MARGIN_TEXELS);
    expect(valuesOf({ peek: true }).margin).toBe(SEE_THROUGH.PEEK_MARGIN_TEXELS);
  });
});

describe('which texels are cut', () => {
  const values = valuesOf();

  it('cuts a tall building in front of the build site and keeps what is behind or beside it', () => {
    // One cell nearer the camera (+x, +y), 30 voxels up: it covers the ghost on screen.
    expect(coverageAt(values, 11 * 32 + 16, 11 * 32 + 16, 30), 'the building in front').toBe(1);
    expect(coverageAt(values, 9 * 32 + 16, 9 * 32 + 16, 30), 'a building behind the site').toBe(0);
    // Nearer than the site, but off to the side on screen: outside the hole and its margin.
    expect(coverageAt(values, 14 * 32, 12 * 32, 30), 'a building beside it').toBe(0);
  });

  it('never cuts the ground or paving, however near the camera (z below the floor)', () => {
    const cell = valuesOf({ mode: 'cell', heightVoxels: 0 });
    for (const z of [0, 0.5, 1, 1.4]) {
      expect(coverageAt(cell, 353, 353, z), `ground at z ${z}`).toBe(0);
    }
    expect(coverageAt(cell, 353, 353, 1.51), 'just above the floor is cut').toBe(1);
  });

  it('keeps the depth boundary exact: one key below the cut key survives, the cut key goes', () => {
    const key = values.cutKey;
    const texelX = values.ax;
    const texelY = values.ay;
    expect(seeThroughCoverage(texelX, texelY, key - 0.01, values, 1)).toBe(0);
    expect(seeThroughCoverage(texelX, texelY, key, values, 1)).toBe(1);
  });

  it('has a soft edge: full inside the plateau, falling to nothing exactly at the margin', () => {
    const middle = values.ay;
    const edge = values.ax + values.aw;
    const key = values.cutKey + 100;
    const at = (distance: number): number => seeThroughCoverage(edge + distance, middle, key, values, 1);
    const margin = values.margin;
    expect(at(0), 'on the rectangle').toBe(1);
    expect(at(0.4 * margin), 'at the end of the plateau').toBe(1);
    expect(at(margin), 'at the margin: nothing').toBe(0);
    expect(at(margin + 5), 'beyond it').toBe(0);
    let previous = 1;
    for (let step = 1; step <= 20; step += 1) {
      const coverage = at(0.4 * margin + (0.6 * margin * step) / 20);
      expect(coverage, `step ${step}`).toBeLessThanOrEqual(previous);
      previous = coverage;
    }
    const halfway = at(0.7 * margin);
    expect(halfway, 'smoothstep midpoint').toBeCloseTo(0.5, 6);
  });

  it('measures the edge by distance to the rectangle, so a corner falls off round', () => {
    const key = values.cutKey + 100;
    const cornerX = values.ax + values.aw;
    const cornerY = values.ay + values.ah;
    const diagonal = 0.7 * values.margin / Math.SQRT2;
    const onAxis = seeThroughCoverage(cornerX + 0.7 * values.margin, cornerY, key, values, 1);
    const atCorner = seeThroughCoverage(cornerX + diagonal, cornerY + diagonal, key, values, 1);
    expect(atCorner).toBeCloseTo(onAxis, 9);
  });

  it('is exactly strength-scaled: 0 cuts nothing anywhere, 1 cuts every Bayer cell inside the plateau', () => {
    const key = values.cutKey + 50;
    expect(seeThroughCoverage(values.ax, values.ay, key, values, 0), 'strength 0').toBe(0);
    const half = seeThroughCoverage(values.ax, values.ay, key, values, 0.5);
    expect(half).toBe(0.5);
    const cut = (coverage: number): number => BAYER_4X4.filter((threshold) => coverage > threshold).length;
    expect(cut(1), 'every cell of the 4x4 door is cut at full strength').toBe(16);
    expect(cut(0), 'and none at zero (no speckles at the margin or when off)').toBe(0);
    expect(cut(half), 'half strength cuts half of the door').toBe(8);
    expect(Math.max(...BAYER_4X4), 'thresholds stay below 1, so strength 1 is complete').toBeLessThan(1);
    expect(Math.min(...BAYER_4X4), 'and above 0, so strength 0 and the margin cut nothing').toBeGreaterThan(0);
  });

  it('opens things beside and one cell behind the cursor in peek, but not two cells behind', () => {
    const peek = seeThroughValuesFor(focus({ minX: 9, minY: 9, maxX: 11, maxY: 11, mode: 'cell', peek: true, heightVoxels: 26 }), createSeeThroughValues());
    expect(coverageAt(peek, 11 * 32 + 16, 11 * 32 + 16, 30), 'inside the 3x3').toBe(1);
    // Behind the 3x3's near corner by less than a cell of depth: still opened.
    expect(coverageAt(peek, 10 * 32 + 20, 11 * 32 + 16, 8), 'a little behind the near corner').toBe(1);
    expect(coverageAt(peek, 9 * 32, 9 * 32, 20), 'two cells behind').toBe(0);
  });

  it('cuts a bulldoze target\'s neighbours in front but never the target itself', () => {
    const doomed = seeThroughValuesFor(focus({ mode: 'bulldoze', minX: 10, minY: 10, maxX: 11, maxY: 11, heightVoxels: 24 }), createSeeThroughValues());
    // The object's tallest, nearest corner: key = X1 + Y1 + H exactly.
    expect(coverageAt(doomed, 12 * 32 - 0.5, 12 * 32 - 0.5, 24 - 0.5), 'its own near top').toBe(0);
    expect(coverageAt(doomed, 12 * 32 + 8, 12 * 32 + 8, 24), 'a tower behind it in screen space, nearer the camera').toBe(1);
  });
});

describe('the depth key from the window depth', () => {
  const range = depthRangeFor(32, 32);

  it('inverts what the rasteriser writes, for keys across the map', () => {
    for (const key of [-300, 0, 1, 700, 1234.5, 4000]) {
      expect(depthKeyOfWindowDepth(windowDepthOfKey(key, range), range)).toBeCloseTo(key, 6);
    }
  });

  it('keeps precision far below the half-voxel the floor leaves (float32 depth over the whole range)', () => {
    const step = Math.fround(1 / (range.max - range.min)); // one key of window depth, in float32
    expect(step * (range.max - range.min)).toBeCloseTo(1, 3);
    const key = 2000;
    const windowZ = Math.fround(windowDepthOfKey(key, range));
    expect(Math.abs(depthKeyOfWindowDepth(windowZ, range) - key), 'float32 round trip').toBeLessThan(0.01);
  });
});

describe('uniform writes', () => {
  it('writes only when the revision moves, and a rebuilt pipeline writes once more', () => {
    const sync = new SeeThroughUniformSync();
    const target = { uSeeA: new Float32Array(4), uSeeB: new Float32Array(4), uSeeC: new Float32Array(4) };
    const frame = createSeeThroughFrame();
    expect(sync.sync(target, frame), 'the first frame writes').toBe(true);
    for (let index = 0; index < 100; index += 1) expect(sync.sync(target, frame), 'an idle frame').toBe(false);
    expect(sync.writes).toBe(1);
    frame.strength = 0.5;
    frame.revision += 1;
    expect(sync.sync(target, frame)).toBe(true);
    expect(target.uSeeB[3]).toBe(0.5);
    sync.invalidate();
    expect(sync.sync(target, frame), 'after invalidate').toBe(true);
    expect(sync.writes).toBe(3);
  });

  it('lays the values out as the shader reads them: A = centre and half size, B = key, floor, margin, strength', () => {
    const target = { uSeeA: new Float32Array(4), uSeeB: new Float32Array(4), uSeeC: new Float32Array(4) };
    const frame = createSeeThroughFrame();
    Object.assign(frame, { ax: 1, ay: 2, aw: 3, ah: 4, cutKey: 5, floorZ: 6, margin: 7, strength: 8 });
    writeSeeThroughUniforms(target, frame);
    expect([...target.uSeeA]).toEqual([1, 2, 3, 4]);
    expect([...target.uSeeB]).toEqual([5, 6, 7, 8]);
  });

  it('bounds chunks by the rectangle grown by the margin', () => {
    const values = valuesOf();
    const view = seeThroughView(values, { minX: 0, minY: 0, maxX: 0, maxY: 0 });
    expect(view.minX).toBe(values.ax - values.aw - values.margin);
    expect(view.maxX).toBe(values.ax + values.aw + values.margin);
    expect(view.minY).toBe(values.ay - values.ah - values.margin);
    expect(view.maxY).toBe(values.ay + values.ah + values.margin);
  });
});

describe('the worldCut program', () => {
  const fragment = preprocessGlsl(voxelProgramSource('worldCut').fragment);
  const vertex = preprocessGlsl(voxelProgramSource('worldCut').vertex);

  it('is the only program besides the dither ones that discards, and flags the rim survivors NO_OUTLINE', () => {
    expect(fragment).toMatch(/\bdiscard\b/);
    expect(fragment).toMatch(/if \(seeCut > 0\.0\) faceAndFlags \|= VX_GFLAG_NO_OUTLINE;/);
    expect(vertex).not.toMatch(/\bdiscard\b/);
    for (const name of VOXEL_PROGRAM_NAMES) {
      if (name === 'worldCut' || name === 'worldFront' || name.endsWith('Dither')) continue;
      expect(/\bdiscard\b/.test(preprocessGlsl(voxelProgramSource(name).fragment)), name).toBe(false);
      // Only the cut programs and the two composites (which mix the front layer) read the hole.
      if (name === 'composite' || name === 'compositeFront') continue;
      expect(preprocessGlsl(voxelProgramSource(name).fragment), name).not.toMatch(/uSee[ABC]/);
    }
  });

  it('is not a ghost: no tint, no coverage uniform, no GHOST flag', () => {
    expect(fragment).not.toMatch(/uGhost|uCoverage|\|= VX_GFLAG_GHOST/);
    expect(vertex).not.toMatch(/uGhostOrigin|uGhostDepthBias/);
  });

  it('computes the same decision as seeThroughCoverage, from the window position and depth alone', () => {
    expect(fragment).toContain('vec2 seeTexel = gl_FragCoord.xy + uCameraTexel;');
    expect(fragment).toContain('length(max(abs(seeTexel - uSeeA.xy) - uSeeA.zw, vec2(0.0)))');
    expect(fragment).toContain('float seeKey = vxDepthKeyFromTexture(gl_FragCoord.z, uDepthRange);');
    expect(fragment).toContain('float seeZ = (seeKey - 2.0 * seeTexel.y) / 3.0;');
    expect(fragment).toMatch(/seeZ >= uSeeB\.y && seeKey >= uSeeB\.x/);
    expect(fragment).toContain('uSeeB.w * (1.0 - smoothstep(0.4 * uSeeB.z, uSeeB.z, seeDistance))');
    // Dither rung: a world-anchored door (the fragment texel plus the camera texel, like the ghost's); translucent
    // rung (uSeeC.z > 0): threshold 0, so every fragment with coverage leaves the buffer for the front layer.
    expect(fragment).toMatch(/float seeThreshold = uSeeC\.z > 0\.0 \? 0\.0 : vxBayer4\(ivec2\(gl_FragCoord\.xy\) \+ ivec2\(uCameraTexel\) \+ ivec2\(3, 1\)\);/);
    expect(fragment).toContain('if (seeCut > seeThreshold) discard;');
  });

  it('uses no loop, struct or varying of its own (the cut reads only gl_FragCoord)', () => {
    expect(fragment).not.toMatch(/\b(?:for|while|do|struct)\b/);
    const added = fragment.split('\n').filter((line) => /see[A-Z]/.test(line)).join('\n');
    expect(added).not.toMatch(/\bin\s+(?:flat\s+)?\w+\s+v[A-Z]/);
  });

  it('keeps the same samplers and clip mapping as the opaque world program', () => {
    const opaque = preprocessGlsl(voxelProgramSource('worldOpaque').vertex);
    const squash = (text: string): string => text.replace(/\n\s*\n+/g, '\n');
    expect(squash(vertex)).toBe(squash(opaque));
  });
});

describe('the translucent weight', () => {
  it('is 1 where nothing is cut and the shared occluder opacity where it is cut completely, falling monotonically', () => {
    expect(occluderWeight(0)).toBe(1);
    expect(occluderWeight(1)).toBeCloseTo(SEE_THROUGH.OCCLUDER_OPACITY, 12);
    let previous = 2;
    for (let step = 0; step <= 100; step += 1) {
      const weight = occluderWeight(step / 100);
      expect(weight, `coverage ${step / 100}`).toBeLessThan(previous);
      expect(weight).toBeGreaterThanOrEqual(SEE_THROUGH.OCCLUDER_OPACITY);
      previous = weight;
    }
  });

  it('shares one constant with the classic renderer, inside the 30 to 35 per cent the feature asks for', () => {
    expect(SEE_THROUGH.CLASSIC_ALPHA).toBe(SEE_THROUGH.OCCLUDER_OPACITY);
    expect(SEE_THROUGH.OCCLUDER_OPACITY).toBeGreaterThanOrEqual(0.3);
    expect(SEE_THROUGH.OCCLUDER_OPACITY).toBeLessThanOrEqual(0.35);
  });
});

describe('the main buffer and the front layer partition the occluders', () => {
  const rng = (seed: number): (() => number) => {
    let state = seed >>> 0 || 1;
    return () => {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state / 4294967296;
    };
  };

  it('puts every fragment in at least one of them, and in exactly one unless it is within the key slack of the cut key', () => {
    const random = rng(7);
    const values = valuesOf({ minX: 12, minY: 9, maxX: 14, maxY: 11, heightVoxels: 28 });
    let both = 0;
    let cutAway = 0;
    for (let index = 0; index < 20_000; index += 1) {
      const texelX = values.ax + (random() - 0.5) * 2 * (values.aw + 60);
      const texelY = values.ay + (random() - 0.5) * 2 * (values.ah + 60);
      const key = values.cutKey + (random() - 0.5) * 120;
      const strength = random() < 0.2 ? 1 : random();
      const coverage = seeThroughCoverage(texelX, texelY, key, values, strength);
      const kept = keptInMainBuffer(coverage);
      const held = heldInFrontLayer(texelX, texelY, key, values, strength);
      expect(kept || held, `fragment ${index} is in neither layer`).toBe(true);
      if (!kept) {
        cutAway += 1;
        expect(held, 'what the main buffer drops, the front layer holds').toBe(true);
      }
      if (kept && held) {
        both += 1;
        expect(Math.abs(key - values.cutKey), 'only a fragment within the slack of the cut key may be in both').toBeLessThan(SEE_THROUGH.KEY_SLACK);
        expect(coverage, 'and it is a fragment the cut would not touch').toBe(0);
      }
    }
    expect(cutAway, 'the sample really cuts things').toBeGreaterThan(1_000);
    expect(both, 'a duplicate is rare').toBeLessThan(40);
  });

  it('holds nothing at strength 0 (the front passes are skipped) and matches the dither rung\'s threshold-0 survivors', () => {
    const values = valuesOf();
    const random = rng(11);
    for (let index = 0; index < 2_000; index += 1) {
      const texelX = values.ax + (random() - 0.5) * 400;
      const texelY = values.ay + (random() - 0.5) * 400;
      const key = values.cutKey + (random() - 0.2) * 200;
      expect(heldInFrontLayer(texelX, texelY, key, values, 0)).toBe(false);
      const coverage = seeThroughCoverage(texelX, texelY, key, values, 1);
      // A dither threshold is in [0, 1): a fragment survives it iff coverage <= threshold; at threshold 0 only coverage 0 survives.
      expect(keptInMainBuffer(coverage)).toBe(coverage <= 0);
    }
  });
});

describe('the front layer rectangle', () => {
  const open = (): SeeThroughUniformValues => valuesOf({ minX: 10, minY: 10, maxX: 12, maxY: 12, heightVoxels: 24 });

  it('covers the hole grown by its margin and the ink ring, relative to the camera and clamped to the target', () => {
    const values = open();
    const rect = createFrontRect();
    const camX = values.ax - values.aw - values.margin - 100;
    const camY = values.ay - values.ah - values.margin - 80;
    expect(frontRectFor(values, camX, camY, 1_000, 800, FRONT_CAPACITY, rect)).toBe(true);
    const width = Math.ceil(2 * (values.aw + values.margin)) + 2 * FRONT_INK_TEXELS;
    const height = Math.ceil(2 * (values.ah + values.margin)) + 2 * FRONT_INK_TEXELS;
    expect(rect.x).toBe(Math.floor(100) - FRONT_INK_TEXELS);
    expect(rect.y).toBe(Math.floor(80) - FRONT_INK_TEXELS);
    expect(rect.width).toBe(width);
    expect(rect.height).toBe(height);
    // Hanging over the left and top edges of a small target: clamped, still on screen.
    frontRectFor(values, values.ax - 50, values.ay - 40, 300, 200, FRONT_CAPACITY, rect);
    expect([rect.x, rect.y], 'clamped to the target origin').toEqual([0, 0]);
    expect(rect.x + rect.width).toBeLessThanOrEqual(300);
    expect(rect.y + rect.height).toBeLessThanOrEqual(200);
  });

  it('is empty (and fits) when the hole is off screen', () => {
    const values = open();
    const rect = createFrontRect();
    expect(frontRectFor(values, values.ax + 5_000, values.ay, 800, 600, FRONT_CAPACITY, rect)).toBe(true);
    expect(rect.width).toBe(0);
    expect(frontRectFor(values, values.ax - 5_000, values.ay - 300, 800, 600, FRONT_CAPACITY, rect)).toBe(true);
    expect(rect.width).toBe(0);
  });

  it('reports a rectangle that does not fit the layer\'s capacity (that frame uses the dither rung)', () => {
    const wide = valuesOf({ minX: 2, minY: 2, maxX: 11, maxY: 11, heightVoxels: 60, mode: 'bulldoze' });
    const rect = createFrontRect();
    const fits = frontRectFor(wide, wide.ax - wide.aw - 100, wide.ay - wide.ah - 100, 4_000, 3_000, FRONT_CAPACITY, rect);
    expect(fits, `${rect.width} x ${rect.height} against ${FRONT_CAPACITY.width} x ${FRONT_CAPACITY.height}`).toBe(false);
    expect(frontRectFor(wide, wide.ax - wide.aw - 100, wide.ay - wide.ah - 100, 4_000, 3_000, { width: 4_000, height: 3_000 }, rect)).toBe(true);
  });

  it('fits the footprints the feature opens: a 6 x 6 cell plot and a 3 x 3 peek, margins included', () => {
    const rect = createFrontRect();
    const plot = valuesOf({ minX: 4, minY: 4, maxX: 9, maxY: 9, heightVoxels: 40 });
    expect(frontRectFor(plot, plot.ax - plot.aw - 80, plot.ay - plot.ah - 80, 4_000, 3_000, FRONT_CAPACITY, rect), `plot ${rect.width} x ${rect.height}`).toBe(true);
    const peek = valuesOf({ minX: 4, minY: 4, maxX: 6, maxY: 6, heightVoxels: SEE_THROUGH.COASTER_HEIGHT_VOXELS, mode: 'cell', peek: true });
    expect(frontRectFor(peek, peek.ax - peek.aw - 80, peek.ay - peek.ah - 80, 4_000, 3_000, FRONT_CAPACITY, rect), `peek ${rect.width} x ${rect.height}`).toBe(true);
  });

  it('moves with a camera pan by exactly the pan, and keeps its size', () => {
    const values = open();
    const first = createFrontRect();
    const second = createFrontRect();
    const camX = values.ax - 300;
    const camY = values.ay - 200;
    frontRectFor(values, camX, camY, 1_000, 800, FRONT_CAPACITY, first);
    frontRectFor(values, camX + 17, camY - 9, 1_000, 800, FRONT_CAPACITY, second);
    expect([first.x - second.x, first.y - second.y]).toEqual([17, -9]);
    expect([first.width, first.height]).toEqual([second.width, second.height]);
  });

  it('allocates nothing: the rectangle is filled in place', () => {
    const rect = createFrontRect();
    const before = { ...rect };
    const values = open();
    frontRectFor(values, 0, 0, 800, 600, FRONT_CAPACITY, rect);
    expect(rect).not.toEqual(before);
    expect(Object.keys(rect).sort()).toEqual(['height', 'width', 'x', 'y']);
  });
});

describe('uniform writes with the front rectangle', () => {
  const target = (): { uSeeA: Float32Array; uSeeB: Float32Array; uSeeC: Float32Array } => ({ uSeeA: new Float32Array(4), uSeeB: new Float32Array(4), uSeeC: new Float32Array(4) });

  it('writes nothing for the same revision and rectangle, once when the camera pans the rectangle, once for a new revision', () => {
    const sync = new SeeThroughUniformSync();
    const out = target();
    const frame = { ...createSeeThroughFrame(), revision: 5, strength: 1 };
    const rect = { x: 40, y: 30, width: 200, height: 120 };
    expect(sync.sync(out, frame, rect)).toBe(true);
    expect([...out.uSeeC]).toEqual([40, 30, 200, 120]);
    for (let index = 0; index < 100; index += 1) expect(sync.sync(out, frame, rect), 'a still frame').toBe(false);
    expect(sync.writes).toBe(1);
    rect.x = 41;
    expect(sync.sync(out, frame, rect), 'a one texel pan').toBe(true);
    expect(out.uSeeC[0]).toBe(41);
    expect(sync.sync(out, frame, rect)).toBe(false);
    frame.revision += 1;
    expect(sync.sync(out, frame, rect), 'a new revision').toBe(true);
    expect(sync.writes).toBe(3);
  });

  it('writes width 0 (the dither rung) when there is no rectangle, and once more when it comes back', () => {
    const sync = new SeeThroughUniformSync();
    const out = target();
    const frame = { ...createSeeThroughFrame(), revision: 1, strength: 1 };
    sync.sync(out, frame, { x: 1, y: 2, width: 3, height: 4 });
    expect(sync.sync(out, frame, null)).toBe(true);
    expect([...out.uSeeC]).toEqual([0, 0, 0, 0]);
    expect(sync.sync(out, frame, null), 'still none').toBe(false);
    expect(sync.sync(out, frame, { x: 1, y: 2, width: 3, height: 4 })).toBe(true);
  });

  it('lays uSeeC out as the shaders read it: origin x, origin y, width, height', () => {
    const out = target();
    writeSeeThroughUniforms(out, createSeeThroughFrame(), { x: 7, y: 8, width: 9, height: 10 });
    expect([...out.uSeeC]).toEqual([7, 8, 9, 10]);
    writeSeeThroughUniforms(out, createSeeThroughFrame());
    expect([...out.uSeeC], 'no rectangle: the dither rung').toEqual([0, 0, 0, 0]);
  });
});

describe('the worldFront program', () => {
  const fragment = preprocessGlsl(voxelProgramSource('worldFront').fragment);
  const vertex = preprocessGlsl(voxelProgramSource('worldFront').vertex);

  it('has the cut\'s volume test, the opposite discard, and the surface colour of the opaque program', () => {
    expect(fragment).toContain('length(max(abs(seeTexel - uSeeA.xy) - uSeeA.zw, vec2(0.0)))');
    expect(fragment).toMatch(/seeZ >= uSeeB\.y && seeKey >= uSeeB\.x - VX_SEE_KEY_SLACK/);
    expect(fragment).toContain('if (!(seeCut > 0.0)) discard;');
    expect(fragment).toMatch(/outGData = vxPackGData\(vGroup, faceAndFlags, emissive, vLambert\);/);
    expect(fragment, 'not a ghost').not.toMatch(/uGhost|uCoverage|\|= VX_GFLAG_GHOST/);
  });

  it('shares the opaque program\'s vertex stage and samplers (one geometry, two frame groups)', () => {
    const opaque = preprocessGlsl(voxelProgramSource('worldOpaque').vertex);
    const squash = (text: string): string => text.replace(/\n\s*\n+/g, '\n');
    expect(squash(vertex)).toBe(squash(opaque));
    expect([...fragment.matchAll(/^\s*uniform\s+highp\s+sampler2D\s+(\w+)\s*;/gm)].map((match) => match[1])).toEqual(['uPalette']);
  });
});
