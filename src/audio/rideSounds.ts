import type { ParkSession } from '../game/session/ParkSession';
import type { CoasterPiece } from '../game/coaster/design';
import type { ViewInfo } from '../rendering/RendererPort';
import type { Emitter, EmitterLoopId } from './AudioEngine';
import type { SoundId } from './synth';
import { GAME_CONFIG } from '../game/config';
import { centreLineFor, centreLineIndexToDistance, createCentreLineSample, sampleCentreLine } from '../game/coaster/centreLine';
import { isShuttleLayout } from '../game/coaster/shuttle';
import { coasterHeadIndex } from '../rendering/coasterTrain';
import { objectPoint, panFor, proximity } from './audioDirector';

/**
 * The rides' and the scenery's positional sounds, read from the live maps a few times a second (presentation only:
 * nothing is written back). Two outputs:
 *
 * - Loops (`Emitter`s for AudioEngine.setEmitters): a coaster train rolls where the train is (louder the faster it
 *   goes) and rattles its chain on a chained climb; the Bumble Coach puffs steam and Temple Trek's carts run an engine
 *   while they run; every other running ride hums its motor; a Ripple Fountain splashes. Paused: only fountains.
 * - One-shots (`play`): a shuttle's station launch (and its riders' scream), a boost or launch piece, the scream over
 *   a circuit's highest crest when it drops at least MIN_SCREAM_DROP levels, and the Bumble Coach's whistle-puff as it
 *   leaves.
 *
 * The train's place comes from the same timing the renderers draw (`coasterHeadIndex`), its speed from how far it
 * moved since the last look. Every level is the proximity to the middle of the screen (audioDirector), so a ride on
 * the other side of the map is not heard.
 */

/** A circuit's riders scream over its highest crest when the drop after it is at least this many levels. */
export const MIN_SCREAM_DROP = 2;
/** Cells a second at which a rolling train is at full level. */
export const FULL_ROLL_SPEED = 8;

/** The loop each non-coaster ride plays while it runs (the rest hum a motor). */
const RIDE_LOOP: ReadonlyMap<string, EmitterLoopId> = new Map([['bumble-coach', 'steam'], ['temple-trek', 'engine']]);
const LOOP_LEVEL: Readonly<Record<EmitterLoopId, number>> = { roll: 0.9, chain: 0.8, motor: 0.45, engine: 0.6, steam: 0.6, fountain: 0.5 };
const LOOP_SLOT: Readonly<Record<EmitterLoopId, number>> = { roll: 0, chain: 1, motor: 2, engine: 2, steam: 2, fountain: 3 };

interface TrainMark {
  head: number;
  moving: boolean;
  running: boolean;
  screamed: boolean;
  x: number;
  y: number;
  tick: number;
  speed: number;
  seen: number;
}

interface Crest {
  /** The highest piece's index, and the drop from it to the lowest piece after it (levels). */
  readonly top: number;
  readonly drop: number;
}

const crests = new WeakMap<readonly CoasterPiece[], Crest>();

/** A circuit's highest crest (cached per piece list). */
export const crestOf = (pieces: readonly CoasterPiece[]): Crest => {
  let crest = crests.get(pieces);
  if (crest !== undefined) return crest;
  let top = 0;
  for (let i = 1; i < pieces.length; i += 1) if (pieces[i].height > pieces[top].height) top = i;
  let lowest = pieces[top]?.height ?? 0;
  for (let i = top + 1; i < pieces.length; i += 1) lowest = Math.min(lowest, pieces[i].height);
  crest = { top, drop: (pieces[top]?.height ?? 0) - lowest };
  crests.set(pieces, crest);
  return crest;
};

export type PlaySound = (sound: SoundId, gain: number, pan: number) => void;

export class RideSounds {
  private readonly emitters: Emitter[] = [];
  private readonly pool: Emitter[] = [];
  private readonly trains = new Map<number, TrainMark>();
  private readonly sample = createCentreLineSample();
  private readonly point = { x: 0, y: 0 };
  private looks = 0;

  /** A new park, a load or a rewind: nothing that was moving is "just launched". */
  reset(): void {
    this.trains.clear();
  }

