import { useEffect } from 'react';
import {
  analysisSetPipelineParallelism,
  libraryAnalysisBackfillConfigure,
} from '@/lib/api/analysis';
import { librarySqlServerId } from '@/lib/api/coverCache';
import { useAuthStore } from '@/store/authStore';
import { useAnalysisStrategyStore } from '@/store/analysisStrategyStore';
import { DEFAULT_ADVANCED_PARALLELISM } from '@/lib/library/analysisStrategy';
import { serverIndexKeyForProfile } from '@/lib/server/serverIndexKey';

const DISABLED_CONFIGURE = {
  enabled: false,
  serverIndexKey: '',
  libraryServerId: '',
  serverUrl: '',
  username: '',
  password: '',
  workers: DEFAULT_ADVANCED_PARALLELISM,
} as const;

/**
 * Advanced analytics strategy: native coordinator in Rust (see `library_analysis_backfill`).
 * Webview only passes session + worker count — no planning loop or batch IPC.
 */
export function useLibraryAnalysisBackfill(enabled = true): void {
  const activeServerId = useAuthStore(s => s.activeServerId);
  const server = useAuthStore(s =>
    s.activeServerId ? s.servers.find(srv => srv.id === s.activeServerId) : undefined,
  );
  const getBaseUrl = useAuthStore(s => s.getBaseUrl);
  const strategy = useAnalysisStrategyStore(s => s.getStrategyForServer(activeServerId));
  const advancedParallelism = useAnalysisStrategyStore(
    s => s.getAdvancedParallelismForServer(activeServerId),
  );

  useEffect(() => {
    if (!enabled) return;
    const workers =
      strategy === 'advanced' ? advancedParallelism : DEFAULT_ADVANCED_PARALLELISM;
    void analysisSetPipelineParallelism(workers).catch(() => {});
  }, [strategy, advancedParallelism, enabled]);

  useEffect(() => {
    const disable = () => {
      void libraryAnalysisBackfillConfigure(DISABLED_CONFIGURE);
    };

    if (!enabled || strategy !== 'advanced' || !activeServerId || !server) {
      disable();
      return disable;
    }

    const indexKey = serverIndexKeyForProfile(server);
    const baseUrl = getBaseUrl();
    void libraryAnalysisBackfillConfigure({
      enabled: true,
      serverIndexKey: indexKey,
      libraryServerId: librarySqlServerId(activeServerId),
      serverUrl: baseUrl,
      username: server.username,
      password: server.password,
      workers: advancedParallelism,
    }).catch(() => {
      /* coordinator optional; avoid unhandled rejection noise in release */
    });

    return disable;
    // Keyed on the server's primitive fields (url/username/password); depending
    // on the `server` object would restart the backfill on every render when its
    // identity changes but its connection fields do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled,
    strategy,
    activeServerId,
    server?.url,
    server?.username,
    server?.password,
    advancedParallelism,
    getBaseUrl,
  ]);
}
