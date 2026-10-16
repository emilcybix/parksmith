import type { BuildDefinition } from '../../game/types';
import { MATERIAL_LIMIT } from './contracts/boxes';
import type { BiomeMaterial } from './content/biomeMaterials';
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
} from './contracts/palette';
import type { FixedMaterialName, Palette } from './contracts/palette';

/**
 * The one palette the voxel renderer uses (contracts/palette.ts).
 *
 * It is built once, eagerly, in a fixed order — material 0 (empty), the fixed materials in MAT id
 * order, every catalog colour and accent, a plot tint per catalog colour, then the guest colours and
 * accents — so a material id is a pure function of the catalog. That is what lets the static world's
 * incremental rebuilds hash equal to a from-scratch build, and why content only ever looks colours
 * up: registering on demand would make ids depend on which model happened to compile first.
 *
 * Colour maths happens on the sRGB-encoded values throughout, exactly like the legacy renderer's
 * alpha blending, so a plot tint here is the colour the classic renderer shows.
 */

/** Legacy plot fill: the definition colour at 23 % over the grass (WorldRenderer.createObjectBase). */
export const PLOT_TINT_MIX = 0.23;
/** The second shade of the legacy terrain checkerboard (WorldRenderer.drawTerrain). */
export const GRASS_ALTERNATE_COLOR = 0x8bce78;

/** Default ± value variation of a patterned material; the art bible allows 6–12 %. */
const DEFAULT_AMPLITUDE = 0.08;
/** Grass blades and plots vary least (art bible: grass speckle ±6 %), so the lawn stays calm. */
const GRASS_AMPLITUDE = 0.06;
/** Colours at least this light get a darker secondary, darker ones a lighter one. */
const VARIANT_DARKEN_FROM_LUMA = 0.4;
const VARIANT_DARKEN = 0.8;
const VARIANT_LIGHTEN = 0.25;

interface MaterialLook {
  /** The pattern's second colour: mortar, gaps, seams, strata, stripes, frames, the second grass shade. */
  secondary: number;
  /** MATERIAL_FLAG_* bits. */
  flags: number;
  /** 0..1. Emissive materials always glow this much; glass glows this much times the preset's glassGlow. */
  emissive: number;
  /** 0..1, the ± value variation patterns apply (speckle, per-brick and per-board variation, …). */
  amplitude: number;
}

const channelOf = (rgb: number, shift: number): number => (rgb >> shift) & 255;

const packRgb = (red: number, green: number, blue: number): number => (red << 16) | (green << 8) | blue;

/** Per-channel sRGB mix, rounded — what alpha-blending `to` at `amount` over `from` gives. */
const mixRgb = (from: number, to: number, amount: number): number => packRgb(
  Math.round(channelOf(from, 16) + (channelOf(to, 16) - channelOf(from, 16)) * amount),
  Math.round(channelOf(from, 8) + (channelOf(to, 8) - channelOf(from, 8)) * amount),
  Math.round(channelOf(from, 0) + (channelOf(to, 0) - channelOf(from, 0)) * amount),
);

const scaleRgb = (rgb: number, factor: number): number => packRgb(
  Math.min(255, Math.round(channelOf(rgb, 16) * factor)),
  Math.min(255, Math.round(channelOf(rgb, 8) * factor)),
  Math.min(255, Math.round(channelOf(rgb, 0) * factor)),
);

/** Rec. 601 weights on the encoded values, 0..1: only used to pick a readable secondary. */
const lumaOf = (rgb: number): number =>
  (0.299 * channelOf(rgb, 16) + 0.587 * channelOf(rgb, 8) + 0.114 * channelOf(rgb, 0)) / 255;

/**
 * Secondary colour for a colour nobody hand-picked one for (catalog and guest colours, most fixed
 * materials): darker for light and mid colours, lighter for dark ones, so mortar, seams, stripes and
 * frames always read against the base whatever colour a content author chose.
 */
const contrastVariant = (rgb: number): number => (lumaOf(rgb) >= VARIANT_DARKEN_FROM_LUMA
  ? scaleRgb(rgb, VARIANT_DARKEN)
  : mixRgb(rgb, MAT_COLOR.WHITE, VARIANT_LIGHTEN));

/** The legacy plot colour of a catalog colour: 23 % of it over the grass, in sRGB, rounded. */
const plotTintColor = (rgb: number): number => mixRgb(MAT_COLOR.GRASS, rgb, PLOT_TINT_MIX);

const hex = (rgb: number): string => `0x${rgb.toString(16).padStart(6, '0')}`;

const isRgb = (value: number): boolean => Number.isInteger(value) && value >= 0 && value <= 0xffffff;

