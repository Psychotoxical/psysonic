import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/subsonicOpenSubsonic', () => ({
  fetchOpenSubsonicExtensionsWithCredentials: vi.fn(),
}));

import { fetchOpenSubsonicExtensionsWithCredentials } from '@/lib/api/subsonicOpenSubsonic';
import { scheduleInstantMixProbeForServer } from '@/lib/api/subsonic';
import { useAuthStore } from '@/store/authStore';
import type { SubsonicServerIdentity } from '@/lib/server/subsonicServerIdentity';

const fetchMock = vi.mocked(fetchOpenSubsonicExtensionsWithCredentials);
const SID = 'srv-probe';
const id062: SubsonicServerIdentity = { type: 'navidrome', serverVersion: '0.62.0', openSubsonic: true };

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function reset() {
  useAuthStore.setState({
    subsonicServerIdentityByServer: {},
    audiomusePluginProbeByServer: {},
    instantMixProbeByServer: {},
    audiomuseNavidromeByServer: {},
    audiomuseNavidromeIssueByServer: {},
    openSubsonicExtensionsByServer: {},
  } as never);
}

describe('scheduleInstantMixProbeForServer (idempotency)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(['sonicSimilarity']);
    reset();
    useAuthStore.setState({
      servers: [{
        id: SID,
        name: 'Probe',
        url: 'https://music.example.com',
        username: 'u',
        password: 'p',
        customHeaders: [{ name: 'CF-Access-Client-Secret', value: 'gate-secret' }],
        customHeadersApplyTo: 'public',
      }],
    } as never);
  });

  it('probes once, caches the result, then skips on the next poll', async () => {
    scheduleInstantMixProbeForServer(SID, 'url', 'u', 'p', id062);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[3]).toMatchObject({
      url: 'https://music.example.com',
      customHeaders: [{ name: 'CF-Access-Client-Secret', value: 'gate-secret' }],
    });
    await flush();
    expect(useAuthStore.getState().audiomusePluginProbeByServer[SID]).toBe('present');

    scheduleInstantMixProbeForServer(SID, 'url', 'u', 'p', id062);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-probes when forced (user-initiated refresh)', async () => {
    scheduleInstantMixProbeForServer(SID, 'url', 'u', 'p', id062);
    await flush();
    scheduleInstantMixProbeForServer(SID, 'url', 'u', 'p', id062, true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('re-probes after a prior error', async () => {
    fetchMock.mockResolvedValueOnce(null);
    scheduleInstantMixProbeForServer(SID, 'url', 'u', 'p', id062);
    await flush();
    expect(useAuthStore.getState().audiomusePluginProbeByServer[SID]).toBe('error');
    scheduleInstantMixProbeForServer(SID, 'url', 'u', 'p', id062);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stores the full extension list and caches both sonicSimilarity and playbackReport', async () => {
    fetchMock.mockResolvedValue(['sonicSimilarity', 'playbackReport']);
    scheduleInstantMixProbeForServer(SID, 'url', 'u', 'p', id062);
    await flush();
    const s = useAuthStore.getState();
    expect(s.openSubsonicExtensionsByServer[SID]).toEqual(['sonicSimilarity', 'playbackReport']);
    expect(s.audiomusePluginProbeByServer[SID]).toBe('present');
  });

  it('stores the list on a non-Navidrome OpenSubsonic server without driving the AudioMuse probe', async () => {
    fetchMock.mockResolvedValue(['playbackReport']);
    const idGonic: SubsonicServerIdentity = { type: 'gonic', serverVersion: '0.16.0', openSubsonic: true };
    scheduleInstantMixProbeForServer(SID, 'url', 'u', 'p', idGonic);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await flush();
    const s = useAuthStore.getState();
    expect(s.openSubsonicExtensionsByServer[SID]).toEqual(['playbackReport']);
    expect(s.audiomusePluginProbeByServer[SID]).toBeUndefined();
  });
});

describe('setSubsonicServerIdentity (version-change cache invalidation)', () => {
  beforeEach(reset);

  it('clears cached probes on a version change but keeps the opt-in', () => {
    useAuthStore.setState({
      subsonicServerIdentityByServer: { [SID]: id062 },
      audiomusePluginProbeByServer: { [SID]: 'present' },
      audiomuseNavidromeByServer: { [SID]: true },
    } as never);

    useAuthStore.getState().setSubsonicServerIdentity(SID, { type: 'navidrome', serverVersion: '0.63.0', openSubsonic: true });

    const s = useAuthStore.getState();
    expect(s.audiomusePluginProbeByServer[SID]).toBeUndefined();
    expect(s.audiomuseNavidromeByServer[SID]).toBe(true);
  });

  it('keeps cached probes when the identity is unchanged', () => {
    useAuthStore.setState({
      subsonicServerIdentityByServer: { [SID]: id062 },
      audiomusePluginProbeByServer: { [SID]: 'present' },
    } as never);

    useAuthStore.getState().setSubsonicServerIdentity(SID, { ...id062 });

    expect(useAuthStore.getState().audiomusePluginProbeByServer[SID]).toBe('present');
  });
});
