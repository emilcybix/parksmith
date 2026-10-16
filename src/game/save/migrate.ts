import { TOUR_NODE_BY_ID } from '../tour/content';
import { hashState } from './hash';
import { PlainDataError, assertPlainData } from './plainData';
import { isGameMode } from '../modes/types';
import { SAVE_SCHEMA_VERSION, SaveError, type ParkSave } from './version';

/**
 * The migration chain and the load-side envelope checks (Phase 34: split out of `version.ts`).
 *
 * Only reading a stored save needs this module: the lazily imported load path (`app/saves/loadSave.ts`, through
 * `session/fromSave.ts`) and tests. Writing a save, the live session and snapshot undo use `version.ts` alone, so the
 * chain stays out of the main chunk (pinned by `src/app/bundleSplit.static.test.ts`). Behaviour is unchanged: the code
 * below moved verbatim.
 */

type PlainRecord = Record<string, unknown>;

/**
 * One step of the chain. `migrate` receives a private deep copy of an envelope at version `from`
 * and returns an envelope at version `to` (always from + 1, so the chain has no gaps to reason
 * about). It must not rely on the current simulation code: a migration is a frozen description of
 * how an old shape maps to the next one.
 */
export interface SaveMigration {
  from: number;
  to: number;
  description: string;
  migrate(save: PlainRecord): PlainRecord;
}

/**
 * Ordered, contiguous migrations from the oldest supported schema up to SAVE_SCHEMA_VERSION - 1.
 * Each is appended together with its fixture save (src/game/save/fixtures).
 */