/**
 * Hand-picked looks of the fixed materials; anything not listed gets contrastVariant(base) and the
 * default amplitude. The flags are the only behaviour a colour can carry, which is why a catalog
 * colour never resolves to a flagged material (see buildPalette).
 */
const FIXED_LOOKS: Readonly<Partial<Record<FixedMaterialName, Partial<MaterialLook>>>> = {
  // The legacy two-colour lawn: GRASS draws the tile-parity checker between these two.
  GRASS: { secondary: GRASS_ALTERNATE_COLOR, amplitude: GRASS_AMPLITUDE },
  // Strata alternate with a slightly darker band every 4 voxels.
  SOIL: { secondary: 0x7c5f43 },
  SOIL_DARK: { secondary: 0x614833 },
  // Mortar in the legacy path-edge colour, so a paved path reads like the classic one.
  PAVING: { secondary: MAT_COLOR.CURB, amplitude: GRASS_AMPLITUDE },
  CURB: { secondary: 0xba9e67, amplitude: GRASS_AMPLITUDE },
  WOOD: { secondary: 0x785335 },
  TIMBER: { secondary: 0x5e422d },
  // Two-tone ironwork: dark steel seams catch light, light steel seams sink.
  STEEL: { secondary: MAT_COLOR.STEEL_LIGHT },
  STEEL_LIGHT: { secondary: MAT_COLOR.STEEL },
  CONCRETE: { secondary: 0x879794, amplitude: GRASS_AMPLITUDE },
  STONE: { secondary: 0x948e83 },
  // Shimmer highlight.
  WATER: { secondary: 0x75a1b6, flags: MATERIAL_FLAG_WATER, amplitude: 0.1 },
  // Window frames: dark steel around cool glass, timber around the warm lit window.
  GLASS: { secondary: MAT_COLOR.STEEL, flags: MATERIAL_FLAG_GLASS, emissive: 0.75, amplitude: GRASS_AMPLITUDE },
  WINDOW_GLOW: { secondary: MAT_COLOR.TIMBER, flags: MATERIAL_FLAG_GLASS, emissive: 1, amplitude: GRASS_AMPLITUDE },
  // Light sources are never patterned: a lantern is one flat glowing colour.
  LAMP_GLOW: { secondary: MAT_COLOR.BULB, flags: MATERIAL_FLAG_EMISSIVE, emissive: 1, amplitude: 0 },
  BULB: { secondary: MAT_COLOR.LAMP_GLOW, flags: MATERIAL_FLAG_EMISSIVE, emissive: 1, amplitude: 0 },
  // Dithered decals: never outlined, never an occluder.
  SHADOW: { secondary: MAT_COLOR.SHADOW, flags: MATERIAL_FLAG_SHADOW | MATERIAL_FLAG_NO_OUTLINE, amplitude: 0 },
  SKIN_1: { amplitude: 0 },
  SKIN_2: { amplitude: 0 },
  SKIN_3: { amplitude: 0 },
  SKIN_4: { amplitude: 0 },
  FOLIAGE: { secondary: MAT_COLOR.FOLIAGE_DARK },
  FOLIAGE_DARK: { secondary: 0x266a48 },
};

const lookFor = (base: number, overrides: Partial<MaterialLook> = {}): MaterialLook => ({
  secondary: overrides.secondary ?? contrastVariant(base),
  flags: overrides.flags ?? 0,
  emissive: overrides.emissive ?? 0,
  amplitude: overrides.amplitude ?? DEFAULT_AMPLITUDE,
});

/** A plot slab: its secondary is the second grass shade under the same tint, like legacy's checkerboard. */
const plotTintLook = (rgb: number): MaterialLook => ({
  secondary: mixRgb(GRASS_ALTERNATE_COLOR, rgb, PLOT_TINT_MIX),
  flags: 0,
  emissive: 0,
  amplitude: GRASS_AMPLITUDE,
});

const FIXED_NAME_BY_ID: ReadonlyMap<number, FixedMaterialName> = new Map(
  (Object.keys(MAT) as FixedMaterialName[]).map((name) => [MAT[name], name]),
);

/**
 * The palette's storage: one slot per material id, quantised exactly as the texture stores it.
 * Slot 0 (MATERIAL_EMPTY) is never written: it carves in blueprints and is never drawn.
 */
class MaterialTable {
  count = MATERIAL_EMPTY + 1;
  readonly base = new Int32Array(MATERIAL_LIMIT);
  readonly secondary = new Int32Array(MATERIAL_LIMIT);
  readonly flags = new Uint8Array(MATERIAL_LIMIT);
  readonly emissive = new Uint8Array(MATERIAL_LIMIT);
  readonly amplitude = new Uint8Array(MATERIAL_LIMIT);

