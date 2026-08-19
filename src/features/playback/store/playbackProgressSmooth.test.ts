/**
 * Unit coverage for the interpolated playback position. The point of the
 * module is that it keeps advancing between the throttled updates it receives,
 * so the tests drive `performance.now()` by hand and assert on the estimate
 * rather than on frame callbacks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetPlaybackProgressForTest,
  emitPlaybackProgress,
  emitPlaybackSeek,
} from '@/features/playback/store/playbackProgress';
import {
  _resetSmoothPlaybackTimeForTest,
  getSmoothPlaybackTime,
  subscribeSmoothPlaybackTime,
} from '@/features/playback/store/playbackProgressSmooth';
import { usePlaybackRateStore } from '@/features/playback/store/playbackRateStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { usePreviewStore } from '@/features/playback/store/previewStore';

let clock = 0;
let rafQueue: FrameRequestCallback[] = [];

/** Run whatever frames are queued, once. Frames scheduled by those callbacks
 *  land in the next batch, so a loop that re-arms keeps the queue non-empty. */
function runFrame(): void {
  const batch = rafQueue;
  rafQueue = [];
  batch.forEach(cb => cb(clock));
}

/** Advance the wall clock the module reads, without running real frames. */
function advance(ms: number): void {
  clock += ms;
}

beforeEach(() => {
  clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  rafQueue = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  usePlayerStore.setState({ isPlaying: true });
  usePlaybackRateStore.setState({ enabled: false, speed: 1 });
  usePreviewStore.setState({ previewingId: null });
});

