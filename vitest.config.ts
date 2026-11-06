import { defineConfig } from 'vitest/config';

// Tests exercise the pure simulation engine only (no DOM, no WebGL).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Phase 3A/3B missions are long (area + corridor survey + recovery/return); multi-seed tests need more time
    testTimeout: 300000,
    hookTimeout: 300000,
  },
});
