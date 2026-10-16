import { GAME_CONFIG } from './config';
import { plainNumber } from './save/plainData';
import type { Serializable, SimulationClockState } from './save/state';
import { invalidState } from './save/version';
import type { GameSpeed } from './types';

/** The largest fraction below 1, so `stepFraction` never claims a step that has not run. */
const MAX_STEP_FRACTION = 1 - Number.EPSILON;

export class SimulationClock implements Serializable<SimulationClockState> {
  speed: GameSpeed = 1;
  simulationTimeMs = 0;
  lastStepDurationMs = 0;
  stepsLastFrame = 0;
  private accumulator = 0;

  constructor(private readonly onStep: (stepMs: number) => void) {}

  /**
   * Pausing keeps the accumulator. The renderer interpolates moving figures by `stepFraction`, and
   * zeroing it on every pause (the 0 key, every scenario result) snapped each walking guest back
   * toward its previous step; resuming now also continues the step that was in progress.
   */
  setSpeed(speed: GameSpeed): void {
    this.speed = speed;
  }

  /**
   * How far the simulation is between its last fixed step and the next one, in [0, 1). Frozen
   * while paused. A frame that hits the catch-up limit drops the backlog, so it reads 0 then.
   */
  get stepFraction(): number {
    return Math.min(MAX_STEP_FRACTION, Math.max(0, this.accumulator / GAME_CONFIG.fixedStepMs));
  }

  /**
   * Drops the partial step in progress. A new park is a new timeline: the old park's leftover
   * fraction must not make its first frame step early or interpolate its figures from a stale
   * point (pausing deliberately keeps it, see setSpeed).
   */
  resetAccumulator(): void {
    this.accumulator = 0;
  }

  serialize(): SimulationClockState {
    return {
      speed: this.speed,
      simulationTimeMs: plainNumber(this.simulationTimeMs, 'simulationTimeMs'),
    };
  }

  /**
   * The partial step in progress and the frame telemetry are not saved: a loaded park is a new
   * timeline (see resetAccumulator). `onStep` is the app's closure and is never touched.
   */
  restore(state: SimulationClockState): void {
    const speed: unknown = state?.speed;
    if (speed !== 0 && speed !== 1 && speed !== 2 && speed !== 4) {
      throw invalidState('SimulationClock', 'speed', `must be 0, 1, 2 or 4 (got ${String(speed)})`);
    }
    const time: unknown = state.simulationTimeMs;
    if (typeof time !== 'number' || !Number.isInteger(time) || time < 0) {
      throw invalidState('SimulationClock', 'simulationTimeMs', 'must be an integer >= 0');
    }
    this.speed = speed;
    this.simulationTimeMs = time === 0 ? 0 : time;
    this.accumulator = 0;
    this.lastStepDurationMs = 0;
    this.stepsLastFrame = 0;
  }

  update(realDeltaMs: number): number {
    this.stepsLastFrame = 0;
    if (this.speed === 0) return 0;
    this.accumulator += Math.min(realDeltaMs, 250) * this.speed;
    const started = performance.now();
    while (this.accumulator >= GAME_CONFIG.fixedStepMs && this.stepsLastFrame < GAME_CONFIG.maxCatchUpSteps) {
      this.onStep(GAME_CONFIG.fixedStepMs);
      this.simulationTimeMs += GAME_CONFIG.fixedStepMs;
      this.accumulator -= GAME_CONFIG.fixedStepMs;
      this.stepsLastFrame += 1;
    }
    if (this.stepsLastFrame === GAME_CONFIG.maxCatchUpSteps) this.accumulator = 0;
    this.lastStepDurationMs = performance.now() - started;
    return this.stepsLastFrame;
  }
}
