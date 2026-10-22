import { describe, expect, it } from 'vitest';
import { createViewTransform, headingInView, patternCellShift, setViewTransform, vectorToViewVoxel, voxelFromView, voxelToView, type ViewTransform } from '../contracts/view';
import { VOXELS_PER_TILE } from '../contracts/space';
import { VIEW_ROTATIONS, type ViewRotation, type XY } from '../../viewRotation';
import { preprocessGlsl } from './glslTestKit';
import { VOXEL_PROGRAM_NAMES, voxelProgramSource, type VoxelProgramName } from './programs';
import { VX_VIEW_COMMON } from './shaders/common';
import { vxPatternsSource } from './shaders/patterns';
import { ViewUniformSync } from './viewUniforms';

/**
 * Phase 26 (voxel view rotation, design-step2.md sections 3 to 5): the GLSL side of the vertex-stage view
 * transform, checked in Node. The GLSL is generated text, so what can be pinned here is pinned: the view-off
 * sources are byte-identical to the pre-rotation ones, the view code sits where the design says, the GLSL maths
 * equals its TypeScript twin (contracts/view.ts), and the pattern cell shift keeps the one-texel-per-voxel
 * property in all four views. Compilation itself is verified in the browser.
 */

/** cyrb53: a small deterministic 53-bit string hash (Node's crypto is not typed in this project). */
const hash53 = (text: string): string => {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
};

/**
 * Hashes of the vertex + fragment text of every program with `viewTurn: false`, taken from the sources before
 * Phase 26 (verified byte for byte against SHA-256 of the pre-change output). This is the `no-view-rotation`
 * rung: if a hash moves, the fallback is no longer today's shader, which is the whole point of having it.
 *
 * Phase 55 re-pinned every program that reads the camera: a uTexelScale uniform (world texels per low-res texel)
 * divides the clip mapping and the sub-texel snap and scales the texel-to-world steps, the outline's plane steps and
 * the lawn's grid line width. At 1 every expression is exact, so the view-off picture is unchanged.
 */
const PRE_ROTATION_HASHES: Readonly<Record<string, string>> = {
  'worldOpaque': 'e10e7ecafd6e7',
  'worldDither': '11a3dcd24d3aed',
  'worldCut': '1c18ccef57e82f',
  'worldFront': '136c4b87fa2d5a',
  // Phase 29: both figure programs re-pinned once, for the keyframe table's new pose columns (sit, hunch, cheer, wave
  // ...); no view code.
  'figureOpaque': '459e7e2ecb60e',
  'figureDither': '1b768f89d6ea64',
  'lightPass': '9a5be3619b012',
  'composite/full/full/plain': '619eedba8bb34',
  'composite/full/full/translucent': '105b0de14fefa',
  'composite/full/rain/plain': 'ac3d88686a316',
  'composite/full/rain/translucent': 'c308aeabc9afe',
  'composite/full/none/plain': 'ba8638d353f99',
  'composite/full/none/translucent': '8db1838e90265',
  'composite/lite/full/plain': '1bbccc968dc895',
  'composite/lite/full/translucent': '1bbccc968dc895',
  'composite/lite/rain/plain': '177dd33fc97b2',
  'composite/lite/rain/translucent': '177dd33fc97b2',
  'composite/lite/none/plain': 'f50f347541cbe',
  'composite/lite/none/translucent': 'f50f347541cbe',
  'compositeFront/full': '761de3ac033ea',
  'compositeFront/rain': 'b106ab6fbcf5f',
  'compositeFront/none': '10f68dc1978e09',
  'upscale': '1e689b1eae22f9',
};

const WEATHER_TIERS = ['full', 'rain', 'none'] as const;

