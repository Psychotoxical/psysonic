import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    // jsdom by default — most new tests touch the DOM or React state. Pure
    // utility tests work fine in jsdom too, so we keep a single environment.
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: [
      'node_modules/**',
      'dist/**',
      'src-tauri/**',
    ],
    // Process isolation. Fake timers + module-level mocks + Zustand globals
    // collide unpredictably across files inside a shared worker — forks +
    // isolate gives each file a fresh module graph. ~20% slower locally,
    // worth it well before the suite hits 30 files. See the pre-refactor
    // testing plan (2026-05-11) §3 for the decision context.
    pool: 'forks',
    isolate: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.d.ts',
        'src/test/**',
        'src/main.tsx',
        'src/vite-env.d.ts',
      ],
      // Soft thresholds — Phase 0 is infra, not coverage push. Real numbers
      // land in Phase 1 once cucadmuh and Frank lock the gate.
      thresholds: {
        lines: 0,
        functions: 0,
        branches: 0,
        statements: 0,
      },
    },
  },
});
