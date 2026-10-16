import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../game/config';
import { ParkSession } from '../game/session/ParkSession';
import { seedDevPark } from '../game/session/devPark';
import { coasterHeadIndex, type CoasterTimingRecord } from './coasterTrain';

/**
 * The train is render-only (the ride simulation only uses the cycle duration), so nothing else
 * would notice if its timing drifted from the physics sweep again. These pin it to the dev park's
 * coaster: three flat station pieces, a two-level lift, a long summit and a two-level drop.
 */
const devParkCoaster = (): CoasterTimingRecord => {
  const session = new ParkSession(null);
  seedDevPark(session);
  const [record] = session.world.coasters.values();
  if (!record) throw new Error('the dev park lost its coaster');
  return record;
};

const PARKED = GAME_CONFIG.coaster.stationLength - 1;
const LOAD = GAME_CONFIG.coaster.stationLoadSeconds;

/** The ride's `cycleRemainingSeconds` at `seconds` after the station load finished. */
const remainingAt = (record: CoasterTimingRecord, seconds: number): number =>
  record.stats.durationSeconds - LOAD - seconds;

const headAt = (record: CoasterTimingRecord, seconds: number): number =>
  coasterHeadIndex(record, remainingAt(record, seconds));

/** First time after the load, to the millisecond, at which the lead car reaches `index`. */
const reachTime = (record: CoasterTimingRecord, index: number): number => {
  for (let milliseconds = 0; milliseconds <= 60_000; milliseconds += 1) {
    if (headAt(record, milliseconds / 1000) >= index) return milliseconds / 1000;
  }
  return Number.POSITIVE_INFINITY;
};

const totalTravel = (record: CoasterTimingRecord): number =>
  record.stats.travelSeconds.reduce((total, seconds) => total + seconds, 0);

describe('coaster train timing', () => {
  it('parks the lead car at the end of the station while the ride is not running', () => {
    const record = devParkCoaster();
    expect(coasterHeadIndex(record, null)).toBe(PARKED);
  });

  it('stays parked for the whole station load', () => {
    const record = devParkCoaster();
    for (let seconds = -LOAD; seconds <= 0; seconds += 0.25) {
      expect(headAt(record, seconds), `moved ${seconds} s into the load`).toBe(PARKED);
    }
  });

  it('climbs the lift at lift speed: piece 4 at 1.26 s after the load, not 0.84 s', () => {
    const record = devParkCoaster();
    const travel = record.stats.travelSeconds;
    expect(record.pieces.map((piece) => piece.height).join('')).toBe('0001222222222210');
    const reached = reachTime(record, 4);
    // Segments 2→3 and 3→4 are the lift, each 1 / lift speed (1.6 cells/s): exactly 1.25 s.
    expect(reached).toBeCloseTo(travel[2] + travel[3], 2);
    expect(reached).toBeCloseTo(1.26, 1);
    // The old indexing spent the two station segments' 0.83 s there instead.
    expect(travel[0] + travel[1]).toBeCloseTo(0.84, 1);
    expect(headAt(record, 0.84), 'the train raced up the lift again').toBeLessThan(4);
  });

  it('spends on every segment exactly the seconds the physics sweep gave that segment', () => {
    const record = devParkCoaster();
    const count = record.pieces.length;
    const travel = record.stats.travelSeconds;
    let elapsed = 0;
    for (let step = 0; step < count - 1; step += 1) {
      elapsed += travel[(PARKED + step) % count];
      // Just before and just after the boundary into piece PARKED + step + 1.
      expect(headAt(record, elapsed - 1e-6)).toBeLessThan(PARKED + step + 1);
      expect(headAt(record, elapsed + 1e-6)).toBeGreaterThanOrEqual(PARKED + step + 1);
    }
  });

  it('only ever moves forward through the cycle', () => {
    const record = devParkCoaster();
    const end = totalTravel(record);
    let previous = PARKED;
    for (let seconds = 0; seconds < end; seconds += 0.005) {
      const head = headAt(record, seconds);
      expect(head).toBeGreaterThanOrEqual(previous);
      previous = head;
    }
    expect(previous).toBeGreaterThan(PARKED + record.pieces.length - 0.1);
  });

  it('wraps back to the station when the cycle ends', () => {
    const record = devParkCoaster();
    const count = record.pieces.length;
    const end = totalTravel(record);
    // Just short of a full lap the lead car is almost home; a full lap (or the last instant of the
    // cycle, when nothing remains) puts it back at the end of the station.
    expect(headAt(record, end - 0.001) % count).toBeCloseTo(PARKED, 1);
    expect(headAt(record, end + 0.001)).toBe(PARKED);
    expect(coasterHeadIndex(record, 0)).toBe(PARKED);
  });

  it('parks when the timing table does not match the layout', () => {
    const record = devParkCoaster();
    const broken: CoasterTimingRecord = {
      pieces: record.pieces,
      stats: { durationSeconds: record.stats.durationSeconds, travelSeconds: record.stats.travelSeconds.slice(1) },
    };
    expect(coasterHeadIndex(broken, remainingAt(broken, 2))).toBe(PARKED);
  });
});
