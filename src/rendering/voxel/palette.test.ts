import { describe, expect, it } from 'vitest';
import { BUILD_CATALOG } from '../../game/content/catalog';
import { COLOUR_SWATCHES, SWATCH_COUNT } from '../../game/content/colours';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../game/guests/GuestSimulation';
import type { BuildDefinition } from '../../game/types';
import { MATERIAL_LIMIT } from './contracts/boxes';
import {
  MAT,
  MAT_COLOR,
  MATERIAL_EMPTY,
  MATERIAL_FLAG_EMISSIVE,
  MATERIAL_FLAG_GLASS,
  MATERIAL_FLAG_NO_OUTLINE,
  MATERIAL_FLAG_SHADOW,
  MATERIAL_FLAG_WATER,
  PALETTE_TEX_ROWS,
  PALETTE_TEX_WIDTH,
  PATTERN,
} from './contracts/palette';
import type { FixedMaterialName, Palette, PatternName } from './contracts/palette';
import { VOXELS_PER_TILE, projectX, projectY, rotateBoxInFootprint } from './contracts/space';
import { VX_PATTERNS } from './gpu/shaders/patterns';
import { buildPalette } from './palette';

/**
 * The palette is the one table every voxel module shares, so its promises are pinned here: ids are
 * a pure function of the catalog (incremental and from-scratch scenes must hash equal), every colour
 * content may use resolves, flags only ever come from the fixed materials that are meant to glow,
 * shimmer or stay unoutlined, and the texture holds exactly what the shaders unpack.
 *
 * The surface patterns' GLSL cannot run in Node; it is compiled and rendered on a real WebGL2
 * context by the B3 probe. What Node can pin is the chunk's shape and the voxel arithmetic it relies
 * on: the top-face cell rule against the contract projection, and the quarter-turn mirror against
 * the contract rotation.
 */

const gamePalette = (): Palette => buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS);

const FIXED_NAMES = Object.keys(MAT) as FixedMaterialName[];

const LAST_FIXED = Math.max(...Object.values(MAT));

const FLAGGED: Partial<Record<FixedMaterialName, number>> = {
  LAMP_GLOW: MATERIAL_FLAG_EMISSIVE,
  BULB: MATERIAL_FLAG_EMISSIVE,
  GLASS: MATERIAL_FLAG_GLASS,
  WINDOW_GLOW: MATERIAL_FLAG_GLASS,
  WATER: MATERIAL_FLAG_WATER,
  SHADOW: MATERIAL_FLAG_SHADOW | MATERIAL_FLAG_NO_OUTLINE,
};

/** Legacy plot: 23 % of the colour over `under`, per sRGB channel, rounded. */
const legacyMix = (under: number, over: number): number => {
  const channel = (shift: number): number => {
    const from = (under >> shift) & 255;
    const to = (over >> shift) & 255;
    return Math.round(from + (to - from) * 0.23) << shift;
  };
  return channel(16) | channel(8) | channel(0);
};

/** RGBA of material `material` in texture row `row`. */
const texel = (bytes: Uint8Array, row: number, material: number): number[] =>
  Array.from(bytes.subarray((row * PALETTE_TEX_WIDTH + material) * 4, (row * PALETTE_TEX_WIDTH + material) * 4 + 4));

const rgbOf = (rgba: readonly number[]): number => (rgba[0] << 16) | (rgba[1] << 8) | rgba[2];

const hex = (rgb: number): string => `0x${rgb.toString(16).padStart(6, '0')}`;

/** A deterministic stream of 24-bit integers, so failures reproduce. */
const seededStream = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state >>> 8;
  };
};