export const SAVE_MIGRATIONS: readonly SaveMigration[] = [
  {
    from: 1,
    to: 2,
    description: 'add the First Day onboarding state',
    // A frozen literal on purpose: no import from the live code. An existing Sandbox park comes
    // over with its hints already dismissed, so a park in progress never gets a tutorial sprung on
    // it; a scenario park has no onboarding.
    migrate: (save) => {
      const state = save.state as PlainRecord;
      return {
        ...save,
        schemaVersion: 2,
        state: {
          ...state,
          onboarding: state.scenarioId === null
            ? { dismissed: true, completed: [], skipped: [], sawLitter: false }
            : null,
        },
      };
    },
  },
  {
    from: 2,
    to: 3,
    description: 'add the park calendar',
    // A frozen literal on purpose. With the anchor at tick 0 and the default length (720 s), an old
    // park's day and time are simply its age in ticks, the same pure function a new park gets, so
    // nothing jumps and no old park needs special casing.
    migrate: (save) => ({
      ...save,
      schemaVersion: 3,
      state: {
        ...(save.state as PlainRecord),
        calendar: { dayLengthSeconds: 720, anchorTick: 0, anchorUnits: 0, timeLock: 'auto' },
      },
    }),
  },
  {
    from: 3,
    to: 4,
    description: 'add weather, opening hours and the wet weather rule',
    // A frozen literal on purpose, with a frozen copy of the seed mixer (a test asserts it equals the
    // live one). An old park gets weather ON at normal severity, hours OFF, and no drawn days: the
    // restore draws them from the park's own seed at the park's own day, so the forecast is
    // deterministic with no special case. It continues under a new balance (the arrival curve and
    // the weather), which the content version reports as "older"; there is no calm period.
    migrate: (save) => {
      const state = save.state as PlainRecord;
      const mixSeed = (seed: number): number => {
        let hash = (seed ^ 0x9e3779b9) >>> 0;
        hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
        hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
        hash ^= hash >>> 16;
        return hash >>> 0;
      };
      return {
        ...save,
        schemaVersion: 4,
        state: {
          ...state,
          rules: { ...(state.rules as PlainRecord), wetWeatherMultiplier: 1 },
          calendar: { ...(state.calendar as PlainRecord), hoursEnabled: false, openHour: 8, closeHour: 21 },
          weather: {
            enabled: true,
            severity: 'normal',
            rngState: mixSeed(state.seed as number),
            chainKind: 'sunny',
            firstDay: 1,
            days: [],
          },
        },
      };
    },
  },
  {
    from: 4,
    to: 5,
    description: 'lift hills: every old coaster piece is chained; add the chain-lift cost rule',
    // A frozen literal on purpose. Before schema 5 every climbing piece was hauled by a chain, so
    // every old piece stays chained (no `freeClimb` key; a hand-edited one is dropped) and the saved
    // stats, which already contain the chain, are left exactly as they are. The cost rule defaults to 1.
    migrate: (save) => {
      const state = save.state as PlainRecord;
      const world = state.world as PlainRecord;
      const coasters = Array.isArray(world.coasters) ? world.coasters as PlainRecord[] : world.coasters;
      return {
        ...save,
        schemaVersion: 5,
        state: {
          ...state,
          rules: { ...(state.rules as PlainRecord), chainLiftCostMultiplier: 1 },
          world: {
            ...world,
            coasters: Array.isArray(coasters)
              ? coasters.map((record) => (Array.isArray(record.pieces)
                ? {
                  ...record,
                  pieces: (record.pieces as PlainRecord[]).map((piece) => {
                    const chained = { ...piece };
                    delete chained.freeClimb;
                    return chained;
                  }),
                }
                : record))
              : coasters,
          },
        },
      };
    },
  },
  {
    from: 5,
    to: 6,
    description: 'colour customisation: no placed object has colours yet',
    // A frozen literal on purpose. Schema 6 adds an optional `colours` record to placed objects;
    // every old object keeps the default colours (no record), so an uncoloured park is byte for byte
    // the same state as before and keeps its state hash. A v5 save cannot legitimately carry colours,
    // so a hand-edited `colours` key is dropped, like 4->5 dropped `freeClimb`.
    migrate: (save) => {
      const state = save.state as PlainRecord;
      const world = state.world as PlainRecord;
      const objects = world.objects;
      return {
        ...save,
        schemaVersion: 6,
        state: {
          ...state,
          world: {
            ...world,
            objects: Array.isArray(objects)
              ? (objects as unknown[]).map((object) => {
                if (typeof object !== 'object' || object === null || Array.isArray(object)) return object;
                const plain = { ...(object as PlainRecord) };
                delete plain.colours;
                return plain;
              })
              : objects,
          },
        },
      };
    },
  },
  {
    from: 6,
    to: 7,
    description: 'colour customisation step 2: the gate colours and the recolour cost rule',
    // A frozen literal on purpose. Schema 7 adds the park-level `world.gateColours` record (an old park's
    // gate keeps its default colours: no record, so an uncoloured park hashes as before apart from the
    // new rule) and `rules.recolourCostMultiplier` (1: recolouring costs the default). A v6 save cannot
    // legitimately carry gate colours, so a hand-edited `gateColours` key is dropped, like 5->6 dropped
    // `colours`. Colour records on objects are kept as they are: restore normalises them against the
    // (larger) slot tables, which may now include coasters, stalls and scenery.
    migrate: (save) => {
      const state = save.state as PlainRecord;
      const world = isRecord(state.world) ? { ...state.world } : state.world;
      if (isRecord(world)) delete world.gateColours;
      return {
        ...save,
        schemaVersion: 7,
        state: {
          ...state,
          rules: isRecord(state.rules) ? { ...state.rules, recolourCostMultiplier: 1 } : state.rules,
          world,
        },
      };
    },
  },
  {
    from: 7,
    to: 8,
    description: 'biomes and maps: every old park is on the Meadow map',
    // A frozen literal on purpose (the ONE allowed entrance literal outside the Meadow map data; `frozen: schema 7
    // entrance`): before schema 8 every park was the 32 x 32 Meadow with the gate at (15, 31) facing north, no
    // props and all base ground. The state gains `map` (appended last, like every new top-level key); the world, the
    // rules (an absent biome rule key reads as 1) and every owner are untouched, so the park continues exactly as
    // it was. A v7 save cannot legitimately carry a map or the biome rule keys, so hand-edited ones are dropped.
    migrate: (save) => {
      const state = save.state as PlainRecord;
      const rules = isRecord(state.rules) ? { ...state.rules } : state.rules;
      if (isRecord(rules)) {
        delete rules.hungerRateMultiplier;
        delete rules.thirstRateMultiplier;
      }
      const { map: _dropped, ...withoutMap } = state;
      void _dropped;
      return {
        ...save,
        schemaVersion: 8,
        state: {
          ...withoutMap,
          rules,
          map: {
            id: 'meadow',
            biomeId: 'meadow',
            width: 32,
            height: 32,
            entrance: { x: 15, y: 31, facing: 'north' }, // frozen: schema 7 entrance
            ground: Array.from({ length: 32 }, () => '................................'),
            props: [],
          },
        },
      };
    },
  },
  {
    from: 8,
    to: 9,
    description: 'generated maps: the map gains a recipe (null for every hand-made map)',
    // Every v8 park was on a hand-made map, so its recipe is null. A v8 save cannot legitimately carry a recipe, so a
    // hand-edited `recipe` key is dropped before null is written (last key inside `map`). Nothing else changes.
    migrate: (save) => {
      const state = save.state as PlainRecord;
      const map = isRecord(state.map) ? { ...state.map } : state.map;
      if (isRecord(map)) {
        delete map.recipe;
        map.recipe = null;
      }
      return { ...save, schemaVersion: 9, state: { ...state, map } };
    },
  },
  {
    from: 9,
    to: 10,
    description: 'game modes: every old park is a Sandbox or a Scenario by its scenarioId, with an empty profile grant',
    // A frozen literal on purpose (no import from the live code): before schema 10 there was no mode and no profile
    // grant, so a park is `sandbox` when it has no scenario and `scenario` otherwise (a Park Tour park too: the app
    // keeps the tour node itself), and its grant is empty (no unlocked buildings, no bonuses; the compiled rules
    // already say what the park played under). A v9 save cannot legitimately carry a mode or a grant, so hand-edited
    // ones are dropped (state and header) before the real values are written last. The rules need nothing: the two
    // bonus-layer keys are absent, which reads as none.
    migrate: (save) => {
      const state = save.state as PlainRecord;
      const { mode: _stateMode, grant: _stateGrant, ...rest } = state;
      void _stateMode;
      void _stateGrant;
      const { mode: _headerMode, ...header } = save;
      void _headerMode;
      const mode = rest.scenarioId === null ? 'sandbox' : 'scenario';
      return {
        ...header,
        schemaVersion: 10,
        mode,
        state: { ...rest, mode, grant: { unlockedBuildingIds: [], bonusIds: [] } },
      };
    },
  },
  {
    from: 10,
    to: 11,
    description: 'The Map (runs): the state may carry a run (mode run only); interim Park Tour run parks become Scenario parks',
    // A frozen literal on purpose (no import from the live code). A v10 save cannot legitimately carry a run, so a
    // hand-edited `run` key is dropped. Schema 10 had a `run` MODE only as the interim The Map (the Park Tour): those parks
    // played a hand-made scenario with no run state, so they continue as Scenario parks (header and state); every bonus
    // that applies in `run` also applies in `scenario`, so the grant and the compiled rules stay valid as they are.
    migrate: (save) => {
      const state = save.state as PlainRecord;
      const { run: _run, ...rest } = state;
      void _run;
      const mode = rest.mode === 'run' ? 'scenario' : rest.mode;
      return {
        ...save,
        schemaVersion: 11,
        mode: save.mode === 'run' ? 'scenario' : save.mode,
        state: { ...rest, mode },
      };
    },
  },
  {
    from: 11,
    to: 12,
    description: 'Card pool: the one-shot ledger in run parks; run format 2',
    // A frozen literal on purpose (no import from the live code). A v11 save cannot carry a one-shot ledger, so a
    // hand-edited `plays` key is dropped. Sandbox and Scenario states are otherwise untouched (byte for byte). A run park
    // gets an empty ledger (written before `run`, which stays last) and its run becomes format 2: the plan key
    // `unplayedOneShots` (the shipped 'return', after `offerRule`) and, per finished level, no plays and no debt
    // (schema 11 had no one-shot cards). A run that is not an object, or a history that is not an array, is kept as it
    // is for the run reader to refuse.
    migrate: (save) => {
      const state = save.state as PlainRecord;
      const { plays: _plays, ...rest } = state;
      void _plays;
      if (rest.mode !== 'run' || !isRecord(rest.run)) return { ...save, schemaVersion: 12, state: rest };
      const { run, ...others } = rest;
      const source = run as PlainRecord;
      const migratedRun: PlainRecord = {};
      for (const [key, value] of Object.entries(source)) {
        if (key === 'unplayedOneShots') continue;
        if (key === 'version') migratedRun.version = 2;
        else if (key === 'history') {
          migratedRun.history = Array.isArray(value)
            ? value.map((entry) => (isRecord(entry) ? { ...entry, playedCardIds: [], unpaidDebt: 0 } : entry))
            : value;
        } else migratedRun[key] = value;
        if (key === 'offerRule') migratedRun.unplayedOneShots = 'return';
      }
      if (!Object.hasOwn(migratedRun, 'unplayedOneShots')) migratedRun.unplayedOneShots = 'return';
      return { ...save, schemaVersion: 12, state: { ...others, plays: { played: [], pending: [] }, run: migratedRun } };
    },
  },
  {
    from: 12,
    to: 13,
    description: 'Neighborhoods & Crowd Flow: the optional crowd field (feedback parks only)',
    // A frozen literal on purpose (no import from the live code). The identity: a schema-12 park has no
    // `rules.crowdFeedback`, so it never gains congestion feedback and carries no `crowd` field; its state is kept byte
    // for byte. A hand-edited `crowd` key or `rules.crowdFeedback` is dropped: a schema-12 build ignored both, so the
    // park played without feedback, and dropping them keeps it exactly that park.
    migrate: (save) => {
      const state = save.state as PlainRecord;
      const handEditedRules = isRecord(state.rules) && Object.hasOwn(state.rules, 'crowdFeedback');
      if (!Object.hasOwn(state, 'crowd') && !handEditedRules) return { ...save, schemaVersion: 13 };
      const { crowd: _crowd, ...rest } = state;
      void _crowd;
      if (handEditedRules) {
        const { crowdFeedback: _feedback, ...rules } = state.rules as PlainRecord;
        void _feedback;
        rest.rules = rules;
      }
      return { ...save, schemaVersion: 13, state: rest };
    },
  },
  {
    from: 13,
    to: 14,
    description: 'Land Expansion: owned land, the land price rule, the land finance category and the parcel metric',
    // A frozen literal on purpose (no import from the live code). The identity: a schema-13 park is wholly owned (its
    // map is 32 x 32 with no owned set), has no land price rule, never bought land and has no parcel metric, so its
    // state is kept byte for byte. Hand-edited Phase 21 keys a schema-13 build ignored (`world.land`,
    // `rules.landCostMultiplier`, `scenario.latestMetrics.ownedParcels`) are dropped, which keeps it exactly that park.
    migrate: (save) => {
      const state = save.state as PlainRecord;
      const world = isRecord(state.world) ? state.world : null;
      const rules = isRecord(state.rules) ? state.rules : null;
      const scenario = isRecord(state.scenario) ? state.scenario : null;
      const metrics = scenario !== null && isRecord(scenario.latestMetrics) ? scenario.latestMetrics : null;
      const editedWorld = world !== null && Object.hasOwn(world, 'land');
      const editedRules = rules !== null && Object.hasOwn(rules, 'landCostMultiplier');
      const editedMetrics = metrics !== null && Object.hasOwn(metrics, 'ownedParcels');
      if (!editedWorld && !editedRules && !editedMetrics) return { ...save, schemaVersion: 14 };
      const rest: PlainRecord = { ...state };
      if (editedWorld) {
        const { land: _land, ...kept } = world as PlainRecord;
        void _land;
        rest.world = kept;
      }
      if (editedRules) {
        const { landCostMultiplier: _multiplier, ...kept } = rules as PlainRecord;
        void _multiplier;
        rest.rules = kept;
      }
      if (editedMetrics) {
        const { ownedParcels: _parcels, ...kept } = metrics as PlainRecord;
        void _parcels;
        rest.scenario = { ...(scenario as PlainRecord), latestMetrics: kept };
      }
      return { ...save, schemaVersion: 14, state: rest };
    },
  },
  {
    from: 14,
    to: 15,
    description: 'Guest life & souvenirs: nausea, warmth, souvenirs and the activity on every guest',
    // A frozen literal on purpose (no import from the live code): every schema-14 guest arrives settled, comfortable,
    // empty-handed and doing nothing special (0 / 50 / 0 / null). Nothing else changes: litter piles and management
    // totals gain only optional keys, which a schema-14 park never carries.
    migrate: (save) => {
      const state = save.state as PlainRecord;
      const guests = isRecord(state.guests) ? state.guests : null;
      if (guests === null || !Array.isArray(guests.guests)) return { ...save, schemaVersion: 15 };
      const migratedGuests = guests.guests.map((guest: unknown) => (
        isRecord(guest) ? { ...guest, nausea: 0, warmth: 50, souvenirs: 0, activity: null } : guest
      ));
      return { ...save, schemaVersion: 15, state: { ...state, guests: { ...guests, guests: migratedGuests } } };
    },
  },
  {
    from: 15,
    to: 16,
    description: 'Building fronts: the optional front-access rule (a schema-15 park keeps every side)',
    // A schema-15 park never had front-only access: a hand-edited `rules.frontAccess` (which a schema-15 build
    // ignored) is dropped, so the park plays as it did. Nothing else changes.
    migrate: (save) => {
      const state = save.state as PlainRecord;
      if (!isRecord(state.rules) || !Object.hasOwn(state.rules, 'frontAccess')) return { ...save, schemaVersion: 16 };
      const { frontAccess: _front, ...rules } = state.rules as PlainRecord;
      void _front;
      return { ...save, schemaVersion: 16, state: { ...state, rules } };
    },
  },
  {
    from: 16,
    to: 17,
    description: 'Shuttle coasters: the optional launch speed on a coaster\'s first piece (a schema-16 park has none)',
    // A schema-16 park has no shuttle: a hand-edited `launchSpeed` on a piece (which a schema-16 build ignored) is
    // dropped, so every coaster runs as it did. Nothing else changes.
    migrate: (save) => {
      const state = save.state as PlainRecord;
      if (!Array.isArray(state.coasters)) return { ...save, schemaVersion: 17 };
      let changed = false;
      const coasters = state.coasters.map((record: unknown) => {
        if (!isRecord(record) || !Array.isArray(record.pieces)) return record;
        if (!record.pieces.some((piece: unknown) => isRecord(piece) && Object.hasOwn(piece, 'launchSpeed'))) return record;
        changed = true;
        const pieces = record.pieces.map((piece: unknown) => {
          if (!isRecord(piece) || !Object.hasOwn(piece, 'launchSpeed')) return piece;
          const { launchSpeed: _launch, ...rest } = piece;
          void _launch;
          return rest;
        });
        return { ...record, pieces };
      });
      return changed ? { ...save, schemaVersion: 17, state: { ...state, coasters } } : { ...save, schemaVersion: 17 };
    },
  },
];

