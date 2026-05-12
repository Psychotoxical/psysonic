import { isNavidromeAudiomuseSoftwareEligible } from '../utils/subsonicServerIdentity';
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
 * - `setInstantMixProbe` — probe result for getSimilarSongs. If
 *   `empty`, wipe the related AudioMuse caps so the row hides.
 * - `setAudiomuseNavidromeIssue` — set/clear the "current session
 *   saw a failure" flag.
 */
export function createPerServerCapabilityActions(set: SetState): Pick<
  AuthState,
  | 'setEntityRatingSupport'
  | 'setAudiomuseNavidromeEnabled'
  | 'setSubsonicServerIdentity'
  | 'setInstantMixProbe'
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
        const subsonicServerIdentityByServer = { ...s.subsonicServerIdentityByServer, [serverId]: { ...identity } };
        if (!isNavidromeAudiomuseSoftwareEligible(identity)) {
          const { [serverId]: _a, ...audiomuseRest } = s.audiomuseNavidromeByServer;
          const { [serverId]: _i, ...issueRest } = s.audiomuseNavidromeIssueByServer;
          const { [serverId]: _p, ...probeRest } = s.instantMixProbeByServer;
          return {
            subsonicServerIdentityByServer,
            audiomuseNavidromeByServer: audiomuseRest,
            audiomuseNavidromeIssueByServer: issueRest,
            instantMixProbeByServer: probeRest,
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
