/**
 * The slow camera drift behind the start screen: pure maths, no renderer, no clock of its own.
 *
 * The path is a sum of two sines in cell space, one that moves the view sideways on screen (it
 * changes x − y, the screen's horizontal axis in 2:1 isometric) and one that moves it a little up
 * and down (it changes x + y), at incommensurate periods so the drift never visibly repeats. The
 * amplitude is eased in over the first seconds, so the position AND the speed start at zero and the
 * hand-over from the entrance framing never jerks. The zoom is not part of it: it stays at whatever
 * integer level the renderer chose.
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
} as const;

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
