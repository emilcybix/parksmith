import { GAME_CONFIG } from '../config';
import { plainNumber } from '../save/plainData';
import type { ScenarioState, Serializable } from '../save/state';
import { MAXIMUM_SAVED_AMOUNT, MAXIMUM_SAVED_SECONDS } from '../save/ranges';
import { invalidState, SaveError } from '../save/version';
import { compileParkRules } from './rules';
import {
  METRIC_LABELS,
  type ObjectiveComparison,
  type ObjectiveMetric,
  type ObjectiveProgressSnapshot,
  type ScenarioDefinition,
  type ScenarioEvent,
  type ScenarioMetrics,
  type ScenarioSnapshot,
  type ScenarioStatus,
} from './types';

const EPSILON = 1e-9;
const OWNER = 'ScenarioSimulation';
const STATUSES: readonly ScenarioStatus[] = ['running', 'succeeded', 'failed'];

const emptyMetrics = (): ScenarioMetrics => ({
  cumulativeGuests: 0,
  guestCount: 0,
  parkRating: 0,
  averageHappiness: null,
  operatingProfit: 0,
  averageQueueSeconds: 0,
});

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const round = (value: number, decimals = 1): number => {
  const multiplier = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
};

const formatClock = (seconds: number): string => {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
};

const metricValue = (metrics: ScenarioMetrics, metric: ObjectiveMetric): number | null => {
  const value = metrics[metric];
  return value !== null && value !== undefined && Number.isFinite(value) ? value : null;
};

const meetsComparison = (value: number, comparison: ObjectiveComparison, target: number): boolean =>
  comparison === 'atLeast' ? value + EPSILON >= target : value <= target + EPSILON;

/**
 * Evaluates one scenario's primary objective and deadline against typed simulation
 * metrics. Status latches on the first success or failure; the session decides what
 * a finished park means for the wider campaign.
 */
export class ScenarioSimulation implements Serializable<ScenarioState> {
  private status: ScenarioStatus = 'running';
  private elapsedSeconds = 0;
  private sustainedSeconds = 0;
  private longestSustainedSeconds = 0;
  private completedAtSeconds: number | null = null;
  private resultEvidence: string | null = null;
  private latestMetrics: ScenarioMetrics = emptyMetrics();
  private pendingEvents: ScenarioEvent[] = [];
  private readonly lockedDefinitionIds: readonly string[];

  constructor(private readonly definition: ScenarioDefinition) {
    this.lockedDefinitionIds = compileParkRules(definition.rules).lockedDefinitionIds;
  }

  get currentStatus(): ScenarioStatus {
    return this.status;
  }

  step(stepMs: number, metrics: ScenarioMetrics): void {
    this.latestMetrics = { ...metrics };
    if (this.status !== 'running') return;
    const deltaSeconds = Number.isFinite(stepMs) ? Math.max(0, stepMs) / 1_000 : 0;
    this.elapsedSeconds += deltaSeconds;

    const objective = this.definition.objective;
    const current = metricValue(metrics, objective.metric);
    if (objective.kind === 'sustain') {
      const meets = current !== null && meetsComparison(current, objective.comparison, objective.target);
      if (meets) this.sustainedSeconds += deltaSeconds;
      else this.sustainedSeconds = 0;
      this.longestSustainedSeconds = Math.max(this.longestSustainedSeconds, this.sustainedSeconds);
      if (this.sustainedSeconds + EPSILON >= objective.durationSeconds) this.succeed(current);
    } else if (current !== null && current + EPSILON >= objective.target) {
      this.succeed(current);
    }

    // Success on the deadline tick counts: the objective is checked before time expires.
    if (this.status === 'running' && this.elapsedSeconds + EPSILON >= this.definition.timeLimitSeconds) {
      this.fail(current);
    }
  }

  drainEvents(): ScenarioEvent[] {
    const events = this.pendingEvents.map((event) => ({ ...event }));
    this.pendingEvents = [];
    return events;
  }