export interface MigrateOptions {
  migrations?: readonly SaveMigration[];
  latestVersion?: number;
}

const isRecord = (value: unknown): value is PlainRecord => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

/** Verifies a migration list is contiguous, ascending, steps by one and ends below `latestVersion`. */
export const assertMigrationChain = (
  migrations: readonly SaveMigration[],
  latestVersion: number = SAVE_SCHEMA_VERSION,
): void => {
  let expectedFrom: number | null = null;
  for (const migration of migrations) {
    if (migration.to !== migration.from + 1) {
      throw new Error(`Migration ${migration.from}->${migration.to} must step by exactly one version`);
    }
    if (expectedFrom !== null && migration.from !== expectedFrom) {
      throw new Error(`Migration chain has a gap or overlap: expected from ${expectedFrom}, got ${migration.from}`);
    }
    expectedFrom = migration.to;
  }
  if (expectedFrom !== null && expectedFrom !== latestVersion) {
    throw new Error(`Migration chain ends at ${expectedFrom} but the latest schema is ${latestVersion}`);
  }
};

/**
 * The one text entry point (a file the player picked, a clipboard paste): JSON.parse failures
 * become a SaveError('corrupt') instead of a raw SyntaxError the caller has to know to catch.
 */
export const parseSaveText = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new SaveError(
      'corrupt',
      `The save is not readable (${error instanceof Error ? error.message : 'invalid JSON'}); the file may be cut short or edited.`,
      { cause: error },
    );
  }
};

