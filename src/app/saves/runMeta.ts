import { BIOME_BY_ID } from '../../game/biomes/content';
import { isMapSeed } from '../../game/maps/recipe';
import { RUN_PHASES, isRunDifficulty, type RunSummary } from '../../game/run/types';

/** The run validator's bound for a plan version (run/validate.ts). */
const MAXIMUM_PLAN_VERSION = 0xffff;

const isInt = (value: unknown, minimum: number, maximum: number): value is number => (
  typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
);

/**
 * Phase 23: the run summary a slot row carries, read back from storage. A hostile or damaged value is dropped (the row
 * then shows the ordinary park texts), never repaired. The summary is display data only: the run itself lives in the
 * save payload and is validated there. Phase 25: an optional integer `planVersion` (written by `runSummaryOf`) tells the
 * Continue note whether the run was planned by this build.
 */
export const readRunSummary = (value: unknown): RunSummary | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  // Phase 25: `planVersion` is optional (headers written before it was added lack it); any other extra key is refused.
  const keys = Object.keys(record).filter((key) => key !== 'planVersion').sort().join(',');
  if (keys !== 'biomeId,difficulty,levelCount,levelNumber,levelsCleared,phase,seed') return null;
  if (Object.hasOwn(record, 'planVersion') && !isInt(record.planVersion, 1, MAXIMUM_PLAN_VERSION)) return null;
  if (!isMapSeed(record.seed) || !isRunDifficulty(record.difficulty)) return null;
  if (!isInt(record.levelCount, 1, 8) || !isInt(record.levelNumber, 1, 8) || record.levelNumber > record.levelCount) return null;
  if (!isInt(record.levelsCleared, 0, 8) || record.levelsCleared > record.levelCount) return null;
  if (typeof record.biomeId !== 'string' || !BIOME_BY_ID.has(record.biomeId as never)) return null;
  if (!RUN_PHASES.includes(record.phase as never)) return null;
  return {
    ...(Object.hasOwn(record, 'planVersion') ? { planVersion: record.planVersion as number } : {}),
    seed: record.seed,
    difficulty: record.difficulty,
    levelNumber: record.levelNumber,
    levelCount: record.levelCount,
    biomeId: record.biomeId as RunSummary['biomeId'],
    phase: record.phase as RunSummary['phase'],
    levelsCleared: record.levelsCleared,
  };
};
