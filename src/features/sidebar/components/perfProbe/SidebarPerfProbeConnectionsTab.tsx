import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useConnectionStatus } from '@/lib/hooks/useConnectionStatus';
import { useNavidromeAdminRole } from '@/lib/hooks/useNavidromeAdminRole';
import { serverListDisplayLabel } from '@/lib/server/serverDisplayName';
import { findServerByIdOrIndexKey } from '@/lib/server/serverLookup';
import { PerfProbeMetricSection } from '@/features/sidebar/components/perfProbe/PerfProbeMetricCard';
import PerfProbeDetailList from '@/features/sidebar/components/perfProbe/PerfProbeDetailList';
import PerfProbeStatusBadge, { type PerfProbeBadgeTone } from '@/features/sidebar/components/perfProbe/PerfProbeStatusBadge';
import SidebarPerfProbeServerSection from '@/features/sidebar/components/perfProbe/SidebarPerfProbeServerSection';

function connectionStatusBadge(status: string): { tone: PerfProbeBadgeTone; label: string } {
  switch (status) {
    case 'connected': return { tone: 'ok', label: 'Connected' };
    case 'disconnected': return { tone: 'error', label: 'Disconnected' };
    case 'checking': return { tone: 'warn', label: 'Checking…' };
    default: return { tone: 'muted', label: status };
  }
}

function sessionBadge(loggedIn: boolean): { tone: PerfProbeBadgeTone; label: string } {
  return loggedIn
    ? { tone: 'ok', label: 'Logged in' }
    : { tone: 'muted', label: 'Not logged in' };
}

function adminRoleBadge(role: ReturnType<typeof useNavidromeAdminRole>): { tone: PerfProbeBadgeTone; label: string } {
  switch (role) {
    case 'admin': return { tone: 'ok', label: 'Admin' };
    case 'user': return { tone: 'neutral', label: 'Standard user' };
    case 'checking':
    case 'idle': return { tone: 'warn', label: 'Checking…' };
    case 'error': return { tone: 'error', label: 'Could not verify' };
    case 'na':
    default: return { tone: 'muted', label: 'N/A (not Navidrome)' };
  }
}

function endpointBadge(isLan: boolean): { tone: PerfProbeBadgeTone; label: string } {
  return isLan
    ? { tone: 'ok', label: 'LAN' }
    : { tone: 'neutral', label: 'Public / remote' };
}

export default function SidebarPerfProbeConnectionsTab() {
  const { status, isLan, serverName } = useConnectionStatus();
  const isLoggedIn = useAuthStore(s => s.isLoggedIn);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const servers = useAuthStore(s => s.servers);
  const connectUrl = useAuthStore(s => s.getBaseUrl());
  const queueServerId = usePlayerStore(s => s.queueServerId);
  const adminRole = useNavidromeAdminRole();

  const queueServer = queueServerId ? findServerByIdOrIndexKey(queueServerId) : undefined;
  const queueDiffersFromActive = Boolean(
    queueServerId && activeServerId && queueServerId !== activeServerId,
  );

  const connBadge = connectionStatusBadge(status);
  const sessBadge = sessionBadge(isLoggedIn);
  const roleBadge = adminRoleBadge(adminRole);

  return (
    <div className="perf-monitor">
      <div className="perf-conn-summary" aria-label="Connection overview">
        <div className="perf-conn-summary__item">
          <span className="perf-conn-summary__label">Link</span>
          <PerfProbeStatusBadge tone={connBadge.tone}>{connBadge.label}</PerfProbeStatusBadge>
        </div>
        <div className="perf-conn-summary__item">
          <span className="perf-conn-summary__label">Session</span>
          <PerfProbeStatusBadge tone={sessBadge.tone}>{sessBadge.label}</PerfProbeStatusBadge>
        </div>
        {isLoggedIn && (
          <div className="perf-conn-summary__item">
            <span className="perf-conn-summary__label">Role</span>
            <PerfProbeStatusBadge tone={roleBadge.tone}>{roleBadge.label}</PerfProbeStatusBadge>
          </div>
        )}
      </div>

      <PerfProbeMetricSection title="Connection" defaultOpen layout="stack">
        <PerfProbeDetailList
          rows={[
            {
              label: 'Status',
              value: <PerfProbeStatusBadge tone={connBadge.tone}>{connBadge.label}</PerfProbeStatusBadge>,
            },
            {
              label: 'Session',
              value: <PerfProbeStatusBadge tone={sessBadge.tone}>{sessBadge.label}</PerfProbeStatusBadge>,
            },
            ...(isLoggedIn
              ? [{
                  label: 'Navidrome role',
                  value: <PerfProbeStatusBadge tone={roleBadge.tone}>{roleBadge.label}</PerfProbeStatusBadge>,
                }]
              : []),
            ...(serverName ? [{ label: 'Browse label', value: serverName }] : []),
            ...(connectUrl ? [{ label: 'Connect URL', value: <code className="perf-server-dl__code">{connectUrl}</code> }] : []),
            ...(status === 'connected'
              ? [{
                  label: 'Endpoint',
                  value: (
                    <PerfProbeStatusBadge tone={endpointBadge(isLan).tone}>
                      {endpointBadge(isLan).label}
                    </PerfProbeStatusBadge>
                  ),
                }]
              : []),
          ]}
        />
      </PerfProbeMetricSection>

      <SidebarPerfProbeServerSection adminRole={adminRole} />

      {queueDiffersFromActive && queueServer && (
        <PerfProbeMetricSection title="Queue playback server" defaultOpen={false} layout="stack">
          <PerfProbeDetailList
            rows={[
              { label: 'Name', value: serverListDisplayLabel(queueServer, servers) },
              { label: 'Scope key', value: <code className="perf-server-dl__code">{queueServerId}</code> },
            ]}
          />
        </PerfProbeMetricSection>
      )}
    </div>
  );
}
