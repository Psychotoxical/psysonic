import { useEffect, useSyncExternalStore } from 'react';
import {
  coverCacheRestHost,
  libraryCoverBackfillConfigure,
  libraryCoverBackfillResetCursor,
  libraryCoverBackfillRunFullPass,
  libraryCoverBackfillSetBaseUrl,
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
  // Runtime-probed connect URL: it flips when the sticky endpoint changes (e.g.
  // laptop moves off the LAN). The native worklist is URL-agnostic — we push the
  // live URL separately (below) rather than baking it into the session.
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

  // Session config (server identity, credentials, strategy, enable). The connect
  // URL is intentionally NOT a dependency here: it changes far more often than
  // these, and the worklist no longer carries it — see the flip effect below.
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
      // Seed the URL with the current best guess; the flip effect keeps it fresh.
      const seedUrl = useAuthStore.getState().getBaseUrl();
      await libraryCoverBackfillConfigure({
        enabled: true,
        serverIndexKey: indexKey,
        libraryServerId: librarySqlServerId(activeServerId),
        restBaseUrl: seedUrl ? coverCacheRestHost(seedUrl) : '',
        username: server.username,
        password: server.password,
      });
      await libraryCoverBackfillResetCursor();
      await libraryCoverBackfillRunFullPass();
    })();

    return disable;
    // Keyed on the server's primitive fields; depending on the `server` object
    // would restart the backfill on every render when its identity changes but
    // its connection fields do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, strategy, activeServerId, server?.url, server?.username, server?.password]);

  // Connect-URL flip: push the new reachable address live. The native worker
  // swaps a single cell, so even an in-flight pass downloads its remaining
  // covers against it; a real change also clears the stale fetch-failed backoff
  // and kicks a retry pass for whatever failed on the old address.
  useEffect(() => {
    if (
      !enabled
      || !coverStrategyAllowsLibraryBackfill(strategy)
      || !activeServerId
      || !server
      || !connectBaseUrl
    ) {
      return;
    }
    void libraryCoverBackfillSetBaseUrl(coverCacheRestHost(connectBaseUrl));
    // Keyed on connectBaseUrl / server?.url; the `server` object guard does not
    // need to retrigger this base-URL push on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectBaseUrl, enabled, strategy, activeServerId, server?.url]);
}
