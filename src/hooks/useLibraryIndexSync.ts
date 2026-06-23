import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../store/authStore';
import { useLibraryIndexStore } from '../store/libraryIndexStore';
import { showToast } from '../utils/ui/toast';
import { resolveIndexKey, serverIndexKeyForProfile } from '../utils/server/serverIndexKey';
import {
  libraryGetStatus,
  librarySyncCancel,
  subscribeLibrarySyncIdle,
  subscribeLibrarySyncProgress,
  type SyncStateDto,
} from '../api/library';
import {
  bootstrapAllIndexedServers,
  bootstrapIndexedServer,
  type BindServerResult,
} from '../utils/library/librarySession';
import { enqueueLibrarySync } from '../utils/library/librarySyncQueue';
import { syncIngestDisplayCount } from '../utils/library/libraryReady';

export type LibraryServerConnection = 'online' | 'offline' | 'unknown';

const STATUS_POLL_MS = 3000;
const SYNC_POLL_MS = 2500;
const OFFLINE_RETRY_MS = 60_000;

export function useLibraryIndexSync() {
  const { t } = useTranslation();
  const servers = useAuthStore(s => s.servers);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const masterEnabled = useLibraryIndexStore(s => s.masterEnabled);

  const serverKeyById = useMemo(
    () => Object.fromEntries(servers.map(s => [s.id, serverIndexKeyForProfile(s)])),
    [servers],
  );
  const indexedKeys = useMemo(
    () => Array.from(new Set(Object.values(serverKeyById))),
    [serverKeyById],
  );
  const indexedServers = useMemo(() => {
    const primary = new Map<string, { key: string; server: typeof servers[number] }>();
    for (const server of servers) {
      const key = serverKeyById[server.id];
      if (!primary.has(key)) primary.set(key, { key, server });
    }
    if (activeServerId) {
      const active = servers.find(s => s.id === activeServerId);
      if (active) {
        const key = serverKeyById[active.id];
        if (primary.has(key)) primary.set(key, { key, server: active });
      }
    }
    return Array.from(primary.values());
  }, [servers, serverKeyById, activeServerId]);

  const [statusByServer, setStatusByServer] = useState<Record<string, SyncStateDto | null>>({});
  const [connectionByServer, setConnectionByServer] = useState<Record<string, LibraryServerConnection>>({});
  const [progressByServer, setProgressByServer] = useState<Record<string, string | null>>({});
  const [busyServerId, setBusyServerId] = useState<string | null>(null);
  const [bootstrapping, setBootstrapping] = useState(false);

  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ingestCountRef = useRef<Record<string, number>>({});
  const syncPhaseRef = useRef<Record<string, string | null>>({});

  const applyConnectionResults = useCallback((results: Record<string, BindServerResult>) => {
    setConnectionByServer(prev => {
      const next = { ...prev };
      for (const [id, result] of Object.entries(results)) {
        next[id] = result === 'offline' ? 'offline' : result === 'bound' ? 'online' : 'unknown';
      }
      return next;
    });
  }, []);

  const refreshAllStatuses = useCallback(async () => {
    if (!masterEnabled || indexedServers.length === 0) return;
    const entries = await Promise.all(
      indexedServers.map(async ({ key }) => {
        try {
          const fresh = await libraryGetStatus(key);
          syncPhaseRef.current[key] = fresh.syncPhase;
          if (fresh.syncPhase === 'initial_sync') {
            const next = Math.max(ingestCountRef.current[key] ?? 0, syncIngestDisplayCount(fresh));
            ingestCountRef.current[key] = next;
            setProgressByServer(p => ({
              ...p,
              [key]: t('settings.libraryIndexProgressIngest', { count: next }),
            }));
          } else if (fresh.syncPhase === 'ready' || fresh.syncPhase === 'idle') {
            ingestCountRef.current[key] = 0;
          }
          return [key, fresh] as const;
        } catch {
          return [key, null] as const;
        }
      }),
    );
    setStatusByServer(Object.fromEntries(entries));
  }, [masterEnabled, indexedServers, t]);

  const runBootstrap = useCallback(async () => {
    if (!masterEnabled) return;
    setBootstrapping(true);
    try {
      const results = await bootstrapAllIndexedServers();
      applyConnectionResults(results);
      await refreshAllStatuses();
    } finally {
      setBootstrapping(false);
    }
  }, [masterEnabled, applyConnectionResults, refreshAllStatuses]);

  const retryOfflineServers = useCallback(async () => {
    if (!masterEnabled) return;
    const offline = indexedServers.filter(s => connectionByServer[s.key] === 'offline');
    if (offline.length === 0) return;
    const results: Record<string, BindServerResult> = {};
    for (const srv of offline) {
      results[srv.key] = await bootstrapIndexedServer(srv.server);
    }
    applyConnectionResults(results);
    void refreshAllStatuses();
  }, [masterEnabled, indexedServers, connectionByServer, applyConnectionResults, refreshAllStatuses]);

  useEffect(() => {
    if (!masterEnabled || indexedKeys.length === 0) return;
    // React Compiler set-state-in-effect rule: state set from a timer/animation callback.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void runBootstrap();
  }, [masterEnabled, indexedKeys.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!masterEnabled) return;
    const poll = () => {
      void refreshAllStatuses();
      const anyInitial = indexedKeys.some(
        key => syncPhaseRef.current[key] === 'initial_sync',
      );
      pollTimer.current = setTimeout(poll, anyInitial ? SYNC_POLL_MS : STATUS_POLL_MS);
    };
    poll();
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
      pollTimer.current = null;
    };
    // indexedKeys is derived from indexedServers (already a dep); the poll loop is
    // keyed on the server set, not on the recomputed key array, to avoid
    // restarting the poll on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [masterEnabled, indexedServers, refreshAllStatuses]);

  useEffect(() => {
    if (!masterEnabled) return;
    const retryTimer = setInterval(() => {
      void retryOfflineServers();
    }, OFFLINE_RETRY_MS);
    return () => clearInterval(retryTimer);
  }, [masterEnabled, retryOfflineServers]);

  useEffect(() => {
    if (!masterEnabled) return;
    const unsubs: Array<Promise<() => void>> = [
      subscribeLibrarySyncProgress(p => {
        const key = resolveIndexKey(p.serverId);
        if (!indexedKeys.includes(key)) return;
        setBusyServerId(key);
        if (p.kind === 'ingest_page') {
          const next = Math.max(ingestCountRef.current[key] ?? 0, p.ingestedTotal ?? 0);
          ingestCountRef.current[key] = next;
          setProgressByServer(prev => ({
            ...prev,
            [key]: t('settings.libraryIndexProgressIngest', { count: next }),
          }));
        } else if (p.kind === 'tombstoned') {
          setProgressByServer(prev => ({
            ...prev,
            [key]: t('settings.libraryIndexProgressVerify', {
              checked: p.tombstonesChecked ?? 0,
              deleted: p.tombstonesDeleted ?? 0,
            }),
          }));
        } else if (p.kind === 'phase_changed' && p.phase) {
          setProgressByServer(prev => ({ ...prev, [key]: p.phase ?? null }));
        }
      }),
      subscribeLibrarySyncIdle(p => {
        const key = resolveIndexKey(p.serverId);
        if (!indexedKeys.includes(key)) return;
        setBusyServerId(cur => (cur === key ? null : cur));
        ingestCountRef.current[key] = 0;
        setProgressByServer(prev => ({ ...prev, [key]: null }));
        void refreshAllStatuses();
        if (!p.ok && p.error) {
          showToast(t('settings.libraryIndexSyncError', { error: p.error }), 5000, 'error');
        }
      }),
    ];
    return () => {
      unsubs.forEach(u => void u.then(fn => fn()));
    };
  }, [masterEnabled, indexedKeys, refreshAllStatuses, t]);

  const runServerAction = useCallback(async (
    serverId: string,
    action: 'full' | 'delta' | 'verify',
  ) => {
    const key = resolveIndexKey(serverId);
    setBusyServerId(key);
    try {
      const kind =
        action === 'verify'
          ? 'verify'
          : action === 'full'
            ? 'full'
            : statusByServer[key]?.lastFullSyncAt
              ? 'delta'
              : 'full';
      ingestCountRef.current[key] = 0;
      await enqueueLibrarySync({ serverId: key, kind });
    } catch (e) {
      setBusyServerId(null);
      showToast(t('settings.libraryIndexSyncError', { error: String(e) }), 5000, 'error');
    }
  }, [statusByServer, t]);

  const handleCancel = useCallback(async () => {
    try {
      await librarySyncCancel();
    } catch {
      /* best-effort */
    }
  }, []);

  const globalBusy = bootstrapping || busyServerId != null;

  return {
    statusByServer,
    connectionByServer,
    progressByServer,
    busyServerId,
    bootstrapping,
    globalBusy,
    runServerAction,
    handleCancel,
  };
}
