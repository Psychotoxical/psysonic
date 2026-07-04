/**
 * Primary-URL change remigration — moves library / analysis SQLite rows and
 * the cover-cache disk bucket from one index key to another when the user
 * edits a server profile's primary `url` in a way that changes the derived
 * `serverIndexKeyFromUrl(url)`.
 *
 * Spec §8 ("URL change remigration"). The pipeline:
 *
 *   1. detect — `indexKeyRemapForUrlChange(prev, next)` returns null when the
 *      index key is unchanged (scheme-only flip, alternateUrl-only edit,
 *      trailing-slash edit, etc.) so callers can short-circuit without doing
 *      any work.
 *   2. inspect — `migration_inspect` confirms how many rows would move (also
 *      surfaces warnings before the destructive step runs).
 *   3. run — `migration_run` re-tags the SQLite rows (library + analysis).
 *   4. front-end rewrite — `rewriteFrontendStoreKeysForRemap` repoints
 *      offlineStore / hotCacheStore / analysisStrategyStore /
 *      playerStore.queueServerId.
 *   5. cover bucket — `cover_cache_rename_server_bucket` moves
 *      `{cover_root}/{oldKey}/` to `{newKey}/`.
 *
 * Failures abort early; the caller blocks the profile save and shows the
 * user a retry. We never partially commit: the SQLite step is the latest
 * destructive step before the front-end rewrite and disk rename, so the
 * worst case (DB ok, cover rename fails) leaves the index key consistent
 * but covers under the new key may need to be re-downloaded — handled by
 * the existing cover backfill on next access.
 */

import { commands } from '@/generated/bindings';
import type { ServerProfile } from '@/store/authStoreTypes';
import {
  migrationInspect,
  migrationRun,
  type MigrationInspectReport,
  type MigrationRunResult,
} from '@/lib/api/migration';
import { rewriteFrontendStoreKeysForRemap } from '@/utils/server/rewriteFrontendStoreKeys';
import { serverIndexKeyFromUrl } from '@/lib/server/serverIndexKey';

export type IndexKeyRemap = { oldKey: string; newKey: string };

export type IndexKeyRemigrationFailure =
  | { stage: 'inspect'; error: string }
  | { stage: 'run'; error: string }
  | { stage: 'cover-rename'; error: string };

export type IndexKeyRemigrationResult =
  | { ok: true; inspect: MigrationInspectReport; run: MigrationRunResult }
  | { ok: false; failure: IndexKeyRemigrationFailure };

/**
 * Detect whether a profile edit changes the **index key** derived from the
 * primary url. Returns `null` when both sides normalize to the same key —
 * scheme-only edits (`http://x` → `https://x`), trailing-slash differences,
 * and any change that only touches `alternateUrl` / credentials / name all
 * fall through.
 *
 * Empty / missing urls return null (no remigration to do).
 */
export function indexKeyRemapForUrlChange(
  previous: Pick<ServerProfile, 'url'>,
  next: Pick<ServerProfile, 'url'>,
): IndexKeyRemap | null {
  const oldKey = serverIndexKeyFromUrl(previous.url ?? '').trim();
  const newKey = serverIndexKeyFromUrl(next.url ?? '').trim();
  if (!oldKey || !newKey) return null;
  if (oldKey === newKey) return null;
  return { oldKey, newKey };
}

/**
 * Run the four-stage pipeline for a single oldKey → newKey remap.
 *
 * Returns a structured result the caller can branch on — UI surfaces the
 * failure stage so the user knows whether to retry the DB step, fix
 * network, or report a cover-rename bug.
 */
export async function runIndexKeyRemigration(
  remap: IndexKeyRemap,
): Promise<IndexKeyRemigrationResult> {
  const mappings = [{ legacyId: remap.oldKey, indexKey: remap.newKey }];

  let inspect: MigrationInspectReport;
  try {
    inspect = await migrationInspect(mappings);
  } catch (e) {
    return { ok: false, failure: { stage: 'inspect', error: String(e) } };
  }

  let run: MigrationRunResult;
  try {
    run = await migrationRun(mappings);
  } catch (e) {
    return { ok: false, failure: { stage: 'run', error: String(e) } };
  }

  // Frontend stores — this is in-memory only; if zustand throws (it
  // shouldn't), the user is left with a DB tagged on newKey and stores on
  // oldKey. That recovers on next app start via the existing rehydration
  // path, so we don't treat it as a failure here.
  try {
    await rewriteFrontendStoreKeysForRemap([remap]);
  } catch {
    /* in-memory rewrite is best-effort; the persisted state catches up at
       the next zustand persist tick. */
  }

  try {
    const res = await commands.coverCacheRenameServerBucket(remap.oldKey, remap.newKey);
    if (res.status === 'error') throw new Error(res.error);
  } catch (e) {
    // Cover rename is the latest step and the most recoverable failure:
    // the disk bucket is still under oldKey, library + analysis already
    // point at newKey, so covers will look "missing" until the user re-
    // triggers a sync or the backfill catches them. Surface the failure
    // but don't undo the DB step — that would be far more destructive.
    return { ok: false, failure: { stage: 'cover-rename', error: String(e) } };
  }

  return { ok: true, inspect, run };
}
