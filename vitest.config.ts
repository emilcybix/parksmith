import { defineConfig } from 'vitest/config';

/** A CI runner has two slow cores: the heavy simulation tests that pass well inside 5 s locally can time out there. */
const ci = Boolean((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.CI);

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    testTimeout: ci ? 30_000 : 5_000,
  },
});