describe('voxel palette', () => {
  it('is deterministic: two builds give byte-identical texture data and the same ids', () => {
    const first = gamePalette();
    const second = gamePalette();
    expect(second.count, 'material count').toBe(first.count);
    expect(second.textureData(), 'texture bytes').toEqual(first.textureData());
    for (const definition of BUILD_CATALOG) {
      expect(second.material(definition.color), definition.id).toBe(first.material(definition.color));
      expect(second.material(definition.accent), definition.id).toBe(first.material(definition.accent));
      expect(second.plotTint(definition.color), definition.id).toBe(first.plotTint(definition.color));
    }
  });

  it('never changes an id because of the order colours are looked up in', () => {
    const palette = gamePalette();
    const before = palette.textureData();
    const colors = [...BUILD_CATALOG.map((definition) => definition.accent), ...GUEST_COLORS].reverse();
    const ids = colors.map((rgb) => palette.material(rgb));
    expect(colors.map((rgb) => palette.material(rgb)), 'same answers the second time').toEqual(ids);
    expect(palette.textureData(), 'lookups leave the texture alone').toEqual(before);
  });

  it('hands out a copy of the texture data, so no caller can repaint the park', () => {
    const palette = gamePalette();
    const data = palette.textureData();
    data.fill(7);
    expect(texel(palette.textureData(), 0, MAT.GRASS), 'grass after a caller scribbled on its copy')
      .toEqual([0x92, 0xd4, 0x7f, 255]);
  });

  it('keeps material 0 empty and every fixed material on its MAT id with its MAT_COLOR base', () => {
    const palette = gamePalette();
    expect(MATERIAL_EMPTY, 'the empty material').toBe(0);
    expect(palette.baseColor(MATERIAL_EMPTY), 'empty colour').toBe(0);
    expect(palette.flags(MATERIAL_EMPTY), 'empty flags').toBe(0);
    for (const name of FIXED_NAMES) {
      expect(palette.baseColor(MAT[name]), name).toBe(MAT_COLOR[name]);
    }
    expect(palette.count, 'catalog materials follow the fixed ones').toBeGreaterThan(LAST_FIXED + 1);
  });

  it('flags exactly the lamps, glass, water and shadow materials', () => {
    const palette = gamePalette();
    for (const name of FIXED_NAMES) {
      expect(palette.flags(MAT[name]), name).toBe(FLAGGED[name] ?? 0);
    }
    for (let material = LAST_FIXED + 1; material < palette.count; material += 1) {
      expect(palette.flags(material), `material ${material} (catalog, tint or guest)`).toBe(0);
    }
    const bytes = palette.textureData();
    expect(texel(bytes, 1, MAT.LAMP_GLOW)[1], 'lamp glow emissive').toBe(255);
    expect(texel(bytes, 1, MAT.BULB)[1], 'bulb emissive').toBe(255);
    expect(texel(bytes, 1, MAT.WINDOW_GLOW)[1], 'lit window glow strength').toBeGreaterThan(0);
    expect(texel(bytes, 1, MAT.GLASS)[1], 'glass glow strength').toBeGreaterThan(0);
    expect(texel(bytes, 1, MAT.PAVING)[1], 'paving does not glow').toBe(0);
  });

  it('resolves every catalog colour and accent to an unflagged material of exactly that colour', () => {
    const palette = gamePalette();
    for (const definition of BUILD_CATALOG) {
      for (const rgb of [definition.color, definition.accent]) {
        const material = palette.material(rgb);
        expect(material, definition.id).toBeGreaterThan(MATERIAL_EMPTY);
        expect(material, definition.id).toBeLessThan(palette.count);
        expect(palette.baseColor(material), definition.id).toBe(rgb);
        expect(palette.flags(material), `${definition.id} must not inherit a flag`).toBe(0);
      }
    }
  });

  it('gives a catalog colour that equals a flagged fixed colour its own plain material', () => {
    // The game's own case: the lollipop lamp's accent is LAMP_GLOW's colour.
    const lamp = BUILD_CATALOG.find((definition) => definition.id === 'lollipop-lamp');
    expect(lamp?.accent, 'the lamp accent is the glow colour').toBe(MAT_COLOR.LAMP_GLOW);
    const game = gamePalette();
    expect(game.material(MAT_COLOR.LAMP_GLOW), 'not the emissive fixed material').not.toBe(MAT.LAMP_GLOW);
    // And every other flagged colour, as a catalog colour and as a guest colour.
    for (const name of Object.keys(FLAGGED) as FixedMaterialName[]) {
      const lookalike: BuildDefinition = { ...BUILD_CATALOG[0], id: `looks-like-${name}`, color: MAT_COLOR[name] };
      for (const palette of [buildPalette([lookalike], [], []), buildPalette([], [MAT_COLOR[name]], [])]) {
        const material = palette.material(MAT_COLOR[name]);
        expect(material, `${name} lookalike gets its own id`).not.toBe(MAT[name]);
        expect(palette.flags(material), `${name} lookalike is plain`).toBe(0);
        expect(palette.baseColor(material), `${name} lookalike keeps the colour`).toBe(MAT_COLOR[name]);
        expect(palette.flags(MAT[name]), `the fixed ${name} keeps its flags`).toBe(FLAGGED[name]);
      }
    }
  });

  it('de-duplicates colours among unflagged materials: the first id with that colour wins', () => {
    const palette = gamePalette();
    // Fixed colours shared by catalog entries resolve to the fixed material.
    expect(palette.material(0xfff0c8), 'sunstone/moonpetal accent = CANVAS').toBe(MAT.CANVAS);
    expect(palette.material(0x2f855a), 'confetti tree = FOLIAGE_DARK').toBe(MAT.FOLIAGE_DARK);
    expect(palette.material(0x2b2d42), 'bumble coach accent = TRAIN').toBe(MAT.TRAIN);
    expect(palette.material(MAT_COLOR.SIGN), 'SIGN shares RAIL\'s colour, RAIL comes first').toBe(MAT.RAIL);
    expect(palette.material(MAT_COLOR.CAP), 'CAP shares WHITE\'s colour, WHITE comes first').toBe(MAT.WHITE);
    expect(palette.material(GUEST_COLORS[0]), 'pink shirts = ARCH_PINK').toBe(MAT.ARCH_PINK);
    // Every colour has one material, and no two unflagged non-tint materials share one.
    const seen = new Map<number, number>();
    const tints = new Set(BUILD_CATALOG.map((definition) => palette.plotTint(definition.color)));
    for (let material = LAST_FIXED + 1; material < palette.count; material += 1) {
      if (tints.has(material)) continue;
      const rgb = palette.baseColor(material);
      expect(seen.get(rgb), `colour ${hex(rgb)} registered twice`).toBeUndefined();
      seen.set(rgb, material);
      expect(palette.material(rgb), 'resolves to itself').toBe(material);
    }
  });

  it('tints every catalog plot like legacy: 23 % of the colour over grass, checkerboard included', () => {
    const palette = gamePalette();
    for (const definition of BUILD_CATALOG) {
      const tint = palette.plotTint(definition.color);
      expect(palette.baseColor(tint), definition.id).toBe(legacyMix(MAT_COLOR.GRASS, definition.color));
      expect(palette.secondaryColor(tint), `${definition.id} second grass shade`).toBe(legacyMix(0x8bce78, definition.color));
      expect(palette.flags(tint), definition.id).toBe(0);
    }
    // Hand arithmetic: 146 + 0.23·(239 − 146) = 167.4 → 0xa7, 212 − 0.23·101 = 188.8 → 0xbd,
    // 127 + 0.23·16 = 130.7 → 0x83.
    const roundabout = BUILD_CATALOG.find((definition) => definition.id === 'petal-roundabout');
    expect(roundabout?.color, 'petal roundabout colour').toBe(0xef6f8f);
    expect(palette.baseColor(palette.plotTint(0xef6f8f)), 'petal roundabout plot').toBe(0xa7bd83);
  });

  it('resolves every guest colour and accent to an unflagged material of that colour', () => {
    const palette = gamePalette();
    for (const rgb of [...GUEST_COLORS, ...GUEST_ACCENTS]) {
      const material = palette.material(rgb);
      expect(palette.baseColor(material), hex(rgb)).toBe(rgb);
      expect(palette.flags(material), hex(rgb)).toBe(0);
    }
  });

  it('orders materials fixed → catalog colours and accents → plot tints → guest colours', () => {
    const palette = gamePalette();
    const newCatalog = BUILD_CATALOG.flatMap((definition) => [definition.color, definition.accent])
      .map((rgb) => palette.material(rgb)).filter((material) => material > LAST_FIXED);
    const tints = BUILD_CATALOG.map((definition) => palette.plotTint(definition.color));
    const newGuests = [...GUEST_COLORS, ...GUEST_ACCENTS].map((rgb) => palette.material(rgb))
      .filter((material) => material > Math.max(...newCatalog, ...tints));
    expect(newCatalog[0], 'first catalog material right after the fixed ones').toBe(LAST_FIXED + 1);
    expect(Math.min(...tints), 'tints after every catalog colour').toBeGreaterThan(Math.max(...newCatalog));
    expect(newGuests.length, 'white and the pastel accents are new guest materials').toBeGreaterThan(0);
    expect(Math.max(...newGuests), 'guest colours are the last materials').toBe(palette.count - 1);
  });

  it('Phase 28: the swatches cost nine materials, come last, never move an id and leave every older byte as it was', async () => {
    const swatchColors = COLOUR_SWATCHES.map((swatch) => swatch.rgb);
    const plain = gamePalette();
    const withSwatches = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS, swatchColors);
    expect(SWATCH_COUNT).toBe(21);
    expect(plain.count, 'the palette without swatches').toBe(122);
    // Twelve swatches are catalog colours (shared); the nine the readability test retuned are new.
    const has = (palette: Palette, rgb: number): boolean => {
      try {
        palette.material(rgb);
        return true;
      } catch {
        return false;
      }
    };
    const shared = COLOUR_SWATCHES.filter((swatch) => has(plain, swatch.rgb));
    expect(shared.map((swatch) => swatch.id)).toEqual(['cherry', 'honey', 'cream', 'rose', 'orchid', 'lavender', 'violet', 'ink', 'sky', 'mint', 'teal', 'lagoon']);
    expect(withSwatches.count, 'budget: one material per retuned swatch').toBe(plain.count + SWATCH_COUNT - shared.length);
    expect(withSwatches.count).toBe(131);
    expect(withSwatches.count, 'budget: within the 256 limit').toBeLessThanOrEqual(MATERIAL_LIMIT);
    expect(plain.count + SWATCH_COUNT, 'the worst case').toBeLessThanOrEqual(MATERIAL_LIMIT);
    const sha = async (bytes: Uint8Array): Promise<string> => Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice().buffer)),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    expect(await sha(plain.textureData()), 'the texture captured before Phase 28').toBe('95fa5ce576f7d791b8fe167b292bc5d26b613a8e5a8664a7f56d96ed74ef6912');
    // Every material that existed before the swatches keeps every byte in every texture row, so a
    // default ride (which only references those) is drawn exactly as before; only the appended ids differ.
    const before = plain.textureData();
    const after = withSwatches.textureData();
    const rowBytes = PALETTE_TEX_WIDTH * 4;
    expect(before.length).toBe(rowBytes * PALETTE_TEX_ROWS);
    const masked = (bytes: Uint8Array): Uint8Array => {
      const copy = bytes.slice();
      for (let row = 0; row < PALETTE_TEX_ROWS; row += 1) copy.fill(0, row * rowBytes + plain.count * 4, (row + 1) * rowBytes);
      return copy;
    };
    expect(await sha(masked(after)), 'materials below the swatches are byte-identical').toBe(await sha(before));
    for (const swatch of COLOUR_SWATCHES) {
      const material = withSwatches.material(swatch.rgb);
      if (has(plain, swatch.rgb)) expect(material, `${swatch.id} resolves to the same material with and without swatches`).toBe(plain.material(swatch.rgb));
      else expect(material, `${swatch.id} is appended after every older material`).toBeGreaterThanOrEqual(plain.count);
      expect(withSwatches.baseColor(material)).toBe(swatch.rgb);
      expect(withSwatches.flags(material), `${swatch.id} never glows, shimmers or turns to glass`).toBe(0);
    }
  });

  it('Phase 28: a swatch colour the palette has never seen is appended after every guest colour as one plain material', () => {
    const fresh = 0x123456;
    const plain = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS, COLOUR_SWATCHES.map((swatch) => swatch.rgb));
    const extended = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS, [...COLOUR_SWATCHES.map((swatch) => swatch.rgb), fresh]);
    expect(extended.count).toBe(plain.count + 1);
    expect(extended.material(fresh), 'the very last material').toBe(plain.count);
    expect(extended.flags(extended.material(fresh))).toBe(0);
    for (let material = 1; material < plain.count; material += 1) {
      expect(extended.baseColor(material), `material ${material} did not move`).toBe(plain.baseColor(material));
    }
    expect(() => buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS, Array.from({ length: 200 }, (_unused, index) => 0x100000 + index)), 'swatches share the 256 budget').toThrow(/256 materials/);
  });

  it('gives every material a readable secondary and an amplitude inside the art bible', () => {
    const palette = gamePalette();
    const bytes = palette.textureData();
    expect(palette.secondaryColor(MAT.GRASS), 'the legacy second grass shade').toBe(0x8bce78);
    expect(palette.secondaryColor(MAT.PAVING), 'paving mortar in the legacy path-edge colour').toBe(MAT_COLOR.CURB);
    for (let material = 1; material < palette.count; material += 1) {
      const amplitude = texel(bytes, 1, material)[2] / 255;
      // Quantised to bytes: 6 % stores as 15/255 = 5.9 %.
      if (amplitude > 0) expect(amplitude, `material ${material} amplitude`).toBeGreaterThanOrEqual(0.058);
      expect(amplitude, `material ${material} amplitude`).toBeLessThanOrEqual(0.12);
      if (palette.flags(material) & MATERIAL_FLAG_SHADOW) continue;
      expect(palette.secondaryColor(material), `material ${material} secondary differs from its base`)
        .not.toBe(palette.baseColor(material));
    }
    expect(texel(bytes, 1, MAT.LAMP_GLOW)[2], 'light sources are never patterned').toBe(0);
    expect(texel(bytes, 1, MAT.SKIN_1)[2], 'skin is never patterned').toBe(0);
  });

  it('lays the texture out as 256 × 4 RGBA8 rows: base, props, secondary, reserved', () => {
    const palette = gamePalette();
    const bytes = palette.textureData();
    expect(bytes.length, 'bytes').toBe(PALETTE_TEX_WIDTH * PALETTE_TEX_ROWS * 4);
    expect(PALETTE_TEX_WIDTH, 'one texel per possible material').toBe(MATERIAL_LIMIT);
    expect(PALETTE_TEX_ROWS, 'rows').toBe(4);
    for (let material = 0; material < PALETTE_TEX_WIDTH; material += 1) {
      const used = material > MATERIAL_EMPTY && material < palette.count;
      const [base, props, secondary, reserved] = [0, 1, 2, 3].map((row) => texel(bytes, row, material));
      expect(reserved, `row 3 of ${material} is reserved`).toEqual([0, 0, 0, 0]);
      if (!used) {
        expect([...base, ...props, ...secondary], `material ${material} is unused`).toEqual(new Array(12).fill(0));
        continue;
      }
      expect(rgbOf(base), `row 0 of ${material}`).toBe(palette.baseColor(material));
      expect(base[3], `row 0 alpha of ${material}`).toBe(255);
      expect(props[0], `row 1 r = flags of ${material}`).toBe(palette.flags(material));
      expect(props[3], `row 1 a of ${material}`).toBe(0);
      expect(rgbOf(secondary), `row 2 of ${material}`).toBe(palette.secondaryColor(material));
      expect(secondary[3], `row 2 alpha of ${material}`).toBe(255);
    }
    expect(texel(bytes, 1, MAT.SHADOW)[0], 'shadow flags').toBe(MATERIAL_FLAG_SHADOW | MATERIAL_FLAG_NO_OUTLINE);
    expect(texel(bytes, 1, MAT.GLASS)[1], 'glass glow strength ·255').toBe(Math.round(0.75 * 255));
    expect(texel(bytes, 1, MAT.GRASS)[2], 'grass amplitude 6 % ·255').toBe(Math.round(0.06 * 255));
  });

  it('fits in the 8-bit material field of a box word', () => {
    expect(gamePalette().count, 'materials in use').toBeLessThanOrEqual(MATERIAL_LIMIT);
  });

  it('refuses to build a palette larger than 256 materials, and says why', () => {
    const next = seededStream(20_260_930);
    const many = Array.from({ length: MATERIAL_LIMIT }, () => next());
    expect(() => buildPalette(BUILD_CATALOG, many, GUEST_ACCENTS), 'one guest colour per slot').toThrow(/256 materials/);
    // Exactly full is fine: fixed + one plain material per remaining slot.
    const fixedOnly = buildPalette([], [], []);
    const room = MATERIAL_LIMIT - fixedOnly.count;
    const exact = new Set<number>();
    while (exact.size < room) {
      const rgb = next();
      if (!Object.values(MAT_COLOR).includes(rgb)) exact.add(rgb);
    }
    expect(buildPalette([], [...exact], []).count, 'a full palette').toBe(MATERIAL_LIMIT);
  });

  it('throws a helpful error for colours and ids it does not know', () => {
    const palette = gamePalette();
    expect(() => palette.material(0x123457), 'unknown colour').toThrow(/no material for colour 0x123457/);
    expect(() => palette.material(0x123457), 'says what to do').toThrow(/never registers/);
    expect(() => palette.material(MAT_COLOR.GLASS), 'a flagged fixed colour').toThrow(/MAT\.GLASS/);
    expect(() => palette.material(palette.baseColor(palette.plotTint(0xef6f8f))), 'a tint colour').toThrow(/plotTint/);
    expect(() => palette.material(-1), 'negative').toThrow(/0xRRGGBB/);
    expect(() => palette.material(1.5), 'fractional').toThrow(/0xRRGGBB/);
    expect(() => palette.material(0x1000000), 'too large').toThrow(/0xRRGGBB/);
    expect(() => palette.plotTint(0xffd166), 'an accent has no plot').toThrow(/no plot tint for 0xffd166/);
    expect(() => palette.baseColor(palette.count), 'id past the end').toThrow(/no material/);
    expect(() => palette.secondaryColor(-1), 'negative id').toThrow(/no material/);
    expect(() => palette.flags(Number.NaN), 'NaN id').toThrow(/no material/);
  });

  it('rejects a catalog colour that is not 0xRRGGBB instead of storing garbage', () => {
    const broken: BuildDefinition = { ...BUILD_CATALOG[1], id: 'broken', color: 0x1_000_000 };
    expect(() => buildPalette([broken], [], []), 'a 25-bit colour').toThrow(/broken colour/);
  });
});

