import { useEffect, useSyncExternalStore } from 'react';
import {
  coverCacheRestHost,
  libraryCoverBackfillConfigure,
  libraryCoverBackfillResetCursor,
  libraryCoverBackfillRunFullPass,
  librarySqlServerId,
} from '../api/coverCache';
import { coverStrategyAllowsLibraryBackfill } from '../utils/library/coverStrategy';
import { useAuthStore } from '../store/authStore';
import { useCoverStrategyStore } from '../store/coverStrategyStore';
import { subscribeLibraryCoverBackfillWake } from '../utils/library/coverBackfillWake';
import { serverIndexKeyForProfile } from '../utils/server/serverIndexKey';
import { subscribeConnectCache } from '../utils/server/serverEndpoint';

/**
 * Library cover warm-up — configure session in Rust; full pass runs natively.
 *
 * - `library_cover_backfill_run_full_pass` on configure / manual wake
 * - `library:sync-idle` handled in Rust (not throttled with the webview)
 */
export function useLibraryCoverBackfill(enabled = true): void {
  const activeServerId = useAuthStore(s => s.activeServerId);
  const strategy = useCoverStrategyStore(s =>
    s.getStrategyForServer(activeServerId),
  );
  const server = useAuthStore(s =>
    s.activeServerId ? s.servers.find(srv => srv.id === s.activeServerId) : undefined,
  );
  // Re-read the runtime-probed connect URL whenever the sticky endpoint flips
  // (e.g. laptop moves off the LAN). Backfill is configured natively with a
  // fixed `rest_base_url`, so without this it would keep fetching covers from
  // the now-unreachable local address while playback already switched to public.
  const connectBaseUrl = useSyncExternalStore(
    subscribeConnectCache,
    () => useAuthStore.getState().getBaseUrl(),
    () => useAuthStore.getState().getBaseUrl(),
  );

  useEffect(() => {
    const kick = () => {
      void libraryCoverBackfillRunFullPass();
    };
    const unsubWake = subscribeLibraryCoverBackfillWake(kick);
    return unsubWake;
  }, []);

  useEffect(() => {
    const disable = () => {
      void libraryCoverBackfillConfigure({
        enabled: false,
        serverIndexKey: '',
        libraryServerId: '',
        restBaseUrl: '',
        username: '',
        password: '',
      });
    };

    if (
      !enabled
      || !coverStrategyAllowsLibraryBackfill(strategy)
      || !activeServerId
      || !server
    ) {
      disable();
      return disable;
    }

    const indexKey = serverIndexKeyForProfile(server);
    void (async () => {
      await libraryCoverBackfillConfigure({
        enabled: true,
        serverIndexKey: indexKey,
        libraryServerId: librarySqlServerId(activeServerId),
        restBaseUrl: connectBaseUrl ? coverCacheRestHost(connectBaseUrl) : '',
        username: server.username,
        password: server.password,
      });
      await libraryCoverBackfillResetCursor();
      // Force: a (re)configure — including a connect-URL flip — must clear the
      // `.fetch-failed` backoff so covers that 404'd / timed out against the
      // previous (now-stale) address are retried immediately on the new one.
      await libraryCoverBackfillRunFullPass(true);
    })();

    return disable;
  }, [enabled, strategy, activeServerId, server?.url, server?.username, server?.password, connectBaseUrl]);
}
