import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { COLOUR_SLOT_TAG, COLOUR_SWATCHES, colourSlotsFor, SWATCH_COUNT } from '../../../game/content/colours';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { seedDevPark } from '../../../game/session/devPark';
import { ParkSession } from '../../../game/session/ParkSession';
import { createModelCache } from '../blueprint/compile';
import chunkFixture from '../content/__fixtures__/dev-park-chunks-pre-colours.json';
import { BOX_FLOATS, unpackBoxWord, withMaterial } from '../contracts/boxes';
import { visualQuarterTurn } from '../contracts/space';
import { buildPalette } from '../palette';
import { createTransformTable } from './rigid';
import { REGISTRY_CONTENT, SceneModels, StaticWorld } from './staticWorld';

/**
 * Phase 28 step 1: a recolour is a DATA change of one object. These tests pin what that costs and
 * what it may not change, on the dev park with the real content:
 * - nothing moves for defaults: every chunk of the seeded dev park hashes to what it hashed before
 *   colours existed, and a recoloured-then-reset ride gives those hashes back;
 * - substitution is 1:1 per box after meshing: for every ride, slot and swatch (and every slot on
 *   one swatch) the chunk keeps its box count, every extent, order, outline group, pattern, quarter
 *   turn and transform slot, and only the material byte of that slot's boxes changes, to the swatch's;
 * - a recolour dirties exactly the ride's home chunk, rebuilds it once, keeps its transform slots,
 *   and a no-op (or an equal record that is a different object, as undo makes) rebuilds nothing.
 */

const PALETTE = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS, COLOUR_SWATCHES.map((swatch) => swatch.rgb));
const CACHE = createModelCache();

const setup = () => {
  const session = new ParkSession(null);
  seedDevPark(session);
  const game = session.world;
  const transforms = createTransformTable();
  const models = new SceneModels(PALETTE, CACHE, REGISTRY_CONTENT, (message, error) => { throw new Error(`${message} ${String(error)}`); });
  const world = new StaticWorld({ width: game.width, height: game.height, models, transforms });
  world.sync(game);
  world.rebuildDirty(game);
  const hashes = (): string[] => Array.from({ length: world.chunkCount }, (_unused, index) => world.chunkHash(index));
  const counts = (): number[] => Array.from({ length: world.chunkCount }, (_unused, index) => world.chunkBoxes(index).count);
  const rebuild = (): number => {
    world.sync(game);
    return world.rebuildDirty(game);
  };
  const rides = [...game.objects.values()].filter((object) => BUILD_BY_ID.get(object.definitionId)?.kind === 'ride' && !game.coasters.has(object.id) && colourSlotsFor(object.definitionId).length > 0);
  return { session, game, world, models, transforms, hashes, counts, rebuild, rides };
};

const copyChunk = (world: StaticWorld, index: number): Float32Array => {
  const writer = world.chunkBoxes(index);
  return writer.data.slice(0, writer.count * BOX_FLOATS);
};

