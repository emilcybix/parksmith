import { describe, expect, it } from 'vitest';
import { COASTER_TYPE_BY_ID } from '../../../game/coaster/content';
import type { CoasterPiece } from '../../../game/coaster/design';
import { GAME_CONFIG } from '../../../game/config';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { centreLineFor } from '../../../game/coaster/centreLine';
import { createModelCache } from '../blueprint/compile';
import { coasterCarSlotKey, coasterCouplingSlotKey } from '../contracts/rigid';
import { buildPalette } from '../palette';
import { CoasterDraft, DRAFT_TRAIN_OBJECT_ID } from './coasterDraft';
import { coasterRailTopZ, createCoasterCarPoses, placeCarsOnTrack, writeCoasterCarTransforms } from './coasterCars';
import { createTransformTable } from './rigid';
import type { TransformTable } from './rigid';
import { REGISTRY_CONTENT, SceneModels } from './staticWorld';

/**
 * Phase 27 step 3 review: the designer's draft train against the built coaster's parked train,
 * for all three types, closed and open drafts.
 */
const PALETTE = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS);
const models = (): SceneModels => new SceneModels(PALETTE, createModelCache(), REGISTRY_CONTENT, (message) => {
  throw new Error(message);
});
const TYPES = ['comet-trail', 'star-chaser', 'skyline-serpent'];

/** A closed 6x4 ring with a flat station running east from (4, 4), plus its first `open` pieces as an open draft. */
const ring = (): CoasterPiece[] => {
  const cells: { x: number; y: number }[] = [];
  for (let x = 0; x < 6; x += 1) cells.push({ x: 4 + x, y: 4 });
  for (let y = 1; y < 4; y += 1) cells.push({ x: 9, y: 4 + y });
  for (let x = 4; x >= 0; x -= 1) cells.push({ x: 4 + x, y: 7 });
  for (let y = 2; y >= 1; y -= 1) cells.push({ x: 4, y: 4 + y });
  return cells.map((cell, index) => ({ cell, height: index >= 4 && index <= 8 ? 1 : 0 }));
};

const pose = (table: TransformTable, objectId: number, key: number): number[] => {
  const slot = table.slotFor(objectId, key);
  const at = (slot - 1) * 8;
  return Array.from(table.data.subarray(at, at + 8));
};

describe('Phase 27 step 3 review: draft train', () => {
  for (const id of TYPES) {
    const definition = BUILD_BY_ID.get(id)!;
    const cars = COASTER_TYPE_BY_ID.get(id)!.trainCars;

    it(`${id}: a closed draft parks the train exactly where the built coaster parks it`, () => {
      const pieces = ring();
      const draftTable = createTransformTable();
      new CoasterDraft().resolve(pieces, definition, true, models(), draftTable);
      const builtTable = createTransformTable();
      const poses = createCoasterCarPoses(cars);
      placeCarsOnTrack(centreLineFor(pieces), GAME_CONFIG.coaster.stationLength - 1, cars, poses);
      writeCoasterCarTransforms(builtTable, 7, poses, 0);
      for (let car = 0; car < cars; car += 1) {
        const draft = pose(draftTable, DRAFT_TRAIN_OBJECT_ID, coasterCarSlotKey(car));
        const built = pose(builtTable, 7, coasterCarSlotKey(car));
        for (let k = 0; k < 8; k += 1) expect(draft[k], `car ${car} float ${k}`).toBeCloseTo(built[k], 4);
      }
      for (let car = 0; car + 1 < cars; car += 1) {
        for (let half = 0; half < 2; half += 1) {
          const draft = pose(draftTable, DRAFT_TRAIN_OBJECT_ID, coasterCouplingSlotKey(car, half));
          const built = pose(builtTable, 7, coasterCouplingSlotKey(car, half));
          for (let k = 0; k < 8; k += 1) expect(draft[k], `coupling ${car} half ${half} float ${k}`).toBeCloseTo(built[k], 4);
        }
      }
    });

    // Fixed (was DEFECT, medium, for the star chaser and the serpent): an open draft's rear cars rode
    // the scratch lead-in of `openLayoutRing`, whose predecessor in the rotated ring is the trailing
    // scratch piece on the far side of the layout, so the lead-in's centre line ran backwards and the
    // rear cars were shoved back or reversed. The draft train now rides its own ring with a straight
    // lead-in of three pieces (coasterDraft.ts `trainRing`).
    it(`${id}: an open draft (station plus one piece) parks every car level on the station or its straight lead-in, nose east`, () => {
      const pieces = ring().slice(0, GAME_CONFIG.coaster.stationLength + 1);
      const table = createTransformTable();
      new CoasterDraft().resolve(pieces, definition, true, models(), table);
      const stationY = 4.5 * 32;
      for (let car = 0; car < cars; car += 1) {
        const [x, y, z, , qx, qy, qz, qw] = pose(table, DRAFT_TRAIN_OBJECT_ID, coasterCarSlotKey(car));
        const where = `car ${car} at ${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)} q ${[qx, qy, qz, qw].map((v) => v.toFixed(3))}`;
        // Behind the head (piece 2's centre, x = 6.5 tiles) by 0.62 tiles per car, on the station's straight line.
        expect(x, where).toBeCloseTo((6.5 - 0.62 * car) * 32, 0);
        expect(y, where).toBeCloseTo(stationY, 1);
        expect(z, where).toBeCloseTo(coasterRailTopZ(0), 1);
        // Identity rotation (car +x = world +x), up to sign.
        expect(Math.abs(qw), where).toBeCloseTo(1, 3);
      }
    });
  }
});
