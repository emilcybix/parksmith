import { GAME_CONFIG } from '../config';
import { isCoasterElement, isCoasterInversion } from './content';
import type { CoasterPiece } from './design';
import { creepSpeedMilli, integerSquareRoot } from './speedModel';

/**
 * Phase 44: the shuttle launch coaster. A shuttle layout is OPEN: the station (pieces 0 … stationLength − 1, flat at
 * level 0) fires the train out at the layout's launch speed (`pieces[0].launchSpeed`, cells per second), it rides the
 * track until its momentum runs out on a climb, rolls backward the whole way, and the station brakes stop it where it
 * started. The last piece leads nowhere; nothing wraps.
 *
 * The model is a deterministic energy sweep in fixed point (speed squared in (milli-cells/s)², the scale of
 * `coaster.lift.speedScale`): a level climbed costs `shuttle.energyPerLevel` and a level fallen gives it back, every
 * segment costs `frictionPerSegment` either way, a loop `loopEnergy` more. The turnaround is a fraction of a segment.
 * Segment i runs from piece i to piece i + 1, as everywhere in the coaster code.
 */

/** Whether a layout is a shuttle (an open out-and-back track): its first piece carries the launch speed. */
export const isShuttleLayout = (pieces: readonly CoasterPiece[]): boolean => pieces.length > 0 && pieces[0].launchSpeed !== undefined;

/** Whether a launch speed is one the designer offers (on the step grid of the configured range). */
export const isValidLaunchSpeed = (speed: unknown): speed is number => {
  const range = GAME_CONFIG.coaster.shuttle.launchSpeed;
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < range.minimum || speed > range.maximum) return false;
  const steps = (speed - range.minimum) / range.step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
};

/** Clamps a launch speed onto the designer's range and step grid. */
export const clampLaunchSpeed = (speed: number): number => {
  const range = GAME_CONFIG.coaster.shuttle.launchSpeed;
  const steps = Math.round((Math.min(range.maximum, Math.max(range.minimum, speed)) - range.minimum) / range.step);
  return range.minimum + steps * range.step;
};

/**
 * - `ok`: the train turns back on a climb before the end of the track.
 * - `overshoots`: it reaches the end of the track with speed to spare (it is turned at the end).
 * - `stops-flat`: its momentum runs out on flat or falling track, where nothing would roll it back.
 * - `loop-slow`: it enters a loop too slowly, either way.
 */
export type ShuttleOutcome = 'ok' | 'overshoots' | 'stops-flat' | 'loop-slow';

export interface ShuttleProfile {
  /** Seconds the train spends on segment i going out (0 on segments it never reaches, the turnaround's share on the turning one). */
  forwardSeconds: number[];
  /** Seconds on segment i rolling back. */
  backwardSeconds: number[];
  /** The segment the train turns on and how far along it (0 … 1). */
  turnSegment: number;
  turnFraction: number;
  outcome: ShuttleOutcome;
  /** The longest run of consecutive segments the returning train crawls over at the creep floor. */
  returnCreepSegments: number;
  /** Cells per second: the fastest the train goes, out or back. */
  topSpeed: number;
  /** Out plus back, without loading. */
  totalSeconds: number;
  /** Cells per second leaving each segment going out (0 past the turnaround). */
  forwardExitSpeeds: number[];
}

const round = (value: number, decimals = 1): number => {
  const multiplier = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
};

/** Speed squared a piece's special costs a shuttle, either way: a loop's, an element's (Phase 46), else 0. */
const specialEnergy = (piece: CoasterPiece): number => {
  if (piece.special === 'loop') return GAME_CONFIG.coaster.shuttle.loopEnergy;
  if (isCoasterElement(piece.special)) return GAME_CONFIG.coaster.elements[piece.special].energy;
  return 0;
};

