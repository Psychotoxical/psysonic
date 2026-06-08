import { useAuthStore } from '../../../store/authStore';
import {
  isNavidromeAudiomuseSoftwareEligible,
  isNavidromeSonicSimilarityEligible,
  isNavidromeServer,
} from '../../../utils/server/subsonicServerIdentity';
import { PerfProbeMetricSection } from './PerfProbeMetricCard';

function formatServerType(identity: { type?: string; serverVersion?: string; openSubsonic?: boolean } | undefined): string {
  if (!identity?.type?.trim()) return 'Unknown';
  const version = identity.serverVersion?.trim();
  return version ? `${identity.type} ${version}` : identity.type;
}

function formatPluginProbe(
  sonicEligible: boolean,
  pluginProbe: string | undefined,
): string {
  if (!sonicEligible) return 'N/A (Navidrome < 0.62)';
  switch (pluginProbe) {
    case 'present': return 'Detected (sonicSimilarity)';
    case 'absent': return 'Not detected';
    case 'probing': return 'Checking…';
    case 'error': return 'Probe failed';
    default: return 'Not probed yet';
  }
}

function formatLegacyProbe(
  sonicEligible: boolean,
  legacyProbe: string | undefined,
): string | null {
  if (sonicEligible) return null;
  if (!legacyProbe) return 'Not probed yet';
  return legacyProbe;
}

export default function SidebarPerfProbeServerSection() {
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
      <PerfProbeMetricSection title="Active server" defaultOpen>
        <div className="perf-monitor-empty perf-monitor-empty--inline">
          No server configured.
        </div>
      </PerfProbeMetricSection>
    );
  }

  const sonicEligible = isNavidromeSonicSimilarityEligible(identity);
  const legacyLabel = formatLegacyProbe(sonicEligible, legacyProbe);

  return (
    <PerfProbeMetricSection title="Active server" defaultOpen>
      <dl className="perf-server-dl">
        <div className="perf-server-dl__row">
          <dt>Name</dt>
          <dd>{server.name || server.url}</dd>
        </div>
        <div className="perf-server-dl__row">
          <dt>Profile URL</dt>
          <dd>{server.url}</dd>
        </div>
        <div className="perf-server-dl__row">
          <dt>Subsonic server</dt>
          <dd>{formatServerType(identity)}</dd>
        </div>
        <div className="perf-server-dl__row">
          <dt>OpenSubsonic</dt>
          <dd>{identity?.openSubsonic ? 'yes' : identity ? 'no' : '—'}</dd>
        </div>
        {isNavidromeServer(identity) && isNavidromeAudiomuseSoftwareEligible(identity) && (
          <>
            <div className="perf-server-dl__row">
              <dt>AudioMuse plugin</dt>
              <dd>{formatPluginProbe(sonicEligible, pluginProbe)}</dd>
            </div>
            {legacyLabel != null && (
              <div className="perf-server-dl__row">
                <dt>Legacy similar probe</dt>
                <dd>{legacyLabel}</dd>
              </div>
            )}
            <div className="perf-server-dl__row">
              <dt>AudioMuse mode</dt>
              <dd>{audiomuseEnabled ? 'enabled in Settings' : 'off'}</dd>
            </div>
          </>
        )}
      </dl>
    </PerfProbeMetricSection>
  );
}