  snapshot(): ScenarioSnapshot {
    return {
      scenarioId: this.definition.id,
      name: this.definition.name,
      status: this.status,
      elapsedSeconds: round(this.elapsedSeconds),
      timeLimitSeconds: this.definition.timeLimitSeconds,
      timeLimitDays: this.definition.timeLimitDays ?? null,
      remainingSeconds: round(Math.max(0, this.definition.timeLimitSeconds - this.elapsedSeconds)),
      remainingDays: round(Math.max(0, this.definition.timeLimitSeconds - this.elapsedSeconds) / GAME_CONFIG.calendar.defaultDayLengthSeconds),
      objective: this.objectiveSnapshot(),
      constraint: this.definition.constraint ? { ...this.definition.constraint } : null,
      lockedDefinitionIds: [...this.lockedDefinitionIds],
      cardSlots: this.definition.cardSlots,
      seed: this.definition.seed,
      completedAtSeconds: this.completedAtSeconds,
      resultEvidence: this.resultEvidence,
    };
  }

  private objectiveSnapshot(): ObjectiveProgressSnapshot {
    const objective = this.definition.objective;
    const current = metricValue(this.latestMetrics, objective.metric);
    const remaining = Math.max(0, this.definition.timeLimitSeconds - this.elapsedSeconds);
    const sustain = objective.kind === 'sustain';
    const requiredSustainSeconds = sustain ? objective.durationSeconds : 0;
    const comparison: ObjectiveComparison = sustain ? objective.comparison : 'atLeast';

    let progressPercent: number;
    let projectedValue: number | null = null;
    let onPace: boolean;
    if (sustain) {
      progressPercent = requiredSustainSeconds > 0
        ? Math.min(100, this.sustainedSeconds / requiredSustainSeconds * 100)
        : 100;
      const meetsNow = current !== null && meetsComparison(current, comparison, objective.target);
      onPace = this.status === 'succeeded'
        || (this.status === 'running' && meetsNow
          && remaining + EPSILON >= requiredSustainSeconds - this.sustainedSeconds);
    } else {
      progressPercent = objective.target > 0
        ? Math.min(100, Math.max(0, (current ?? 0) / objective.target * 100))
        : 100;
      projectedValue = this.elapsedSeconds > 0 && current !== null
        ? round(current / this.elapsedSeconds * this.definition.timeLimitSeconds)
        : null;
      onPace = this.status === 'succeeded'
        || (this.status === 'running'
          && (projectedValue === null || projectedValue + EPSILON >= objective.target));
    }
    if (this.status === 'failed') onPace = false;

    return {
      id: objective.id,
      name: objective.name,
      kind: objective.kind,
      metric: objective.metric,
      comparison,
      target: objective.target,
      current: current === null ? null : round(current),
      progressPercent: round(progressPercent),
      sustainedSeconds: round(this.sustainedSeconds),
      requiredSustainSeconds,
      longestSustainedSeconds: round(this.longestSustainedSeconds),
      projectedValue,
      onPace,
    };
  }

  private succeed(current: number | null): void {
    const objective = this.definition.objective;
    const label = METRIC_LABELS[objective.metric];
    const spare = Math.max(0, this.definition.timeLimitSeconds - this.elapsedSeconds);
    this.finish('succeeded', objective.kind === 'sustain'
      ? `Held ${label} ${objective.comparison === 'atMost' ? 'at or below' : 'at or above'} `
        + `${objective.target} for ${formatClock(objective.durationSeconds)} straight, `
        + `with ${formatClock(spare)} still on the clock.`
      : `Reached ${round(current ?? objective.target)} ${label} `
        + `(target ${objective.target}) with ${formatClock(spare)} to spare.`);
  }

  private fail(current: number | null): void {
    const objective = this.definition.objective;
    const label = METRIC_LABELS[objective.metric];
    this.finish('failed', objective.kind === 'sustain'
      ? `Time expired: the longest ${label} streak was `
        + `${formatClock(this.longestSustainedSeconds)} of the required `
        + `${formatClock(objective.durationSeconds)}.`
      : `Time expired at ${round(current ?? 0)} of ${objective.target} ${label}.`);
  }

  /**
   * Development only (the `__parksmithDev` hooks, never the app flow): latches a result now, with the same event a real
   * result emits. A finished scenario ignores it.
   */
  forceResultForDevelopment(status: 'succeeded' | 'failed'): void {
    if (this.status !== 'running') return;
    this.finish(status, 'Forced by a developer hook.');
  }

