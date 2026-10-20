/**
 * Phase 14 (design Q4 and section 7): the words and rows of the neighborhoods UI. Pure: GameApp builds the store's
 * `crowd` field with `buildCrowdUi` on the 250 ms UI cadence; the HUD and the Neighborhoods tab only render it.
 *
 * Park Pulse DESCRIBES, it never prescribes: every line says what is happening and where, never what to do about it
 * (`ADVICE_WORDS` is the banned list a test checks every string of this file against).
 */
import type { CrowdNoticeKind, CrowdNoticeLine } from '../app/crowdNotice';
import { GAME_CONFIG } from '../game/config';
import type { CrowdBand, CrowdView, NeighborhoodView } from '../game/crowd/types';
import type { Cell } from '../game/types';
import type { CrowdUi, NeighborhoodRow } from './neighborhoodTypes';

/** Imperative or advice words no neighborhood line may contain (whole words, any case). */
export const ADVICE_WORDS: readonly string[] = Object.freeze([
  'build', 'add', 'place', 'widen', 'move', 'hire', 'should', 'try', 'consider', 'need to',
]);

/** Legend words, by band (the heatmap legend, the toggle's description and the CROWD cell). */
export const BAND_WORDS: readonly string[] = Object.freeze(['Quiet', 'Normal', 'Busy', 'Severe bottleneck']);

/** The CROWD cell word: a severe band is a "bottleneck" only with a structural cause (design Q1). */
export const bandWord = (band: CrowdBand, bottleneck: boolean): string => (
  band === 3 && !bottleneck ? 'Severe' : BAND_WORDS[band]
);

export const CROWD_TOGGLE_LABEL = 'Crowd flow';
export const CROWD_TOGGLE_TITLE = 'Toggle crowd flow heatmap';
export const CROWD_TOGGLE_CLASSIC_TITLE = 'Crowd flow heatmap (voxel renderer only)';
/** The toggle's `aria-description`: the legend in words, so the colours are never the only cue. */
export const CROWD_LEGEND_TEXT = `Path colours: ${BAND_WORDS.join(', ')}`;
export const CROWD_CLASSIC_TOAST = 'The crowd heatmap is drawn by the voxel renderer.';
/** The classic toggle's `aria-description`: why it is unavailable, then the legend (the title alone is not read out). */
export const CROWD_TOGGLE_CLASSIC_DESCRIPTION = `${CROWD_CLASSIC_TOAST} ${CROWD_LEGEND_TEXT}`;

export const NEIGHBORHOODS_TAB_LABEL = 'Neighborhoods';
export const NEIGHBORHOODS_KICKER = 'EVERY NEIGHBORHOOD';
export const NEIGHBORHOODS_TITLE = 'Neighborhoods';
export const NEIGHBORHOODS_EMPTY = 'Neighborhoods form around rides. This park has none yet.';
export const NEIGHBORHOODS_ADVICE = 'Select a row to centre the camera on it.';
export const NEIGHBORHOODS_NOTICED_KICKER = 'WHAT PARK PULSE NOTICED';
export const NEIGHBORHOODS_NOTICED_EMPTY = 'Nothing stands out in any neighborhood right now.';

export const unreachedLine = (count: number): string | null => (
  count <= 0 ? null : `${count} building${count === 1 ? ' has' : 's have'} no path access and belong${count === 1 ? 's' : ''} to no neighborhood.`
);

/** One Park Pulse line (design Q4). */
export const crowdNoticeText = (kind: CrowdNoticeKind, name: string): string => {
  switch (kind) {
    case 'bottleneck': return `${name} has a bottleneck`;
    case 'crowded': return `${name} is becoming crowded`;
    case 'noToilet': return `${name} has no toilet within reach`;
    case 'noFood': return `${name} has no food within reach`;
    case 'noDrink': return `${name} has nothing to drink within reach`;
    case 'unhappy': return `Guests in ${name} are unhappy`;
    case 'litterOutpaces': return `Litter outpaces your cleaners: bins near ${name} would help`;
    case 'litter': return `Litter is piling up in ${name}`;
  }
};

/** Names in a grouped line before the rest are counted ("A, B, C and 2 other neighborhoods"). */
export const NOTICED_NAMES_SHOWN = 3;

