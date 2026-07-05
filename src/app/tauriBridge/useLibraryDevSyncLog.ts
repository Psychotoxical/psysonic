import { useEffect } from 'react';
import { useAuthStore } from '@/store/authStore';
import {
  libraryGetStatus,
  libraryGetPlaybackHint,
  subscribeLibrarySyncIdle,
  subscribeLibrarySyncProgress,
} from '@/lib/api/library';
import {
  activeIngestStrategy,
  ingestParallelismNote,
  ingestStallHint,
  libraryDevEnabled,
  logLibraryStatus,
  logLibrarySync,
  normalizeIngestMetrics,
  timed,
} from '@/lib/library/libraryDevLog';

/**
 * DevTools: log library sync progress + idle with ingest strategy from status.
 * Filter console: `[psysonic][library]`
 */
export function useLibraryDevSyncLog(): void {
  const serverId = useAuthStore(s => s.activeServerId);

  useEffect(() => {
    if (!libraryDevEnabled()) return;

    let unlistenProgress: (() => void) | undefined;
    let unlistenIdle: (() => void) | undefined;
    let lastIngestStatusFetchMs = 0;
    let lastIngestEventMs = 0;

    void subscribeLibrarySyncProgress(payload => {
      const now = Date.now();
      const sinceLastIngestMs =
        payload.kind === 'ingest_page' && lastIngestEventMs > 0
          ? now - lastIngestEventMs
          : undefined;
      if (payload.kind === 'ingest_page') {
        lastIngestEventMs = now;
      }
      const metrics = normalizeIngestMetrics(payload.ingestMetrics);
      const stallHint = metrics ? ingestStallHint(metrics) : undefined;

      logLibrarySync({
        at: new Date().toISOString(),
        kind: payload.kind,
        serverId: payload.serverId,
        libraryScope: payload.libraryScope,
        ingestPhase: payload.phase ?? null,
        ingestedTotal: payload.ingestedTotal ?? null,
        batchCount: payload.batchCount ?? null,
        message: payload.message ?? payload.completedKind ?? null,
        sinceLastIngestMs,
        ingestMetrics: metrics,
        stallHint,
      });

      const shouldFetchStatus =
        payload.kind === 'phase_changed' ||
        (payload.kind === 'ingest_page' &&
          Date.now() - lastIngestStatusFetchMs >= 2500);

      if (shouldFetchStatus) {
        if (payload.kind === 'ingest_page') {
          lastIngestStatusFetchMs = Date.now();
        }
        void Promise.all([
          timed(() => libraryGetStatus(payload.serverId)),
          libraryGetPlaybackHint().catch(() => 'idle' as const),
        ]).then(([{ result: status, ms }, playbackHint]) => {
          const ingest = activeIngestStrategy(status);
          logLibrarySync({
            at: new Date().toISOString(),
            kind: payload.kind,
            serverId: payload.serverId,
            libraryScope: payload.libraryScope,
            ingestStrategy: ingest.tag,
            ingestPhase: status.ingestPhase ?? payload.phase ?? null,
            syncPhase: status.syncPhase,
            ingestedTotal: payload.ingestedTotal ?? status.cursorIngestedCount ?? null,
            batchCount: payload.batchCount ?? null,
            message: ingestParallelismNote(ingest.tag, playbackHint),
            durationMs: ms,
          });
          logLibraryStatus(payload.serverId, status, `sync-${payload.kind} (${ms}ms)`, playbackHint);
        });
      }
    }).then(fn => {
      unlistenProgress = fn;
    });

    void subscribeLibrarySyncIdle(payload => {
      void (async () => {
        const { result: status, ms } = await timed(() => libraryGetStatus(payload.serverId));
        logLibrarySync({
          at: new Date().toISOString(),
          kind: payload.ok ? `idle_${payload.kind}` : 'idle_error',
          serverId: payload.serverId,
          libraryScope: payload.libraryScope,
          ingestStrategy: status.ingestStrategy ?? null,
          ingestPhase: status.ingestPhase ?? null,
          syncPhase: status.syncPhase,
          n1BulkUnreliable: status.n1BulkUnreliable ?? null,
          message: payload.error ?? null,
          durationMs: ms,
        });
        logLibraryStatus(payload.serverId, status, `sync-idle (${ms}ms)`);
      })();
    }).then(fn => {
      unlistenIdle = fn;
    });

    return () => {
      unlistenProgress?.();
      unlistenIdle?.();
    };
  }, []);

  useEffect(() => {
    if (!libraryDevEnabled() || !serverId) return;
    void timed(() => libraryGetStatus(serverId)).then(({ result: status, ms }) => {
      logLibraryStatus(serverId, status, `active-server (${ms}ms)`);
    });
  }, [serverId]);
}
