import { useEffect } from 'react';
import { getScanStatus } from '../api/subsonicScan';
import { useScanStore } from '../store/scanStore';
import { useAuthStore } from '../store/authStore';
import { serverListDisplayLabel } from '../utils/server/serverDisplayName';
import { showToast } from '../utils/ui/toast';
import i18n from '../i18n';

const POLL_MS = 2000;
const JUST_FINISHED_HOLD_MS = 2500;

/**
 * Polls `getScanStatus` on each server whose scan was triggered from the app.
 * Lives at the app root so dismissing the dropdown doesn't stop the poll.
 */
export function useScanPolling() {
  useEffect(() => {
    let cancelled = false;
    const inFlight = new Set<string>();

    const tick = async () => {
      if (cancelled) return;
      const { byServer, set } = useScanStore.getState();
      const runningIds = Object.entries(byServer)
        .filter(([, e]) => e.phase === 'starting' || e.phase === 'running')
        .map(([id]) => id);

      await Promise.all(runningIds.map(async serverId => {
        if (inFlight.has(serverId)) return;
        inFlight.add(serverId);
        try {
          const status = await getScanStatus(serverId);
          if (cancelled) return;
          const current = useScanStore.getState().byServer[serverId];
          if (!current) return;

          if (status.scanning) {
            set(serverId, { phase: 'running', count: status.count });
          } else {
            // Scan finished — show check briefly, then auto-clear.
            set(serverId, { phase: 'just-finished', count: status.count });
            const servers = useAuthStore.getState().servers;
            const srv = servers.find(s => s.id === serverId);
            const name = srv ? serverListDisplayLabel(srv, servers) : serverId;
            showToast(i18n.t('settings.scan.toast', { name, count: status.count }), 4000, 'success');
            setTimeout(() => {
              const after = useScanStore.getState().byServer[serverId];
              if (after?.phase === 'just-finished') {
                useScanStore.getState().clear(serverId);
              }
            }, JUST_FINISHED_HOLD_MS);
          }
        } catch {
          if (!cancelled) set(serverId, { phase: 'error' });
        } finally {
          inFlight.delete(serverId);
        }
      }));
    };

    const interval = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);
}