const nameList = (names: readonly string[]): string => {
  if (names.length === 1) return names[0];
  if (names.length <= NOTICED_NAMES_SHOWN + 1) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const rest = names.length - NOTICED_NAMES_SHOWN;
  return `${names.slice(0, NOTICED_NAMES_SHOWN).join(', ')} and ${rest} other neighborhoods`;
};

/** One dashboard line for every neighborhood with the same observation (plural verbs from two names on). */
export const groupedNoticeText = (kind: CrowdNoticeKind, names: readonly string[]): string => {
  if (names.length === 1) return crowdNoticeText(kind, names[0]);
  const list = nameList(names);
  switch (kind) {
    case 'bottleneck': return `${list} have a bottleneck`;
    case 'crowded': return `${list} are becoming crowded`;
    case 'noToilet': return `${list} have no toilet within reach`;
    case 'noFood': return `${list} have no food within reach`;
    case 'noDrink': return `${list} have nothing to drink within reach`;
    case 'unhappy': return `Guests in ${list} are unhappy`;
    case 'litterOutpaces': return `Litter outpaces your cleaners: bins near ${list} would help`;
    case 'litter': return `Litter is piling up in ${list}`;
  }
};

/**
 * The dashboard's "What Park Pulse noticed" list: one line per kind, in Pulse priority, naming every neighborhood
 * with it in dashboard order (Wave 4 audit: the dev park at 1,000 guests had 8 to 13 single lines, which pushed every
 * row below the fold; grouped, it is at most eight lines, one per kind).
 */
export const groupNoticeLines = (active: readonly CrowdNoticeLine[]): string[] => {
  const byKind = new Map<CrowdNoticeKind, string[]>();
  for (const line of active) {
    const names = byKind.get(line.kind) ?? byKind.set(line.kind, []).get(line.kind)!;
    if (!names.includes(line.name)) names.push(line.name);
  }
  return [...byKind].map(([kind, names]) => groupedNoticeText(kind, names));
};

/** The Overview tab's button text. */
export const overviewLineOf = (pulseLine: string | null): string | null => (pulseLine === null ? null : `${pulseLine} · see Neighborhoods`);

const wholeNumber = (value: number): number => Math.max(0, Math.round(value));

/** "38 guests a minute", "1 guest a minute". */
export const perMinuteText = (perMinute: number): string => {
  const n = wholeNumber(perMinute);
  return `${n} guest${n === 1 ? '' : 's'} a minute`;
};

/**
 * The CursorReadout line with the pointer tool and the heatmap on: "Busy path · 38 guests a minute · Clover Corner".
 * A path in no neighborhood leaves the name out; a severe tile with a structural cause says "Bottleneck path".
 */
export const crowdHoverLine = (tile: { band: CrowdBand; perMinute: number; bottleneck: boolean }, neighborhoodName: string | null): string => {
  const word = tile.band === 3 ? (tile.bottleneck ? 'Bottleneck' : 'Severe') : BAND_WORDS[tile.band];
  return [`${word} path`, perMinuteText(tile.perMinute), ...(neighborhoodName ? [neighborhoodName] : [])].join(' · ');
};

/** Phase 49: what lies on a hovered path tile: "vomit and 2 litter", "vomit", "4 litter"; null when it is clean. */
export const hoverLitterText = (litterUnits: number, sick: boolean): string | null => {
  if (litterUnits <= 0) return null;
  if (!sick) return `${litterUnits} litter`;
  const onTop = litterUnits - GAME_CONFIG.operations.litter.sickUnits;
  return onTop > 0 ? `vomit and ${onTop} litter` : 'vomit';
};

/** The same from `ParkSession.crowdHoverAt(cell)`; null (off the path network) stays null. Phase 49: litter last. */
export const crowdHoverText = (
  hover: Readonly<{
    band: CrowdBand; perMinute: number; bottleneck: boolean; neighborhoodName: string | null; litterUnits?: number; sick?: boolean;
  }> | null,
): string | null => {
  if (hover === null) return null;
  const litter = hoverLitterText(hover.litterUnits ?? 0, hover.sick === true);
  const line = crowdHoverLine(hover, hover.neighborhoodName);
  return litter === null ? line : `${line} · ${litter}`;
};

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

