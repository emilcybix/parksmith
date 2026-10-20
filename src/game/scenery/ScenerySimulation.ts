import { BUILD_BY_ID } from '../content/catalog';
import { GAME_CONFIG } from '../config';
import { plainNumber } from '../save/plainData';
import type { SceneryState, Serializable } from '../save/state';
import { SaveError, invalidState } from '../save/version';
import { footprintSize } from '../types';
import type { Cell, PlacedObject, Rotation, SceneryThemeId } from '../types';
import type { GameWorld } from '../World';
import type {
  SceneryDestinationSnapshot,
  SceneryInfluenceReader,
  ScenerySnapshot,
  ScenerySourceSnapshot,
  ThemeBonusPreview,
  SceneryNextStep,
  ThemeBonusPreviewEntry,
} from './types';

interface SourceDescriptor {
  objectId: number;
  definitionId: string;
  anchor: Cell;
  footprint: readonly [number, number];
  appeal: number;
  radius: number;
  signature: string;
}

/** A source's reach: its footprint rectangle, appeal and radius (all the theme affinity needs). */
interface SourceReach {
  anchor: Cell;
  footprint: readonly [number, number];
  appeal: number;
  radius: number;
  theme: SceneryThemeId | null;
}

interface CachedSource extends SourceDescriptor {
  influence: Array<{ index: number; contribution: number }>;
}