/** The out-and-back run of a shuttle layout (any layout: a closed one is read as open). Pure, deterministic. */
export const shuttleProfile = (pieces: readonly CoasterPiece[]): ShuttleProfile => {
  const config = GAME_CONFIG.coaster;
  const shuttle = config.shuttle;
  const scale = config.lift.speedScale;
  const creep = creepSpeedMilli();
  const creepEnergy = creep * creep;
  const count = pieces.length;
  const parked = Math.min(config.stationLength - 1, Math.max(0, count - 2));
  const forwardSeconds = new Array<number>(count).fill(0);
  const backwardSeconds = new Array<number>(count).fill(0);
  const forwardExitSpeeds = new Array<number>(count).fill(0);
  const launch = pieces[0]?.launchSpeed ?? shuttle.launchSpeed.default;
  const launchMilli = Math.round(launch * scale);
  const boostMilli = Math.round(config.speed.boost * scale);
  let energy = launchMilli * launchMilli;
  let top = launchMilli;
  let outcome: ShuttleOutcome = 'ok';
  let turnSegment = Math.max(parked, count - 2);
  let turnFraction = 1;
  let turned = false;
  const lengthOf = (segment: number): number => (pieces[segment].special === 'loop' ? config.speed.loopLengthFactor : 1);
  const seconds = (length: number, heldMilli: number): number => length / (Math.max(creep, heldMilli) / scale);

  for (let segment = parked; segment <= count - 2; segment += 1) {
    const current = pieces[segment];
    const rise = pieces[segment + 1].height - current.height;
    if (current.special === 'boost') energy = Math.max(energy, boostMilli * boostMilli);
    if (isCoasterInversion(current.special) && energy < shuttle.loopMinimumEnergy) {
      outcome = 'loop-slow';
      turnSegment = segment;
      turnFraction = 0;
      turned = true;
      break;
    }
    const cost = shuttle.energyPerLevel * rise + shuttle.frictionPerSegment + specialEnergy(current);
    const exit = energy - cost;
    const entrySpeed = integerSquareRoot(energy);
    if (exit <= 0) {
      if (rise <= 0) outcome = 'stops-flat';
      turnSegment = segment;
      turnFraction = cost > 0 ? Math.min(1, energy / cost) : 1;
      forwardSeconds[segment] = seconds(lengthOf(segment) * turnFraction, entrySpeed >> 1);
      turned = true;
      break;
    }
    const exitSpeed = integerSquareRoot(exit);
    forwardSeconds[segment] = seconds(lengthOf(segment), (entrySpeed + exitSpeed) >> 1);
    forwardExitSpeeds[segment] = exitSpeed / scale;
    top = Math.max(top, exitSpeed);
    energy = exit;
  }
  if (!turned) {
    // The end of the track with speed to spare: the designer refuses it; a loaded park turns the train at the end.
    outcome = 'overshoots';
    turnSegment = Math.max(parked, count - 2);
    turnFraction = 1;
  }

  // Back from rest at the turnaround: the share of the turning segment first, then every segment down to the station.
  let returnCreep = 0;
  let creepRun = 0;
  let back = 0;
  if (count >= 2 && turnFraction > 0) {
    const rise = pieces[turnSegment + 1].height - pieces[turnSegment].height;
    const gain = Math.round(turnFraction * (shuttle.energyPerLevel * rise - shuttle.frictionPerSegment));
    back = Math.max(0, gain);
    const speed = integerSquareRoot(back);
    backwardSeconds[turnSegment] = seconds(lengthOf(turnSegment) * turnFraction, speed >> 1);
    top = Math.max(top, speed);
  }
  for (let segment = turnSegment - (turnFraction > 0 ? 1 : 0); segment >= parked; segment -= 1) {
    const current = pieces[segment];
    const rise = pieces[segment + 1].height - current.height;
    if (isCoasterInversion(current.special) && back < shuttle.loopMinimumEnergy && outcome === 'ok') outcome = 'loop-slow';
    let exit = back + shuttle.energyPerLevel * rise - shuttle.frictionPerSegment - specialEnergy(current);
    if (exit < creepEnergy) {
      exit = creepEnergy;
      creepRun += 1;
      returnCreep = Math.max(returnCreep, creepRun);
    } else {
      creepRun = 0;
    }
    const entrySpeed = integerSquareRoot(back);
    // The station brakes take the train down to the brake speed on the last segment home.
    const exitSpeed = segment === parked ? Math.min(integerSquareRoot(exit), Math.round(shuttle.brakeSpeed * scale)) : integerSquareRoot(exit);
    backwardSeconds[segment] = seconds(lengthOf(segment), (entrySpeed + exitSpeed) >> 1);
    top = Math.max(top, entrySpeed, exitSpeed);
    back = exit;
  }
  let totalSeconds = 0;
  for (let segment = 0; segment < count; segment += 1) totalSeconds += forwardSeconds[segment] + backwardSeconds[segment];
  return {
    forwardSeconds,
    backwardSeconds,
    turnSegment,
    turnFraction,
    outcome,
    returnCreepSegments: returnCreep,
    topSpeed: round(top / scale),
    totalSeconds,
    forwardExitSpeeds,
  };
};

