import { useAuthStore } from '../../../store/authStore';
import { usePlayerStore } from '../../../store/playerStore';
import { useConnectionStatus } from '../../../hooks/useConnectionStatus';
import { serverListDisplayLabel } from '../../../utils/server/serverDisplayName';
import { findServerByIdOrIndexKey } from '../../../utils/server/serverLookup';
import { PerfProbeMetricSection } from './PerfProbeMetricCard';
import SidebarPerfProbeServerSection from './SidebarPerfProbeServerSection';

function formatConnectionStatus(status: string): string {
  switch (status) {
    case 'connected': return 'Connected';
    case 'disconnected': return 'Disconnected';
    case 'checking': return 'Checking…';
    default: return status;
  }
}

export default function SidebarPerfProbeConnectionsTab() {
  const { status, isLan, serverName } = useConnectionStatus();
  const isLoggedIn = useAuthStore(s => s.isLoggedIn);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const servers = useAuthStore(s => s.servers);
  const connectUrl = useAuthStore(s => s.getBaseUrl());
  const queueServerId = usePlayerStore(s => s.queueServerId);

  const queueServer = queueServerId ? findServerByIdOrIndexKey(queueServerId) : undefined;
  const queueDiffersFromActive = Boolean(
    queueServerId && activeServerId && queueServerId !== activeServerId,
  );

  return (
    <div className="perf-monitor">
      <PerfProbeMetricSection title="Connection" defaultOpen>
        <dl className="perf-server-dl">
          <div className="perf-server-dl__row">
            <dt>Status</dt>
            <dd>{formatConnectionStatus(status)}</dd>
          </div>
          <div className="perf-server-dl__row">
            <dt>Session</dt>
            <dd>{isLoggedIn ? 'Logged in' : 'Not logged in'}</dd>
          </div>
          {serverName && (
            <div className="perf-server-dl__row">
              <dt>Browse label</dt>
              <dd>{serverName}</dd>
            </div>
          )}
          {connectUrl && (
            <div className="perf-server-dl__row">
              <dt>Connect URL</dt>
              <dd>{connectUrl}</dd>
            </div>
          )}
          {status === 'connected' && (
            <div className="perf-server-dl__row">
              <dt>Endpoint</dt>
              <dd>{isLan ? 'LAN' : 'Public / remote'}</dd>
            </div>
          )}
        </dl>
      </PerfProbeMetricSection>

      <SidebarPerfProbeServerSection />

      {queueDiffersFromActive && queueServer && (
        <PerfProbeMetricSection title="Queue playback server" defaultOpen={false}>
          <dl className="perf-server-dl">
            <div className="perf-server-dl__row">
              <dt>Name</dt>
              <dd>{serverListDisplayLabel(queueServer, servers)}</dd>
            </div>
            <div className="perf-server-dl__row">
              <dt>Scope key</dt>
              <dd>{queueServerId}</dd>
            </div>
          </dl>
        </PerfProbeMetricSection>
      )}
    </div>
  );
}