/** Every (key, source) pair the hash table covers, built with the given viewTurn. */
const allSources = (viewTurn: boolean): Map<string, { vertex: string; fragment: string }> => {
  const sources = new Map<string, { vertex: string; fragment: string }>();
  for (const name of VOXEL_PROGRAM_NAMES) {
    if (name === 'composite') {
      for (const variant of ['full', 'lite'] as const) {
        for (const tier of WEATHER_TIERS) {
          for (const translucent of [false, true]) sources.set(`composite/${variant}/${tier}/${translucent ? 'translucent' : 'plain'}`, voxelProgramSource(name, variant, tier, translucent, viewTurn));
        }
      }
    } else if (name === 'compositeFront') {
      for (const tier of WEATHER_TIERS) sources.set(`compositeFront/${tier}`, voxelProgramSource(name, 'full', tier, false, viewTurn));
    } else {
      sources.set(name, voxelProgramSource(name, 'full', undefined, false, viewTurn));
    }
  }
  return sources;
};

describe('the view-off sources (the no-view-rotation rung)', () => {
  it('are byte-identical to the pre-rotation sources, program by program', () => {
    const sources = allSources(false);
    expect([...sources.keys()].sort()).toEqual(Object.keys(PRE_ROTATION_HASHES).sort());
    for (const [key, source] of sources) {
      expect(hash53(`${source.vertex}\u0000${source.fragment}`), key).toBe(PRE_ROTATION_HASHES[key]);
    }
  });

  it('contain no view code at all', () => {
    for (const [key, source] of allSources(false)) {
      for (const stage of [source.vertex, source.fragment]) {
        expect(stage, key).not.toMatch(/uView|vxViewPoint|vxViewVector|vxWorldXYOfView|vCellShift|cellShift/);
      }
    }
  });

  it('keep the pre-rotation pattern chunk (no cellShift parameter) under the old name', () => {
    expect(vxPatternsSource(false)).not.toContain('cellShift');
    expect(vxPatternsSource(true)).toContain('vec3 cellShift');
  });
});

/** Programs whose vertex stage carries the view transform. */
const GEOMETRY_PROGRAMS: readonly VoxelProgramName[] = ['worldOpaque', 'worldDither', 'worldCut', 'worldFront', 'figureOpaque', 'figureDither', 'lightPass'];

const uniformDeclarations = (stage: string, name: string): string[] =>
  [...stage.matchAll(new RegExp(`^\\s*uniform\\s+(?:\\w+\\s+)?(\\w+)\\s+${name}\\s*;`, 'gm'))].map((match) => match[1]);