/**
 * The saved `travelSeconds` of a shuttle: the outbound seconds per segment (what the inspector's speed strip reads),
 * with a nominal cruise time on every segment the train never rides out (the station behind it, past the turnaround,
 * the last piece), so the save's "positive time per piece" rule holds. The train's timeline comes from
 * `shuttleProfile`, not from these.
 */
export const shuttleTravelSeconds = (profile: ShuttleProfile): number[] => {
  const nominal = 1 / GAME_CONFIG.coaster.speed.cruise;
  return profile.forwardSeconds.map((value) => (value > 0 ? value : nominal));
};

const PROFILE_CACHE = new WeakMap<readonly CoasterPiece[], { count: number; launch: number | undefined; profile: ShuttleProfile }>();

/** `shuttleProfile`, cached per pieces array (a built coaster's layout never changes in place; the count and launch are re-checked). */
export const shuttleProfileFor = (pieces: readonly CoasterPiece[]): ShuttleProfile => {
  const cached = PROFILE_CACHE.get(pieces);
  const launch = pieces[0]?.launchSpeed;
  if (cached && cached.count === pieces.length && cached.launch === launch) return cached.profile;
  const profile = shuttleProfile(pieces);
  PROFILE_CACHE.set(pieces, { count: pieces.length, launch, profile });
  return profile;
};

/**
 * Fractional piece index of the shuttle train's lead car `elapsed` seconds after it left the station (loading not
 * included), on a timeline `scale` times the profile's own (the saved duration over the profile's, so a park saved
 * under other numbers still ends its cycle parked). Out to the turnaround, then back; parked before and after.
 */
export const shuttleHeadIndex = (pieces: readonly CoasterPiece[], elapsed: number, scale = 1): number => {
  const profile = shuttleProfileFor(pieces);
  const parked = Math.min(GAME_CONFIG.coaster.stationLength - 1, Math.max(0, pieces.length - 2));
  if (!(elapsed > 0) || !(scale > 0)) return parked;
  let remaining = elapsed / scale;
  const turn = profile.turnSegment;
  for (let segment = parked; segment <= turn; segment += 1) {
    const seconds = profile.forwardSeconds[segment];
    const share = segment === turn ? profile.turnFraction : 1;
    if (seconds <= 0) continue;
    if (remaining < seconds) return segment + share * (remaining / seconds);
    remaining -= seconds;
  }
  for (let segment = turn; segment >= parked; segment -= 1) {
    const seconds = profile.backwardSeconds[segment];
    const share = segment === turn ? profile.turnFraction : 1;
    if (seconds <= 0) continue;
    if (remaining < seconds) return segment + share * (1 - remaining / seconds);
    remaining -= seconds;
  }
  return parked;
};
