import { GAME_CONFIG } from '../config';
import { BUILD_BY_ID, BUILD_CATALOG } from '../content/catalog';
import { ParkSession } from '../session/ParkSession';
import { createWeatherView } from '../weather/types';
import { RESEARCH_PROJECTS } from '../progression/content';
import { MANAGEMENT_CONFIG } from '../management/ManagementSimulation';
import type { ManagementSnapshot } from '../management/types';
import { hashState } from './hash';
import type { ParkSaveV8 } from './state';

/**
 * Test harness for the determinism proof (Phase 12 hard acceptance criterion).
 *
 * A "run" is: for tick t = 0..total-1, `act(session, t)` (scripted player actions, identical in
 * every run) and then `session.step(fixedStepMs)`. A save point K sits between `act(K)` and
 * `step(K)`: that is where an autosave can fire (after the player's edit and its sync, before the
 * next fixed step), so it exercises the stale-route and uncollected-transaction states a real
 * save meets. The twin that restores from the save continues with `step(K)` and then the normal
 * loop; `act(K)` is never run twice.
 */

export type Act = (session: ParkSession, tick: number) => void;

export interface RunTrace {
  /** Hash of the events a step returned, per tick (progression and scenario event streams). */
  eventHashes: string[];
  /** Cheap per-tick fingerprint, to name the first divergent tick when a checkpoint hash differs. */
  fingerprints: string[];
  /** Full serialized-state hash at each tick in `checkpointTicks`, taken BEFORE that tick's step. */
  checkpointHashes: Map<number, string>;
  /** The serialized state at the same checkpoints (kept to name the first differing path). */
  checkpointStates: Map<number, ParkSaveV8>;
  finalHash: string;
  finalState: ParkSaveV8;
  observables: unknown;
}

export const stepOnce = (session: ParkSession, trace?: Pick<RunTrace, 'eventHashes' | 'fingerprints'>): void => {
  const events = session.step(GAME_CONFIG.fixedStepMs);
  if (!trace) return;
  trace.eventHashes.push(hashState(events));
  trace.fingerprints.push(`${session.world.tick}|${session.world.cash}|${session.guests.guests.size}`);
};

export const emptyTrace = (): RunTrace => ({
  eventHashes: [],
  fingerprints: [],
  checkpointHashes: new Map(),
  checkpointStates: new Map(),
  finalHash: '',
  finalState: undefined as unknown as ParkSaveV8,
  observables: null,
});

