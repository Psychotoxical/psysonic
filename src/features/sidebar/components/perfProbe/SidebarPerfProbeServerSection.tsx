import { useAuthStore } from '@/store/authStore';
import type { NavidromeAdminRole } from '@/lib/hooks/useNavidromeAdminRole';
import { isNavidromeServer, formatServerSoftware } from '@/lib/server/subsonicServerIdentity';
import { FEATURE_AUDIOMUSE_SIMILAR_TRACKS, OP_SIMILAR_TRACKS } from '@/lib/serverCapabilities/catalog';
import {
  isFeatureActiveForServer,
  resolveCallRoutesForServer,
  resolveFeatureForServer,
} from '@/lib/serverCapabilities/storeView';
import type { CapabilityStatus, FeatureTrust, ResolvedCapability } from '@/lib/serverCapabilities/types';
import { PerfProbeMetricSection } from '@/features/sidebar/components/perfProbe/PerfProbeMetricCard';
import PerfProbeDetailList, { type PerfProbeDetailRow } from '@/features/sidebar/components/perfProbe/PerfProbeDetailList';
import PerfProbeStatusBadge, { type PerfProbeBadgeTone } from '@/features/sidebar/components/perfProbe/PerfProbeStatusBadge';

function detectionBadge(status: CapabilityStatus): { tone: PerfProbeBadgeTone; label: string } {
  switch (status) {
    case 'present': return { tone: 'ok', label: 'Detected' };
    case 'absent': return { tone: 'muted', label: 'Not detected' };
    case 'probing': return { tone: 'warn', label: 'Checking…' };
    case 'error': return { tone: 'error', label: 'Probe failed' };
    case 'unknown': return { tone: 'muted', label: 'Not probed yet' };
    default: return { tone: 'muted', label: 'N/A' };
  }
}

function strategyLabel(strategyId: string | null): string {
  switch (strategyId) {
    case 'opensubsonic.sonicSimilarity': return 'sonicSimilarity (OpenSubsonic)';
    case 'subsonic.getSimilarSongs': return 'getSimilarSongs (legacy)';
    default: return '—';
  }
}

function trustBadge(trust: FeatureTrust | null): { tone: PerfProbeBadgeTone; label: string } {
  switch (trust) {
    case 'high': return { tone: 'ok', label: 'high' };
    case 'low': return { tone: 'warn', label: 'heuristic' };
    default: return { tone: 'muted', label: '—' };
  }
}

function adminRoleBadge(role: NavidromeAdminRole): { tone: PerfProbeBadgeTone; label: string } {
  switch (role) {
    case 'admin': return { tone: 'ok', label: 'Admin' };
    case 'user': return { tone: 'neutral', label: 'Standard user' };
    case 'checking':
    case 'idle': return { tone: 'warn', label: 'Checking…' };
    case 'error': return { tone: 'error', label: 'Could not verify' };
    case 'na':
    default: return { tone: 'muted', label: 'N/A' };
  }
}

interface Props {
  adminRole?: NavidromeAdminRole;
}

export default function SidebarPerfProbeServerSection({ adminRole = 'na' }: Props) {
  const activeServerId = useAuthStore(s => s.activeServerId);
  const server = useAuthStore(s => s.servers.find(srv => srv.id === s.activeServerId));
  const identity = useAuthStore(s =>
    activeServerId ? s.subsonicServerIdentityByServer[activeServerId] : undefined,
  );
  // Subscribe to the probe maps so the resolver-derived rows re-render on probe updates.
  useAuthStore(s => (activeServerId ? s.audiomusePluginProbeByServer[activeServerId] : undefined));
  useAuthStore(s => (activeServerId ? s.instantMixProbeByServer[activeServerId] : undefined));
  useAuthStore(s => (activeServerId ? s.audiomuseNavidromeByServer[activeServerId] : undefined));

  if (!server) {
    return (
      <PerfProbeMetricSection title="Active server" defaultOpen layout="stack">
        <div className="perf-monitor-empty perf-monitor-empty--inline">
          No server configured.
        </div>
      </PerfProbeMetricSection>
    );
  }

  const navidrome = isNavidromeServer(identity);
  const role = adminRoleBadge(adminRole);
  const resolved: ResolvedCapability | null = activeServerId
    ? resolveFeatureForServer(activeServerId, FEATURE_AUDIOMUSE_SIMILAR_TRACKS)
    : null;
  const audiomuseActive = activeServerId
    ? isFeatureActiveForServer(activeServerId, FEATURE_AUDIOMUSE_SIMILAR_TRACKS)
    : false;
  const routes = activeServerId
    ? resolveCallRoutesForServer(activeServerId, FEATURE_AUDIOMUSE_SIMILAR_TRACKS, OP_SIMILAR_TRACKS)
    : [];

  const rows: PerfProbeDetailRow[] = [
    { label: 'Name', value: server.name || server.url },
    { label: 'Profile URL', value: <code className="perf-server-dl__code">{server.url}</code> },
    { label: 'Subsonic server', value: formatServerSoftware(identity) ?? 'Unknown' },
    {
      label: 'OpenSubsonic',
      value: identity?.openSubsonic
        ? <PerfProbeStatusBadge tone="ok">yes</PerfProbeStatusBadge>
        : identity
          ? <PerfProbeStatusBadge tone="muted">no</PerfProbeStatusBadge>
          : '—',
    },
  ];

  if (navidrome) {
    rows.push({
      label: 'Navidrome role',
      value: <PerfProbeStatusBadge tone={role.tone}>{role.label}</PerfProbeStatusBadge>,
    });
  }

  if (resolved && resolved.strategyId !== null && resolved.status !== 'ineligible') {
    const detect = detectionBadge(resolved.status);
    const trust = trustBadge(resolved.trust);
    rows.push(
      {
        label: 'AudioMuse Instant Mix',
        value: <PerfProbeStatusBadge tone={detect.tone}>{detect.label}</PerfProbeStatusBadge>,
      },
      { label: 'Provider', value: <code className="perf-server-dl__code">{strategyLabel(resolved.strategyId)}</code> },
      {
        label: 'Detection trust',
        value: <PerfProbeStatusBadge tone={trust.tone}>{trust.label}</PerfProbeStatusBadge>,
      },
      {
        label: 'Mode',
        value: audiomuseActive
          ? (
            <PerfProbeStatusBadge tone="ok">
              {resolved.activation === 'auto' ? 'active (auto)' : 'enabled in Settings'}
            </PerfProbeStatusBadge>
          )
          : <PerfProbeStatusBadge tone="muted">off</PerfProbeStatusBadge>,
      },
    );
    if (routes.length > 0) {
      rows.push({
        label: 'Call route',
        value: <code className="perf-server-dl__code">{routes.map(r => r.endpoint).join(' → ')}</code>,
      });
    }
  }

  return (
    <PerfProbeMetricSection title="Active server" defaultOpen layout="stack">
      <PerfProbeDetailList rows={rows} />
    </PerfProbeMetricSection>
  );
}
