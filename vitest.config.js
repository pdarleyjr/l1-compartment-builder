import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js', 'worker/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['src/dropdown-position.js', 'worker/index.js'],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
  },
});
