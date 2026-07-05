/**
 * Rebuild library-cluster identity keys after each successful library sync so
 * multi-library dedup does not use stale precomputed keys.
 */
import { commands } from '@/generated/bindings';
import { subscribeLibrarySyncIdle } from '@/lib/api/library/events';
import { resolveIndexKey } from '@/lib/server/serverIndexKey';

const inFlight = new Set<string>();

async function rebuildClusterForIndexKey(indexKey: string): Promise<void> {
  if (inFlight.has(indexKey)) return;
  inFlight.add(indexKey);
  try {
    const res = await commands.libraryClusterRebuild(indexKey);
    if (res.status === 'error') {
      console.warn('[psysonic] libraryClusterRebuild failed:', indexKey, res.error);
    }
  } catch (err) {
    console.warn('[psysonic] libraryClusterRebuild error:', indexKey, err);
  } finally {
    inFlight.delete(indexKey);
  }
}

/** Subscribe globally; call the returned fn on teardown (e.g. MainApp unmount). */
export function initClusterRebuildOnSync(): () => void {
  let unlisten: (() => void) | undefined;

  void subscribeLibrarySyncIdle(payload => {
    if (!payload.ok) return;
    const indexKey = resolveIndexKey(payload.serverId);
    void rebuildClusterForIndexKey(indexKey);
  }).then(fn => {
    unlisten = fn;
  });

  return () => {
    unlisten?.();
    unlisten = undefined;
  };
}