const CARDINALS: readonly Cell[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

const clamp = (value: number, minimum = 0, maximum = 100): number =>
  Math.min(maximum, Math.max(minimum, value));
const round = (value: number, decimals = 2): number => {
  const multiplier = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
};
const cellKey = ({ x, y }: Cell): string => `${x},${y}`;

export class ScenerySimulation implements SceneryInfluenceReader, Serializable<SceneryState> {
  private readonly scores: Float64Array;
  private readonly sources = new Map<number, CachedSource>();
  private readonly objectScores = new Map<number, number>();
  private lastWorldVersion = -1;
  private lastPathVersion = -1;
  private cacheVersion = 0;
  private latestSnapshot: ScenerySnapshot = {
    version: 0,
    sourceCount: 0,
    influencedCells: 0,
    connectedPathTiles: 0,
    decoratedPathTiles: 0,
    coveragePercent: 0,
    averagePathScore: 0,
    averageDestinationScore: 0,
    parkScore: 0,
    themeAffinity: 0,
    cells: [],
    sources: [],
    destinations: [],
  };

  constructor(
    private readonly world: GameWorld,
    /**
     * Phase 25: `sceneryAppealMultiplier` scales every source's appeal before its signature is built, so a restore under
     * the same (saved) ruleset rebuilds the same signatures. 1 by default (`x * 1` is exact).
     */
    private readonly rules: { sceneryAppealMultiplier: number; themeAffinity?: number } = { sceneryAppealMultiplier: 1 },
  ) {
    this.scores = new Float64Array(world.width * world.height);
    const share = rules.themeAffinity ?? 0;
    this.themeAffinity = Number.isFinite(share) && share > 0 ? share : 0;
    this.syncWithWorld();
  }

  /** Phase 16: the ruleset's theme-affinity share (0 = off: absent in every park saved before Phase 16). */
  readonly themeAffinity: number;

  /**
   * Whether the cached sources were built from the world as it is now. A save taken while this is
   * false would pair scores from an older world with the new one, so ParkSession.serialize refuses.
   */
  isSyncedWithWorld(): boolean {
    if (this.lastWorldVersion === this.world.version && this.lastPathVersion === this.world.pathVersion) return true;
    // A version bump alone (opening the park, a path edit) changes no scenery source; only a
    // different source set or signature makes the cached scores wrong, and that is what restore rejects.
    const current = this.collectSourceDescriptors();
    if (current.size !== this.sources.size) return false;
    for (const descriptor of current.values()) {
      if (this.sources.get(descriptor.objectId)?.signature !== descriptor.signature) return false;
    }
    return true;
  }

  syncWithWorld(): void {
    if (this.lastWorldVersion === this.world.version && this.lastPathVersion === this.world.pathVersion) return;
    this.lastWorldVersion = this.world.version;
    this.lastPathVersion = this.world.pathVersion;

    const nextSources = this.collectSourceDescriptors();
    for (const [objectId, cached] of this.sources) {
      const next = nextSources.get(objectId);
      if (next?.signature === cached.signature) continue;
      this.applyInfluence(cached.influence, -1);
      this.sources.delete(objectId);
    }
    for (const descriptor of nextSources.values()) {
      if (this.sources.has(descriptor.objectId)) continue;
      const influence = this.buildInfluence(descriptor);
      this.applyInfluence(influence, 1);
      this.sources.set(descriptor.objectId, { ...descriptor, influence });
    }

    this.rebuildDerivedSnapshot();
  }

  /**
   * Read-only image of the score field. The field is a running add/subtract sum, so its low bits
   * depend on the order edits were applied in; a from-scratch rebuild would be equal to ~1e-15 but
   * not bit-equal, and that residue leaks into rounded scores and guest decisions. Hence the exact
   * doubles are saved, sparsely (most of the grid is 0).
   *
   * Deliberately does NOT call syncWithWorld(): a sync here would apply a world edit at a different
   * moment than the never-saved run does (two edits applied in one pass versus two passes change
   * the float history) and would bump cacheVersion. The sources written are the CACHED ones, the
   * exact set the scores were accumulated from. The session syncs after every edit, so at a tick
   * boundary the cache equals the world.
   */
  serialize(): SceneryState {
    const scores: Array<[number, number]> = [];
    for (let index = 0; index < this.scores.length; index += 1) {
      const value = this.scores[index];
      if (value !== 0) scores.push([index, plainNumber(value, `scores[${index}]`)]);
    }
    const sources = [...this.sources.values()]
      .sort((left, right) => left.objectId - right.objectId)
      .map((source) => ({ objectId: source.objectId, signature: source.signature }));
    return { width: this.world.width, height: this.world.height, scores, sources };
  }

  /**
   * Validates, then rebuilds. Everything that can fail (shape, grid size, content drift) is
   * decided before the first write. Sources are rebuilt WITHOUT applying their influence: the saved
   * scores already contain it, and applying it again would double count. Instance identity (and the
   * Float64Array) is kept because guests, rides and shops hold this reader.
   */
  restore(state: SceneryState): void {
    const owner = 'ScenerySimulation';
    if (typeof state !== 'object' || state === null) throw invalidState(owner, '$', 'is not an object');
    if (state.width !== this.world.width || state.height !== this.world.height) {
      throw invalidState(owner, 'width/height', `is ${String(state.width)}x${String(state.height)} but the world is ${this.world.width}x${this.world.height}`);
    }
    if (!Array.isArray(state.scores)) throw invalidState(owner, 'scores', 'is not an array');
    if (!Array.isArray(state.sources)) throw invalidState(owner, 'sources', 'is not an array');
    let previousIndex = -1;
    state.scores.forEach((entry, position) => {
      const path = `scores[${position}]`;
      if (!Array.isArray(entry) || entry.length !== 2) throw invalidState(owner, path, 'is not an [index, value] pair');
      const [index, value] = entry;
      if (!Number.isInteger(index) || index < 0 || index >= this.scores.length) {
        throw invalidState(owner, `${path}[0]`, `is not a cell index inside 0..${this.scores.length - 1}`);
      }
      if (index <= previousIndex) throw invalidState(owner, `${path}[0]`, 'is not strictly ascending');
      previousIndex = index;
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw invalidState(owner, `${path}[1]`, 'is not a finite number above 0');
      }
    });
    let previousObjectId = Number.NEGATIVE_INFINITY;
    state.sources.forEach((source, position) => {
      const path = `sources[${position}]`;
      if (typeof source !== 'object' || source === null) throw invalidState(owner, path, 'is not an object');
      if (!Number.isInteger(source.objectId)) throw invalidState(owner, `${path}.objectId`, 'is not an integer');
      if (source.objectId <= previousObjectId) throw invalidState(owner, `${path}.objectId`, 'is not strictly ascending');
      previousObjectId = source.objectId;
      if (typeof source.signature !== 'string') throw invalidState(owner, `${path}.signature`, 'is not a string');
    });

    // Content check against what this world and catalog produce right now.
    const descriptors = this.collectSourceDescriptors();
    const expected = [...descriptors.values()].sort((left, right) => left.objectId - right.objectId);
    const mismatch = expected.length !== state.sources.length
      ? `the save has ${state.sources.length} scenery sources but this world and catalog produce ${expected.length}`
      : expected
        .map((descriptor, position) => (
          descriptor.objectId === state.sources[position].objectId
          && descriptor.signature === state.sources[position].signature
            ? null
            : `source ${descriptor.objectId} is "${descriptor.signature}" here but "${state.sources[position].signature}" in the save`
        ))
        .find((problem) => problem !== null);
    if (mismatch) {
      throw new SaveError('content-mismatch', `ScenerySimulation cannot restore: ${mismatch} (scenery content changed since the save)`);
    }
    // Heavy work last before the writes, still non-mutating. World.objects order matters: it is the
    // order the never-saved run built its cache in.
    const rebuilt = [...descriptors.values()].map((descriptor): CachedSource => (
      { ...descriptor, influence: this.buildInfluence(descriptor) }
    ));

    this.scores.fill(0);
    for (const [index, value] of state.scores) this.scores[index] = value;
    this.sources.clear();
    for (const source of rebuilt) this.sources.set(source.objectId, source);
    this.objectScores.clear();
    // -1 forces the sync to refill objectScores/latestSnapshot. Sources already equal the world's,
    // so it applies no influence. cacheVersion is monotone and keeps counting up on purpose.
    this.lastWorldVersion = -1;
    this.lastPathVersion = -1;
    this.syncWithWorld();
  }

  scoreAt(cell: Cell): number {
    this.syncWithWorld();
    if (!this.world.isInside(cell)) return 0;
    return round(clamp(this.scores[this.indexOf(cell)]));
  }

  scoreForObject(objectId: number): number {
    this.syncWithWorld();
    return this.objectScores.get(objectId) ?? 0;
  }

  snapshot(): ScenerySnapshot {
    this.syncWithWorld();
    return {
      ...this.latestSnapshot,
      cells: this.latestSnapshot.cells.map((entry) => ({ ...entry, cell: { ...entry.cell } })),
      sources: this.latestSnapshot.sources.map((source) => ({ ...source })),
      destinations: this.latestSnapshot.destinations.map((destination) => ({ ...destination })),
    };
  }

  /**
   * Phase 16: which rides and stalls of the candidate's theme a scenery piece at `anchor` would raise, and by how much.
   * Pure: it reads the cached sources and the world and changes nothing. The preview bonus is computed exactly as the
   * bonus after the build would be (the same sources in object-id order, the candidate last, as a new object is).
   */
  previewThemeBonus(definitionId: string, anchor: Cell, rotation: Rotation = 0): ThemeBonusPreview {
    this.syncWithWorld();
    const definition = BUILD_BY_ID.get(definitionId);
    const theme = definition?.theme ?? null;
    const empty: ThemeBonusPreview = { theme, themeAffinity: this.themeAffinity, destinations: [], reachedDestinations: 0 };
    if (!definition || definition.kind !== 'scenery' || theme === null) return empty;
    const candidate: SourceReach = {
      anchor: { ...anchor },
      footprint: footprintSize(definition, rotation),
      appeal: this.appealOf(definition.stats?.sceneryAppeal),
      radius: this.radiusOf(definition.stats?.sceneryRadius),
      theme,
    };
    if (candidate.appeal <= 0) return empty;
    const sources = this.orderedSourceReaches();
    const destinations: ThemeBonusPreviewEntry[] = [];
    let reachedDestinations = 0;
    for (const object of [...this.world.objects.values()].sort((left, right) => left.id - right.id)) {
      const target = BUILD_BY_ID.get(object.definitionId);
      if (!target || target.theme !== theme || (target.kind !== 'ride' && !target.stats?.serviceType)) continue;
      const footprint = this.world.objectFootprint(object);
      if (footprint.length === 0 || !footprint.some((cell) => reachDistance(candidate, cell) <= candidate.radius)) continue;
      reachedDestinations += 1;
      const before = this.themeBonusOf(this.matchingOf(theme, footprint, sources).matching);
      const after = this.themeBonusOf(this.matchingOf(theme, footprint, [...sources, candidate]).matching);
      if (after > before) {
        destinations.push({ objectId: object.id, definitionId: object.definitionId, themeBonus: before, previewBonus: after, gain: round(after - before) });
      }
    }
    destinations.sort((left, right) => right.gain - left.gain || left.objectId - right.objectId);
    return { ...empty, destinations, reachedDestinations };
  }

  /**
   * Phase 49: the next step for an object's area score, so the inspector can say how far it is. Among `candidateIds`
   * (the scenery the player may build), the piece and free spot within its reach that lifts the object's base score
   * (the footprint mean of the clamped field, without the theme bonus) the most; ties go to the cheaper piece, then
   * the first spot in row order. `canPlace` says whether a piece may stand at an anchor. Null when nothing within
   * reach adds at least `minimumGain`, which is what a fully decorated ride (or one boxed in) reads as. Pure: reads
   * the field, changes nothing.
   */
  nextStepFor(
    objectId: number,
    candidateIds: readonly string[],
    canPlace: (definitionId: string, anchor: Cell) => boolean,
    minimumGain = 0.5,
  ): SceneryNextStep | null {
    this.syncWithWorld();
    const object = this.world.objects.get(objectId);
    if (!object) return null;
    const footprint = this.world.objectFootprint(object);
    if (footprint.length === 0) return null;
    const values = footprint.map((cell) => this.scores[this.indexOf(cell)]);
    const before = values.reduce((sum, value) => sum + clamp(value), 0) / footprint.length;
    let best: (SceneryNextStep & { cost: number }) | null = null;
    for (const definitionId of candidateIds) {
      const definition = BUILD_BY_ID.get(definitionId);
      if (definition?.kind !== 'scenery') continue;
      const appeal = this.appealOf(definition.stats?.sceneryAppeal);
      const radius = this.radiusOf(definition.stats?.sceneryRadius);
      if (appeal <= 0) continue;
      const [width, height] = footprintSize(definition);
      const minimumX = Math.min(...footprint.map((cell) => cell.x)) - radius - width + 1;
      const maximumX = Math.max(...footprint.map((cell) => cell.x)) + radius;
      const minimumY = Math.min(...footprint.map((cell) => cell.y)) - radius - height + 1;
      const maximumY = Math.max(...footprint.map((cell) => cell.y)) + radius;
      for (let y = Math.max(0, minimumY); y <= Math.min(this.world.height - height, maximumY); y += 1) {
        for (let x = Math.max(0, minimumX); x <= Math.min(this.world.width - width, maximumX); x += 1) {
          let total = 0;
          for (let index = 0; index < footprint.length; index += 1) {
            const distance = reachDistance({ anchor: { x, y }, footprint: [width, height] }, footprint[index]);
            const contribution = distance > radius ? 0 : appeal * (radius + 1 - distance) / (radius + 1);
            total += clamp(values[index] + contribution);
          }
          const gain = total / footprint.length - before;
          if (gain < minimumGain || (best && (gain < best.gain || (gain === best.gain && definition.buildCost >= best.cost)))) continue;
          if (!canPlace(definitionId, { x, y })) continue;
          best = {
            definitionId,
            anchor: { x, y },
            gain: round(gain),
            scoreBefore: round(before),
            scoreAfter: round(before + gain),
            cost: definition.buildCost,
          };
        }
      }
    }
    if (!best) return null;
    return { definitionId: best.definitionId, anchor: best.anchor, gain: best.gain, scoreBefore: best.scoreBefore, scoreAfter: best.scoreAfter };
  }

  /** A source's appeal as the field uses it: the catalog appeal after `sceneryAppealMultiplier`, clamped to 0..100. */
  private appealOf(rawAppeal: number | undefined): number {
    const value = rawAppeal ?? 0;
    return clamp((Number.isFinite(value) ? value : 0) * this.rules.sceneryAppealMultiplier);
  }

  private radiusOf(rawRadius: number | undefined): number {
    const value = rawRadius ?? 0;
    return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  }

  /** The cached sources in object-id order, with their themes (the order the affinity sums in, for bit-identity). */
  private orderedSourceReaches(): SourceReach[] {
    return [...this.sources.values()]
      .sort((left, right) => left.objectId - right.objectId)
      .map((source) => ({
        anchor: source.anchor,
        footprint: source.footprint,
        appeal: source.appeal,
        radius: source.radius,
        theme: BUILD_BY_ID.get(source.definitionId)?.theme ?? null,
      }));
  }

  /**
   * Phase 16: the same-theme appeal field over a footprint: the mean over its cells of the sum, over sources of that
   * theme within reach, of appeal x (r + 1 - d) / (r + 1) (the score field's own falloff, unclamped). Derived, never
   * saved: summed from scratch in source object-id order, so a restored park recomputes it bit-identically.
   */
  private matchingOf(theme: SceneryThemeId, footprint: readonly Cell[], sources: readonly SourceReach[]): { matching: number; sources: number } {
    let total = 0;
    let count = 0;
    for (const source of sources) {
      if (source.theme !== theme) continue;
      let reached = false;
      for (const cell of footprint) {
        const distance = reachDistance(source, cell);
        if (distance > source.radius) continue;
        reached = true;
        total += source.appeal * (source.radius + 1 - distance) / (source.radius + 1);
      }
      if (reached) count += 1;
    }
    return { matching: footprint.length > 0 ? total / footprint.length : 0, sources: count };
  }

  /** min(maximumBonus, matching x share), rounded like every score; 0 when the affinity is off. */
  private themeBonusOf(matching: number): number {
    if (this.themeAffinity <= 0 || matching <= 0) return 0;
    return round(Math.min(GAME_CONFIG.scenery.themeAffinity.maximumBonus, matching * this.themeAffinity));
  }

  private collectSourceDescriptors(): Map<number, SourceDescriptor> {
    const descriptors = new Map<number, SourceDescriptor>();
    for (const object of this.world.objects.values()) {
      const definition = BUILD_BY_ID.get(object.definitionId);
      if (definition?.kind !== 'scenery') continue;
      const appeal = this.appealOf(definition.stats?.sceneryAppeal);
      const radius = this.radiusOf(definition.stats?.sceneryRadius);
      if (appeal <= 0) continue;
      const footprint = footprintSize(definition, object.rotation);
      descriptors.set(object.id, {
        objectId: object.id,
        definitionId: definition.id,
        anchor: { ...object.anchor },
        footprint,
        appeal,
        radius,
        signature: [
          definition.id,
          object.anchor.x,
          object.anchor.y,
          footprint[0],
          footprint[1],
          appeal,
          radius,
        ].join(':'),
      });
    }
    return descriptors;
  }

  private buildInfluence(source: SourceDescriptor): Array<{ index: number; contribution: number }> {
    const influence: Array<{ index: number; contribution: number }> = [];
    const minimumX = Math.max(0, source.anchor.x - source.radius);
    const minimumY = Math.max(0, source.anchor.y - source.radius);
    const maximumX = Math.min(
      this.world.width - 1,
      source.anchor.x + source.footprint[0] - 1 + source.radius,
    );
    const maximumY = Math.min(
      this.world.height - 1,
      source.anchor.y + source.footprint[1] - 1 + source.radius,
    );
    const sourceMaximumX = source.anchor.x + source.footprint[0] - 1;
    const sourceMaximumY = source.anchor.y + source.footprint[1] - 1;

    for (let y = minimumY; y <= maximumY; y += 1) {
      for (let x = minimumX; x <= maximumX; x += 1) {
        const dx = x < source.anchor.x
          ? source.anchor.x - x
          : x > sourceMaximumX ? x - sourceMaximumX : 0;
        const dy = y < source.anchor.y
          ? source.anchor.y - y
          : y > sourceMaximumY ? y - sourceMaximumY : 0;
        const distance = dx + dy;
        if (distance > source.radius) continue;
        const contribution = source.appeal
          * (source.radius + 1 - distance)
          / (source.radius + 1);
        influence.push({ index: this.indexOf({ x, y }), contribution });
      }
    }
    return influence;
  }

  private applyInfluence(
    influence: readonly { index: number; contribution: number }[],
    direction: -1 | 1,
  ): void {
    for (const entry of influence) {
      const next = this.scores[entry.index] + entry.contribution * direction;
      this.scores[entry.index] = Math.abs(next) < 1e-9 ? 0 : Math.max(0, next);
    }
  }

  private rebuildDerivedSnapshot(): void {
    this.cacheVersion += 1;
    this.objectScores.clear();
    const connectedPaths = this.entranceConnectedPaths();
    const cells: ScenerySnapshot['cells'] = [];
    let decoratedPathTiles = 0;
    let connectedPathScoreTotal = 0;

    for (let y = 0; y < this.world.height; y += 1) {
      for (let x = 0; x < this.world.width; x += 1) {
        const cell = { x, y };
        const score = round(clamp(this.scores[this.indexOf(cell)]));
        // Phase 21: the heatmap shows owned land only (influence spills past the fence, but nobody can build there).
        if (score > 0 && this.world.land.isCellOwned(x, y)) cells.push({ cell, score });
        if (!connectedPaths.has(cellKey(cell))) continue;
        connectedPathScoreTotal += score;
        if (score > 0) decoratedPathTiles += 1;
      }
    }

    const destinations: SceneryDestinationSnapshot[] = [];
    let sourceReaches: SourceReach[] | null = null;
    for (const object of [...this.world.objects.values()].sort((left, right) => left.id - right.id)) {
      const definition = BUILD_BY_ID.get(object.definitionId);
      if (!definition || (definition.kind !== 'ride' && !definition.stats?.serviceType)) continue;
      const theme = definition.theme ?? null;
      let score = this.objectScore(object);
      let themeBonus = 0;
      let matchingSources = 0;
      if (theme !== null && this.sources.size > 0) {
        sourceReaches ??= this.orderedSourceReaches();
        const matching = this.matchingOf(theme, this.world.objectFootprint(object), sourceReaches);
        matchingSources = matching.sources;
        themeBonus = this.themeBonusOf(matching.matching);
        // Only a non-zero bonus touches the score: with the affinity off the score is exactly the footprint average.
        if (themeBonus > 0) score = round(Math.min(GAME_CONFIG.scenery.maximumScore, score + themeBonus));
      }
      this.objectScores.set(object.id, score);
      if (!this.hasConnectedAccess(object, connectedPaths)) continue;
      const ride = definition.kind === 'ride';
      destinations.push({
        objectId: object.id,
        score,
        choiceBonus: round(score * (ride
          ? GAME_CONFIG.scenery.rideChoiceWeight
          : GAME_CONFIG.scenery.serviceChoiceWeight)),
        satisfactionBonus: round(score * (ride
          ? GAME_CONFIG.scenery.rideSatisfactionWeight
          : GAME_CONFIG.scenery.serviceSatisfactionWeight)),
        theme,
        themeBonus,
        matchingSources,
      });
    }

    const connectedPathTiles = connectedPaths.size;
    const averagePathScore = connectedPathTiles > 0
      ? round(connectedPathScoreTotal / connectedPathTiles)
      : 0;
    const averageDestinationScore = destinations.length > 0
      ? round(destinations.reduce((total, destination) => total + destination.score, 0) / destinations.length)
      : 0;
    const sourceSnapshots: ScenerySourceSnapshot[] = [...this.sources.values()]
      .sort((left, right) => left.objectId - right.objectId)
      .map((source) => ({
        objectId: source.objectId,
        definitionId: source.definitionId,
        appeal: source.appeal,
        radius: source.radius,
        influencedCells: source.influence.length,
      }));

    this.latestSnapshot = {
      version: this.cacheVersion,
      sourceCount: sourceSnapshots.length,
      influencedCells: cells.length,
      connectedPathTiles,
      decoratedPathTiles,
      coveragePercent: connectedPathTiles > 0 ? round(decoratedPathTiles / connectedPathTiles * 100) : 0,
      averagePathScore,
      averageDestinationScore,
      parkScore: destinations.length > 0 ? averageDestinationScore : averagePathScore,
      themeAffinity: this.themeAffinity,
      cells,
      sources: sourceSnapshots,
      destinations,
    };
  }

  private objectScore(object: PlacedObject): number {
    const footprint = this.world.objectFootprint(object);
    if (footprint.length === 0) return 0;
    const total = footprint.reduce((sum, cell) => sum + clamp(this.scores[this.indexOf(cell)]), 0);
    return round(total / footprint.length);
  }

  private entranceConnectedPaths(): Set<string> {
    const connected = new Set<string>();
    const entranceKey = cellKey(this.world.entrance);
    if (!this.world.paths.has(entranceKey)) return connected;
    const queue: Cell[] = [{ ...this.world.entrance }];
    connected.add(entranceKey);
    for (let index = 0; index < queue.length; index += 1) {
      const cell = queue[index];
      for (const direction of CARDINALS) {
        const neighbor = { x: cell.x + direction.x, y: cell.y + direction.y };
        const key = cellKey(neighbor);
        if (connected.has(key) || !this.world.paths.has(key)) continue;
        connected.add(key);
        queue.push(neighbor);
      }
    }
    return connected;
  }

  private hasConnectedAccess(
    object: PlacedObject,
    connectedPaths: ReadonlySet<string>,
  ): boolean {
    const footprint = this.world.objectFootprint(object);
    const footprintKeys = new Set(footprint.map(cellKey));
    return footprint.some((cell) => CARDINALS.some((direction) => {
      const neighbor = { x: cell.x + direction.x, y: cell.y + direction.y };
      const key = cellKey(neighbor);
      return !footprintKeys.has(key) && connectedPaths.has(key);
    }));
  }

  private indexOf(cell: Cell): number {
    return cell.y * this.world.width + cell.x;
  }
}

/** Manhattan distance from a cell to a source's footprint rectangle (0 inside it), as the score field measures it. */
const reachDistance = (source: Pick<SourceReach, 'anchor' | 'footprint'>, cell: Cell): number => {
  const maximumX = source.anchor.x + source.footprint[0] - 1;
  const maximumY = source.anchor.y + source.footprint[1] - 1;
  const dx = cell.x < source.anchor.x ? source.anchor.x - cell.x : cell.x > maximumX ? cell.x - maximumX : 0;
  const dy = cell.y < source.anchor.y ? source.anchor.y - cell.y : cell.y > maximumY ? cell.y - maximumY : 0;
  return dx + dy;
};