describe('the view-on sources (design section 4)', () => {
  it('declare uView once, as a vec4, in the vertex stage of every geometry program and nowhere else but the full ground hook', () => {
    for (const name of VOXEL_PROGRAM_NAMES) {
      const source = voxelProgramSource(name);
      const vertex = preprocessGlsl(source.vertex);
      const fragment = preprocessGlsl(source.fragment);
      if (GEOMETRY_PROGRAMS.includes(name)) {
        expect(uniformDeclarations(vertex, 'uView'), `${name} vertex`).toEqual(['vec4']);
        expect(uniformDeclarations(fragment, 'uView'), `${name} fragment`).toEqual([]);
      } else if (name === 'composite' || name === 'compositeFront') {
        expect(uniformDeclarations(vertex, 'uView'), `${name} vertex`).toEqual([]);
        expect(uniformDeclarations(fragment, 'uView'), `${name} fragment`).toEqual(['vec4']);
      } else {
        expect(`${vertex}${fragment}`, name).not.toContain('uView');
      }
    }
  });

  it('contain no view code in the lite composite and in the rain and no-weather tiers (the lite rung drops it with the ground hook)', () => {
    for (const tier of WEATHER_TIERS) {
      for (const translucent of [false, true]) {
        expect(voxelProgramSource('composite', 'lite', tier, translucent).fragment, `lite ${tier}`).not.toMatch(/uView|vxWorldXYOfView|vxViewPoint/);
      }
    }
    for (const tier of ['rain', 'none'] as const) {
      expect(voxelProgramSource('composite', 'full', tier, true).fragment, tier).not.toMatch(/uView|vxWorldXYOfView|vxViewPoint/);
      expect(voxelProgramSource('compositeFront', 'full', tier).fragment, tier).not.toMatch(/uView|vxWorldXYOfView|vxViewPoint/);
    }
    expect(voxelProgramSource('composite', 'lite', 'full').fragment).not.toContain('vxWeatherSurface(vec3 lit, vec3 viewPoint');
  });

  it('apply vxViewPoint before vxProject and vxDepthKey in every geometry vertex stage', () => {
    for (const name of GEOMETRY_PROGRAMS) {
      const vertex = preprocessGlsl(voxelProgramSource(name).vertex);
      const main = vertex.slice(vertex.indexOf('void main()'));
      const mapped = main.indexOf('vxViewPoint(');
      expect(mapped, `${name}: vxViewPoint in main`).toBeGreaterThan(-1);
      for (const use of ['vxProject(', 'vxDepthKey(']) {
        const at = main.indexOf(use);
        if (at >= 0) expect(mapped, `${name}: ${use}`).toBeLessThan(at);
      }
    }
  });

  it('project and key the VIEW point, and light from the view normal (the key light stays on the screen, design 5.1)', () => {
    const world = preprocessGlsl(voxelProgramSource('worldOpaque').vertex);
    expect(world).toContain('vec3 view = vxViewPoint(world, uView);');
    expect(world).toContain('float key = vxDepthKey(view);');
    expect(world).toContain('vxProject(view)');
    expect(world).toContain('vec3 axisNormal = vxViewVector(axisWorld, uView);');
    expect(world).toContain('float side = dot(axisNormal, vec3(1.0)) >= 0.0 ? 1.0 : -1.0;');
    expect(world).toContain('vec3 normal = axisNormal * side;');
    expect(world).toContain('vLambert = vxLambert(normal);');
    expect(world).toContain('vFaceCode = vxFaceOfNormal(normal);');
    // Patterns stay anchored to the world (static) or the part (rigid).
    expect(world).toContain('vPatternNormal = rigid ? vxAxis(axisIndex) * side : axisWorld * side;');
    expect(world).toContain('vPatternPosition = rigid ? local : world;');
    const figure = preprocessGlsl(voxelProgramSource('figureOpaque').vertex);
    expect(figure).toContain('int heading = (int(place.w) + turn) & 3;');
    expect(figure).toContain('vec3 feet = vxViewPoint(place.xyz, uView);');
    expect(figure).not.toMatch(/vxProject\(place\.xyz\)|vxDepthKey\(place\.xyz\)/);
    expect(figure).toContain('vLambert = vxLambert(normal);');
    const light = preprocessGlsl(voxelProgramSource('lightPass').vertex);
    expect(light).toContain('place.xyz = vxViewPoint(place.xyz, uView);');
  });

  it('anchor every Bayer dither to the fragment texel plus the camera texel, with no turn term (design 5.2)', () => {
    for (const name of VOXEL_PROGRAM_NAMES) {
      const { vertex, fragment } = voxelProgramSource(name);
      for (const stage of [vertex, fragment]) {
        for (const line of preprocessGlsl(stage).split('\n').filter((candidate) => candidate.includes('vxBayer4('))) {
          if (line.includes('M[')) continue; // the table lookup itself
          expect(line, `${name}: ${line.trim()}`).not.toMatch(/uView|vxViewPoint|vxViewVector|vxWorldXYOfView/);
        }
      }
    }
    const world = preprocessGlsl(voxelProgramSource('worldDither').fragment);
    expect(world).toMatch(/ivec2 anchor = ivec2\(gl_FragCoord\.xy\) \+ ivec2\(uCameraTexel \/ uTexelScale\)/);
  });

  it('map the texel point back to the world once, in the ground hook only (cloud shadows and puddles are world-anchored)', () => {
    for (const name of ['composite', 'compositeFront'] as const) {
      const fragment = preprocessGlsl(voxelProgramSource(name).fragment);
      expect(fragment.match(/vxWorldXYOfView\(/g), name).toHaveLength(2); // the definition and its one use
      expect(fragment).toContain('vec3 world = vec3(vxWorldXYOfView(viewPoint.xy, uView), viewPoint.z);');
    }
    // The look itself calls the hook exactly as before, with the view point of the texel.
    expect(preprocessGlsl(voxelProgramSource('composite').fragment)).toContain('lit = vxWeatherSurface(lit, world, texel, flags, faceC, vxGroupOf(gdata));');
  });

  it('add no loop, struct, array or subscript over the view-off programs, and only a few lines', () => {
    for (const [key, on] of allSources(true)) {
      const off = allSources(false).get(key)!;
      for (const stage of ['vertex', 'fragment'] as const) {
        const added = preprocessGlsl(on[stage]);
        const base = preprocessGlsl(off[stage]);
        expect(added, `${key} ${stage}`).not.toMatch(/\b(for|while|do)\s*\(|\bstruct\b/);
        const subscripts = (source: string): string[] => [...source.matchAll(/\w+\s*\[[^\]]+\]/g)].map((match) => match[0]).sort();
        expect(subscripts(added), `${key} ${stage} subscripts`).toEqual(subscripts(base));
        const lines = (source: string): number => source.split('\n').filter((line) => line.trim().length > 0).length;
        expect(lines(added) - lines(base), `${key} ${stage} added lines`).toBeLessThanOrEqual(stage === 'vertex' ? 34 : 14);
      }
    }
  });
});

// ---- GLSL twins ------------------------------------------------------------------------------------

interface V { x: number; y: number; z?: number; w?: number }
const vec2 = (x: number, y: number): V => ({ x, y });
const vec3 = (x: number, y: number, z: number): V => ({ x, y, z });
const vec4 = (x: number, y: number, z: number, w: number): V => ({ x, y, z, w });

/** Turns the three plain-scalar GLSL functions of VX_VIEW_COMMON into JS (no texture reads, no loops: the text is straight-line code). */
const glslFunctions = (): { vxViewPoint: (p: V, view: V) => V; vxViewVector: (n: V, view: V) => V; vxWorldXYOfView: (uv: V, view: V) => V } => {
  const code = VX_VIEW_COMMON
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^(?:vec[234]|float)\s+(\w+)\(([^)]*)\)\s*\{/gm, (_match, name: string, params: string) =>
      `function ${name}(${params.split(',').map((param) => param.trim().split(/\s+/)[1]).join(', ')}) {`)
    .replace(/^\s*float\s+(\w+)\s*=/gm, '  const $1 =');
  return new Function('vec2', 'vec3', 'vec4', `${code}\nreturn { vxViewPoint, vxViewVector, vxWorldXYOfView };`)(vec2, vec3, vec4) as ReturnType<typeof glslFunctions>;
};