afterEach(() => {
  // currentTrack drives the sameTrack branch, so a leak here would silently
  // flip the buffering-freeze specs.
  usePlayerStore.setState({ currentTrack: null, isPlaying: false });
  _resetSmoothPlaybackTimeForTest();
  _resetPlaybackProgressForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('getSmoothPlaybackTime', () => {
  it('advances between updates while playing', () => {
    const off = subscribeSmoothPlaybackTime(() => {});
    emitPlaybackProgress({ currentTime: 10, progress: 0.1, buffered: 0 });

    advance(400);
    expect(getSmoothPlaybackTime()).toBeCloseTo(10.4, 3);

    advance(500);
    expect(getSmoothPlaybackTime()).toBeCloseTo(10.9, 3);
    off();
  });

  it('re-anchors on every real update instead of drifting', () => {
    const off = subscribeSmoothPlaybackTime(() => {});
    emitPlaybackProgress({ currentTime: 10, progress: 0.1, buffered: 0 });
    advance(900);

    // The engine reports a position slightly behind the estimate; the estimate
    // must follow the engine, not its own extrapolation.
    emitPlaybackProgress({ currentTime: 10.8, progress: 0.2, buffered: 0 });
    expect(getSmoothPlaybackTime()).toBeCloseTo(10.8, 3);

    advance(100);
    expect(getSmoothPlaybackTime()).toBeCloseTo(10.9, 3);
    off();
  });

  it('freezes while paused', () => {
    const off = subscribeSmoothPlaybackTime(() => {});
    emitPlaybackProgress({ currentTime: 30, progress: 0.3, buffered: 0 });
    advance(200);

    usePlayerStore.setState({ isPlaying: false });
    const atPause = getSmoothPlaybackTime();

    advance(5000);
    expect(getSmoothPlaybackTime()).toBeCloseTo(atPause, 3);
    off();
  });

  it('holds the last position while buffering instead of following the zeroed report', () => {
    const off = subscribeSmoothPlaybackTime(() => {});
    emitPlaybackProgress({ currentTime: 60, progress: 0.3, buffered: 0 });
    advance(200);

    // audioEventHandlers sends currentTime: 0 alongside buffering: true, so a
    // naive anchor would drop the lyrics to the start of the track.
    emitPlaybackProgress({ currentTime: 0, progress: 0, buffered: 0, buffering: true });
    expect(getSmoothPlaybackTime()).toBeCloseTo(60.2, 3);

    advance(1000);
    expect(getSmoothPlaybackTime()).toBeCloseTo(60.2, 3);
    off();
  });

  it('scales with the playback rate when one is active', () => {
    usePlaybackRateStore.setState({ enabled: true, speed: 1.5 });
    const off = subscribeSmoothPlaybackTime(() => {});
    emitPlaybackProgress({ currentTime: 0, progress: 0, buffered: 0 });

    advance(1000);
    expect(getSmoothPlaybackTime()).toBeCloseTo(1.5, 3);
    off();
  });

  it('ignores the rate while the feature is disabled', () => {
    usePlaybackRateStore.setState({ enabled: false, speed: 1.5 });
    const off = subscribeSmoothPlaybackTime(() => {});
    emitPlaybackProgress({ currentTime: 0, progress: 0, buffered: 0 });

    advance(1000);
    expect(getSmoothPlaybackTime()).toBeCloseTo(1, 3);
    off();
  });

  it('caps how far it runs past the last update', () => {
    const off = subscribeSmoothPlaybackTime(() => {});
    emitPlaybackProgress({ currentTime: 100, progress: 0.5, buffered: 0 });

    // Updates stop arriving; the estimate must not run away.
    advance(60_000);
    expect(getSmoothPlaybackTime()).toBeCloseTo(102, 3);
    off();
  });
});

describe('subscribeSmoothPlaybackTime', () => {
  it('pushes the current estimate to listeners on each update', () => {
    const seen: number[] = [];
    const off = subscribeSmoothPlaybackTime(v => seen.push(v));

    emitPlaybackProgress({ currentTime: 7, progress: 0.07, buffered: 0 });
    emitPlaybackProgress({ currentTime: 8, progress: 0.08, buffered: 0 });

    expect(seen).toEqual([7, 8]);
    off();
  });

  it('stops listening once the last subscriber leaves', () => {
    const cb = vi.fn();
    const off = subscribeSmoothPlaybackTime(cb);
    emitPlaybackProgress({ currentTime: 1, progress: 0.01, buffered: 0 });
    expect(cb).toHaveBeenCalledTimes(1);

    off();
    emitPlaybackProgress({ currentTime: 2, progress: 0.02, buffered: 0 });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('regressions caught in review', () => {
  it('reports the engine position when nothing is subscribed yet', () => {
    // Consumers read once before they subscribe. Returning a module global
    // here made the lyrics pane open on line 0 mid-playback.
    emitPlaybackProgress({ currentTime: 150, progress: 0.5, buffered: 0 });
    expect(getSmoothPlaybackTime()).toBeCloseTo(150, 3);
  });

  it('reports the engine position again after the last subscriber left', () => {
    const off = subscribeSmoothPlaybackTime(() => {});
    emitPlaybackProgress({ currentTime: 240, progress: 0.8, buffered: 0 });
    off();

    emitPlaybackProgress({ currentTime: 5, progress: 0.01, buffered: 0 });
    expect(getSmoothPlaybackTime()).toBeCloseTo(5, 3);
  });

  it('does not retroactively rescale elapsed time when the rate changes', () => {
    const off = subscribeSmoothPlaybackTime(() => {});
    emitPlaybackProgress({ currentTime: 100, progress: 0.5, buffered: 0 });
    advance(1800);
    expect(getSmoothPlaybackTime()).toBeCloseTo(101.8, 3);

    usePlaybackRateStore.setState({ enabled: true, speed: 2 });
    // Must continue from where it was, not recompute 1.8 s at the new rate.
    expect(getSmoothPlaybackTime()).toBeCloseTo(101.8, 3);

    advance(1000);
    expect(getSmoothPlaybackTime()).toBeCloseTo(103.8, 3);
    off();
  });

  it('freezes while a track preview is running', () => {
    const off = subscribeSmoothPlaybackTime(() => {});
    emitPlaybackProgress({ currentTime: 60, progress: 0.3, buffered: 0 });

    // A preview pauses the main sink without clearing isPlaying.
    usePreviewStore.setState({ previewingId: 'song-1' });
    const atPreview = getSmoothPlaybackTime();

    advance(3000);
    expect(getSmoothPlaybackTime()).toBeCloseTo(atPreview, 3);
    off();
  });

  it('caps the media position, not the wall clock, at higher rates', () => {
    usePlaybackRateStore.setState({ enabled: true, speed: 2 });
    const off = subscribeSmoothPlaybackTime(() => {});
    emitPlaybackProgress({ currentTime: 10, progress: 0.1, buffered: 0 });

    advance(60_000);
    // 2 s of media, not 2 s of wall clock scaled to 4 s.
    expect(getSmoothPlaybackTime()).toBeCloseTo(12, 3);
    off();
  });
});

describe('work bounds', () => {
  it('emits on every real update regardless of how recently a frame went out', () => {
    const seen: number[] = [];
    const off = subscribeSmoothPlaybackTime(v => seen.push(v));

    // Two engine updates in the same millisecond must both reach listeners:
    // the throttle is for interpolated frames, not for real state.
    emitPlaybackProgress({ currentTime: 1, progress: 0.01, buffered: 0 });
    emitPlaybackProgress({ currentTime: 2, progress: 0.02, buffered: 0 });
    expect(seen).toEqual([1, 2]);
    off();
  });

  it('ignores playback-rate writes that leave the effective rate unchanged', () => {
    const off = subscribeSmoothPlaybackTime(() => {});
    emitPlaybackProgress({ currentTime: 10, progress: 0.1, buffered: 0 });
    advance(1000);
    expect(getSmoothPlaybackTime()).toBeCloseTo(11, 3);

    // UI-only writes must not re-anchor — each re-anchor would hand the
    // estimate a fresh extrapolation budget.
    usePlaybackRateStore.setState({ fineStep: true });
    advance(1500);

    // Still capped 2 s past the original anchor, not 2 s past the UI write.
    expect(getSmoothPlaybackTime()).toBeCloseTo(12, 3);
    off();
  });
});

describe('frame loop', () => {
  it('stops re-arming once the estimate sits at the cap', () => {
    const off = subscribeSmoothPlaybackTime(() => {});
    emitPlaybackProgress({ currentTime: 10, progress: 0.1, buffered: 0 });
    expect(rafQueue.length).toBe(1);

    advance(500);
    runFrame();
    expect(rafQueue.length).toBe(1); // below the cap, still running

    advance(2000); // now past MAX_EXTRAPOLATION_SEC
    runFrame();
    expect(rafQueue.length).toBe(0); // nothing left to compute
    off();
  });

  it('resumes the loop when a real update arrives after the cap', () => {
    const off = subscribeSmoothPlaybackTime(() => {});
    emitPlaybackProgress({ currentTime: 10, progress: 0.1, buffered: 0 });
    advance(3000);
    runFrame();
    expect(rafQueue.length).toBe(0);

    emitPlaybackProgress({ currentTime: 13, progress: 0.13, buffered: 0 });
    expect(rafQueue.length).toBe(1);
    off();
  });

  it('spaces interpolated pushes without delaying real updates', () => {
    const seen: number[] = [];
    const off = subscribeSmoothPlaybackTime(v => seen.push(v));
    // Not 0: the channel below drops a snapshot identical to its own starting
    // value, so that update would never arrive here.
    emitPlaybackProgress({ currentTime: 1, progress: 0.01, buffered: 0 });
    expect(seen).toHaveLength(1);

    advance(10);
    runFrame();
    expect(seen).toHaveLength(1); // inside the 30 ms window, skipped

    advance(40);
    runFrame();
    expect(seen).toHaveLength(2); // window elapsed, pushed
    off();
  });
});

describe('track boundaries', () => {
  it('follows the reported zero when the track changed', () => {
    usePlayerStore.setState({ currentTrack: { id: 'a' } as never });
    const off = subscribeSmoothPlaybackTime(() => {});
    emitPlaybackProgress({ currentTime: 240, progress: 0.99, buffered: 0 });
    expect(getSmoothPlaybackTime()).toBeCloseTo(240, 3);

    // Gapless advance: new track, position 0, buffering while the stream fills.
    usePlayerStore.setState({ currentTrack: { id: 'b' } as never });
    emitPlaybackProgress({ currentTime: 0, progress: 0, buffered: 0, buffering: true });
    expect(getSmoothPlaybackTime()).toBeCloseTo(0, 3);
    off();
  });
});

describe('first subscriber during a buffering stall', () => {
  it('seeds from the store instead of the zeroed snapshot', () => {
    // Mid-track stall: the progress snapshot reads 0, while the store still
    // holds the last committed position. A view mounted now must not open at
    // the top of the track.
    usePlayerStore.setState({ currentTime: 137, isPlaying: true });
    emitPlaybackProgress({ currentTime: 0, progress: 0, buffered: 0, buffering: true });

    // Consumers read before they subscribe, so that is the order under test.
    expect(getSmoothPlaybackTime()).toBeCloseTo(137, 3);
    const off = subscribeSmoothPlaybackTime(() => {});
    expect(getSmoothPlaybackTime()).toBeCloseTo(137, 3);
    off();
  });

  it('still seeds from the snapshot when nothing is buffering', () => {
    usePlayerStore.setState({ currentTime: 137, isPlaying: true });
    emitPlaybackProgress({ currentTime: 42, progress: 0.4, buffered: 0 });

    expect(getSmoothPlaybackTime()).toBeCloseTo(42, 3);
    const off = subscribeSmoothPlaybackTime(() => {});
    expect(getSmoothPlaybackTime()).toBeCloseTo(42, 3);
    off();
  });
});

describe('seeking', () => {
  it('follows a seek immediately while paused', () => {
    // The engine emits no progress at all while paused, so without the seek
    // signal the views would stay on the old line until playback resumed.
    usePlayerStore.setState({ isPlaying: false });
    const seen: number[] = [];
    const off = subscribeSmoothPlaybackTime(v => seen.push(v));
    emitPlaybackProgress({ currentTime: 30, progress: 0.3, buffered: 0 });

    emitPlaybackSeek(90);
    expect(getSmoothPlaybackTime()).toBeCloseTo(90, 3);
    expect(seen[seen.length - 1]).toBeCloseTo(90, 3);

    advance(5000);
    expect(getSmoothPlaybackTime()).toBeCloseTo(90, 3); // paused: no drift
    off();
  });

  it('keeps advancing from the seeked position while playing', () => {
    const off = subscribeSmoothPlaybackTime(() => {});
    emitPlaybackProgress({ currentTime: 30, progress: 0.3, buffered: 0 });

    emitPlaybackSeek(90);
    advance(500);
    expect(getSmoothPlaybackTime()).toBeCloseTo(90.5, 3);
    off();
  });

  it('is ignored when nobody is listening', () => {
    emitPlaybackProgress({ currentTime: 12, progress: 0.12, buffered: 0 });
    emitPlaybackSeek(90);
    // No subscriber means no anchor to move; the reported position still wins.
    expect(getSmoothPlaybackTime()).toBeCloseTo(12, 3);
  });
});

describe('hidden windows', () => {
  it('skips the work but keeps the loop alive', () => {
    const seen: number[] = [];
    const off = subscribeSmoothPlaybackTime(v => seen.push(v));
    emitPlaybackProgress({ currentTime: 1, progress: 0.01, buffered: 0 });
    const before = seen.length;

    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    advance(100);
    runFrame();
    expect(seen).toHaveLength(before); // nothing pushed
    expect(rafQueue.length).toBe(1);   // loop still armed
    off();
  });
});