describe('recolour in the static world', () => {
  it('draws every default exactly as before colours existed (dev park, REGISTRY content)', () => {
    const { world, hashes, counts } = setup();
    expect(world.chunkCount).toBe(chunkFixture.chunkCount);
    expect(counts()).toEqual(chunkFixture.boxes);
    expect(counts().reduce((sum, count) => sum + count, 0)).toBe(chunkFixture.totalBoxes);
    expect(hashes()).toEqual(chunkFixture.hashes);
  });

  it('has every colourable ride of the catalog in the dev park to recolour', () => {
    expect([...new Set(setup().rides.map((object) => object.definitionId))].sort()).toEqual(
      ['aurora-wheel', 'bumble-coach', 'cloud-hopper', 'comet-cups', 'gale-spinner', 'harbor-swings', 'moonpetal-carousel', 'petal-roundabout', 'splash-rings', 'thunder-drum'],
    );
  });

  it('a recolour then a reset gives the default chunk hashes back, rebuilding only the home chunk each time', () => {
    const { game, world, hashes, rebuild, rides } = setup();
    for (const ride of rides) {
      const home = world.placements.get(ride.id)!.homeChunk;
      const slots = colourSlotsFor(ride.definitionId);
      expect(game.setObjectColours(ride.id, slots.map((_slot, index) => (index * 7 + 5) % SWATCH_COUNT))).toEqual({ ok: true, changed: true });
      expect(world.dirtyCount === 0, 'nothing is dirty until the scene syncs').toBe(true);
      world.sync(game);
      expect(world.dirtyCount, `${ride.definitionId}: one chunk dirty`).toBe(1);
      expect(world.dirty[home]).toBe(1);
      expect(world.rebuildDirty(game)).toBe(1);
      expect(world.rebuiltChunks[0]).toBe(home);
      expect(hashes(), `${ride.definitionId}: the recolour is visible`).not.toEqual(chunkFixture.hashes);
      game.clearObjectColours(ride.id);
      expect(rebuild()).toBe(1);
      expect(hashes(), `${ride.definitionId}: reset restores the default chunks`).toEqual(chunkFixture.hashes);
    }
  });

  it('changes only the material byte of the slot boxes, to the swatch material, for every ride, slot and swatch', () => {
    const { game, world, models, counts, rebuild, rides: allRides } = setup();
    // One ride per type: the dev park has two comet-cups and two bumble-coaches.
    const rides = allRides.filter((ride, index) => allRides.findIndex((other) => other.definitionId === ride.definitionId) === index);
    const totalBefore = counts();
    let checked = 0;
    for (const ride of rides) {
      const definition = BUILD_BY_ID.get(ride.definitionId)!;
      const home = world.placements.get(ride.id)!.homeChunk;
      const model = models.objectModel(definition, visualQuarterTurn(ride.rotation));
      const tagged = new Map<number, number>();
      for (const part of model.parts) {
        for (let box = 0; box < part.boxCount; box += 1) {
          const tag = part.boxes[box * BOX_FLOATS + 7];
          if (tag !== 0) tagged.set(tag, (tagged.get(tag) ?? 0) + 1);
        }
      }
      const slots = colourSlotsFor(ride.definitionId);
      const before = copyChunk(world, home);
      const variants: (number | null)[][] = [];
      slots.forEach((_slot, slotIndex) => {
        for (let swatch = 0; swatch < SWATCH_COUNT; swatch += 1) variants.push(slots.map((_other, index) => (index === slotIndex ? swatch : null)));
      });
      for (let swatch = 0; swatch < SWATCH_COUNT; swatch += 1) variants.push(slots.map(() => swatch));
      for (const colours of variants) {
        expect(game.setObjectColours(ride.id, colours).ok).toBe(true);
        expect(rebuild(), `${ride.definitionId} ${colours.join()}`).toBe(1);
        const after = copyChunk(world, home);
        expect(world.chunkBoxes(home).count, 'a recolour never changes a box count').toBe(totalBefore[home]);
        expect(after.length).toBe(before.length);
        let changed = 0;
        let expectedChanges = 0;
        for (let box = 0; box < before.length / BOX_FLOATS; box += 1) {
          const at = box * BOX_FLOATS;
          for (const field of [0, 1, 2, 4, 5, 6, 7]) {
            if (after[at + field] !== before[at + field]) throw new Error(`${ride.definitionId} ${colours.join()} box ${box} field ${field}: ${before[at + field]} -> ${after[at + field]}`);
          }
          const was = unpackBoxWord(before[at + 3]);
          const now = unpackBoxWord(after[at + 3]);
          expect([now.group, now.pattern, now.quarterTurn], 'group, pattern and turn are the box').toEqual([was.group, was.pattern, was.quarterTurn]);
          if (now.material !== was.material) changed += 1;
          if (after[at + 3] !== before[at + 3]) expect(after[at + 3]).toBe(withMaterial(before[at + 3], now.material));
        }
        // Every box of a recoloured slot whose swatch differs from the slot default changes; no other box does.
        slots.forEach((slot, index) => {
          const swatch = colours[index];
          if (swatch === null) return;
          const material = PALETTE.material(COLOUR_SWATCHES[swatch].rgb);
          expect(PALETTE.flags(material), 'swatch materials are plain').toBe(0);
          if (material !== PALETTE.material(slot.defaultRgb)) expectedChanges += tagged.get(COLOUR_SLOT_TAG[slot.id]) ?? 0;
        });
        expect(changed, `${ride.definitionId} ${colours.join()}: exactly the slot boxes changed material`).toBe(expectedChanges);
        checked += 1;
      }
      game.clearObjectColours(ride.id);
      rebuild();
      expect(copyChunk(world, home)).toEqual(before);
    }
    expect(checked, 'every ride type x (slots x 21 swatches + 21 all-slot swatches)').toBe(rides.reduce((sum, ride) => sum + (colourSlotsFor(ride.definitionId).length + 1) * SWATCH_COUNT, 0));
  }, 120_000);

  it('keeps every transform slot of the recoloured ride and of every other object', () => {
    const { game, world, transforms, rebuild, rides } = setup();
    const keys = (): string[] => world.placements.size === 0 ? [] : [...world.placements.values()].flatMap((placement) => placement.parts.map((part) => `${placement.objectId}:${part.partId}:${part.slot}:${transforms.keyOfSlot(part.slot)?.partKey}`));
    const before = keys();
    expect(before.length).toBeGreaterThan(10);
    for (const ride of rides) game.setObjectColours(ride.id, colourSlotsFor(ride.definitionId).map(() => 3));
    rebuild();
    expect(keys()).toEqual(before);
    for (const ride of rides) game.clearObjectColours(ride.id);
    rebuild();
    expect(keys()).toEqual(before);
  });

  it('rebuilds nothing for a repeated recolour or for an equal record that is another object (undo restores)', () => {
    const { session, game, world, rebuild, rides } = setup();
    const ride = rides[0];
    const colours = colourSlotsFor(ride.definitionId).map((_slot, index) => index + 2);
    game.setObjectColours(ride.id, colours);
    expect(rebuild()).toBe(1);
    expect(game.setObjectColours(ride.id, colours)).toEqual({ ok: true, changed: false });
    expect(rebuild()).toBe(0);
    expect(world.dirtyCount).toBe(0);
    session.syncWithWorld();
    session.restoreState(session.serialize());
    session.syncWithWorld();
    expect(session.world.objectColours(ride.id)).toEqual(colours);
    expect(rebuild(), 'a restore re-creates equal records: same values, no rebuild').toBe(0);
    expect(world.dirtyCount).toBe(0);
  });

  it('an unknown swatch index repaints nothing and never throws', () => {
    const { models } = setup();
    for (const bad of [-1, SWATCH_COUNT, 99, 1.5, Number.NaN, 1e300]) expect(models.swatchMaterial(bad), String(bad)).toBe(0);
    for (const swatch of COLOUR_SWATCHES) expect(models.swatchMaterial(swatch.index)).toBe(PALETTE.material(swatch.rgb));
  });
});