const WORLD_TILES = { width: 7, height: 5 };

const transformFor = (rotation: ViewRotation): ViewTransform => {
  const t = createViewTransform();
  setViewTransform({ rotation, ...WORLD_TILES }, t);
  return t;
};

const uView = (t: ViewTransform): V => vec4(t.c, t.s, t.ox, t.oy);

/** Deterministic pseudo-random voxel points (integers and halves) inside the map. */
const points = (count: number): V[] => {
  const result: V[] = [];
  let seed = 12345;
  const next = (): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < count; i += 1) {
    result.push(vec3(Math.floor(next() * WORLD_TILES.width * VOXELS_PER_TILE * 2) / 2, Math.floor(next() * WORLD_TILES.height * VOXELS_PER_TILE * 2) / 2, Math.floor(next() * 40)));
  }
  return result;
};

describe('the GLSL view maths equals its TypeScript twin (contracts/view.ts)', () => {
  const glsl = glslFunctions();

  it('vxViewPoint equals voxelToView with z untouched, for every turn', () => {
    for (const q of VIEW_ROTATIONS) {
      const t = transformFor(q);
      for (const p of points(60)) {
        const out = glsl.vxViewPoint(p, uView(t));
        const twin: XY = { x: 0, y: 0 };
        voxelToView(t, p.x, p.y, twin);
        expect([out.x, out.y, out.z], `q ${q} at ${p.x},${p.y}`).toEqual([twin.x, twin.y, p.z]);
      }
    }
  });

  it('is exact for view 0: the input comes back bit for bit', () => {
    const t = transformFor(0);
    for (const p of points(60)) {
      const out = glsl.vxViewPoint(p, uView(t));
      expect(Object.is(out.x, p.x) && Object.is(out.y, p.y) && Object.is(out.z, p.z), `${p.x},${p.y}`).toBe(true);
    }
  });

  it('vxViewVector equals vectorToViewVoxel, and vxWorldXYOfView inverts vxViewPoint (voxelFromView)', () => {
    for (const q of VIEW_ROTATIONS) {
      const t = transformFor(q);
      for (const p of points(40)) {
        const vector = glsl.vxViewVector(p, uView(t));
        const twin: XY = { x: 0, y: 0 };
        vectorToViewVoxel(t, p.x, p.y, twin);
        expect([vector.x, vector.y]).toEqual([twin.x, twin.y]);
        const view = glsl.vxViewPoint(p, uView(t));
        const back = glsl.vxWorldXYOfView(vec2(view.x, view.y), uView(t));
        const backTwin: XY = { x: 0, y: 0 };
        voxelFromView(t, view.x, view.y, backTwin);
        expect([back.x, back.y], `q ${q}`).toEqual([p.x, p.y]);
        expect([back.x, back.y]).toEqual([backTwin.x, backTwin.y]);
      }
    }
  });

  it('keeps every integer corner an integer and every view point inside the view map', () => {
    for (const q of VIEW_ROTATIONS) {
      const t = transformFor(q);
      const w = (q & 1) === 0 ? WORLD_TILES.width : WORLD_TILES.height;
      const h = (q & 1) === 0 ? WORLD_TILES.height : WORLD_TILES.width;
      for (const p of [vec3(0, 0, 0), vec3(WORLD_TILES.width * 32, WORLD_TILES.height * 32, 0), vec3(17, 40, 3)]) {
        const out = glsl.vxViewPoint(p, uView(t));
        expect(Number.isInteger(out.x) && Number.isInteger(out.y)).toBe(true);
        expect(out.x).toBeGreaterThanOrEqual(0);
        expect(out.x).toBeLessThanOrEqual(w * 32);
        expect(out.y).toBeGreaterThanOrEqual(0);
        expect(out.y).toBeLessThanOrEqual(h * 32);
      }
    }
  });
});

