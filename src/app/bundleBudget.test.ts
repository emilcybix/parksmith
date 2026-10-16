import { describe, expect, it } from 'vitest';

/**
 * Phase 34: the bundle budget. Builds the production bundle in memory (vite's `build()` with `write: false`, the real
 * vite.config.ts, so the same chunking as `yarn build`) and fails when the initial load grows past the recorded budget.
 *
 * Two numbers, both gzip (what the player downloads), measured the same way here and recorded in IMPLEMENTATION_PLAN.md
 * (Phase 34):
 * - the entry chunk (`index-*.js`), the "main chunk" that Vite's size warning is about;
 * - the initial load: the entry plus every chunk it imports statically (rolldown moves code shared with a lazy chunk
 *   into small common chunks, so the entry alone can shrink while the first download does not).
 * Each budget is the measured size plus about 5 %. Raising one is a decision: record why in the plan.
 *
 * Opt-in: `BUNDLE_BUDGET=1 yarn -s test src/app/bundleBudget.test.ts`. A production build inside the suite adds several
 * seconds and competes with ~200 test files for the CPU, so the default run skips it; the measuring helpers below
 * are checked on every run. `yarn build` itself warns above `chunkSizeWarningLimit` (vite.config.ts).
 */

/**
 * Gzip bytes (CompressionStream, default level; Vite's report differs by under 1 %). Measured in Phase 34 (2026-10-15):
 * entry 287,239 B, initial load 345,911 B (10 files); budget = measured + 5 %, rounded up to 100 B.
 */
export const BUNDLE_BUDGET = {
  entryGzipBytes: 301_700,
  initialGzipBytes: 363_300,
} as const;

interface ChunkInfo {
  fileName: string;
  code: string;
  isEntry: boolean;
  imports: readonly string[];
}

const gzipBytes = async (text: string): Promise<number> => {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return (await new Response(stream).arrayBuffer()).byteLength;
};

/** The entry chunk and every chunk reachable from it through static imports. */
export const initialChunks = (chunks: readonly ChunkInfo[]): ChunkInfo[] => {
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const entries = chunks.filter((chunk) => chunk.isEntry);
  if (entries.length !== 1) throw new Error(`expected one entry chunk, got ${entries.length}`);
  const seen = new Map<string, ChunkInfo>([[entries[0].fileName, entries[0]]]);
  const queue = [entries[0]];
  while (queue.length > 0) {
    for (const name of queue.pop()!.imports) {
      const chunk = byName.get(name);
      if (chunk !== undefined && !seen.has(name)) {
        seen.set(name, chunk);
        queue.push(chunk);
      }
    }
  }
  return [...seen.values()];
};

export interface BundleMeasure {
  entry: { fileName: string; rawBytes: number; gzipBytes: number };
  initial: { files: string[]; rawBytes: number; gzipBytes: number };
}

export const measureBundle = async (chunks: readonly ChunkInfo[]): Promise<BundleMeasure> => {
  const initial = initialChunks(chunks);
  const sizes = await Promise.all(initial.map(async (chunk) => ({ raw: new Blob([chunk.code]).size, gzip: await gzipBytes(chunk.code) })));
  return {
    entry: { fileName: initial[0].fileName, rawBytes: sizes[0].raw, gzipBytes: sizes[0].gzip },
    initial: {
      files: initial.map((chunk) => chunk.fileName),
      rawBytes: sizes.reduce((sum, size) => sum + size.raw, 0),
      gzipBytes: sizes.reduce((sum, size) => sum + size.gzip, 0),
    },
  };
};

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

describe('bundle budget helpers', () => {
  it('follows static imports from the one entry and ignores chunks it does not import', () => {
    const chunk = (fileName: string, imports: string[], isEntry = false): ChunkInfo => ({ fileName, code: fileName, isEntry, imports });
    const chunks = [chunk('index.js', ['a.js', 'b.js'], true), chunk('a.js', ['c.js']), chunk('b.js', []), chunk('c.js', ['a.js']), chunk('lazy.js', ['a.js'])];
    expect(initialChunks(chunks).map((each) => each.fileName).sort()).toEqual(['a.js', 'b.js', 'c.js', 'index.js']);
    expect(() => initialChunks([chunk('a.js', [])])).toThrow(/one entry/);
  });

  it('measures gzip bytes smaller than raw for repetitive text', async () => {
    const code = 'export const x = 1;\n'.repeat(500);
    const measure = await measureBundle([{ fileName: 'index.js', code, isEntry: true, imports: [] }]);
    expect(measure.entry.rawBytes).toBe(code.length);
    expect(measure.entry.gzipBytes).toBeGreaterThan(0);
    expect(measure.entry.gzipBytes).toBeLessThan(code.length / 10);
    expect(measure.initial.gzipBytes).toBe(measure.entry.gzipBytes);
  });
});

describe.runIf(env.BUNDLE_BUDGET === '1')('bundle budget (BUNDLE_BUDGET=1)', () => {
  it('the entry chunk and the initial load stay within the recorded gzip budget', async () => {
    const { build } = await import('vite');
    const root = new URL('../..', import.meta.url).pathname;
    // Vitest sets NODE_ENV=test, which would make vite bundle React's development build: measure what `yarn build` ships.
    const nodeEnv = env.NODE_ENV;
    env.NODE_ENV = 'production';
    let result: Awaited<ReturnType<typeof build>>;
    try {
      result = await build({ root, mode: 'production', configFile: `${root}vite.config.ts`, logLevel: 'silent', build: { write: false } });
    } finally {
      if (nodeEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = nodeEnv;
    }
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((each) => ('output' in each ? each.output : []));
    const chunks: ChunkInfo[] = outputs.flatMap((item) => (item.type === 'chunk'
      ? [{ fileName: item.fileName, code: item.code, isEntry: item.isEntry, imports: item.imports }]
      : []));
    const measure = await measureBundle(chunks);
    console.info(`[bundle budget] entry ${measure.entry.fileName}: ${measure.entry.rawBytes} B raw, ${measure.entry.gzipBytes} B gzip `
      + `(budget ${BUNDLE_BUDGET.entryGzipBytes}); initial load ${measure.initial.files.length} files: ${measure.initial.rawBytes} B raw, `
      + `${measure.initial.gzipBytes} B gzip (budget ${BUNDLE_BUDGET.initialGzipBytes})`);
    expect(measure.entry.gzipBytes, 'entry chunk gzip bytes').toBeLessThanOrEqual(BUNDLE_BUDGET.entryGzipBytes);
    expect(measure.initial.gzipBytes, 'initial load gzip bytes').toBeLessThanOrEqual(BUNDLE_BUDGET.initialGzipBytes);
  }, 120_000);
});
