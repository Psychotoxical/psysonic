import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateRequiredJobs,
  isTransientApiError,
  newestChecksByName,
  pathTriggersFrontend,
  pathTriggersRust,
  requiredJobNames,
  withTransientRetry,
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

test('isTransientApiError treats 5xx, 429 and network errors as transient', () => {
  assert.equal(isTransientApiError({ status: 503 }), true);
  assert.equal(isTransientApiError({ status: 500 }), true);
  assert.equal(isTransientApiError({ status: 429 }), true);
  assert.equal(isTransientApiError(new Error('socket hang up')), true);
  assert.equal(isTransientApiError({ status: 404 }), false);
  assert.equal(isTransientApiError({ status: 401 }), false);
});

const silentCore = { info: () => {} };

test('withTransientRetry retries transient errors and returns the late success', async () => {
  let calls = 0;
  const result = await withTransientRetry(
    'test',
    async () => {
      calls += 1;
      if (calls < 3) {
        const err = new Error('unavailable');
        err.status = 503;
        throw err;
      }
      return 'ok';
    },
    silentCore,
    5,
    1,
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('withTransientRetry rethrows non-transient errors immediately', async () => {
  let calls = 0;
  await assert.rejects(
    withTransientRetry(
      'test',
      async () => {
        calls += 1;
        const err = new Error('not found');
        err.status = 404;
        throw err;
      },
      silentCore,
      5,
      1,
    ),
    /not found/,
  );
  assert.equal(calls, 1);
});

test('withTransientRetry gives up after the attempt budget', async () => {
  let calls = 0;
  await assert.rejects(
    withTransientRetry(
      'test',
      async () => {
        calls += 1;
        const err = new Error('unavailable');
        err.status = 503;
        throw err;
      },
      silentCore,
      3,
      1,
    ),
    /unavailable/,
  );
  assert.equal(calls, 3);
});
