/**
 * Orbit — diagnostics ring buffer.
 *
 * In-memory log of recent Orbit events for users who can't reach DevTools or
 * Settings → Debug → Export. The Diagnostics popover in the Orbit bar reads
 * this buffer live and offers a one-click clipboard copy so a Discord user
 * can paste the buffer straight into a bug-report channel.
 *
 * Events are also bridged to `frontend_debug_log` when the user has Debug
 * logging on in Settings, so the same data lands in `psysonic-logs-*.log`
 * for power users who want a persistent file.
 */
import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from '../store/authStore';

/** Hard cap so a long session doesn't spend memory unbounded. ~200 entries. */
const MAX_EVENTS = 200;

export interface OrbitDiagEvent {
  /** Wall-clock ms when the event was pushed. */
  ts: number;
  /** Short tag, e.g. `pull`, `divergence`, `audio:ended`, `host:state`. */
  scope: string;
  /** Already-stringified message body. Whitespace + line breaks preserved. */
  message: string;
}

const buffer: OrbitDiagEvent[] = [];
const subscribers = new Set<() => void>();
/** Frozen snapshot for `useSyncExternalStore`. Replaced on every mutation;
 *  identical between mutations so React doesn't keep re-rendering. */
let snapshot: readonly OrbitDiagEvent[] = [];

function notify() {
  snapshot = buffer.slice();
  for (const sub of subscribers) {
    try { sub(); } catch { /* never let one bad listener kill the rest */ }
  }
}

/**
 * Append an event to the ring. Also fires `frontend_debug_log` so the same
 * line shows up in the runtime log file when Debug mode is enabled.
 *
 * Safe to call from anywhere — never throws, never blocks.
 */
export function pushOrbitEvent(scope: string, message: string | Record<string, unknown>): void {
  const text = typeof message === 'string' ? message : safeStringify(message);
  const evt: OrbitDiagEvent = { ts: Date.now(), scope, message: text };
  buffer.push(evt);
  if (buffer.length > MAX_EVENTS) buffer.splice(0, buffer.length - MAX_EVENTS);
  notify();

  // Bridge to the existing Rust log buffer when Debug mode is on, so
  // Settings → Debug → Export still works for the same data.
  if (useAuthStore.getState().loggingMode === 'debug') {
    void invoke('frontend_debug_log', {
      scope: `orbit:${scope}`,
      message: text,
    }).catch(() => { /* best-effort */ });
  }
}

function safeStringify(obj: Record<string, unknown>): string {
  try { return JSON.stringify(obj); }
  catch { return '[unserialisable]'; }
}

/** Snapshot of all currently-buffered events, oldest first.
 *  Returns the SAME reference between mutations so `useSyncExternalStore`
 *  can detect "nothing changed" and skip the render. */
export function getOrbitEvents(): readonly OrbitDiagEvent[] {
  return snapshot;
}

/** Wipe the buffer. Used by the Clear button in the Diagnostics popover. */
export function clearOrbitEvents(): void {
  buffer.length = 0;
  notify();
}

/** Subscribe to buffer mutations. Returns the unsubscribe function. */
export function subscribeOrbitEvents(listener: () => void): () => void {
  subscribers.add(listener);
  return () => { subscribers.delete(listener); };
}

/** Format the buffer as a copy-pasteable plain-text block. */
export function formatOrbitEvents(events: readonly OrbitDiagEvent[]): string {
  if (events.length === 0) return '';
  const lines = events.map(e => {
    const stamp = new Date(e.ts).toISOString();
    return `[${stamp}] [${e.scope}] ${e.message}`;
  });
  return lines.join('\n');
}
