import { useAuthStore } from '../../../store/authStore';
import type { NavidromeAdminRole } from '../../../hooks/useNavidromeAdminRole';
import {
  isNavidromeAudiomuseSoftwareEligible,
  isNavidromeSonicSimilarityEligible,
  isNavidromeServer,
} from '../../../utils/server/subsonicServerIdentity';
import { PerfProbeMetricSection } from './PerfProbeMetricCard';
import PerfProbeDetailList, { type PerfProbeDetailRow } from './PerfProbeDetailList';
import PerfProbeStatusBadge, { type PerfProbeBadgeTone } from './PerfProbeStatusBadge';

function formatServerType(identity: { type?: string; serverVersion?: string; openSubsonic?: boolean } | undefined): string {
  if (!identity?.type?.trim()) return 'Unknown';
  const version = identity.serverVersion?.trim();
  return version ? `${identity.type} ${version}` : identity.type;
}

function pluginProbeBadge(
  sonicEligible: boolean,
  pluginProbe: string | undefined,
): { tone: PerfProbeBadgeTone; label: string } {
  if (!sonicEligible) return { tone: 'muted', label: 'N/A (Navidrome < 0.62)' };
  switch (pluginProbe) {
    case 'present': return { tone: 'ok', label: 'Detected (sonicSimilarity)' };
    case 'absent': return { tone: 'muted', label: 'Not detected' };
    case 'probing': return { tone: 'warn', label: 'Checking…' };
    case 'error': return { tone: 'error', label: 'Probe failed' };
    default: return { tone: 'muted', label: 'Not probed yet' };
  }
}

function legacyProbeBadge(
  sonicEligible: boolean,
  legacyProbe: string | undefined,
): { tone: PerfProbeBadgeTone; label: string } | null {
  if (sonicEligible) return null;
  if (!legacyProbe) return { tone: 'muted', label: 'Not probed yet' };
  if (legacyProbe === 'ok') return { tone: 'ok', label: legacyProbe };
  if (legacyProbe === 'empty' || legacyProbe === 'skipped') return { tone: 'muted', label: legacyProbe };
  return { tone: 'error', label: legacyProbe };
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
  const pluginProbe = useAuthStore(s =>
    activeServerId ? s.audiomusePluginProbeByServer[activeServerId] : undefined,
  );
  const legacyProbe = useAuthStore(s =>
    activeServerId ? s.instantMixProbeByServer[activeServerId] : undefined,
  );
  const audiomuseEnabled = useAuthStore(s =>
    activeServerId ? Boolean(s.audiomuseNavidromeByServer[activeServerId]) : false,
  );

  if (!server) {
    return (
      <PerfProbeMetricSection title="Active server" defaultOpen layout="stack">
        <div className="perf-monitor-empty perf-monitor-empty--inline">
          No server configured.
        </div>
      </PerfProbeMetricSection>
    );
  }

  const sonicEligible = isNavidromeSonicSimilarityEligible(identity);
  const plugin = pluginProbeBadge(sonicEligible, pluginProbe);
  const legacy = legacyProbeBadge(sonicEligible, legacyProbe);
  const navidrome = isNavidromeServer(identity);
  const role = adminRoleBadge(adminRole);

  const rows: PerfProbeDetailRow[] = [
    { label: 'Name', value: server.name || server.url },
    { label: 'Profile URL', value: <code className="perf-server-dl__code">{server.url}</code> },
    { label: 'Subsonic server', value: formatServerType(identity) },
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

  if (navidrome && isNavidromeAudiomuseSoftwareEligible(identity)) {
    rows.push({
      label: 'AudioMuse plugin',
      value: <PerfProbeStatusBadge tone={plugin.tone}>{plugin.label}</PerfProbeStatusBadge>,
    });
    if (legacy) {
      rows.push({
        label: 'Legacy similar probe',
        value: <PerfProbeStatusBadge tone={legacy.tone}>{legacy.label}</PerfProbeStatusBadge>,
      });
    }
    rows.push({
      label: 'AudioMuse mode',
      value: audiomuseEnabled
        ? <PerfProbeStatusBadge tone="ok">enabled in Settings</PerfProbeStatusBadge>
        : <PerfProbeStatusBadge tone="muted">off</PerfProbeStatusBadge>,
    });
  }

  return (
    <PerfProbeMetricSection title="Active server" defaultOpen layout="stack">
      <PerfProbeDetailList rows={rows} />
    </PerfProbeMetricSection>
  );
}
