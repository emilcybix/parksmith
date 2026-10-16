import { describe, expect, it } from 'vitest';
import { createDigestOf, planDigestOf } from './testSupport';

// The app tsconfig has no node types: reach the built-ins through process (like generator.crossprocess.test.ts).
interface NodeBuiltins {
  process: { execPath: string; env: Record<string, string | undefined>; getBuiltinModule(id: string): never };
}
const nodeProcess = (globalThis as unknown as NodeBuiltins).process;
const { execFileSync } = nodeProcess.getBuiltinModule('node:child_process') as { execFileSync(file: string, args: string[], options: Record<string, unknown>): string };
const { mkdtempSync, rmSync, writeFileSync } = nodeProcess.getBuiltinModule('node:fs') as {
  mkdtempSync(prefix: string): string; rmSync(path: string, options: Record<string, unknown>): void; writeFileSync(path: string, data: string): void;
};
const { tmpdir } = nodeProcess.getBuiltinModule('node:os') as { tmpdir(): string };
const { join } = nodeProcess.getBuiltinModule('node:path') as { join(...parts: string[]): string };
const { fileURLToPath } = nodeProcess.getBuiltinModule('node:url') as { fileURLToPath(url: URL): string };

/**
 * Cross-process determinism (Phase 23): a SEPARATE node process (the run module bundled with rolldown) computes the
 * same two digests, in a different locale and time zone: no evaluation-order, module-state, clock, locale or float
 * dependence anywhere in the plan, the deck or the generator.
 */
describe('the run plan across processes', () => {
  it('a separate node process prints the same plan digest (1,000 seeds x 3) and the same run digest (50 runs, maps included)', () => {
    const directory = mkdtempSync(join(tmpdir(), 'parksmith-run-'));
    try {
      const support = fileURLToPath(new URL('./testSupport.ts', import.meta.url));
      writeFileSync(join(directory, 'child.ts'), `
        import { createDigestOf, planDigestOf } from ${JSON.stringify(support)};
        process.stdout.write(JSON.stringify({ plan: planDigestOf(1000), create: createDigestOf(50) }));
      `);
      const rolldown = fileURLToPath(new URL('../../../node_modules/.bin/rolldown', import.meta.url));
      execFileSync(rolldown, [join(directory, 'child.ts'), '--file', join(directory, 'child.mjs'), '--format', 'esm', '--platform', 'node'], { stdio: 'pipe' });
      const printed = JSON.parse(execFileSync(nodeProcess.execPath, [join(directory, 'child.mjs')], { encoding: 'utf8', env: { ...nodeProcess.env, LANG: 'tr_TR.UTF-8', TZ: 'Pacific/Kiritimati' } })) as { plan: string; create: string };
      expect(printed.plan).toBe(planDigestOf(1_000));
      expect(printed.create).toBe(createDigestOf(50));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 240_000);
});
