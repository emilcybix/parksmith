/**
 * The slow camera drift behind the start screen: pure maths, no renderer, no clock of its own.
 *
 * The path is a sum of two sines in cell space, one that moves the view sideways on screen (it
 * changes x − y, the screen's horizontal axis in 2:1 isometric) and one that moves it a little up
 * and down (it changes x + y), at incommensurate periods so the drift never visibly repeats. The
 * amplitude is eased in over the first seconds, so the position AND the speed start at zero and the
 * hand-over from the entrance framing never jerks.
 *
 * Two slower changes ride on the same clock (`sweepZoomStep`, `sweepDayPhase`): the zoom steps in whole levels (the
 * pixel art stays crisp, so a step is a cut, not a glide), and the time of day runs through a full day in a few minutes.
 *
 * `advance` writes into a reused object and allocates nothing, so it can run every frame. Under
 * reduced motion the caller simply does not advance it and the view stands still at the centre.
 */

export interface SweepPoint {
  x: number;
  y: number;
}

export interface CameraSweepOptions {
  /** The map's centre in cell coordinates. */
  centreX: number;
  centreY: number;
  /** How far the view moves sideways / vertically, in cells of x − y and x + y (half-ranges). */
  sideCells?: number;
  depthCells?: number;
  sidePeriodSeconds?: number;
  depthPeriodSeconds?: number;
  easeInSeconds?: number;
}

export const SWEEP_DEFAULTS = {
  sideCells: 5,
  depthCells: 2,
  sidePeriodSeconds: 84,
  depthPeriodSeconds: 133,
  easeInSeconds: 4,
  /** How long each zoom step is held; the steps cycle through ZOOM_STEPS. */
  zoomHoldSeconds: 16,
  /** One full day of light, midnight to midnight. */
  dayPeriodSeconds: 150,
} as const;

/** Zoom levels above the renderer's own, in order: out to the starting level, in one, in two, back one. */
export const ZOOM_STEPS = [0, 1, 2, 1] as const;

/** The zoom step (levels above the starting level) the sweep holds `seconds` after its start. */
export const sweepZoomStep = (seconds: number, holdSeconds: number = SWEEP_DEFAULTS.zoomHoldSeconds): number => (
  ZOOM_STEPS[Math.floor(Math.max(0, seconds) / holdSeconds) % ZOOM_STEPS.length]
);

/**
 * The clock fraction of the day (0 = midnight, 0.5 = noon) the sweep shows `seconds` after its start, beginning at
 * `startPhase`. Its speed eases in like the drift's amplitude (it is the integral of the same smoothstep), so the light
 * starts still and never jumps at the hand-over.
 */
export const sweepDayPhase = (
  seconds: number,
  startPhase: number,
  periodSeconds: number = SWEEP_DEFAULTS.dayPeriodSeconds,
  easeInSeconds: number = SWEEP_DEFAULTS.easeInSeconds,
): number => {
  const t = Math.max(0, seconds);
  const s = t / easeInSeconds;
  const eased = s >= 1 ? t - easeInSeconds / 2 : easeInSeconds * (s ** 3 - s ** 4 / 2);
  const phase = (startPhase + eased / periodSeconds) % 1;
  return phase < 0 ? phase + 1 : phase;
};

const smooth = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export interface CameraSweep {
  /** Back to the centre, as at the first frame. */
  reset(): void;
  /** Advances by real time and writes the centre of the view into `out`. */
  advance(deltaMs: number, out: SweepPoint): SweepPoint;
  /** The map's centre moved (a different park, Phase 24): the drift is about the new centre from the next write. */
  setCentre(centreX: number, centreY: number): void;
  /** Writes the current centre without advancing (the still frame under reduced motion). */
  current(out: SweepPoint): SweepPoint;
  readonly elapsedSeconds: number;
}

export const createCameraSweep = (options: CameraSweepOptions): CameraSweep => {
  const side = options.sideCells ?? SWEEP_DEFAULTS.sideCells;
  const depth = options.depthCells ?? SWEEP_DEFAULTS.depthCells;
  const sidePeriod = options.sidePeriodSeconds ?? SWEEP_DEFAULTS.sidePeriodSeconds;
  const depthPeriod = options.depthPeriodSeconds ?? SWEEP_DEFAULTS.depthPeriodSeconds;
  const easeIn = options.easeInSeconds ?? SWEEP_DEFAULTS.easeInSeconds;
  let seconds = 0;
  let centreX = options.centreX;
  let centreY = options.centreY;

  const write = (out: SweepPoint): SweepPoint => {
    const ramp = smooth(seconds / easeIn);
    // u moves x - y (sideways on screen), v moves x + y (up and down); x = c + (u + v) / 2, y = c + (v - u) / 2.
    const u = side * ramp * Math.sin((2 * Math.PI * seconds) / sidePeriod);
    const v = depth * ramp * Math.sin((2 * Math.PI * seconds) / depthPeriod + 1);
    out.x = centreX + (u + v) / 2;
    out.y = centreY + (v - u) / 2;
    return out;
  };

  return {
    reset() { seconds = 0; },
    setCentre(x, y) { centreX = x; centreY = y; },
    advance(deltaMs, out) {
      // A background tab or a long frame must not make the camera jump: one frame moves it at most 100 ms.
      if (Number.isFinite(deltaMs) && deltaMs > 0) seconds += Math.min(deltaMs, 100) / 1000;
      return write(out);
    },
    current: write,
    get elapsedSeconds() { return seconds; },
  };
};
