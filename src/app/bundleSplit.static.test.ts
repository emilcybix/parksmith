import { describe, expect, it } from 'vitest';

/**
 * Phase 34 (bundle budget and load split): which modules the main chunk may reach. Rollup/rolldown puts every module
 * that the entry reaches through STATIC imports into the initial load, so these checks walk the static import graph of
 * the sources (type-only imports are erased and do not count; `import()` is a split point and is not followed).
 *
 * The runtime twin of the renderer checks is `GameApp.classic.test.ts` (classic never evaluates the voxel module).
 * The size budget itself is `bundleBudget.test.ts`.
 */
const sources = import.meta.glob('/src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const modules = new Map(Object.entries(sources).filter(([path]) => !/\.test\.tsx?$/.test(path)));

const STATIC_IMPORT = /^\s*(?:import|export)\s+([^;]*?)\s*from\s*'([^']+)'/gm;
const SIDE_EFFECT_IMPORT = /^\s*import\s+'([^']+)'/gm;
const DYNAMIC_IMPORT = /\bimport\(\s*'([^']+)'\s*\)/g;

const typeOnly = (clause: string): boolean => {
  const trimmed = clause.trim();
  if (trimmed.startsWith('type ')) return true;
  const braces = /^\{([\s\S]*)\}$/.exec(trimmed);
  if (!braces) return false;
  const names = braces[1].split(',').map((name) => name.trim()).filter((name) => name !== '');
  return names.length > 0 && names.every((name) => name.startsWith('type '));
};

const normalise = (path: string): string => {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') out.pop();
    else if (part !== '.' && part !== '') out.push(part);
  }
  return `/${out.join('/')}`;
};

/** A relative specifier resolved to a module key; a package becomes `pkg:<name>`; CSS and the like return null. */
const resolve = (from: string, specifier: string): string | null => {
  if (!specifier.startsWith('.')) {
    const parts = specifier.split('/');
    return `pkg:${specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]}`;
  }
  const base = normalise(`${from.slice(0, from.lastIndexOf('/'))}/${specifier}`);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (modules.has(candidate)) return candidate;
  }
  if (/\.(css|json|svg|png)(\?.*)?$/.test(specifier) || specifier.includes('?')) return null;
  throw new Error(`${from}: cannot resolve '${specifier}'`);
};

const staticImportsOf = (path: string): string[] => {
  const text = modules.get(path);
  if (text === undefined) throw new Error(`no module ${path}`);
  const found: string[] = [];
  for (const match of text.matchAll(STATIC_IMPORT)) {
    if (typeOnly(match[1])) continue;
    const target = resolve(path, match[2]);
    if (target !== null) found.push(target);
  }
  for (const match of text.matchAll(SIDE_EFFECT_IMPORT)) {
    const target = resolve(path, match[1]);
    if (target !== null) found.push(target);
  }
  return found;
};

const dynamicImportsOf = (path: string): string[] => (
  [...(modules.get(path) ?? '').matchAll(DYNAMIC_IMPORT)].map((match) => resolve(path, match[1])).filter((target): target is string => target !== null)
);

/** Every module (and package) reachable from `entry` through static imports, the entry included. */
const staticClosure = (entry: string): Set<string> => {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const next = queue.pop()!;
    if (next.startsWith('pkg:')) continue;
    for (const target of staticImportsOf(next)) {
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return seen;
};

const ENTRY = '/src/main.tsx';
const isClassic = (path: string): boolean => path === '/src/rendering/WorldRenderer.ts' || /^\/src\/rendering\/classic[A-Z]\w*\.ts$/.test(path);
/**
 * `voxel/gpu/glFailure.ts` is pure string and plan logic (URL flag parsing, degrade labels) with no WebGL, shared with
 * `app/rendererFlag.ts`; it has always been in the main chunk and is not part of the voxel renderer.
 */
const SHARED_VOXEL_HELPERS = new Set(['/src/rendering/voxel/gpu/glFailure.ts']);
const isVoxel = (path: string): boolean => path.startsWith('/src/rendering/voxel/') && !SHARED_VOXEL_HELPERS.has(path);

/** Modules that must stay out of the initial load: each is reached only through an `import()`. */
const LAZY_ONLY = [
  'pkg:pixi.js',
  '/src/rendering/WorldRenderer.ts',
  '/src/rendering/voxel/VoxelRenderer.ts',
  '/src/app/saves/loadSave.ts',
  '/src/game/session/fromSave.ts',
  '/src/game/save/migrate.ts',
  '/src/ui/SettingsDialog.tsx',
  '/src/ui/KeyboardSettings.tsx',
  '/src/ui/SaveLoadDialog.tsx',
  '/src/ui/PaintPanel.tsx',
] as const;

describe('the static import graph keeps the lazy chunks lazy', () => {
  const main = staticClosure(ENTRY);

  it('walks a real graph', () => {
    expect(modules.size).toBeGreaterThan(300);
    expect(main.size).toBeGreaterThan(200);
    for (const needed of ['/src/app/GameApp.ts', '/src/game/session/ParkSession.ts', '/src/game/save/version.ts', '/src/ui/lazyPanels.tsx', 'pkg:react-dom']) {
      expect(main.has(needed), needed).toBe(true);
    }
  });

  it.each(LAZY_ONLY)('the main chunk does not reach %s statically', (module) => {
    expect(main.has(module)).toBe(false);
  });

  it('the main chunk reaches no classic and no voxel renderer module', () => {
    expect([...main].filter((path) => isClassic(path) || isVoxel(path))).toEqual([]);
  });

  it('GameApp reaches both renderers and the load path through import() only', () => {
    expect(dynamicImportsOf('/src/app/GameApp.ts')).toEqual(expect.arrayContaining([
      '/src/rendering/WorldRenderer.ts', '/src/rendering/voxel/VoxelRenderer.ts', '/src/app/saves/loadSave.ts',
    ]));
  });

  it('the panels are reached through import() from lazyPanels.tsx', () => {
    expect(dynamicImportsOf('/src/ui/lazyPanels.tsx').sort()).toEqual(['/src/ui/PaintPanel.tsx', '/src/ui/SaveLoadDialog.tsx', '/src/ui/SettingsDialog.tsx']);
  });

  it('the voxel renderer never loads the classic renderer', () => {
    const voxel = staticClosure('/src/rendering/voxel/VoxelRenderer.ts');
    expect([...voxel].filter(isClassic)).toEqual([]);
  });

  it('the classic renderer never loads the voxel renderer (the mirror check)', () => {
    const classic = staticClosure('/src/rendering/WorldRenderer.ts');
    expect(classic.has('pkg:pixi.js')).toBe(true);
    expect([...classic].filter(isVoxel)).toEqual([]);
  });

  it('the load path still reaches the migration chain', () => {
    const load = staticClosure('/src/app/saves/loadSave.ts');
    expect(load.has('/src/game/save/migrate.ts')).toBe(true);
    expect(load.has('/src/game/session/fromSave.ts')).toBe(true);
  });

  it('the type-only filter is not fooled by a mixed import', () => {
    expect(typeOnly('{ type A, type B }')).toBe(true);
    expect(typeOnly('type { A }')).toBe(true);
    expect(typeOnly('{ type A, B }')).toBe(false);
    expect(typeOnly('{ A }')).toBe(false);
  });
});