  add(base: number, look: MaterialLook, what: string): number {
    if (!isRgb(base) || !isRgb(look.secondary)) {
      throw new Error(`Palette: ${what} has no valid 0xRRGGBB colour (${hex(base)} / ${hex(look.secondary)}).`);
    }
    if (this.count >= MATERIAL_LIMIT) {
      throw new Error(`Palette: ${what} would be material ${this.count}, but a box word holds only `
        + `${MATERIAL_LIMIT} materials (0..${MATERIAL_LIMIT - 1}). Reuse colours instead of adding new ones.`);
    }
    const material = this.count;
    this.count += 1;
    this.base[material] = base;
    this.secondary[material] = look.secondary;
    this.flags[material] = look.flags;
    this.emissive[material] = Math.round(Math.min(1, Math.max(0, look.emissive)) * 255);
    this.amplitude[material] = Math.round(Math.min(1, Math.max(0, look.amplitude)) * 255);
    return material;
  }
}

class EagerPalette implements Palette {
  readonly count: number;
  private readonly table: MaterialTable;
  private readonly unflaggedByRgb: ReadonlyMap<number, number>;
  private readonly tintByColor: ReadonlyMap<number, number>;
  private readonly bytes: Uint8Array;

  constructor(table: MaterialTable, unflaggedByRgb: ReadonlyMap<number, number>, tintByColor: ReadonlyMap<number, number>) {
    this.table = table;
    this.count = table.count;
    this.unflaggedByRgb = unflaggedByRgb;
    this.tintByColor = tintByColor;
    this.bytes = this.encode();
  }

  material(rgb: number): number {
    const material = this.unflaggedByRgb.get(rgb);
    if (material !== undefined) return material;
    throw new Error(this.unknownColorMessage(rgb));
  }

  plotTint(rgb: number): number {
    const material = this.tintByColor.get(rgb);
    if (material !== undefined) return material;
    const shown = isRgb(rgb) ? hex(rgb) : String(rgb);
    throw new Error(`Palette has no plot tint for ${shown}: plot tints exist only for catalog colours `
      + '(BuildDefinition.color), and the palette is built from the catalog it was given.');
  }

  baseColor(material: number): number {
    return this.table.base[this.checked(material)];
  }

  secondaryColor(material: number): number {
    return this.table.secondary[this.checked(material)];
  }

  flags(material: number): number {
    return this.table.flags[this.checked(material)];
  }

  /** A copy, so no caller can change what later uploads or other callers see. */
  textureData(): Uint8Array {
    return this.bytes.slice();
  }

  private checked(material: number): number {
    if (Number.isInteger(material) && material >= 0 && material < this.count) return material;
    throw new Error(`Palette has no material ${material}: ids run from 0 (empty) to ${this.count - 1}.`);
  }

  private unknownColorMessage(rgb: number): string {
    if (!isRgb(rgb)) return `Palette.material expects a 0xRRGGBB colour, got ${String(rgb)}.`;
    const lead = `Palette has no material for colour ${hex(rgb)}.`;
    for (let material = 1; material < this.count; material += 1) {
      if (this.table.base[material] !== rgb || this.table.flags[material] === 0) continue;
      const name = FIXED_NAME_BY_ID.get(material);
      if (name) {
        return `${lead} It is only the base of the flagged fixed material ${name} (id ${material}); `
          + `colours never resolve to flagged materials, so use MAT.${name} directly.`;
      }
    }
    for (const tint of this.tintByColor.values()) {
      if (this.table.base[tint] === rgb) return `${lead} It is a plot tint: use palette.plotTint(<catalog colour>).`;
    }
    return `${lead} Content looks colours up and never registers them: use a catalog colour or accent, `
      + 'a guest colour or accent, a MAT_COLOR base, or a MAT.* id.';
  }

  /** 256 × 4 RGBA8, rows as contracts/palette.ts documents; unused slots and material 0 stay zero. */
  private encode(): Uint8Array {
    const bytes = new Uint8Array(PALETTE_TEX_WIDTH * PALETTE_TEX_ROWS * 4);
    const table = this.table;
    for (let material = 1; material < this.count; material += 1) {
      const base = material * 4;
      const props = (PALETTE_TEX_WIDTH + material) * 4;
      const secondary = (2 * PALETTE_TEX_WIDTH + material) * 4;
      bytes[base] = channelOf(table.base[material], 16);
      bytes[base + 1] = channelOf(table.base[material], 8);
      bytes[base + 2] = channelOf(table.base[material], 0);
      bytes[base + 3] = 255;
      bytes[props] = table.flags[material];
      bytes[props + 1] = table.emissive[material];
      bytes[props + 2] = table.amplitude[material];
      bytes[secondary] = channelOf(table.secondary[material], 16);
      bytes[secondary + 1] = channelOf(table.secondary[material], 8);
      bytes[secondary + 2] = channelOf(table.secondary[material], 0);
      bytes[secondary + 3] = 255;
    }
    return bytes;
  }
}

