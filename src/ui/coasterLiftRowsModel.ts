import type { DraftLiftRun } from './store';

export interface LiftRowModel {
  start: number;
  label: string;
  chained: boolean;
  /** Text of the small verdict badge, or null when the hill is fine. */
  badge: 'crawls' | 'too long' | null;
  badgeTone: 'amber' | 'red' | null;
}

/** One row per lift of the draft: "Hill 2 · 3 pcs", its mode and, for a free climb that struggles, a badge. */
export const liftRowModels = (runs: readonly DraftLiftRun[]): LiftRowModel[] =>
  runs.map((run, index) => ({
    start: run.start,
    label: `Hill ${index + 1} · ${run.length} pc${run.length === 1 ? '' : 's'}`,
    chained: run.chained,
    badge: run.verdict === 'slow' ? 'crawls' : run.verdict === 'stalls' ? 'too long' : null,
    badgeTone: run.verdict === 'slow' ? 'amber' : run.verdict === 'stalls' ? 'red' : null,
  }));

/** The evidence line's tail: "1 chained / 1 free climbs", or null with no climbs. */
export const liftSummary = (runs: readonly DraftLiftRun[]): string | null => {
  if (runs.length === 0) return null;
  const free = runs.filter((run) => !run.chained).length;
  const chained = runs.length - free;
  return `${chained} chained / ${free} free climb${runs.length === 1 ? '' : 's'}`;
};
