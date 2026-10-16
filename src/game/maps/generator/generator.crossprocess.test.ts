import { describe, expect, it } from 'vitest';
import { BIOME_IDS } from '../../biomes/types';
import { hash32 } from '../../weather/random';
import { generateMap, generatedMapHash, recipeOf } from './index';

// The app tsconfig has no node types (like src/settings/motion.review.test.ts): reach the built-ins through process.
interface NodeBuiltins {
  process: {
    execPath: string;
    env: Record<string, string | undefined>;
    getBuiltinModule(id: string): never;
  };
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
 * Cross-process determinism (Phase 24 step 2): the generator is bundled with rolldown into a temporary .mjs and run by a
 * SEPARATE node process, which generates 60 recipes in REVERSE order and prints their hashes. They must equal this
 * process's hashes: no evaluation-order, module-state, locale or float dependence anywhere.
 */
const RECIPES = Array.from({ length: 60 }, (_, i) => ({
  biome: BIOME_IDS[i % 6],
  seed: hash32(i, 31),
  density: (['low', 'normal', 'high'] as const)[i % 3],
  water: i % 5 !== 0,
}));

describe('generator across processes', () => {
  it('a separate node process generating in reverse order prints the same 60 hashes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'parksmith-gen-'));
    try {
      const index = fileURLToPath(new URL('./index.ts', import.meta.url));
      writeFileSync(join(directory, 'child.ts'), `
        import { generateMap, generatedMapHash, recipeOf } from ${JSON.stringify(index)};
        const recipes = ${JSON.stringify(RECIPES)};
        const out = {};
        for (let i = recipes.length - 1; i >= 0; i -= 1) {
          const r = recipes[i];
          out[i] = generatedMapHash(generateMap(recipeOf(r.biome, r.seed, { density: r.density, water: r.water })));
        }
        process.stdout.write(JSON.stringify(out));
      `);
      const rolldown = fileURLToPath(new URL('../../../../node_modules/.bin/rolldown', import.meta.url));
      execFileSync(rolldown, [join(directory, 'child.ts'), '--file', join(directory, 'child.mjs'), '--format', 'esm', '--platform', 'node'], { stdio: 'pipe' });
      const printed = JSON.parse(execFileSync(nodeProcess.execPath, [join(directory, 'child.mjs')], { encoding: 'utf8', env: { ...nodeProcess.env, LANG: 'tr_TR.UTF-8', TZ: 'Pacific/Kiritimati' } })) as Record<string, string>;
      const here = RECIPES.map((r) => generatedMapHash(generateMap(recipeOf(r.biome, r.seed, { density: r.density, water: r.water }))));
      expect(Object.keys(printed).length).toBe(60);
      expect(RECIPES.map((_, i) => printed[i])).toEqual(here);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
