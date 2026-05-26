import { useEffect } from 'react';
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
  const getBaseUrl = useAuthStore(s => s.getBaseUrl);

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
    const baseUrl = getBaseUrl();
    void (async () => {
      await libraryCoverBackfillConfigure({
        enabled: true,
        serverIndexKey: indexKey,
        libraryServerId: librarySqlServerId(activeServerId),
        restBaseUrl: baseUrl ? coverCacheRestHost(baseUrl) : '',
        username: server.username,
        password: server.password,
      });
      await libraryCoverBackfillResetCursor();
      await libraryCoverBackfillRunFullPass();
    })();

    return disable;
  }, [enabled, strategy, activeServerId, server?.url, server?.username, server?.password, getBaseUrl]);
}