  private finish(status: 'succeeded' | 'failed', evidence: string): void {
    this.status = status;
    this.completedAtSeconds = round(this.elapsedSeconds);
    this.resultEvidence = evidence;
    this.pendingEvents.push({
      kind: status === 'succeeded' ? 'scenarioSucceeded' : 'scenarioFailed',
      scenarioId: this.definition.id,
      atSeconds: this.completedAtSeconds,
      evidence,
    });
  }

  /** Pure copy; round() upstream can produce -0, so every number goes through plainNumber. */
  serialize(): ScenarioState {
    return {
      scenarioId: this.definition.id,
      status: this.status,
      elapsedSeconds: plainNumber(this.elapsedSeconds, 'elapsedSeconds'),
      sustainedSeconds: plainNumber(this.sustainedSeconds, 'sustainedSeconds'),
      longestSustainedSeconds: plainNumber(this.longestSustainedSeconds, 'longestSustainedSeconds'),
      completedAtSeconds: this.completedAtSeconds === null
        ? null
        : plainNumber(this.completedAtSeconds, 'completedAtSeconds'),
      resultEvidence: this.resultEvidence,
      latestMetrics: {
        cumulativeGuests: plainNumber(this.latestMetrics.cumulativeGuests, 'latestMetrics.cumulativeGuests'),
        guestCount: plainNumber(this.latestMetrics.guestCount, 'latestMetrics.guestCount'),
        parkRating: plainNumber(this.latestMetrics.parkRating, 'latestMetrics.parkRating'),
        averageHappiness: this.latestMetrics.averageHappiness === null
          ? null
          : plainNumber(this.latestMetrics.averageHappiness, 'latestMetrics.averageHappiness'),
        operatingProfit: plainNumber(this.latestMetrics.operatingProfit, 'latestMetrics.operatingProfit'),
        averageQueueSeconds: plainNumber(this.latestMetrics.averageQueueSeconds, 'latestMetrics.averageQueueSeconds'),
        ...(this.latestMetrics.ownedParcels === undefined
          ? {}
          : { ownedParcels: plainNumber(this.latestMetrics.ownedParcels, 'latestMetrics.ownedParcels') }),
      },
      pendingEvents: this.pendingEvents.map((event, index) => ({
        kind: event.kind,
        scenarioId: event.scenarioId,
        atSeconds: plainNumber(event.atSeconds, `pendingEvents[${index}].atSeconds`),
        evidence: event.evidence,
      })),
    };
  }

