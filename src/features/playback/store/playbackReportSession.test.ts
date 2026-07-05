import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/subsonicScrobble', () => ({
  reportPlayback: vi.fn(() => Promise.resolve()),
  reportNowPlaying: vi.fn(() => Promise.resolve()),
}));
vi.mock('@/lib/serverCapabilities/storeView', () => ({
  isFeatureActiveForServer: vi.fn(),
}));
vi.mock('@/store/authStore', () => ({
  useAuthStore: { getState: vi.fn(() => ({ nowPlayingEnabled: true })) },
}));
vi.mock('@/features/playback/store/playbackProgress', () => ({
  getPlaybackProgressSnapshot: vi.fn(() => ({ currentTime: 12, progress: 0, buffered: 0, buffering: false })),
}));
vi.mock('@/features/playback/store/playbackRateStore', () => ({
  usePlaybackRateStore: {
    getState: () => ({ enabled: false, strategy: 'speed_corrected', speed: 1, pitchSemitones: 0 }),
  },
}));
vi.mock('@/features/playback/utils/audio/playbackRateHelpers', () => ({ isPlaybackRateApplied: () => false }));
vi.mock('@/store/orbitRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/store/orbitRuntime')>()),
  isOrbitPlaybackSyncActive: () => false,
}));

import { reportNowPlaying, reportPlayback } from '@/lib/api/subsonicScrobble';
import { isFeatureActiveForServer } from '@/lib/serverCapabilities/storeView';
import { useAuthStore } from '@/store/authStore';
import {
  _resetPlaybackReportSessionForTest,
  playbackReportPaused,
  playbackReportPlaying,
  playbackReportSeek,
  playbackReportStart,
  playbackReportStopped,
} from '@/features/playback/store/playbackReportSession';

const reportPlaybackMock = vi.mocked(reportPlayback);
const reportNowPlayingMock = vi.mocked(reportNowPlaying);
const featureActiveMock = vi.mocked(isFeatureActiveForServer);
const authStateMock = vi.mocked(useAuthStore.getState);

const SID = 'srv-1';
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function lastState(): string | undefined {
  const calls = reportPlaybackMock.mock.calls;
  const call = calls[calls.length - 1];
  return call?.[1].state;
}

beforeEach(() => {
  reportPlaybackMock.mockClear();
  reportPlaybackMock.mockResolvedValue(undefined);
  reportNowPlayingMock.mockClear();
  featureActiveMock.mockReset();
  featureActiveMock.mockReturnValue(true);
  authStateMock.mockReturnValue({ nowPlayingEnabled: true } as never);
  _resetPlaybackReportSessionForTest();
});

afterEach(() => {
  _resetPlaybackReportSessionForTest();
});

describe('playbackReportStart', () => {
  it('does nothing when now-playing is disabled', () => {
    authStateMock.mockReturnValue({ nowPlayingEnabled: false } as never);
    playbackReportStart('t1', SID);
    expect(reportPlaybackMock).not.toHaveBeenCalled();
    expect(reportNowPlayingMock).not.toHaveBeenCalled();
  });

  it('opens the FSM with starting then playing on a new track', async () => {
    playbackReportStart('t1', SID);
    expect(reportPlaybackMock).toHaveBeenCalledTimes(1);
    expect(reportPlaybackMock.mock.calls[0][1]).toMatchObject({
      mediaId: 't1',
      state: 'starting',
      positionMs: 12000,
      playbackRate: 1,
      ignoreScrobble: true,
    });
    await flush();
    expect(reportPlaybackMock).toHaveBeenCalledTimes(2);
    expect(reportPlaybackMock.mock.calls[1][1].state).toBe('playing');
  });

  it('falls back to the legacy presence call when the extension is absent', () => {
    featureActiveMock.mockReturnValue(false);
    playbackReportStart('t1', SID);
    expect(reportPlaybackMock).not.toHaveBeenCalled();
    expect(reportNowPlayingMock).toHaveBeenCalledWith('t1', SID);
  });

  it('stops the previous server before opening a cross-server session', async () => {
    playbackReportStart('t1', SID);
    await flush();
    reportPlaybackMock.mockClear();

    playbackReportStart('t2', 'srv-2');
    expect(reportPlaybackMock).toHaveBeenCalledTimes(1);
    expect(reportPlaybackMock.mock.calls[0][1]).toMatchObject({
      mediaId: 't1',
      state: 'stopped',
    });
    await flush();
    expect(reportPlaybackMock.mock.calls[1][1]).toMatchObject({
      mediaId: 't2',
      state: 'starting',
    });
    expect(reportPlaybackMock.mock.calls[2][1].state).toBe('playing');
  });
});

describe('FSM transitions on an open session', () => {
  beforeEach(async () => {
    playbackReportStart('t1', SID);
    await flush();
    reportPlaybackMock.mockClear();
  });

  it('reports playing on heartbeat with the supplied position', () => {
    playbackReportPlaying(30);
    expect(reportPlaybackMock).toHaveBeenCalledTimes(1);
    expect(reportPlaybackMock.mock.calls[0][1]).toMatchObject({ state: 'playing', positionMs: 30000 });
  });

  it('reports paused', () => {
    playbackReportPaused(45);
    expect(lastState()).toBe('paused');
    expect(reportPlaybackMock.mock.calls[0][1].positionMs).toBe(45000);
  });

  it('reports the transport state on seek', () => {
    playbackReportSeek(60, true);
    expect(lastState()).toBe('playing');
    playbackReportSeek(60, false);
    expect(lastState()).toBe('paused');
  });

  it('reports stopped and clears the session', async () => {
    await playbackReportStopped(90);
    expect(lastState()).toBe('stopped');
    reportPlaybackMock.mockClear();
    // No session left: further FSM calls are inert.
    playbackReportPlaying(100);
    playbackReportPaused(100);
    expect(reportPlaybackMock).not.toHaveBeenCalled();
  });
});

describe('extension toggled off mid-session', () => {
  it('stops emitting FSM reports once the server no longer advertises the extension', async () => {
    playbackReportStart('t1', SID);
    await flush();
    reportPlaybackMock.mockClear();
    featureActiveMock.mockReturnValue(false);
    playbackReportPlaying(10);
    playbackReportPaused(10);
    expect(reportPlaybackMock).not.toHaveBeenCalled();
  });
});
