/**
 * Phase 14: what the UI store holds for crowds and neighborhoods (written by GameApp on the 250 ms UI cadence, read by
 * the HUD and the Neighborhoods tab). Plain data, presentation only, never saved. The rows are built by
 * `ui/neighborhoodModel.ts` from the session's `CrowdView`.
 */
import type { Cell } from '../game/types';
import type { CrowdBand, SectorWord } from '../game/crowd/types';

/** One dashboard row (one `<button>` per neighborhood, estate-row pattern). */
export interface NeighborhoodRow {
  /** The leader ride's object id; 0 = the gate neighborhood. Passed to `gameBridge.focusNeighborhood`. */
  key: number;
  name: string;
  sector: SectorWord;
  /** "north-west · 4 rides · 2 stalls · bottleneck at 14, 9". */
  subtitle: string;
  rideCount: number;
  memberCount: number;
  /** Walking guests on its tiles (the GUESTS WALKING KPI sums these). */
  walking: number;
  guests: number;
  happiness: number | null;
  hunger: number | null;
  thirst: number | null;
  toilet: number | null;
  spending: number;
  litter: number;
  scenery: number;
  queueing: number;
  longestWaitSeconds: number | null;
  demand: number;
  /** Share (0..1) of its tiles within reach of an open service of that kind. */
  coverage: { food: number; drink: number; toilet: number };
  /** The worst band on its tiles and its word (Quiet, Normal, Busy, Severe bottleneck). */
  band: CrowdBand;
  bandWord: string;
  /** The worst tile when it is busy or worse, with its flow; null otherwise. */
  worst: { cell: Cell; perMinute: number } | null;
  /** The bottleneck cell (a severe tile with a structural cause), or null. */
  bottleneck: Cell | null;
}

/** The store's `crowd` field. Null until the first publish and after a session swap. */
export interface CrowdUi {
  /** The one neighborhood Park Pulse line (bottleneck > crowded > coverage > unhappy > litter), or null. */
  pulseLine: string | null;
  /** Computed only while the Neighborhoods tab is open; null otherwise. Dashboard order: gate first, then key. */
  rows: NeighborhoodRow[] | null;
  /** "{Pulse line} · see Neighborhoods" for the Overview tab, or null. */
  overviewLine: string | null;
  /** CursorReadout line with the pointer tool and the heatmap on: "Busy path · 38 guests a minute · Clover Corner". */
  hover: string | null;
  /**
   * Every neighborhood line that is on, in Park Pulse priority (the dashboard lists all; Park Pulse shows only
   * `pulseLine`, the first). Optional: absent = none. Added in Phase 14 Wave 2 (Agent 5).
   */
  lines?: string[];
  /**
   * The dashboard's grouped form of `lines`: one line per kind naming every neighborhood with it, in Pulse priority
   * (`groupNoticeLines`). Optional: absent = render `lines`. Added in the Phase 14 Wave 4 audit.
   */
  noticed?: string[];
  /** Buildings with no path access in no neighborhood (the tab's "{n} buildings have no path access ..." line). */
  unreachedCount?: number;
}
