import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAuthStore } from '../store/authStore';
import { scheduleInstantMixProbeForServer } from '../api/subsonic';
import { serverListDisplayLabel } from '../utils/server/serverDisplayName';
import {
  ensureConnectUrlResolved,
  invalidateReachableEndpointCache,
  isLanUrl,
} from '../utils/server/serverEndpoint';
import { usePerfProbeFlags } from '../utils/perf/perfFlags';

// Backward-compatible re-export for call sites that still import from the hook.
export { isLanUrl };

export type ConnectionStatus = 'connected' | 'disconnected' | 'checking';

export function useConnectionStatus() {
  const perfFlags = usePerfProbeFlags();
  const [status, setStatus] = useState<ConnectionStatus>('checking');
  const [isRetrying, setIsRetrying] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const check = useCallback(async () => {
    const server = useAuthStore.getState().getActiveServer();
    if (!server) {
      setStatus('disconnected');
      return;
    }

    if (!navigator.onLine) {
      setStatus('disconnected');
      return;
    }

    // Dual-address: probe LAN-first via the shared cache. On every poll the
    // sticky entry is tried first; on failure the full sequence runs and the
    // cache flips to whichever endpoint actually answers — so a laptop moving
    // off WiFi smoothly transitions from LAN to public without a manual retry.
    const probe = await ensureConnectUrlResolved(server);
    if (probe.ok) {
      const sid = useAuthStore.getState().activeServerId;
      if (sid) {
        const identity = {
          type: probe.ping.type,
          serverVersion: probe.ping.serverVersion,
          openSubsonic: probe.ping.openSubsonic,
        };
        useAuthStore.getState().setSubsonicServerIdentity(sid, identity);
        scheduleInstantMixProbeForServer(sid, probe.baseUrl, server.username, server.password, identity);
      }
    }
    setStatus(probe.ok ? 'connected' : 'disconnected');
  }, []);

  const retry = useCallback(async () => {
    setIsRetrying(true);
    // Manual retry: drop the sticky cache so the next probe starts in the
    // natural LAN-first order instead of revalidating whatever last worked.
    const sid = useAuthStore.getState().activeServerId;
    if (sid) invalidateReachableEndpointCache(sid);
    await check();
    setIsRetrying(false);
  }, [check]);

  useEffect(() => {
    if (perfFlags.disableBackgroundPolling) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setStatus('connected');
      return;
    }
    check();
    intervalRef.current = setInterval(check, 120_000);

    const handleOnline = () => {
      // Network just came back — the sticky entry is from a different network
      // moment and may be wrong. Flush, then re-probe LAN-first.
      const sid = useAuthStore.getState().activeServerId;
      if (sid) invalidateReachableEndpointCache(sid);
      check();
    };
    const handleOffline = () => setStatus('disconnected');

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [check, perfFlags.disableBackgroundPolling]);

  const server = useAuthStore(s => s.getActiveServer());
  const servers = useAuthStore(s => s.servers);
  const serverName = useMemo(
    () => (server ? serverListDisplayLabel(server, servers) : ''),
    [server, servers],
  );

  return {
    status,
    isRetrying,
    retry,
    isLan: server ? isLanUrl(server.url) : false,
    serverName,
  };
}
