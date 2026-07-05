/**
 * Path-aware ci-ok gate: wait for required workflow job checks on a ref, then pass
 * or fail. Mirrors path filters in frontend-tests.yml, eslint.yml, rust-tests.yml.
 */

const FRONTEND_PATH_RE =
  /^(src\/|package\.json$|package-lock\.json$|vitest\.config\.ts$|vite\.config\.ts$|tsconfig\.json$|eslint\.config\.mjs$|\.dependency-cruiser\.cjs$|\.dependency-cruiser-known-violations\.json$|\.github\/workflows\/frontend-tests\.yml$|\.github\/workflows\/eslint\.yml$|\.github\/frontend-hot-path-files\.txt$|scripts\/check-frontend-hot-path-coverage\.sh$|scripts\/check-css-import-graph\.mjs$)/;

const RUST_PATH_RE = /^(src-tauri\/|\.github\/workflows\/rust-tests\.yml$)/;

const FRONTEND_JOBS = [
  'vitest run',
  'tsc --noEmit',
  'vitest --coverage (baseline + hot-path file gate)',
  'eslint',
  'dependency-cruiser',
];

const RUST_JOBS = [
  'cargo test --workspace',
  'cargo clippy --workspace',
  'cargo llvm-cov (baseline + hot-path file gate)',
];

const POLL_MS = 30_000;
const TIMEOUT_MS = 90 * 60 * 1000;
const OK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

export function pathTriggersFrontend(file) {
  return FRONTEND_PATH_RE.test(file);
}

export function pathTriggersRust(file) {
  return RUST_PATH_RE.test(file);
}

export function requiredJobNames(changedFiles) {
  const names = [];
  if (changedFiles.some(pathTriggersFrontend)) {
    names.push(...FRONTEND_JOBS);
  }
  if (changedFiles.some(pathTriggersRust)) {
    names.push(...RUST_JOBS);
  }
  return names;
}

export function newestChecksByName(checks, excludeRunId) {
  const newest = new Map();
  for (const check of checks) {
    if (excludeRunId && (check.details_url || '').includes(`/actions/runs/${excludeRunId}/`)) {
      continue;
    }
    const key = check.name;
    const prev = newest.get(key);
    if (!prev) {
      newest.set(key, check);
      continue;
    }
    const prevTime = Date.parse(prev.started_at || prev.completed_at || '') || 0;
    const curTime = Date.parse(check.started_at || check.completed_at || '') || 0;
    if (curTime >= prevTime) {
      newest.set(key, check);
    }
  }
  return newest;
}

export function evaluateRequiredJobs(required, newestByName) {
  const pending = [];
  const failures = [];

  for (const name of required) {
    const latest = newestByName.get(name);
    if (!latest) {
      pending.push(`${name}: not started`);
      continue;
    }
    if (latest.status !== 'completed') {
      pending.push(`${name}: status=${latest.status}`);
      continue;
    }
    if (!OK_CONCLUSIONS.has(latest.conclusion || '')) {
      failures.push(`${name}: conclusion=${latest.conclusion}`);
    }
  }

  return { pending, failures, done: pending.length === 0 && failures.length === 0 };
}

export async function listChangedFiles(github, context) {
  const { owner, repo } = context.repo;

  if (context.eventName === 'pull_request') {
    const files = await github.paginate(github.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: context.payload.pull_request.number,
      per_page: 100,
    });
    return files.map((f) => f.filename);
  }

  if (context.eventName === 'push') {
    const before = context.payload.before;
    const after = context.sha;
    if (!before || /^0+$/.test(before)) {
      const commit = await github.rest.repos.getCommit({ owner, repo, ref: after });
      return commit.data.files?.map((f) => f.filename) ?? [];
    }
    const compare = await github.rest.repos.compareCommits({
      owner,
      repo,
      base: before,
      head: after,
    });
    return compare.data.files?.map((f) => f.filename) ?? [];
  }

  if (context.eventName === 'workflow_run') {
    const pr = context.payload.workflow_run.pull_requests?.[0];
    if (pr?.number) {
      const files = await github.paginate(github.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: pr.number,
        per_page: 100,
      });
      return files.map((f) => f.filename);
    }
    const headSha = context.payload.workflow_run.head_sha;
    const commit = await github.rest.repos.getCommit({ owner, repo, ref: headSha });
    return commit.data.files?.map((f) => f.filename) ?? [];
  }

  return [];
}

export function resolveTargetSha(context) {
  if (context.eventName === 'pull_request') {
    return context.payload.pull_request.head.sha;
  }
  if (context.eventName === 'workflow_run') {
    return context.payload.workflow_run.head_sha;
  }
  return context.sha;
}

export async function runCiOkAggregate(github, context, core) {
  const { owner, repo } = context.repo;
  const sha = resolveTargetSha(context);
  const excludeRunId = String(context.runId);
  const changedFiles = await listChangedFiles(github, context);
  const required = requiredJobNames(changedFiles);

  core.info(`ci-ok @ ${sha}; ${changedFiles.length} changed file(s)`);
  if (required.length === 0) {
    core.info('No path-filtered test workflows apply — ci-ok passes.');
    return;
  }
  core.info(`Waiting for required job checks: ${required.join(', ')}`);

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const checksAll = await github.paginate(github.rest.checks.listForRef, {
      owner,
      repo,
      ref: sha,
      per_page: 100,
    });
    const newestByName = newestChecksByName(checksAll, excludeRunId);
    const { pending, failures, done } = evaluateRequiredJobs(required, newestByName);

    if (failures.length > 0) {
      core.setFailed(`Required checks failed:\n${failures.join('\n')}`);
      return;
    }
    if (done) {
      core.info('All required checks are green.');
      return;
    }

    core.info(`Pending (${pending.length}): ${pending.join('; ')}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  core.setFailed(`Timed out after ${TIMEOUT_MS / 60_000} minutes waiting for: ${required.join(', ')}`);
}