  /** The loops to play now (a reused array) after playing this look's one-shots through `play`. */
  update(session: ParkSession, view: Readonly<ViewInfo>, paused: boolean, play: PlaySound): Emitter[] {
    this.looks += 1;
    const emitters = this.emitters;
    emitters.length = 0;
    const world = session.world;
    const point = this.point;
    for (const ride of session.rides.rides.values()) {
      const record = world.coasters.get(ride.objectId);
      const running = ride.status === 'running';
      if (record !== undefined) {
        this.coaster(session, view, paused, play, ride.objectId, record, running ? ride.cycleRemainingSeconds : null);
        continue;
      }
      const mark = this.mark(ride.objectId, world.tick);
      const started = running && !mark.running;
      mark.running = running;
      if (!running || paused || !objectPoint(session, ride.objectId, point)) continue;
      const level = proximity(view, point.x, point.y);
      if (level === 0) continue;
      const pan = panFor(view, point.x, point.y);
      const definitionId = world.objects.get(ride.objectId)?.definitionId ?? '';
      if (started && definitionId === 'bumble-coach') play('puff', level, pan);
      this.emit(ride.objectId, RIDE_LOOP.get(definitionId) ?? 'motor', level, pan);
    }
    for (const object of world.objects.values()) {
      if (object.definitionId !== 'ripple-fountain' || !objectPoint(session, object.id, point)) continue;
      const level = proximity(view, point.x, point.y);
      if (level > 0) this.emit(object.id, 'fountain', level, panFor(view, point.x, point.y));
    }
    for (const [id, mark] of this.trains) if (mark.seen !== this.looks) this.trains.delete(id);
    return emitters;
  }

  private coaster(
    session: ParkSession,
    view: Readonly<ViewInfo>,
    paused: boolean,
    play: PlaySound,
    objectId: number,
    record: { readonly pieces: readonly CoasterPiece[]; readonly stats: { readonly durationSeconds: number; readonly travelSeconds: readonly number[] } },
    cycleRemainingSeconds: number | null,
  ): void {
    const tick = session.world.tick;
    const mark = this.mark(objectId, tick);
    const head = coasterHeadIndex(record, cycleRemainingSeconds);
    const moving = cycleRemainingSeconds !== null
      && record.stats.durationSeconds - cycleRemainingSeconds > GAME_CONFIG.coaster.stationLoadSeconds;
    const line = centreLineFor(record.pieces);
    const sample = sampleCentreLine(line, centreLineIndexToDistance(line, head), this.sample);
    const seconds = ((tick - mark.tick) * GAME_CONFIG.fixedStepMs) / 1_000;
    if (seconds > 0) mark.speed = moving && mark.moving && Number.isFinite(mark.head) ? Math.hypot(sample.x - mark.x, sample.y - mark.y) / seconds : 0;
    const level = proximity(view, sample.x, sample.y);
    const pan = panFor(view, sample.x, sample.y);
    const shuttle = isShuttleLayout(record.pieces);
    const n = record.pieces.length;
    if (moving && !mark.moving) mark.screamed = false;
    if (moving && level > 0) {
      if (shuttle && !mark.moving) {
        play('launch', level, pan);
        play('scream', level, pan);
      } else if (!shuttle && mark.moving && head > mark.head) {
        // Every piece the train entered since the last look (the index is unwrapped within a cycle).
        for (let index = Math.floor(mark.head) + 1; index <= Math.floor(head); index += 1) {
          const special = record.pieces[index % n]?.special;
          if (special === 'launch') play('launch', level, pan);
          else if (special === 'boost') play('boost', level, pan);
        }
        const crest = crestOf(record.pieces);
        const parked = GAME_CONFIG.coaster.stationLength - 1;
        const top = crest.top < parked ? crest.top + n : crest.top;
        if (!mark.screamed && crest.drop >= MIN_SCREAM_DROP && mark.head < top && head >= top) {
          mark.screamed = true;
          play('scream', level, pan);
        }
      }
    }
    if (moving && !paused && level > 0) {
      this.emit(objectId, 'roll', level * Math.min(1, 0.3 + mark.speed / FULL_ROLL_SPEED), pan);
      const segment = ((Math.floor(head) % line.pieceCount) + line.pieceCount) % line.pieceCount;
      if (line.chained[segment] === 1) this.emit(objectId, 'chain', level, pan);
    }
    mark.head = head;
    mark.moving = moving;
    mark.running = cycleRemainingSeconds !== null;
    mark.x = sample.x;
    mark.y = sample.y;
    mark.tick = tick;
  }

  private mark(objectId: number, tick: number): TrainMark {
    let mark = this.trains.get(objectId);
    if (mark === undefined) {
      // First seen: as if it was already doing what it does (and with no head to compare), so a load does not launch
      // every train at once.
      mark = { head: Number.NaN, moving: true, running: true, screamed: true, x: 0, y: 0, tick, speed: 0, seen: this.looks };
      this.trains.set(objectId, mark);
    }
    mark.seen = this.looks;
    return mark;
  }

  private emit(objectId: number, loop: EmitterLoopId, level: number, pan: number): void {
    const index = this.emitters.length;
    let emitter = this.pool[index];
    if (emitter === undefined) {
      emitter = { key: 0, loop, gain: 0, pan: 0 };
      this.pool.push(emitter);
    }
    emitter.key = objectId * 4 + LOOP_SLOT[loop];
    emitter.loop = loop;
    emitter.gain = level * LOOP_LEVEL[loop];
    emitter.pan = pan;
    this.emitters.push(emitter);
  }
}
