import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // 120s covers the slowest integration test (real browser launch + navigate).
    // Fast unit tests finish in milliseconds regardless of this ceiling.
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
