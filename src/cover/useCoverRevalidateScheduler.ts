import { useEffect } from 'react';
import { commands } from '@/generated/bindings';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';

const TICK_MS = 60_000;

/** Scheduled cover revalidate slices (Rust); pauses while streaming. */
export function useCoverRevalidateScheduler(enabled = true): void {
  const cycleDays = useAuthStore(s => s.coverRevalidateCycleDays);
  const isPlaying = usePlayerStore(s => s.isPlaying);

  useEffect(() => {
    if (!enabled || isPlaying) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled || usePlayerStore.getState().isPlaying) return;
      void commands.coverRevalidateTick(cycleDays).catch(() => {});
    };
    tick();
    const id = window.setInterval(tick, TICK_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [enabled, cycleDays, isPlaying]);
}