describe('the visible side of a box in every view (the vertex face walk)', () => {
  const glsl = glslFunctions();
  const axis = (k: number): V => vec3(k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0);

  it('always lands on a view +x, +y or +z face, so the face codes and the lambert are the view-0 ones', () => {
    for (const q of VIEW_ROTATIONS) {
      const t = transformFor(q);
      for (let k = 0; k < 3; k += 1) {
        const axisView = glsl.vxViewVector(axis(k), uView(t));
        const side = axisView.x + axisView.y + (axisView.z ?? 0) >= 0 ? 1 : -1;
        const normal = [axisView.x * side, axisView.y * side, (axisView.z ?? 0) * side].map((value) => value + 0);
        expect([normal.filter((value) => value === 1).length, normal.filter((value) => value === 0).length], `q ${q} axis ${k}`).toEqual([1, 2]);
        expect(normal.every((value) => value === 0 || value === 1), `q ${q} axis ${k}: ${normal}`).toBe(true);
      }
    }
  });

  it('picks the min face of the world axis a quarter turn reverses, and the max face otherwise', () => {
    // The visible world faces per view: q 0: +x +y; q 1: world +x shows as view +y, world -y as view +x; q 2: -x, -y; q 3: -x as view +y... derived, not asserted by hand.
    const expected: Record<ViewRotation, [number, number]> = { 0: [1, 1], 1: [1, -1], 2: [-1, -1], 3: [-1, 1] };
    for (const q of VIEW_ROTATIONS) {
      const t = transformFor(q);
      const sides = [0, 1].map((k) => {
        const view = glsl.vxViewVector(axis(k), uView(t));
        return view.x + view.y >= 0 ? 1 : -1;
      });
      expect(sides, `q ${q}`).toEqual(expected[q]);
    }
  });

  it('turns a figure heading by the view quarter turns, exactly as the heading helper does', () => {
    for (const q of VIEW_ROTATIONS) {
      const t = transformFor(q);
      // The shader derives q from (c, s): the same table as the figure vertex stage.
      const turn = t.c > 0.5 ? 0 : t.s > 0.5 ? 1 : t.c < -0.5 ? 2 : 3;
      expect(turn).toBe(q);
      const headings: XY[] = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];
      headings.forEach((heading, h) => {
        const viewed: XY = { x: 0, y: 0 };
        vectorToViewVoxel(t, heading.x, heading.y, viewed);
        expect(headings[headingInView(h, q)], `heading ${h} in view ${q}`).toEqual({ x: viewed.x + 0, y: viewed.y + 0 });
        expect(headings[(h + turn) & 3]).toEqual({ x: viewed.x + 0, y: viewed.y + 0 });
      });
    }
  });
});

