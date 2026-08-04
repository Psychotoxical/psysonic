#!/usr/bin/env node
/**
 * Pre-build guard: node_modules must match package-lock.json.
 *
 * A stale install is silent. npm keeps whatever is already on disk, the build
 * succeeds without a single warning, and the resulting bundle can be split into
 * different chunks than the locked toolchain produces. The app then hangs on the
 * splash screen with a TDZ-style "X is not a function" from a chunk that was
 * never initialised — a failure that looks nothing like its cause.
 *
 * Observed 2026-08-04: a contributor's tree carried rolldown 1.0.0-rc.17 while
 * the lockfile pinned 1.0.3. That build emitted no authStore chunk at all and
 * folded it into a 3.7 MB index chunk, so the offline chunk called an
 * uninitialised import. Deleting node_modules and running `npm ci` fixed it.
 *
 * Related but distinct: check-boot-chunk-lucide.mjs inspects the built output
 * for one known cause of the same symptom. This one checks the input instead.
 *
 * It runs before `dev` as well as `build`, for a second reason: the runtime
 * benchmark procedure measures the app through `npm run dev`. A stale install
 * would produce timings for a bundle that does not match the lockfile, and
 * those numbers can end up in a PR as evidence.
 *
 * npm already detects the drift (`npm ls` exits non-zero with ELSPROBLEMS);
 * this only surfaces it early and explains what to do.
 */
import { spawnSync } from 'node:child_process';

// `shell: true` is required, not cosmetic: npm is a .cmd shim on Windows, and
// Node refuses to spawn .cmd/.bat directly (EINVAL) since the CVE-2024-27980
// fix. Without it this guard fails to launch on exactly the platform it is
// meant to protect, and a silent EINVAL would look identical to "all good".
// Arguments are fixed literals, so there is nothing to inject here.
const result = spawnSync('npm', ['ls', '--depth=0'], { encoding: 'utf8', shell: true });

if (result.error) {
  console.warn(`  Dependency freshness check could not run: ${result.error.message}`);
  process.exit(0);
}

if (result.status === 0) process.exit(0);

const offenders = `${result.stdout ?? ''}`
  .split('\n')
  .filter(line => /invalid|missing|extraneous/i.test(line))
  .slice(0, 12);

console.error('');
console.error('  Installed dependencies do not match package-lock.json.');
console.error('');
if (offenders.length > 0) {
  for (const line of offenders) console.error(`    ${line.trim()}`);
  console.error('');
}
console.error('  A stale node_modules still builds without errors, but can emit a');
console.error('  broken bundle — the app then hangs on the splash screen.');
console.error('');
console.error('  Fix:  npm ci');
console.error('');

process.exit(1);
