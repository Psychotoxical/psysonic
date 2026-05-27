import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAuthStore } from '../store/authStore';
import { pingWithCredentials, scheduleInstantMixProbeForServer } from '../api/subsonic';
import { serverListDisplayLabel } from '../utils/server/serverDisplayName';
import { isLanUrl } from '../utils/server/serverEndpoint';
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

    const ping = await pingWithCredentials(server.url, server.username, server.password);
       if (ping.ok) {
      const sid = useAuthStore.getState().activeServerId;
      if (sid) {
        const identity = {
          type: ping.type,
          serverVersion: ping.serverVersion,
          openSubsonic: ping.openSubsonic,
        };
        useAuthStore.getState().setSubsonicServerIdentity(sid, identity);
        scheduleInstantMixProbeForServer(sid, server.url, server.username, server.password, identity);
      }
    }
    setStatus(ping.ok ? 'connected' : 'disconnected');
  }, []);

  const retry = useCallback(async () => {
    setIsRetrying(true);
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

    const handleOnline = () => check();
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