// ---- patterns --------------------------------------------------------------------------------------

describe('the top-face pattern cell with cellShift (design 4.5)', () => {
  /** The CPU twin of vxPatternCell for a top face: floor(pos + cellShift + (0, 0, -1/2)). */
  const cellOf = (pos: V, shift: V): [number, number] => [Math.floor(pos.x + shift.x), Math.floor(pos.y + shift.y)];

  it('gives every voxel of a top face exactly one texel, in every view (the view-0 property)', () => {
    for (const q of VIEW_ROTATIONS) {
      const t = transformFor(q);
      const shift: XY = { x: 0, y: 0 };
      patternCellShift(t, shift);
      const height = 4;
      // Texel centres of a flat top at z = height, in view space: (sx, sy) -> view voxel on that plane.
      const counts = new Map<string, number>();
      for (let sy = -400; sy < 400; sy += 1) {
        for (let sx = -400; sx < 400; sx += 1) {
          const tx = sx + 0.5;
          const ty = sy + 0.5;
          const sum = ty + height; // (u + v) / 2
          const u = sum + tx / 2;
          const v = sum - tx / 2;
          const world: XY = { x: 0, y: 0 };
          voxelFromView(t, u, v, world);
          const [cx, cy] = cellOf(vec3(world.x, world.y, height), vec3(shift.x, shift.y, 0));
          counts.set(`${cx},${cy}`, (counts.get(`${cx},${cy}`) ?? 0) + 1);
          // The texel samples the same pattern cell it does in view 0: the view voxel of the world cell is
          // the view-0 cell of this texel, floor(u + 1/2), floor(v). (A fixed +x world shift fails this in q 1..3.)
          const centreOfCell: XY = { x: 0, y: 0 };
          voxelToView(t, cx + 0.5, cy + 0.5, centreOfCell);
          if (sx % 7 === 0 && sy % 5 === 0) expect([Math.floor(centreOfCell.x), Math.floor(centreOfCell.y)], `q ${q} texel ${sx},${sy}`).toEqual([Math.floor(u + 0.5), Math.floor(v)]);
        }
      }
      // A 4 x 4 patch well inside the sampled region (world voxels, all of them on the view's visible plane).
      const centre: XY = { x: 0, y: 0 };
      voxelFromView(t, 6, 4, centre);
      let checked = 0;
      for (let dy = -2; dy < 2; dy += 1) {
        for (let dx = -2; dx < 2; dx += 1) {
          const key = `${Math.floor(centre.x) + dx},${Math.floor(centre.y) + dy}`;
          expect(counts.get(key), `q ${q} voxel ${key}`).toBe(1);
          checked += 1;
        }
      }
      expect(checked).toBe(16);
    }
  });

  it('shifts by (0.5, 0, 0) in view 0, the pre-rotation rule', () => {
    const shift: XY = { x: 0, y: 0 };
    patternCellShift(transformFor(0), shift);
    expect(shift).toEqual({ x: 0.5, y: 0 });
  });

  it('gives a rigid part its view-0 shift (0.5, 0, 0) bit for bit in view 0, whatever its rotation, and the world shift when it is not turned', () => {
    const quatRotate = (q: [number, number, number, number], v: [number, number, number]): [number, number, number] => {
      const cross = (a: number[], b: number[]): number[] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const t = cross(q, v).map((value) => 2 * value);
      const c = cross(q, t);
      return [v[0] + q[3] * t[0] + c[0], v[1] + q[3] * t[1] + c[1], v[2] + q[3] * t[2] + c[2]];
    };
    const rigidShift = (rotation: [number, number, number, number], view: ViewTransform): [number, number, number] => {
      const cellShift: [number, number, number] = [0.5 * view.c, -0.5 * view.s, 0];
      const delta = quatRotate([-rotation[0], -rotation[1], -rotation[2], rotation[3]], [cellShift[0] - 0.5, cellShift[1], cellShift[2]]);
      return [0.5 + delta[0], delta[1], delta[2]];
    };
    const spin = Math.sin(0.7);
    const rotations: [number, number, number, number][] = [[0, 0, 0, 1], [0, 0, spin, Math.cos(0.7)], [0.3, 0, 0.2, 0.93], [0, 0, 1, 0]];
    for (const rotation of rotations) {
      const shift = rigidShift(rotation, transformFor(0));
      expect(shift.map((value) => Object.is(value, 0.5) || Object.is(value, 0) ? value : NaN), JSON.stringify(rotation)).toEqual([0.5, 0, 0]);
    }
    const identityTurned = rigidShift([0, 0, 0, 1], transformFor(1));
    expect(identityTurned.map((value) => value + 0)).toEqual([0, -0.5, 0]);
  });
});