export interface NeighborhoodRowOptions {
  /** True for a member that is a stall (food, drink or toilet); without it the subtitle counts no stalls. */
  isStall?: ((objectId: number) => boolean) | null;
}

const bottleneckOf = (neighborhood: Readonly<NeighborhoodView>, view: Readonly<CrowdView>): Cell | null => {
  if (neighborhood.worst?.bottleneck) return neighborhood.worst.cell;
  return view.bottlenecks.find((tile) => tile.neighborhoodKey === neighborhood.key)?.cell ?? null;
};

/** "north-west · 4 rides · 2 stalls · bottleneck at 14, 9"; the gate: "south · park entrance · ...". */
export const neighborhoodSubtitle = (
  neighborhood: Readonly<Pick<NeighborhoodView, 'key' | 'sector' | 'rideIds'>>,
  stalls: number,
  bottleneck: Readonly<Cell> | null,
): string => {
  const parts: string[] = [neighborhood.sector];
  if (neighborhood.key === 0) parts.push('park entrance');
  if (neighborhood.rideIds.length > 0 || neighborhood.key !== 0) parts.push(plural(neighborhood.rideIds.length, 'ride', 'rides'));
  if (stalls > 0) parts.push(plural(stalls, 'stall', 'stalls'));
  if (bottleneck) parts.push(`bottleneck at ${bottleneck.x}, ${bottleneck.y}`);
  return parts.join(' · ');
};

const worstBandOf = (bands: readonly [number, number, number, number]): CrowdBand => (
  bands[3] > 0 ? 3 : bands[2] > 0 ? 2 : bands[1] > 0 ? 1 : 0
);

/** Dashboard rows in view order (gate first, then key ascending). */
export const buildNeighborhoodRows = (view: Readonly<CrowdView>, options: NeighborhoodRowOptions = {}): NeighborhoodRow[] => (
  view.neighborhoods.map((neighborhood) => {
    const { metrics } = neighborhood;
    const bottleneck = bottleneckOf(neighborhood, view);
    const band = Math.max(worstBandOf(metrics.bands), neighborhood.worst?.band ?? 0) as CrowdBand;
    const stalls = options.isStall ? neighborhood.memberIds.filter((id) => options.isStall!(id)).length : 0;
    const worst = neighborhood.worst !== null && neighborhood.worst.band >= 2
      ? { cell: { ...neighborhood.worst.cell }, perMinute: neighborhood.worst.perMinute }
      : null;
    return {
      key: neighborhood.key,
      name: neighborhood.name,
      sector: neighborhood.sector,
      subtitle: neighborhoodSubtitle(neighborhood, stalls, bottleneck),
      rideCount: neighborhood.rideIds.length,
      memberCount: neighborhood.memberIds.length,
      walking: view.walkingByKey?.[neighborhood.key] ?? 0,
      guests: metrics.guests,
      happiness: metrics.happiness,
      hunger: metrics.hunger,
      thirst: metrics.thirst,
      toilet: metrics.toilet,
      spending: metrics.spending,
      litter: metrics.litter,
      scenery: metrics.scenery,
      queueing: metrics.queueing,
      longestWaitSeconds: metrics.longestWaitSeconds,
      demand: metrics.demand,
      coverage: { ...metrics.coverage },
      band,
      bandWord: bandWord(band, bottleneck !== null),
      worst,
      bottleneck: bottleneck === null ? null : { ...bottleneck },
    };
  })
);

export interface NeighborhoodKpis {
  count: number;
  /** The name of the row with the worst band, then the most guests a minute; null when every row is quiet. */
  busiest: string | null;
  /** Neighborhoods with a bottleneck. */
  bottlenecks: number;
  walking: number;
}

export const neighborhoodKpis = (rows: readonly NeighborhoodRow[]): NeighborhoodKpis => {
  let busiest: NeighborhoodRow | null = null;
  for (const row of rows) {
    if (row.band === 0) continue;
    if (busiest === null || row.band > busiest.band || (row.band === busiest.band && (row.worst?.perMinute ?? 0) > (busiest.worst?.perMinute ?? 0))) busiest = row;
  }
  return {
    count: rows.length,
    busiest: busiest?.name ?? null,
    bottlenecks: rows.filter((row) => row.bottleneck !== null).length,
    walking: rows.reduce((total, row) => total + row.walking, 0),
  };
};

