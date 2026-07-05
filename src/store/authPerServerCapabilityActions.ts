import { isNavidromeAudiomuseSoftwareEligible } from '@/lib/server/subsonicServerIdentity';
import type { AuthState } from './authStoreTypes';

type SetState = (
  partial: Partial<AuthState> | ((state: AuthState) => Partial<AuthState>),
) => void;

/**
 * Per-server capability flags learned from pings/probes:
 *
 * - `setEntityRatingSupport` — does setRating apply to album/artist
 *   ids on this server? Stored as `unknown`/`yes`/`no`.
 * - `setAudiomuseNavidromeEnabled` — user opted in/out of the
 *   AudioMuse-AI Instant Mix path for this Navidrome. Disable also
 *   clears the related issue flag.
 * - `setSubsonicServerIdentity` — server's identity from ping. If the
 *   ping reveals the server isn't AudioMuse-eligible (wrong type or
 *   too old), wipe the related caps for that id so the UI doesn't
 *   keep a stale toggle.
 * - `setInstantMixProbe` — legacy probe (pre-0.62). If `empty`, wipe AudioMuse caps.
 * - `setAudiomusePluginProbe` — Navidrome ≥ 0.62 `sonicSimilarity` extension probe.
 * - `setAudiomuseNavidromeIssue` — set/clear the "current session saw a failure" flag.
 */
export function createPerServerCapabilityActions(set: SetState): Pick<
  AuthState,
  | 'setEntityRatingSupport'
  | 'setAudiomuseNavidromeEnabled'
  | 'setSubsonicServerIdentity'
  | 'setInstantMixProbe'
  | 'setAudiomusePluginProbe'
  | 'setOpenSubsonicExtensions'
  | 'setAudiomuseNavidromeIssue'
> {
  return {
    setEntityRatingSupport: (serverId, level) =>
      set(s => ({
        entityRatingSupportByServer: { ...s.entityRatingSupportByServer, [serverId]: level },
      })),

    setAudiomuseNavidromeEnabled: (serverId, enabled) =>
      set(s => {
        const audiomuseNavidromeByServer = enabled
          ? { ...s.audiomuseNavidromeByServer, [serverId]: true }
          : (() => {
              const { [serverId]: _removed, ...rest } = s.audiomuseNavidromeByServer;
              return rest;
            })();
        const { [serverId]: _issueRm, ...issueRest } = s.audiomuseNavidromeIssueByServer;
        return { audiomuseNavidromeByServer, audiomuseNavidromeIssueByServer: issueRest };
      }),

    setSubsonicServerIdentity: (serverId, identity) =>
      set(s => {
        const prev = s.subsonicServerIdentityByServer[serverId];
        const subsonicServerIdentityByServer = { ...s.subsonicServerIdentityByServer, [serverId]: { ...identity } };
        if (!isNavidromeAudiomuseSoftwareEligible(identity)) {
          const { [serverId]: _a, ...audiomuseRest } = s.audiomuseNavidromeByServer;
          const { [serverId]: _i, ...issueRest } = s.audiomuseNavidromeIssueByServer;
          const { [serverId]: _p, ...probeRest } = s.instantMixProbeByServer;
          const { [serverId]: _pp, ...pluginProbeRest } = s.audiomusePluginProbeByServer;
          return {
            subsonicServerIdentityByServer,
            audiomuseNavidromeByServer: audiomuseRest,
            audiomuseNavidromeIssueByServer: issueRest,
            instantMixProbeByServer: probeRest,
            audiomusePluginProbeByServer: pluginProbeRest,
          };
        }
        // Server generation changed (version/type) → drop cached capability probes
        // so the next probe re-runs against the new generation. The user opt-in
        // (`audiomuseNavidromeByServer`) is preserved.
        if (prev && (prev.serverVersion !== identity.serverVersion || prev.type !== identity.type)) {
          const { [serverId]: _p, ...probeRest } = s.instantMixProbeByServer;
          const { [serverId]: _pp, ...pluginProbeRest } = s.audiomusePluginProbeByServer;
          const { [serverId]: _ex, ...extRest } = s.openSubsonicExtensionsByServer;
          return {
            subsonicServerIdentityByServer,
            instantMixProbeByServer: probeRest,
            audiomusePluginProbeByServer: pluginProbeRest,
            openSubsonicExtensionsByServer: extRest,
          };
        }
        return { subsonicServerIdentityByServer };
      }),

    setInstantMixProbe: (serverId, result) =>
      set(s => {
        const instantMixProbeByServer = { ...s.instantMixProbeByServer, [serverId]: result };
        if (result === 'empty') {
          const { [serverId]: _a, ...audiomuseRest } = s.audiomuseNavidromeByServer;
          const { [serverId]: _i, ...issueRest } = s.audiomuseNavidromeIssueByServer;
          return {
            instantMixProbeByServer,
            audiomuseNavidromeByServer: audiomuseRest,
            audiomuseNavidromeIssueByServer: issueRest,
          };
        }
        return { instantMixProbeByServer };
      }),

    setAudiomusePluginProbe: (serverId, result) =>
      set(s => {
        const audiomusePluginProbeByServer = { ...s.audiomusePluginProbeByServer, [serverId]: result };
        if (result === 'present') {
          return {
            audiomusePluginProbeByServer,
            audiomuseNavidromeByServer: { ...s.audiomuseNavidromeByServer, [serverId]: true },
          };
        }
        if (result === 'absent' || result === 'error') {
          const { [serverId]: _a, ...audiomuseRest } = s.audiomuseNavidromeByServer;
          const { [serverId]: _i, ...issueRest } = s.audiomuseNavidromeIssueByServer;
          return {
            audiomusePluginProbeByServer,
            audiomuseNavidromeByServer: audiomuseRest,
            audiomuseNavidromeIssueByServer: issueRest,
          };
        }
        return { audiomusePluginProbeByServer };
      }),

    setOpenSubsonicExtensions: (serverId, extensions) =>
      set(s => ({
        openSubsonicExtensionsByServer: { ...s.openSubsonicExtensionsByServer, [serverId]: extensions },
      })),

    setAudiomuseNavidromeIssue: (serverId, hasIssue) =>
      set(s =>
        hasIssue
          ? { audiomuseNavidromeIssueByServer: { ...s.audiomuseNavidromeIssueByServer, [serverId]: true } }
          : (() => {
              const { [serverId]: _rm, ...rest } = s.audiomuseNavidromeIssueByServer;
              return { audiomuseNavidromeIssueByServer: rest };
            })(),
      ),
  };
}