  /**
   * Validates, then resets all eight fields and applies. The status latch is restored as saved,
   * so a finished scenario never emits a second result event. `lockedDefinitionIds` is CONFIG.
   */
  restore(state: ScenarioState): void {
    if (!isRecord(state)) throw invalidState(OWNER, 'state', 'is not an object');
    if (state.scenarioId !== this.definition.id) {
      throw new SaveError(
        'content-mismatch',
        `${OWNER} cannot restore: save is for scenario '${String(state.scenarioId)}' but this park runs '${this.definition.id}'`,
      );
    }
    if (typeof state.status !== 'string' || !STATUSES.includes(state.status)) {
      throw invalidState(OWNER, 'status', `must be one of ${STATUSES.join(', ')}`);
    }
    const status = state.status;
    const finite = (value: unknown, path: string): number => {
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAXIMUM_SAVED_AMOUNT) {
        throw invalidState(OWNER, path, `must be a finite number within +-${MAXIMUM_SAVED_AMOUNT}`);
      }
      return value === 0 ? 0 : value;
    };
    const nonNegative = (value: unknown, path: string): number => {
      const number = finite(value, path);
      if (number < 0 || number > MAXIMUM_SAVED_SECONDS) throw invalidState(OWNER, path, `must be within 0..${MAXIMUM_SAVED_SECONDS}`);
      return number;
    };
    const elapsedSeconds = nonNegative(state.elapsedSeconds, 'elapsedSeconds');
    const sustainedSeconds = nonNegative(state.sustainedSeconds, 'sustainedSeconds');
    const longestSustainedSeconds = nonNegative(state.longestSustainedSeconds, 'longestSustainedSeconds');
    // Sustain streaks are sums of the same step lengths the elapsed clock sums, so neither can
    // outrun it (the tolerance covers float addition order); the best streak is never below the current.
    if (sustainedSeconds > elapsedSeconds + 1e-6) throw invalidState(OWNER, 'sustainedSeconds', 'exceeds elapsedSeconds');
    if (longestSustainedSeconds > elapsedSeconds + 1e-6) throw invalidState(OWNER, 'longestSustainedSeconds', 'exceeds elapsedSeconds');
    if (longestSustainedSeconds + 1e-6 < sustainedSeconds) throw invalidState(OWNER, 'longestSustainedSeconds', 'is below sustainedSeconds');
    if (state.completedAtSeconds === null) {
      if (status !== 'running') throw invalidState(OWNER, 'completedAtSeconds', 'must be set once the scenario has finished');
    } else if (status === 'running') {
      throw invalidState(OWNER, 'completedAtSeconds', 'must be null while the scenario is running');
    }
    const completedAtSeconds = state.completedAtSeconds === null ? null : nonNegative(state.completedAtSeconds, 'completedAtSeconds');
    if (state.resultEvidence !== null && typeof state.resultEvidence !== 'string') {
      throw invalidState(OWNER, 'resultEvidence', 'must be a string or null');
    }
    const resultEvidence = state.resultEvidence;
    if (!isRecord(state.latestMetrics)) throw invalidState(OWNER, 'latestMetrics', 'must be an object');
    const metrics = state.latestMetrics;
    const latestMetrics: ScenarioMetrics = {
      cumulativeGuests: finite(metrics.cumulativeGuests, 'latestMetrics.cumulativeGuests'),
      guestCount: finite(metrics.guestCount, 'latestMetrics.guestCount'),
      parkRating: finite(metrics.parkRating, 'latestMetrics.parkRating'),
      averageHappiness: metrics.averageHappiness === null
        ? null
        : finite(metrics.averageHappiness, 'latestMetrics.averageHappiness'),
      operatingProfit: finite(metrics.operatingProfit, 'latestMetrics.operatingProfit'),
      averageQueueSeconds: finite(metrics.averageQueueSeconds, 'latestMetrics.averageQueueSeconds'),
      // Phase 21: present only on a park with restricted land.
      ...(metrics.ownedParcels === undefined ? {} : { ownedParcels: finite(metrics.ownedParcels, 'latestMetrics.ownedParcels') }),
    };
    if (!Array.isArray(state.pendingEvents)) throw invalidState(OWNER, 'pendingEvents', 'must be an array');
    const pendingEvents = state.pendingEvents.map((raw: unknown, index): ScenarioEvent => {
      const path = `pendingEvents[${index}]`;
      if (!isRecord(raw)) throw invalidState(OWNER, path, 'must be an object');
      if (raw.kind !== 'scenarioSucceeded' && raw.kind !== 'scenarioFailed') {
        throw invalidState(OWNER, `${path}.kind`, 'must be scenarioSucceeded or scenarioFailed');
      }
      if (raw.scenarioId !== this.definition.id) {
        throw new SaveError('content-mismatch', `${OWNER} cannot restore: ${path}.scenarioId is not '${this.definition.id}'`);
      }
      if (typeof raw.evidence !== 'string') throw invalidState(OWNER, `${path}.evidence`, 'must be a string');
      return {
        kind: raw.kind,
        scenarioId: this.definition.id,
        atSeconds: nonNegative(raw.atSeconds, `${path}.atSeconds`),
        evidence: raw.evidence,
      };
    });

    this.status = 'running';
    this.elapsedSeconds = 0;
    this.sustainedSeconds = 0;
    this.longestSustainedSeconds = 0;
    this.completedAtSeconds = null;
    this.resultEvidence = null;
    this.latestMetrics = emptyMetrics();
    this.pendingEvents = [];

    this.status = status;
    this.elapsedSeconds = elapsedSeconds;
    this.sustainedSeconds = sustainedSeconds;
    this.longestSustainedSeconds = longestSustainedSeconds;
    this.completedAtSeconds = completedAtSeconds;
    this.resultEvidence = resultEvidence;
    this.latestMetrics = latestMetrics;
    this.pendingEvents = pendingEvents;
  }
}
