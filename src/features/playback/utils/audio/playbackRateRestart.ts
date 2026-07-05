import { usePlayerStore } from '@/features/playback/store/playerStore';
import { setSeekFallbackVisualTarget } from '@/features/playback/store/seekFallbackState';
import {
  engineStrategy,
  isPlaybackEffectActive,
  type PlaybackStrategy,
} from '@/features/playback/utils/audio/playbackRateHelpers';

/** Preserve-pitch DSP (worker) vs direct varispeed sample-rate scaling. */
export function usesPreservePlaybackPath(strategy: PlaybackStrategy): boolean {
  return strategy === 'speed_corrected' || strategy === 'preserve_pitch';
}

export function playbackPathChanged(a: PlaybackStrategy, b: PlaybackStrategy): boolean {
  return usesPreservePlaybackPath(a) !== usesPreservePlaybackPath(b);
}

export interface PlaybackRateSnapshot {
  enabled: boolean;
  strategy: PlaybackStrategy;
  speed: number;
  pitchSemitones: number;
}

/** Whether live atomics are enough vs needing a source rebuild (spec §2.5). */
export function shouldRestartPlaybackForRateChange(
  prev: PlaybackRateSnapshot,
  next: PlaybackRateSnapshot,
): boolean {
  // varispeed ↔ varispeed_semitones share one engine path at the same speed;
  // only restart when the underlying engine strategy actually changes.
  if (engineStrategy(prev.strategy) !== engineStrategy(next.strategy)) return true;
  if (prev.enabled !== next.enabled && isPlaybackEffectActive(
    next.enabled,
    next.strategy,
    next.speed,
    next.pitchSemitones,
  )) {
    return true;
  }
  const prevActive = isPlaybackEffectActive(
    prev.enabled,
    prev.strategy,
    prev.speed,
    prev.pitchSemitones,
  );
  const nextActive = isPlaybackEffectActive(
    next.enabled,
    next.strategy,
    next.speed,
    next.pitchSemitones,
  );
  if (prevActive !== nextActive) return true;
  return false;
}

/** Re-decode current track at the current timeline position (seek-restart). */
export function restartPlaybackForRateChange(): void {
  const player = usePlayerStore.getState();
  const track = player.currentTrack;
  if (!track || !player.isPlaying) return;
  if (track.radioAdded) return;

  const dur = track.duration;
  if (!dur || !Number.isFinite(dur) || dur <= 0) return;

  const time = Math.max(0, Math.min(player.currentTime, dur - 0.25));
  if (time > 0.05) {
    setSeekFallbackVisualTarget({
      trackId: track.id,
      seconds: time,
      setAtMs: Date.now(),
    });
  }
  // No-arg queue: keep the canonical refs, restart the current track in place.
  player.playTrack(track, undefined, true);
}
