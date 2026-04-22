/** Remaining time until wall-clock `deadlineMs` (m:ss or h:mm:ss). */
export function formatPlaybackScheduleRemaining(deadlineMs: number | null, nowMs: number): string {
  if (deadlineMs == null) return '';
  const sec = Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return `${h}:${rm.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}