/**
 * Builds the palette from the catalog and the guest colour tables (BUILD_CATALOG, GUEST_COLORS,
 * GUEST_ACCENTS in the game). Deterministic: the same inputs give byte-identical texture data.
 *
 * `swatchColors` (COLOUR_SWATCHES rgb, Phase 28) are appended after the guest colours, then `biomeMaterials`
 * (Phase 24: the biomes' ground and prop colours, BIOME_MATERIALS; none by default, so a palette
 * built for a test without them keeps its ids; the game's palette is `gamePalette()`).
 *
 * Colours are de-duplicated by rgb among UNFLAGGED materials only: a catalog colour that happens to
 * equal a lamp's glow (the lollipop lamp's accent is LAMP_GLOW's colour) gets its own plain material,
 * because a colour is appearance and a flag is behaviour — nothing should start glowing, turn to
 * water or lose its outline because two colours matched. Plot tints are their own materials (their
 * secondary is the tinted second grass shade), looked up by catalog colour through `plotTint`.
 */
export const buildPalette = (
  catalog: readonly BuildDefinition[],
  guestColors: readonly number[],
  guestAccents: readonly number[],
  swatchColors: readonly number[] = [],
  biomeMaterials: readonly BiomeMaterial[] = [],
): Palette => {
  const table = new MaterialTable();
  const unflaggedByRgb = new Map<number, number>();
  const tintByColor = new Map<number, number>();

  const fixedNames = (Object.keys(MAT) as FixedMaterialName[]).sort((a, b) => MAT[a] - MAT[b]);
  for (const name of fixedNames) {
    const material = table.add(MAT_COLOR[name], lookFor(MAT_COLOR[name], FIXED_LOOKS[name]), `fixed material ${name}`);
    if (material !== MAT[name]) {
      throw new Error(`Palette: fixed material ${name} must be id ${MAT[name]} but landed on ${material}; `
        + 'MAT ids must run 1..N without gaps.');
    }
    if (table.flags[material] === 0 && !unflaggedByRgb.has(MAT_COLOR[name])) unflaggedByRgb.set(MAT_COLOR[name], material);
  }

  const addColor = (rgb: number, what: string): void => {
    if (unflaggedByRgb.has(rgb)) return;
    unflaggedByRgb.set(rgb, table.add(rgb, lookFor(rgb), what));
  };
  for (const definition of catalog) {
    addColor(definition.color, `${definition.id} colour`);
    addColor(definition.accent, `${definition.id} accent`);
  }
  for (const definition of catalog) {
    if (tintByColor.has(definition.color)) continue;
    const tint = plotTintColor(definition.color);
    tintByColor.set(definition.color, table.add(tint, plotTintLook(definition.color), `${definition.id} plot tint`));
  }
  guestColors.forEach((rgb, index) => addColor(rgb, `guest colour ${index}`));
  guestAccents.forEach((rgb, index) => addColor(rgb, `guest accent ${index}`));
  // Phase 28: the curated colour swatches come last, so no id before them ever moves. A swatch that is a
  // catalog colour shares that material (de-duplicated by rgb above); a swatch the readability test
  // retuned costs exactly one plain, unflagged material (nine today: 131 of 256).
  swatchColors.forEach((rgb, index) => addColor(rgb, `colour swatch ${index}`));
  // Phase 24: the biomes' ground and prop colours come after the swatches, so no earlier id moves either. A colour
  // that is already a plain material (Meadow's fixed lawn, soil, paving and curb; a prop colour that is a catalog
  // or fixed colour) is reused and costs nothing; the rest cost one plain, unflagged material each.
  for (const entry of biomeMaterials) {
    if (unflaggedByRgb.has(entry.rgb)) continue;
    const look = lookFor(entry.rgb, {
      ...(entry.secondary === undefined ? {} : { secondary: entry.secondary }),
      amplitude: entry.variation === 'calm' ? GRASS_AMPLITUDE : DEFAULT_AMPLITUDE,
    });
    unflaggedByRgb.set(entry.rgb, table.add(entry.rgb, look, entry.what));
  }
  return new EagerPalette(table, unflaggedByRgb, tintByColor);
};
