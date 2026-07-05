import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import {
  FEATURE_AUDIOMUSE_SIMILAR_TRACKS,
  FEATURE_PLAYBACK_REPORT,
  OP_SIMILAR_TRACKS,
} from './catalog';
import {
  isFeatureActiveForServer,
  resolveCallRoutesForServer,
  resolveFeatureForServer,
} from './storeView';

const SID = 'srv-test';

function seed(identity: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  useAuthStore.setState({
    subsonicServerIdentityByServer: { [SID]: identity as never },
    audiomusePluginProbeByServer: {},
    instantMixProbeByServer: {},
    audiomuseNavidromeByServer: {},
    openSubsonicExtensionsByServer: {},
    ...extra,
  } as never);
}

describe('storeView (capability read facade)', () => {
  beforeEach(() => {
    useAuthStore.setState({
      subsonicServerIdentityByServer: {},
      audiomusePluginProbeByServer: {},
      instantMixProbeByServer: {},
      audiomuseNavidromeByServer: {},
      openSubsonicExtensionsByServer: {},
    } as never);
  });

  it('resolves sonic strategy as present from the plugin probe map', () => {
    seed({ type: 'navidrome', serverVersion: '0.62.1', openSubsonic: true }, {
      audiomusePluginProbeByServer: { [SID]: 'present' },
    });
    const resolved = resolveFeatureForServer(SID, FEATURE_AUDIOMUSE_SIMILAR_TRACKS);
    expect(resolved).toMatchObject({ strategyId: 'opensubsonic.sonicSimilarity', status: 'present', activation: 'auto' });
    expect(isFeatureActiveForServer(SID, FEATURE_AUDIOMUSE_SIMILAR_TRACKS)).toBe(true);
    expect(resolveCallRoutesForServer(SID, FEATURE_AUDIOMUSE_SIMILAR_TRACKS, OP_SIMILAR_TRACKS).map(r => r.endpoint))
      .toEqual(['getSonicSimilarTracks.view', 'getSimilarSongs.view']);
  });

  it('resolves sonic absent → legacy-only route, feature off', () => {
    seed({ type: 'navidrome', serverVersion: '0.62.1', openSubsonic: true }, {
      audiomusePluginProbeByServer: { [SID]: 'absent' },
    });
    expect(resolveFeatureForServer(SID, FEATURE_AUDIOMUSE_SIMILAR_TRACKS)?.status).toBe('absent');
    expect(isFeatureActiveForServer(SID, FEATURE_AUDIOMUSE_SIMILAR_TRACKS)).toBe(false);
    expect(resolveCallRoutesForServer(SID, FEATURE_AUDIOMUSE_SIMILAR_TRACKS, OP_SIMILAR_TRACKS).map(r => r.endpoint))
      .toEqual(['getSimilarSongs.view']);
  });

  it('legacy server: manual opt-in drives active state', () => {
    seed({ type: 'navidrome', serverVersion: '0.61.0', openSubsonic: false }, {
      instantMixProbeByServer: { [SID]: 'ok' },
      audiomuseNavidromeByServer: { [SID]: true },
    });
    expect(resolveFeatureForServer(SID, FEATURE_AUDIOMUSE_SIMILAR_TRACKS)?.strategyId).toBe('subsonic.getSimilarSongs');
    expect(isFeatureActiveForServer(SID, FEATURE_AUDIOMUSE_SIMILAR_TRACKS)).toBe(true);
  });

  it('non-Navidrome server resolves ineligible with no routes', () => {
    seed({ type: 'gonic', serverVersion: '0.16.0', openSubsonic: true });
    expect(resolveFeatureForServer(SID, FEATURE_AUDIOMUSE_SIMILAR_TRACKS)?.status).toBe('ineligible');
    expect(resolveCallRoutesForServer(SID, FEATURE_AUDIOMUSE_SIMILAR_TRACKS, OP_SIMILAR_TRACKS)).toEqual([]);
  });

  it('playbackReport is active from the stored extension list', () => {
    seed({ type: 'navidrome', serverVersion: '0.62.1', openSubsonic: true }, {
      openSubsonicExtensionsByServer: { [SID]: ['sonicSimilarity', 'playbackReport'] },
    });
    expect(isFeatureActiveForServer(SID, FEATURE_PLAYBACK_REPORT)).toBe(true);
    // The same stored list still satisfies AudioMuse detection.
    expect(isFeatureActiveForServer(SID, FEATURE_AUDIOMUSE_SIMILAR_TRACKS)).toBe(true);
  });

  it('playbackReport is inactive when the extension is absent from the list', () => {
    seed({ type: 'navidrome', serverVersion: '0.62.1', openSubsonic: true }, {
      openSubsonicExtensionsByServer: { [SID]: ['sonicSimilarity'] },
    });
    expect(isFeatureActiveForServer(SID, FEATURE_PLAYBACK_REPORT)).toBe(false);
  });
});
