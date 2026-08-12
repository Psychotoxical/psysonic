import { useEffect, useRef, useState } from 'react';
import {
  bindAllIndexedServers,
  startInitialSyncsForBoundServers,
} from '@/lib/library/librarySession';
import { hydrateQueueFromIndex } from '@/features/playback/store/queueRestore';
import { reconcileStartupPlayQueues } from '@/features/playback/store/startupPlayQueueReconcile';

const STARTUP_RETRY_BASE_MS = 250;
const STARTUP_RETRY_MAX_MS = 30_000;

export function useStartupReadiness(options: {
  migrationReady: boolean;
  activeServerId: string | null;
  serverIdsKey: string;
  masterEnabled: boolean;
  migrationRevision: number;
}): boolean {
  const { migrationReady, activeServerId, serverIdsKey, masterEnabled, migrationRevision } = options;
  const readinessKey = `${migrationRevision}\u0000${activeServerId ?? ''}\u0000${serverIdsKey}\u0000${masterEnabled ? '1' : '0'}`;
  const [readyKey, setReadyKey] = useState<string | null>(null);
  const generationRef = useRef(0);
  const queueReconciledGenerationRef = useRef<string | null>(null);

  useEffect(() => {
    const generation = ++generationRef.current;
    if (!migrationReady) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    void (async () => {
      let attempt = 0;
      while (!cancelled && generationRef.current === generation) {
        try {
          const results = await bindAllIndexedServers();
          if (cancelled || generationRef.current !== generation) return;
          void startInitialSyncsForBoundServers(results).catch(() => {});
          await hydrateQueueFromIndex();
          if (cancelled || generationRef.current !== generation) return;
          if (queueReconciledGenerationRef.current !== readinessKey) {
            await reconcileStartupPlayQueues({
              shouldAbort: () => cancelled || generationRef.current !== generation,
            });
            if (cancelled || generationRef.current !== generation) return;
            queueReconciledGenerationRef.current = readinessKey;
          }
          if (cancelled || generationRef.current !== generation) return;
          setReadyKey(readinessKey);
          return;
        } catch {
          if (cancelled || generationRef.current !== generation) return;
          const delayMs = Math.min(
            STARTUP_RETRY_MAX_MS,
            STARTUP_RETRY_BASE_MS * 2 ** Math.min(attempt, 20),
          );
          attempt += 1;
          await new Promise<void>(resolve => {
            retryTimer = setTimeout(resolve, delayMs);
          });
          retryTimer = null;
          if (cancelled || generationRef.current !== generation) return;
        }
      }
    })();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [activeServerId, masterEnabled, migrationReady, readinessKey, serverIdsKey]);

  return migrationReady && readyKey === readinessKey;
}
