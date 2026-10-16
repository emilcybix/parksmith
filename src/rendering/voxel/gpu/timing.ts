/**
 * Per-pass GPU time for the voxel pipeline, from EXT_disjoint_timer_query_webgl2 when the browser
 * offers it (it does headless too). Recorded, never gated (design §13): SwiftShader timings say
 * nothing about a real iGPU, but on real hardware — and as a relative regression metric everywhere —
 * the G-buffer / light / composite / upscale split is the number that shows where a frame goes.
 *
 * Queries resolve a frame or more after they were issued, so each pass owns a small ring of query
 * objects: a slot whose result has not arrived yet is skipped for that frame rather than reused (a
 * reused query would stall the pipeline), and results are only read once QUERY_RESULT_AVAILABLE says
 * so. When the GPU reports a disjoint event (a clock change, a context switch) every result read in
 * that poll is discarded, as the extension requires. Nothing is allocated once constructed.
 */

export const VOXEL_GPU_PASSES = ['gbuffer', 'light', 'composite', 'upscale'] as const;
export type VoxelGpuPass = (typeof VOXEL_GPU_PASSES)[number];

export const PASS_GBUFFER = 0;
export const PASS_LIGHT = 1;
export const PASS_COMPOSITE = 2;
export const PASS_UPSCALE = 3;
export const PASS_COUNT = VOXEL_GPU_PASSES.length;

/** Frames of queries in flight per pass before a pass skips timing (results usually take 1–2). */
export const TIMER_QUERY_FRAMES = 4;
/** Weight of a new sample in each pass's running average. */
export const TIMER_SMOOTHING = 0.1;

const NANOSECONDS_PER_MILLISECOND = 1e6;

export const TIMER_QUERY_EXTENSION = 'EXT_disjoint_timer_query_webgl2';

/** The WebGL2 calls the timer makes: a real context, or a fake in Node tests. */
export interface TimerQueryContext {
  readonly QUERY_RESULT: number;
  readonly QUERY_RESULT_AVAILABLE: number;
  getExtension(name: typeof TIMER_QUERY_EXTENSION): unknown;
  createQuery(): WebGLQuery | null;
  deleteQuery(query: WebGLQuery | null): void;
  beginQuery(target: number, query: WebGLQuery): void;
  endQuery(target: number): void;
  getQueryParameter(query: WebGLQuery, parameter: number): unknown;
  getParameter(parameter: number): unknown;
}

/** The two enums of EXT_disjoint_timer_query_webgl2 the timer needs. */
export interface TimerQueryExtension {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

/** Smoothed milliseconds per pass, in VOXEL_GPU_PASSES order, plus how many samples each has. */
export interface GpuPassTimings {
  readonly milliseconds: Float64Array;
  readonly samples: Uint32Array;
}

/** Running average that starts at the first sample instead of creeping up from zero. */
export const smoothedMilliseconds = (previous: number, sample: number, samplesBefore: number): number =>
  samplesBefore === 0 ? sample : previous + (sample - previous) * TIMER_SMOOTHING;

export class GpuPassTimer implements GpuPassTimings {
  readonly milliseconds = new Float64Array(PASS_COUNT);
  readonly samples = new Uint32Array(PASS_COUNT);
  private readonly queries: (WebGLQuery | null)[] = [];
  /** 1 while a slot's query has been issued and its result not read yet. */
  private readonly pending = new Uint8Array(PASS_COUNT * TIMER_QUERY_FRAMES);
  /** Results read in the current poll, applied only if the poll saw no disjoint event. */
  private readonly polled = new Float64Array(PASS_COUNT * TIMER_QUERY_FRAMES);
  private readonly polledValid = new Uint8Array(PASS_COUNT * TIMER_QUERY_FRAMES);
  private frame = 0;
  private activeSlot = -1;
  private gl: TimerQueryContext;
  /** Null while the (restored) context does not offer the extension: then nothing is timed. */
  private extension: TimerQueryExtension | null;

  constructor(gl: TimerQueryContext, extension: TimerQueryExtension) {
    this.gl = gl;
    this.extension = extension;
    this.createQueries();
  }

  /** A timer for this context, or null when the extension is missing (most mobile browsers). */
  static create(gl: TimerQueryContext): GpuPassTimer | null {
    const extension = gl.getExtension(TIMER_QUERY_EXTENSION) as TimerQueryExtension | null;
    return extension ? new GpuPassTimer(gl, extension) : null;
  }

  /** Reads every result that has arrived, then moves to the next ring slot. Call once per frame. */
  beginFrame(): void {
    this.poll();
    this.frame = (this.frame + 1) % TIMER_QUERY_FRAMES;
  }

  /** Starts timing `pass` (PASS_*) unless its slot for this frame is still waiting for a result. */
  begin(pass: number): void {
    if (this.activeSlot >= 0) this.end();
    const slot = pass * TIMER_QUERY_FRAMES + this.frame;
    const query = this.queries[slot];
    if (!this.extension || this.pending[slot] === 1 || !query) return;
    this.gl.beginQuery(this.extension.TIME_ELAPSED_EXT, query);
    this.activeSlot = slot;
  }

  end(): void {
    if (this.activeSlot < 0 || !this.extension) return;
    this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
    this.pending[this.activeSlot] = 1;
    this.activeSlot = -1;
  }

  /**
   * After a context restore every query object and extension object belongs to the lost context:
   * enable the extension again (a restored context starts with none) and start over on `gl`. The
   * averages survive; they describe the same GPU.
   */
  reset(gl: TimerQueryContext): void {
    this.gl = gl;
    this.extension = gl.getExtension(TIMER_QUERY_EXTENSION) as TimerQueryExtension | null;
    this.pending.fill(0);
    this.polledValid.fill(0);
    this.activeSlot = -1;
    this.frame = 0;
    this.createQueries();
  }

  destroy(): void {
    for (const query of this.queries) this.gl.deleteQuery(query);
    this.queries.length = 0;
    this.pending.fill(0);
  }

  private createQueries(): void {
    this.queries.length = 0;
    for (let slot = 0; slot < PASS_COUNT * TIMER_QUERY_FRAMES; slot += 1) this.queries.push(this.gl.createQuery());
  }

  private poll(): void {
    const gl = this.gl;
    let any = false;
    for (let slot = 0; slot < this.pending.length; slot += 1) {
      this.polledValid[slot] = 0;
      const query = this.queries[slot];
      if (this.pending[slot] === 0 || !query) continue;
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) continue;
      this.polled[slot] = Number(gl.getQueryParameter(query, gl.QUERY_RESULT)) / NANOSECONDS_PER_MILLISECOND;
      this.polledValid[slot] = 1;
      this.pending[slot] = 0;
      any = true;
    }
    if (!any || !this.extension || gl.getParameter(this.extension.GPU_DISJOINT_EXT)) return;
    for (let slot = 0; slot < this.pending.length; slot += 1) {
      if (this.polledValid[slot] === 0) continue;
      const pass = Math.floor(slot / TIMER_QUERY_FRAMES);
      this.milliseconds[pass] = smoothedMilliseconds(this.milliseconds[pass], this.polled[slot], this.samples[pass]);
      this.samples[pass] += 1;
    }
  }
}