/** Walks two plain values and names the first path where they differ (null when equal). */
export const firstDifference = (left: unknown, right: unknown, path = '$'): string | null => {
  if (Object.is(left, right)) return null;
  if (typeof left !== typeof right || left === null || right === null || typeof left !== 'object') {
    return `${path}: ${JSON.stringify(left)?.slice(0, 80)} != ${JSON.stringify(right)?.slice(0, 80)}`;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return `${path}: array vs object`;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return `${path}.length: ${left.length} != ${right.length}`;
    for (let index = 0; index < left.length; index += 1) {
      const found = firstDifference(left[index], right[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
  for (const key of keys) {
    if (!(key in leftRecord) || !(key in rightRecord)) return `${path}.${key}: present on one side only`;
    const found = firstDifference(leftRecord[key], rightRecord[key], `${path}.${key}`);
    if (found) return found;
  }
  return null;
};

/**
 * Fields of the live object graph that are deliberately not part of a save, and so are allowed to
 * differ between a session and its restored twin: derived caches (rebuilt on demand), cache
 * versions, subscriber lists, and the two completed-id Sets whose insertion order
 * is documented as unobservable (ProgressionSimulation.serialize). Everything else must match.
 */
const LIVE_GRAPH_IGNORED_KEYS: ReadonlySet<string> = new Set([
  'listeners', 'cacheVersion', 'navigation', 'destinationWorldVersion', 'rideDestinations', 'serviceDestinations',
  'lastWorldVersion', 'lastPathVersion', 'latestSnapshot', 'sources', 'objectScores', 'buildAccessPolicy',
  'latestOperations', 'latestParkOperations', 'latestScenery', 'connectivityWorldVersion', 'connectivityPathVersion',
  'batchDepth', 'batchedChange', 'connectedObjectIds', 'entranceConnectedPathCount', 'entranceConnectedTip', 'completedExperiences',
  'lockedDefinitionIds', 'completedProjectIds', 'completedMilestoneIds',
  // Phase 49: the operations' running waste tally for the Staff window and Pulse; never saved, a restore starts it at 0.
  'wasteCounts',
  // Phase 28: a transient edit counter for the app's undo stamp; restore bumps it, a never-restored twin does not.
  'appearanceCounter',
  // Phase 29: the guests' bench and landmark lists (derived per world version, dropped on restore) and the bench seat
  // table (rebuilt from the guests at the start of every step).
  'benchDestinations', 'landmarks', 'benchSeats',
  // Phase 24: the prop-set revision for the renderers; a restore bumps it, a never-restored twin does not.
  'propRevisionCounter',
  // Phase 21: the owned-land revision for the renderers; a restore bumps it, a never-restored twin does not.
  'landRevisionCounter',
  // Phase 14: the crowd's path-shape cache (derived per pathVersion, dropped on restore) and the session's crowd
  // presentation memory (displayed bands, heatmap revision, memoised view; never saved, never read by the simulation).
  'shapes', 'crowdDisplay',
]);

/**
 * `world.map` is the immutable layout. A session built from a map definition holds the props at session start,
 * the map's seed and its starting objects; its restored twin holds the saved (remaining) props and no seed.
 * None of that is state (the live props are `world.props`, compared in full), so the layout is compared by
 * identity: id, biome, size, entrance and the ground key.
 */
const layoutIdentity = (layout: { id: unknown; biome: { id: unknown }; width: unknown; height: unknown; entrance: unknown; groundKey: unknown }): unknown => ({
  id: layout.id, biome: layout.biome.id, width: layout.width, height: layout.height, entrance: layout.entrance, groundKey: layout.groundKey,
});
const isLayout = (value: unknown): value is Parameters<typeof layoutIdentity>[0] => (
  typeof value === 'object' && value !== null && 'groundKey' in value && 'biome' in value && 'entrance' in value
);

/**
 * An independent deep comparison of two LIVE object graphs, not of their serialized forms. This is
 * the check the state hash cannot make: if serialize() forgets a field, both the original and the
 * restored twin serialize without it, the hashes agree, and only the live graph shows that the
 * restored field fell back to a default. Maps and Sets compare in iteration order, numbers with
 * Object.is (so 0 vs -0 and NaN are visible), and the first difference is named by path.
 */
export const liveGraphDifference = (
  left: unknown,
  right: unknown,
  path = 'session',
  seen = new WeakMap<object, object>(),
  depth = 0,
): string | null => {
  if (Object.is(left, right)) return null;
  if (typeof left !== typeof right) return `${path}: type ${typeof left} vs ${typeof right}`;
  if (typeof left === 'function') return null;
  if (typeof left !== 'object' || left === null || right === null) return `${path}: ${String(left)} vs ${String(right)}`;
  if (seen.get(left) === right) return null;
  seen.set(left, right as object);
  if (depth > 40) return null;
  const next = (a: unknown, b: unknown, child: string): string | null => liveGraphDifference(a, b, child, seen, depth + 1);
  if (left instanceof Map) {
    if (!(right instanceof Map)) return `${path}: Map vs other`;
    const leftEntries = [...left.entries()];
    const rightEntries = [...right.entries()];
    if (leftEntries.length !== rightEntries.length) return `${path}.size ${leftEntries.length} vs ${rightEntries.length}`;
    for (let index = 0; index < leftEntries.length; index += 1) {
      const key = next(leftEntries[index][0], rightEntries[index][0], `${path}.key[${index}]`);
      if (key) return key;
      const value = next(leftEntries[index][1], rightEntries[index][1], `${path}.get(${String(leftEntries[index][0])})`);
      if (value) return value;
    }
    return null;
  }
  if (left instanceof Set) {
    if (!(right instanceof Set)) return `${path}: Set vs other`;
    const leftItems = [...left];
    const rightItems = [...right];
    if (leftItems.length !== rightItems.length) return `${path}.size ${leftItems.length} vs ${rightItems.length}`;
    for (let index = 0; index < leftItems.length; index += 1) {
      const found = next(leftItems[index], rightItems[index], `${path}.item[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (Array.isArray(left)) {
    if (!Array.isArray(right)) return `${path}: array vs other`;
    if (left.length !== right.length) return `${path}.length ${left.length} vs ${right.length}`;
    for (let index = 0; index < left.length; index += 1) {
      const found = next(left[index], right[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  const leftKeys = Object.keys(left as object).filter((key) => !LIVE_GRAPH_IGNORED_KEYS.has(key)).sort();
  const rightKeys = Object.keys(right as object).filter((key) => !LIVE_GRAPH_IGNORED_KEYS.has(key)).sort();
  if (leftKeys.join() !== rightKeys.join()) {
    return `${path}: keys ${leftKeys.filter((key) => !rightKeys.includes(key))} / ${rightKeys.filter((key) => !leftKeys.includes(key))}`;
  }
  for (const key of leftKeys) {
    let a = (left as Record<string, unknown>)[key];
    let b = (right as Record<string, unknown>)[key];
    if (key === 'map' && isLayout(a) && isLayout(b)) {
      a = layoutIdentity(a);
      b = layoutIdentity(b);
    }
    const found = next(a, b, `${path}.${key}`);
    if (found) return found;
  }
  return null;
};

/** Per-owner hashes, to bisect a mismatch to the owner that diverged first. */
export const ownerHashes = (state: ParkSaveV8): Record<string, string> => {
  const hashes: Record<string, string> = {};
  for (const [key, value] of Object.entries(state)) hashes[key] = hashState(value);
  return hashes;
};

/**
 * Drops what is intentionally NOT part of a save: the scenery snapshot's `version` is the renderer's
 * monotone redraw key (a restore bumps it, which forces the redraw a swapped session needs), so it
 * counts differently in a restored session by design. Recurses through plain data only.
 */
const withoutRenderCacheKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutRenderCacheKeys);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  const isScenerySnapshot = 'sourceCount' in record && 'parkScore' in record && 'version' in record;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (isScenerySnapshot && key === 'version') continue;
    result[key] = withoutRenderCacheKeys(child);
  }
  return result;
};

/**
 * Phase 16 appended 12 catalog entries and 5 research projects (and a `tier` on each project snapshot). The observables
 * of the pinned fixtures stay what they were before they existed (exactly as Phase 22 did for the gated entries): the
 * appended entries and projects are filtered out and `tier` is dropped. Their behaviour has its own tests.
 */
const PHASE16_DEFINITION_IDS: ReadonlySet<string> = new Set(
  BUILD_CATALOG.slice(BUILD_CATALOG.findIndex((definition) => definition.id === 'puddle-jumpers')).map((definition) => definition.id),
);
const PHASE16_PROJECT_IDS: ReadonlySet<string> = new Set(
  RESEARCH_PROJECTS.slice(RESEARCH_PROJECTS.findIndex((project) => project.id === 'refreshment-lab')).map((project) => project.id),
);
const PRE_PHASE16_DEFINITIONS = BUILD_CATALOG.filter((definition) => !PHASE16_DEFINITION_IDS.has(definition.id));

/**
 * The Phase 16 scenery snapshot fields (`themeAffinity`, and a destination's `theme`, `themeBonus`, `matchingSources`)
 * are dropped while the affinity is off (share 0, bonus 0), so a park without affinity observes exactly what it did
 * before Phase 16. A non-zero value is kept, so an affinity that acts stays visible. Plain data only.
 */
const withoutNeutralPhase16Keys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutNeutralPhase16Keys);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  const isScenerySnapshot = 'sourceCount' in record && 'parkScore' in record;
  const isNeutralDestination = 'choiceBonus' in record && 'satisfactionBonus' in record && record.themeBonus === 0;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (isScenerySnapshot && key === 'themeAffinity' && child === 0) continue;
    if (isNeutralDestination && (key === 'theme' || key === 'themeBonus' || key === 'matchingSources')) continue;
    result[key] = withoutNeutralPhase16Keys(child);
  }
  return result;
};

/**
 * Phase 11 (PA-023) deleted `ManagementSnapshot.health` (`cashScore` and `cashStatus`), which nothing read. It is a
 * retired key, kept in the observable so the pins stay the pre-deletion record: this re-inserts it computed exactly as
 * the deleted `ManagementSimulation.healthSnapshot()` did, from the same `world.cash` at the observation instant. The
 * inverse of the Phase 16 strip shims above. `round` and `clamp` are local copies of the management ones.
 */
const retiredClamp = (value: number, minimum = 0, maximum = 100): number => Math.min(maximum, Math.max(minimum, value));
const retiredRound = (value: number, decimals = 1): number => {
  const multiplier = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
};
export const withRetiredHealthKey = (
  management: ManagementSnapshot,
  cash: number,
): ManagementSnapshot & { health: { cashScore: number; cashStatus: 'healthy' | 'watch' | 'low' | 'negative' } } => {
  const cashStatus = cash < 0
    ? 'negative'
    : cash <= MANAGEMENT_CONFIG.lowCashThreshold
      ? 'low'
      : cash <= MANAGEMENT_CONFIG.watchCashThreshold
        ? 'watch'
        : 'healthy';
  return {
    ...management,
    health: { cashScore: retiredRound(retiredClamp(cash / GAME_CONFIG.startingCash * 100)), cashStatus },
  };
};

/**
 * Phase 21 added the `land` finance category. A park that never bought land observes exactly what it did before it
 * existed: an unused `land` row (no transaction) is dropped; a used one stays visible. The same strip shim as Phase 16's.
 */
export const withoutUnusedLandCategory = <Snapshot extends ManagementSnapshot>(management: Snapshot): Snapshot => {
  // Phase 29: the souvenir sales category is dropped the same way while no souvenir was ever sold.
  const souvenirs = management.finances.categories.souvenirSales?.transactionCount === 0;
  const land = management.finances.categories.land?.transactionCount === 0;
  if (!souvenirs && !land) return management;
  const categories: Partial<typeof management.finances.categories> = { ...management.finances.categories };
  if (land) delete categories.land;
  if (souvenirs) delete categories.souvenirSales;
  return { ...management, finances: { ...management.finances, categories } } as Snapshot;
};

/**
 * Phase 30: the Overview's comfort counts are a pure function of observed guest fields (energy, nausea, warmth, state,
 * souvenirs), the observed weather and the observed litter piles, so they are dropped like the insight link.
 */
const withoutComfortCounts = <Snapshot extends ManagementSnapshot>(management: Snapshot): Snapshot => {
  if (!management.operations.comfort) return management;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { comfort, ...operations } = management.operations;
  return { ...management, operations } as Snapshot;
};

/**
 * Phase 29: a guest record's four guest-life fields while they hold their neutral values (no nausea, comfortable, no
 * souvenirs, no activity) and a litter pile's `sick: false` are dropped from the observables, so a park whose guests
 * never lived Phase 29 (the switch off) observes exactly what it did before. A value that moved stays visible. The park
 * conditions' two Phase 29 keys are dropped always (see below).
 */
const withoutNeutralPhase29Keys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutNeutralPhase29Keys);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  const guest = 'preferredIntensity' in record && 'toiletNeed' in record;
  const pile = 'units' in record && 'assignedCleanerId' in record && 'cell' in record;
  // The park conditions' ambient warmth and night flag are pure functions of the weather, the calendar and the biome,
  // which are observed already.
  const conditions = 'coldTreatBonus' in record && 'warmFoodBonus' in record;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (conditions && (key === 'ambientWarmth' || key === 'night')) continue;
    if (guest && ((key === 'nausea' && child === 0) || (key === 'warmth' && child === 50) || (key === 'souvenirs' && child === 0)
      || (key === 'activity' && child === null)
      // Phase 30: a live guest's complaint link while there is none (a save omits the key then).
      || (key === 'thoughtObjectId' && child === null))) continue;
    if (pile && key === 'sick' && child === false) continue;
    result[key] = withoutNeutralPhase29Keys(child);
  }
  return result;
};

/**
 * Everything a player or another system can observe through the public API, gathered in a fixed
 * order. It exists to catch a serializer that omits something the state hash cannot see because the
 * omitted thing is also missing from the (restored) serialized form. It MUTATES (spawns guests,
 * hires, builds, refreshes management), identically in every run, so it runs once at the very end.
 */
export const observe = (session: ParkSession): unknown => {
  const { world, guests } = session;
  const positions = [...guests.guests.values()].map((guest) => [guest.id, guest.position.x, guest.position.y, guest.state, guest.routeIndex]);
  const rideRevenue = [...session.rides.rides.values()].map((ride) => [ride.objectId, ride.lifetimeRevenue, ride.status, ride.queueGuestIds.length]);
  const cells: Array<[number, number, number | null, boolean, boolean, boolean, number]> = [];
  const tidy = BUILD_CATALOG.find((definition) => definition.id === 'tidy-totem');
  for (let y = 0; y < world.height; y += 1) {
    for (let x = 0; x < world.width; x += 1) {
      const cell = { x, y };
      cells.push([
        x,
        y,
        world.objectAt(cell)?.id ?? null,
        tidy ? world.canPlace(tidy, cell) : false,
        world.canPlaceCoasterPiece({ cell, height: 0 }),
        world.canPlaceCoasterPiece({ cell, height: 2 }),
        session.scenery.scoreAt(cell),
      ]);
    }
  }
  guests.navigation.sync(world.paths, world.pathVersion);
  const connected = guests.navigation.connectedCells(world.entrance).map((cell) => `${cell.x},${cell.y}`);
  const distances = [...world.paths].sort().map((key) => {
    const [x, y] = key.split(',').map(Number);
    return guests.navigation.routeDistance(world.entrance, { x, y });
  });
  const unlocked = PRE_PHASE16_DEFINITIONS.filter((definition) => !definition.profileGate).map((definition) => [definition.id, world.isDefinitionUnlocked(definition.id)]);
  const snapshotBefore = { rides: [...session.rides.rides.keys()].map((id) => session.rides.snapshot(id)), buildings: session.buildingsSnapshot() };

  // Mutating probes, identical in every run.
  const firstNewGuestId = session.guests.serialize().nextGuestId;
  guests.spawnGuests(3);
  const spawned = [...guests.guests.values()].filter((guest) => guest.id >= firstNewGuestId);
  const hired = session.operations.hireStaff('cleaner');
  let builtId: number | null = null;
  for (let x = 0; x < world.width && builtId === null; x += 1) {
    builtId = world.buildObject('tidy-totem', { x, y: 0 })?.id ?? null;
  }
  world.postTransaction(1, 'probe', 'other');
  const probeTransactionId = world.transactions[0]?.id ?? null;
  session.syncWithWorld();
  session.refreshManagement();
  const events = session.step(GAME_CONFIG.fixedStepMs);
  return withoutNeutralPhase29Keys(withoutNeutralPhase16Keys(withoutRenderCacheKeys({
    positions,
    rideRevenue,
    cash: world.cash,
    guestCount: guests.guests.size,
    cells,
    connected,
    distances,
    unlocked,
    snapshotBefore,
    spawned,
    hiredId: hired?.id ?? null,
    builtId,
    probeTransactionId,
    management: withoutComfortCounts(withoutUnusedLandCategory(withRetiredHealthKey(session.management.snapshot(), world.cash))),
    scenario: session.scenarioSnapshot(),
    onboarding: session.onboardingSnapshot(),
    // Phase 22: profile-gated entries have no research project, so the snapshot lists them as unlocked; the
    // observable stays what it was before they existed (their gating has its own tests).
    progression: (() => {
      const snapshot = session.progression.snapshot();
      return {
        ...snapshot,
        unlockedDefinitionIds: snapshot.unlockedDefinitionIds.filter((id) => BUILD_BY_ID.get(id)?.profileGate !== true && !PHASE16_DEFINITION_IDS.has(id)),
        projects: snapshot.projects
          .filter((project) => !PHASE16_PROJECT_IDS.has(project.id))
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          .map(({ tier, ...project }) => project),
      };
    })(),
    calendar: [session.calendarView(), session.calendarView(session.world.tick + 0.5)],
    weather: [
      session.weatherViewInto(createWeatherView()),
      session.weatherViewInto(createWeatherView(), session.world.tick + 0.5),
      session.weatherForecast(),
      { ...session.weather.conditions },
      session.rides.stormClosedCount(),
      session.buildingsSnapshot().filter((row) => row.group === 'ride').map((row) => [row.objectId, row.status]),
    ],
    // Phase 30: an insight's link (`objectId`, `objectName`) is a pure function of the guests' `thoughtObjectId`
    // (observed in `spawned` and in every saved state) and the world, so it is dropped like the conditions' Phase 29
    // keys; the link itself has its own tests (GuestSimulation.test.ts).
    // The per-building split of complaint lines (Phase 30 review fix) is a presentation rule; the observable keeps one
    // group per summary, as it was before the link existed.
    insights: guests.thoughtInsights(10, false).map(({ text, count }) => ({ text, count })),
    events,
    operations: session.operations.snapshot(),
    nextGuestId: guests.serialize().nextGuestId,
    nextObjectId: session.world.serialize().nextObjectId,
  })));
};

export interface RunOptions {
  build: () => ParkSession;
  act: Act;
  total: number;
  checkpointTicks: ReadonlySet<number>;
  /** Serialize at every checkpoint (mutation-free; the purity test compares a run with and without). */
  checkpoints: boolean;
  /** Optional: runs once at the end of the trace for observables. */
  observeAtEnd: boolean;
}

/** The never-saved reference: build, then act+step for `total` ticks. */
export const runReference = (options: RunOptions): RunTrace => {
  const session = options.build();
  const trace = emptyTrace();
  for (let tick = 0; tick < options.total; tick += 1) {
    options.act(session, tick);
    if (options.checkpoints && options.checkpointTicks.has(tick)) {
      const state = session.serialize();
      trace.checkpointStates.set(tick, state);
      trace.checkpointHashes.set(tick, hashState(state));
    }
    stepOnce(session, trace);
  }
  trace.finalState = session.serialize();
  trace.finalHash = hashState(trace.finalState);
  if (options.observeAtEnd) trace.observables = observe(session);
  return trace;
};

/** Round trip a state through JSON text, the form IndexedDB-less step 2 persistence would write. */
export const viaJson = (state: ParkSaveV8): ParkSaveV8 => JSON.parse(JSON.stringify(state)) as ParkSaveV8;

export interface TwinResult {
  trace: RunTrace;
  savedJson: string;
  restoredImmediateHash: string;
  savedHash: string;
  /** First difference between the live graph that was saved and its restored twin (null = none). */
  liveDifference: string | null;
}

/**
 * The saved run: run to K exactly like the reference (with the same acts), save between act(K) and
 * step(K), restore into a FRESH session, continue to `total`.
 */
export const runTwin = (
  options: RunOptions,
  saveTick: number,
  transport: (state: ParkSaveV8) => ParkSaveV8,
): TwinResult => {
  let session = options.build();
  for (let tick = 0; tick < saveTick; tick += 1) {
    options.act(session, tick);
    stepOnce(session);
  }
  options.act(session, saveTick);
  const saved = session.serialize();
  const savedJson = JSON.stringify(saved);
  const savedHash = hashState(saved);
  const original = session;
  session = ParkSession.fromState(transport(saved));
  const liveDifference = liveGraphDifference(original, session);
  const restoredImmediateHash = hashState(session.serialize());
  const trace = emptyTrace();
  for (let tick = saveTick; tick < options.total; tick += 1) {
    if (tick !== saveTick) options.act(session, tick);
    if (options.checkpoints && options.checkpointTicks.has(tick)) {
      const state = session.serialize();
      trace.checkpointStates.set(tick, state);
      trace.checkpointHashes.set(tick, hashState(state));
    }
    stepOnce(session, trace);
  }
  trace.finalState = session.serialize();
  trace.finalHash = hashState(trace.finalState);
  if (options.observeAtEnd) trace.observables = observe(session);
  return { trace, savedJson, restoredImmediateHash, savedHash, liveDifference };
};
