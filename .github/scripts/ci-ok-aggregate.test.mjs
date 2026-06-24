import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateRequiredJobs,
  newestChecksByName,
  pathTriggersFrontend,
  pathTriggersRust,
  requiredJobNames,
} from './ci-ok-aggregate.mjs';

test('pathTriggersFrontend matches frontend workflow paths', () => {
  assert.equal(pathTriggersFrontend('src/App.tsx'), true);
  assert.equal(pathTriggersFrontend('eslint.config.mjs'), true);
  assert.equal(pathTriggersFrontend('README.md'), false);
});

test('pathTriggersRust matches rust workflow paths', () => {
  assert.equal(pathTriggersRust('src-tauri/src/lib.rs'), true);
  assert.equal(pathTriggersRust('src/App.tsx'), false);
});

test('requiredJobNames unions frontend and rust jobs', () => {
  const names = requiredJobNames(['src/foo.ts', 'src-tauri/bar.rs']);
  assert.ok(names.includes('eslint'));
  assert.ok(names.includes('cargo test --workspace'));
});

test('evaluateRequiredJobs fails on red conclusions', () => {
  const newest = newestChecksByName([
    {
      name: 'eslint',
      status: 'completed',
      conclusion: 'failure',
      started_at: '2026-01-01T00:00:00Z',
      details_url: '',
    },
  ]);
  const result = evaluateRequiredJobs(['eslint'], newest);
  assert.equal(result.done, false);
  assert.equal(result.failures.length, 1);
});

test('evaluateRequiredJobs passes when all required jobs succeeded', () => {
  const checks = ['eslint', 'vitest run'].map((name) => ({
    name,
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-01-01T00:00:00Z',
    details_url: '',
  }));
  const result = evaluateRequiredJobs(['eslint', 'vitest run'], newestChecksByName(checks));
  assert.equal(result.done, true);
});
