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
      // Aggregate ratchet — prevents regressions across the whole tree.
      // Set ~1pp under the current measured floor (lines 13.3, statements
      // 12.5, functions 11.3, branches 9.9 as of 2026-05-12). Real per-file
      // coverage on critical paths is enforced by the hot-path gate
      // (.github/frontend-hot-path-files.txt + scripts/check-frontend-coverage.cjs).
      // Bump these numbers up as refactor PRs add coverage; never down.
      thresholds: {
        lines: 12,
        functions: 10,
        branches: 9,
        statements: 11,
      },
    },
  },
});