describe('surface pattern GLSL chunk', () => {
  const code = VX_PATTERNS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const flat = code.replace(/\s+/g, ' ');

  const intConstant = (name: string): number => {
    const match = new RegExp(`const int ${name} = (-?\\d+);`).exec(code);
    if (!match) throw new Error(`${name} is not declared in VX_PATTERNS`);
    return Number(match[1]);
  };

  it('declares the two contract functions with their exact signatures', () => {
    expect(flat, 'vxMaterialProps').toContain('vec4 vxMaterialProps(highp sampler2D palette, int material)');
    expect(flat, 'vxSurfaceColor').toContain('vec3 vxSurfaceColor(highp sampler2D palette, int material, int pattern, '
      + 'int quarterTurn, int face, vec3 pos, vec3 normal, float time, float grid)');
  });

  it('handles every PATTERN id with the contract value', () => {
    for (const name of Object.keys(PATTERN) as PatternName[]) {
      expect(intConstant(`VX_PATTERN_${name}`), `${name} constant`).toBe(PATTERN[name]);
      expect(code, `${name} branch`).toMatch(new RegExp(`pattern == VX_PATTERN_${name}\\b`));
    }
  });

  it('follows the chunk rules: no uniforms, samplers, loops, discard, filtering or version lines', () => {
    expect(code, 'uniforms belong to top-level shaders').not.toMatch(/\buniform\b/);
    expect(code, 'opaque programs never discard').not.toMatch(/\bdiscard\b/);
    expect(code, 'no loops').not.toMatch(/\b(for|while|do)\b/);
    expect(code, 'data is fetched with texelFetch only').not.toMatch(/\btexture\s*\(/);
    expect(code, 'the top-level shader owns #version and precision').not.toMatch(/#version|\bprecision\b/);
    expect(code, 'no samplers declared outside parameters').not.toMatch(/^\s*(highp\s+)?sampler2D/m);
  });

  it('addresses cells with the two rules the sampling tests below rely on', () => {
    expect(flat, 'the 1:1 cell: top faces shift half a voxel along x; other faces step inside along the normal')
      .toContain('vec3 p = normal.z > 0.5 ? pos + vec3(0.5, 0.0, -0.5) : pos - 0.5 * normal;');
    expect(flat, 'the voxel under the sample').toContain('return ivec3(floor(pos - 0.5 * normal)) + VX_PATTERN_ORIGIN;');
    // Bands and tiles use the voxel: ROOF's tabs and STRIPES' bands, and the lawn's tiles and grid line.
    expect(flat.match(/vxPatternPlane\(voxel,/g)?.length, 'ROOF and STRIPES read the voxel plane').toBe(2);
    expect(flat, 'lawn tiles').toContain('color = (((voxel.x >> 5) + (voxel.y >> 5)) & 1) == 0 ? base : second;');
    expect(flat, 'grid line').toContain('bool border = (voxel.x & 31) == 0 || (voxel.y & 31) == 0;');
  });

  it('offsets cells by a multiple of every period, and mirrors model x so lattices survive a quarter turn', () => {
    const origin = intConstant('VX_PATTERN_ORIGIN');
    const mirror = intConstant('VX_PATTERN_MIRROR');
    // 32: tiles and every power-of-two period; 3 and 6: BRICK courses and bricks, FOLIAGE clusters.
    for (const period of [3, 4, 6, 8, 16, 32, 64]) expect(origin % period, `origin mod ${period}`).toBe(0);
    expect(mirror, 'mirror').toBe(2 * origin - 1);
    // A turned static box: model voxel (i, k) of a W-wide footprint lands on world voxel
    // (tile x + k, tile y + W − 1 − i) (space.ts), and the shader's model x = mirror − (world y + origin)
    // must be non-negative and name the same voxel modulo 32; model y = world x + origin likewise.
    const next = seededStream(9_301);
    for (let sample = 0; sample < 500; sample += 1) {
      const width = VOXELS_PER_TILE * (1 + (next() % 4));
      const tileX = VOXELS_PER_TILE * (next() % 64);
      const tileY = VOXELS_PER_TILE * (next() % 64);
      const i = next() % width;
      const k = next() % width;
      const world = rotateBoxInFootprint(i, k, 1, 1, 1, width);
      const cellX = tileX + world.minX + origin;
      const cellY = tileY + world.minY + origin;
      const modelX = mirror - cellY;
      expect(modelX, 'model x stays non-negative').toBeGreaterThanOrEqual(0);
      expect(modelX % VOXELS_PER_TILE, `model x of voxel ${i} in a ${width}-wide footprint`).toBe(i % VOXELS_PER_TILE);
      expect(cellX % VOXELS_PER_TILE, `model y of voxel ${k}`).toBe(k % VOXELS_PER_TILE);
    }
  });
});

/**
 * One texel per voxel step (space.ts): which voxel cell does each texel of a face show? These pin the
 * reasons for the two addressing rules (critique gpu #6, visual #11) with the contract's own
 * projection: the 1:1 cell shows every voxel of a top face once, and the voxel under the sample keeps
 * a band or grid line that lies on a face's edge whole and inside the face.
 */
describe('surface pattern cell addressing', () => {
  type Point = readonly [number, number, number];
  type Rule = (point: Point, normal: Point) => Point;

  interface Sample {
    row: number;
    point: Point;
  }

  /** The voxel under the sample: floor(pos − 0.5·normal) on every face (the critique's naive rule). */
  const voxelOf: Rule = (point, normal) => [
    Math.floor(point[0] - 0.5 * normal[0]),
    Math.floor(point[1] - 0.5 * normal[1]),
    Math.floor(point[2] - 0.5 * normal[2]),
  ];

  /** The contract's 1:1 cell: top faces shift half a voxel along x first. */
  const cellOf: Rule = (point, normal) => (normal[2] > 0.5
    ? [Math.floor(point[0] + 0.5), Math.floor(point[1]), Math.floor(point[2] - 0.5)]
    : voxelOf(point, normal));

  /** Every texel centre (world texel = legacy px) that lands on a face, with the face point under it. */
  const faceSamples = (
    pointAt: (centreX: number, centreY: number) => Point,
    inside: (point: Point) => boolean,
    texels: { minX: number; maxX: number; minY: number; maxY: number },
  ): Sample[] => {
    const samples: Sample[] = [];
    for (let sy = texels.minY; sy < texels.maxY; sy += 1) {
      for (let sx = texels.minX; sx < texels.maxX; sx += 1) {
        const point = pointAt(sx + 0.5, sy + 0.5);
        expect(projectX(point[0], point[1]), 'point projects back to its texel (x)').toBeCloseTo(sx + 0.5, 9);
        expect(projectY(point[0], point[1], point[2]), 'point projects back to its texel (y)').toBeCloseTo(sy + 0.5, 9);
        if (inside(point)) samples.push({ row: sy, point });
      }
    }
    return samples;
  };

  const countCells = (samples: readonly Sample[], normal: Point, rule: Rule): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const { point } of samples) {
      const key = rule(point, normal).join(',');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };

  const SIZE = 64;
  const X0 = 96;
  const Y0 = 160;
  const UP: Point = [0, 0, 1];

  /** A SIZE × SIZE top face at height z: the plane point under each texel centre. */
  const topFace = (z: number): Sample[] => faceSamples(
    (centreX, centreY) => [centreY + z + centreX / 2, centreY + z - centreX / 2, z],
    (point) => point[0] >= X0 && point[0] < X0 + SIZE && point[1] >= Y0 && point[1] < Y0 + SIZE,
    { minX: X0 - Y0 - SIZE, maxX: X0 - Y0 + SIZE, minY: (X0 + Y0) / 2 - z, maxY: (X0 + Y0) / 2 + SIZE - z },
  );

  it('samples every voxel of a top face exactly once with the 1:1 cell, both parities', () => {
    for (const z of [0, 1, 7]) {
      const counts = countCells(topFace(z), UP, cellOf);
      expect(Math.max(...counts.values()), `z ${z}: no voxel is sampled twice`).toBe(1);
      // Interior columns: a column's sample points lie within ±½ voxel of its centre line.
      for (let x = X0 + 1; x < X0 + SIZE; x += 1) {
        for (let y = Y0; y < Y0 + SIZE; y += 1) {
          expect(counts.get(`${x},${y},${z - 1}`), `z ${z}: voxel ${x},${y} is sampled`).toBe(1);
        }
      }
    }
  });

  it('shows why fine features need the cell: the voxel under the sample is only ever an even voxel', () => {
    const counts = countCells(topFace(0), UP, voxelOf);
    const parities = new Set([...counts.keys()].map((key) => {
      const [x, y] = key.split(',').map(Number);
      return (x + y) & 1;
    }));
    expect([...parities], 'only even x + y is ever visible').toEqual([0]);
    expect(Math.max(...counts.values()), 'each visible voxel covers two texels').toBe(2);
  });

  it('keeps a line on a top face\'s edge whole and inside the face with the voxel, not with the cell', () => {
    const samples = topFace(1);
    /** Texels per row of the 1-voxel line x = X0 (a tile's first column), and texels sampled off the face. */
    const edgeLine = (rule: Rule): { perRow: number[]; outside: number } => {
      const rows = new Map<number, number>();
      let outside = 0;
      for (const { row, point } of samples) {
        const [x, y] = rule(point, UP);
        if (x < X0 || x >= X0 + SIZE || y < Y0 || y >= Y0 + SIZE) outside += 1;
        if (x === X0) rows.set(row, (rows.get(row) ?? 0) + 1);
      }
      const ordered = [...rows.keys()].sort((a, b) => a - b);
      // Every row between the line's two ends.
      return { perRow: ordered.slice(1, -1).map((row) => rows.get(row) ?? 0), outside };
    };
    const voxel = edgeLine(voxelOf);
    expect(voxel.perRow.length, 'the line spans the face').toBeGreaterThan(SIZE / 2 - 4);
    expect(new Set(voxel.perRow), 'voxel: two texels on every row, a whole 2:1 line').toEqual(new Set([2]));
    expect(voxel.outside, 'voxel: nothing sampled off the face').toBe(0);
    const cell = edgeLine(cellOf);
    expect(cell.perRow.filter((count) => count === 1).length, 'cell: the edge line thins to one texel').toBeGreaterThan(SIZE / 4);
    expect(cell.outside, 'cell: the far edge samples the next column').toBeGreaterThan(0);
  });

  it('samples every voxel of both side faces exactly once (both rules agree there)', () => {
    const HEIGHT = 16;
    const xNormal: Point = [1, 0, 0];
    const yNormal: Point = [0, 1, 0];
    const xFace = faceSamples(
      (centreX, centreY) => {
        const y = X0 - centreX;
        return [X0, y, (X0 + y) / 2 - centreY];
      },
      (point) => point[1] >= Y0 && point[1] < Y0 + SIZE && point[2] >= 0 && point[2] < HEIGHT,
      { minX: X0 - Y0 - SIZE, maxX: X0 - Y0, minY: (X0 + Y0) / 2 - HEIGHT, maxY: (X0 + Y0 + SIZE) / 2 },
    );
    const yFace = faceSamples(
      (centreX, centreY) => {
        const x = centreX + Y0;
        return [x, Y0, (x + Y0) / 2 - centreY];
      },
      (point) => point[0] >= X0 && point[0] < X0 + SIZE && point[2] >= 0 && point[2] < HEIGHT,
      { minX: X0 - Y0, maxX: X0 - Y0 + SIZE, minY: (X0 + Y0) / 2 - HEIGHT, maxY: (X0 + Y0 + SIZE) / 2 },
    );
    for (const [name, samples, normal] of [['x face', xFace, xNormal], ['y face', yFace, yNormal]] as const) {
      const counts = countCells(samples, normal, cellOf);
      expect(counts.size, `${name}: every voxel`).toBe(SIZE * HEIGHT);
      expect(Math.max(...counts.values()), `${name}: once`).toBe(1);
      expect(countCells(samples, normal, voxelOf), `${name}: the voxel is the cell`).toEqual(counts);
    }
    expect(countCells(xFace, xNormal, cellOf).has(`${X0 - 1},${Y0},0`), 'the x face shows the voxel it belongs to').toBe(true);
    expect(countCells(yFace, yNormal, cellOf).has(`${X0},${Y0 - 1},0`), 'the y face shows the voxel it belongs to').toBe(true);
  });
});