/** First schema whose envelope carries `stateHash`. Every schema since then must. */
const FIRST_CHECKSUMMED_SCHEMA = 1;

const corrupt = (problem: string): never => {
  throw new SaveError('corrupt', `The save envelope is invalid: ${problem}.`);
};

/**
 * Header and app checks that need no simulation: the values the caller hands straight to the
 * clock and the tour, plus the header fields that must agree with the state they describe.
 */
const validateEnvelope = (save: PlainRecord): void => {
  const state = save.state as PlainRecord;
  if (typeof save.contentVersion !== 'number' || !Number.isInteger(save.contentVersion) || save.contentVersion < 1) {
    corrupt('contentVersion is not a positive integer');
  }
  if (typeof save.savedAtEpochMs !== 'number' || !Number.isFinite(save.savedAtEpochMs) || save.savedAtEpochMs < 0) {
    corrupt('savedAtEpochMs is not a finite non-negative number');
  }
  const world = state.world;
  if (isRecord(world) && save.savedAtTick !== world.tick) corrupt('savedAtTick differs from the state\'s world tick');
  if (typeof save.savedAtTick !== 'number' || !Number.isInteger(save.savedAtTick) || save.savedAtTick < 0) {
    corrupt('savedAtTick is not a non-negative integer');
  }
  if (save.scenarioId !== (state.scenarioId ?? null)) corrupt('scenarioId differs from the state\'s scenarioId');
  // Schema 10 and later carry the mode in the header too (a migration stopped below 10 by a test does not).
  if (typeof save.schemaVersion === 'number' && save.schemaVersion >= 10) {
    if (!isGameMode(save.mode)) corrupt('mode is not sandbox, scenario or run');
    if (save.mode !== state.mode) corrupt('mode differs from the state\'s mode');
  }
  // Schema 11 (The Map): a run state exists exactly in mode `run`.
  if (typeof save.schemaVersion === 'number' && save.schemaVersion >= 11 && Object.hasOwn(state, 'run') !== (state.mode === 'run')) {
    corrupt('the run state must exist exactly in mode run');
  }
  // Schema 12 (Phase 25): so does the one-shot ledger.
  if (typeof save.schemaVersion === 'number' && save.schemaVersion >= 12 && Object.hasOwn(state, 'plays') !== (state.mode === 'run')) {
    corrupt('the one-shot ledger (plays) must exist exactly in mode run');
  }
  // Schema 13 (Phase 14): the crowd field exists exactly when the ruleset has congestion feedback (an explicit 0 is off).
  if (typeof save.schemaVersion === 'number' && save.schemaVersion >= 13) {
    const feedback = isRecord(state.rules) ? state.rules.crowdFeedback : undefined;
    if (Object.hasOwn(state, 'crowd') !== (feedback !== undefined && feedback !== 0)) {
      corrupt('the crowd field must exist exactly when rules.crowdFeedback does');
    }
  }
  const app = save.app as PlainRecord;
  const clock = app.clock;
  if (!isRecord(clock)) return corrupt('app.clock is missing');
  const speed = clock.speed;
  if (speed !== 0 && speed !== 1 && speed !== 2 && speed !== 4) corrupt('app.clock.speed is not 0, 1, 2 or 4');
  if (typeof clock.simulationTimeMs !== 'number' || !Number.isInteger(clock.simulationTimeMs) || clock.simulationTimeMs < 0) {
    corrupt('app.clock.simulationTimeMs is not a non-negative integer');
  }
  const tour = app.tourNodeId;
  if (tour !== null && (typeof tour !== 'string' || !TOUR_NODE_BY_ID.has(tour as never))) {
    corrupt('app.tourNodeId is not null or a known Park Tour node');
  }
  const view = app.viewRotation;
  if (view !== undefined && view !== 0 && view !== 1 && view !== 2 && view !== 3) {
    corrupt('app.viewRotation is not 0, 1, 2 or 3');
  }
};

