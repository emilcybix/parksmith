import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Phase 19: `PARKSMITH_BASE` sets the public path of a hosted build (for example `/parksmith/` on GitHub Pages under a
 * project site); a local build and the dev server keep `/`.
 */
export default defineConfig({
  base: (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.PARKSMITH_BASE ?? '/',
  plugins: [react()],
  server: { port: 3000, strictPort: true },
  /**
   * Phase 34: the entry chunk is about 976 kB raw after the load split (it was 1,408 kB). The warning limit sits about
   * 5 % above it, so a build that grows the main chunk past that says so. The gzip budget that a test enforces is in
   * src/app/bundleBudget.test.ts (opt-in: BUNDLE_BUDGET=1).
   */
  build: { chunkSizeWarningLimit: 1025 },
});