export interface CoverageChip {
  kind: 'food' | 'drink' | 'toilet';
  /** "Food ✓", "Food —" or "Food 60%". */
  text: string;
  /** Spoken / tooltip form: "Food within reach of every path here". */
  title: string;
  tone: 'full' | 'partial' | 'none';
}

const COVERAGE_WORDS = { food: 'Food', drink: 'Drink', toilet: 'Toilet' } as const;

export const coverageChips = (coverage: Readonly<NeighborhoodRow['coverage']>): CoverageChip[] => (
  (['food', 'drink', 'toilet'] as const).map((kind) => {
    const share = coverage[kind];
    const word = COVERAGE_WORDS[kind];
    if (share >= 1) return { kind, text: `${word} ✓`, title: `${word} within reach of every path here`, tone: 'full' };
    if (share <= 0) return { kind, text: `${word} —`, title: `${word}: none within reach`, tone: 'none' };
    const percent = Math.min(99, Math.max(1, Math.round(share * 100)));
    return { kind, text: `${word} ${percent}%`, title: `${word} within reach of ${percent}% of the paths here`, tone: 'partial' };
  })
);

const money = (value: number): string => `${value < 0 ? '−' : ''}$${Math.round(Math.abs(value)).toLocaleString('en-US')}`;
const percentOrDash = (value: number | null): string => (value === null ? '—' : `${Math.round(value)}%`);
const waitText = (seconds: number | null): string | null => {
  if (seconds === null || seconds < 1) return null;
  return seconds < 60 ? `${Math.round(seconds)} sec` : `${Math.round(seconds / 60)} min`;
};

export interface MetricCell {
  label: string;
  value: string;
  /** A longer spoken / tooltip form when the short value needs one. */
  title?: string;
}

/** The row's metric cells, in design order (GUESTS ... DEMAND); the CROWD cell is rendered apart. */
export const neighborhoodMetricCells = (row: Readonly<NeighborhoodRow>): MetricCell[] => {
  const wait = waitText(row.longestWaitSeconds);
  return [
    { label: 'GUESTS', value: String(row.guests), title: `${row.guests} guests, ${row.walking} walking` },
    { label: 'HAPPY', value: percentOrDash(row.happiness) },
    { label: 'HUNGER', value: percentOrDash(row.hunger) },
    { label: 'THIRST', value: percentOrDash(row.thirst) },
    { label: 'TOILET', value: percentOrDash(row.toilet) },
    { label: 'SPENT', value: money(row.spending) },
    { label: 'LITTER', value: String(row.litter) },
    { label: 'SCENERY', value: String(Math.round(row.scenery)) },
    { label: 'QUEUE', value: String(row.queueing), title: wait === null ? `${row.queueing} queueing` : `${row.queueing} queueing, longest wait ${wait}` },
    { label: 'DEMAND', value: String(row.demand), title: `${row.demand} guests heading here or queueing` },
  ];
};

export interface CrowdUiInput {
  view: Readonly<CrowdView> | null;
  /** `stepCrowdNotice(...).active`. */
  active: readonly CrowdNoticeLine[];
  /** True while the dashboard is open on the Neighborhoods tab (rows are built only then). */
  rowsOpen: boolean;
  /** The hover line (`crowdHoverLine`) or null. */
  hover: string | null;
  rowOptions?: NeighborhoodRowOptions;
  /** Overrides the view's `unreached` count. */
  unreachedCount?: number;
}

/** The store's `crowd` field from the view, the tracker's lines and the hover line. */
export const buildCrowdUi = (input: CrowdUiInput): CrowdUi => {
  const lines = input.active.map((line) => crowdNoticeText(line.kind, line.name));
  const pulseLine = lines[0] ?? null;
  return {
    pulseLine,
    rows: input.rowsOpen && input.view !== null ? buildNeighborhoodRows(input.view, input.rowOptions) : null,
    overviewLine: overviewLineOf(pulseLine),
    hover: input.hover,
    lines,
    noticed: groupNoticeLines(input.active),
    unreachedCount: input.unreachedCount ?? input.view?.unreached ?? 0,
  };
};

/** Structural equality, so GameApp writes the store only when something a player can see changed. */
export const crowdUiEqual = (a: Readonly<CrowdUi> | null, b: Readonly<CrowdUi> | null): boolean => {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
};