const assertSavePlain = (value: unknown, root: string): void => {
  try {
    assertPlainData(value, root);
  } catch (error) {
    if (error instanceof PlainDataError) throw new SaveError('corrupt', `The save is not plain data: ${error.message}`, { cause: error });
    throw error;
  }
};

/** Reads only the version of a raw stored value, for slot lists and pre-flight checks. */
export const readSchemaVersion = (raw: unknown): number => {
  if (!isRecord(raw)) throw new SaveError('not-a-save', 'The stored value is not a save (not an object).');
  const version = raw.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new SaveError('not-a-save', 'The stored value has no valid integer schemaVersion.');
  }
  return version;
};

/**
 * Brings any readable stored save to the latest envelope shape. Never mutates its input. The
 * result still has to pass the owners' own restore validation; this only guarantees the version,
 * the plain-data rule and the envelope's top-level keys.
 */
export const migrateSave = (raw: unknown, options: MigrateOptions = {}): ParkSave => {
  const migrations = options.migrations ?? SAVE_MIGRATIONS;
  const latestVersion = options.latestVersion ?? SAVE_SCHEMA_VERSION;
  const version = readSchemaVersion(raw);
  if (version > latestVersion) {
    throw new SaveError(
      'too-new',
      `This save was written by a newer version of the game (schema ${version}, this build reads up to ${latestVersion}).`,
    );
  }
  assertSavePlain(raw, '$save');
  let current = JSON.parse(JSON.stringify(raw)) as PlainRecord;
  // Integrity is checked at the version the file was WRITTEN at: the hash covers that shape. After
  // the chain, trusted migration code has produced a new shape and the hash is recomputed.
  if (version >= FIRST_CHECKSUMMED_SCHEMA) {
    if (!isRecord(current.state)) throw new SaveError('corrupt', 'The save envelope is missing savedAtTick, app or state.');
    if (typeof current.stateHash !== 'string') throw new SaveError('corrupt', 'The save has no integrity hash (stateHash).');
    let actual: string;
    try {
      actual = hashState(current.state);
    } catch (error) {
      throw new SaveError('corrupt', `The save state cannot be hashed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (actual !== current.stateHash) {
      throw new SaveError('corrupt', 'The save failed its integrity check: part of it was lost or changed after it was written.');
    }
  }
  let currentVersion = version;
  while (currentVersion < latestVersion) {
    const step = migrations.find((migration) => migration.from === currentVersion);
    if (!step) {
      throw new SaveError(
        'no-migration-path',
        `No migration from schema ${currentVersion} toward ${latestVersion}; this save is too old to open.`,
      );
    }
    let next: PlainRecord;
    try {
      next = step.migrate(current);
    } catch (error) {
      throw new SaveError(
        'migration-failed',
        `Migration ${step.from}->${step.to} (${step.description}) failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (!isRecord(next) || next.schemaVersion !== step.to) {
      throw new SaveError(
        'migration-failed',
        `Migration ${step.from}->${step.to} (${step.description}) did not produce schemaVersion ${step.to}.`,
      );
    }
    current = next;
    currentVersion = step.to;
  }
  if (typeof current.savedAtTick !== 'number' || !isRecord(current.state) || !isRecord(current.app)) {
    throw new SaveError('corrupt', 'The save envelope is missing savedAtTick, app or state.');
  }
  if (currentVersion !== version) {
    // A migration is code, and code can emit undefined or NaN: re-prove the plain-data rule on its output.
    assertSavePlain(current, '$migrated');
    current.stateHash = hashState(current.state);
  }
  validateEnvelope(current);
  return current as unknown as ParkSave;
};