// ---- uniform dirty tracking -------------------------------------------------------------------------

describe('ViewUniformSync (uView is written only when the revision moves)', () => {
  it('writes nothing for the identity view or an unchanged revision, and once per turn', () => {
    const target = new Float32Array([1, 0, 0, 0]);
    const sync = new ViewUniformSync();
    const t = createViewTransform();
    expect(sync.sync(target, undefined), 'omitted = identity, already held').toBe(false);
    expect(sync.sync(target, t), 'revision 0 = identity, already held').toBe(false);
    for (let frame = 0; frame < 100; frame += 1) sync.sync(target, t);
    expect(sync.writes).toBe(0);
    setViewTransform({ rotation: 1, width: 2, height: 3 }, t);
    expect(sync.sync(target, t)).toBe(true);
    expect([...target]).toEqual([0, 1, 96, 0]);
    for (let frame = 0; frame < 100; frame += 1) expect(sync.sync(target, t)).toBe(false);
    expect(sync.writes).toBe(1);
    setViewTransform({ rotation: 1, width: 2, height: 3 }, t);
    expect(sync.sync(target, t), 'same values do not bump the revision').toBe(false);
  });

  it('returns to the identity when the view is omitted again, and survives four turns', () => {
    const target = new Float32Array([1, 0, 0, 0]);
    const sync = new ViewUniformSync();
    const t = createViewTransform();
    for (const q of [1, 2, 3, 0] as const) {
      setViewTransform({ rotation: q, width: 4, height: 4 }, t);
      expect(sync.sync(target, t)).toBe(true);
      expect([...target], `q ${q}`).toEqual([t.c, t.s, t.ox, t.oy]);
    }
    expect([...target]).toEqual([1, 0, 0, 0]);
    expect(sync.writes).toBe(4);
  });
});
