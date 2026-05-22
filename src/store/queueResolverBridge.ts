/**
 * Side-effect wiring (queue thin-state, phase 2b): seed the queue track
 * resolver cache with the tracks around the current index whenever the queue
 * changes. The store stays `queue: Track[]`-canonical for now — this only fills
 * the resolver cache (additive; no mutation or persist change), so the queue
 * selectors resolve without a fetch once consumers move onto them (phase 3) and
 * after `queue: Track[]` is dropped (phase 4).
 */
import { usePlayerStore } from './playerStore';
import { seedQueueResolver } from '../utils/library/queueTrackResolver';

const SEED_BACK = 50;
const SEED_AHEAD = 200;

usePlayerStore.subscribe((state, prev) => {
  if (state.queue === prev.queue && state.queueServerId === prev.queueServerId) return;
  const serverId = state.queueServerId ?? '';
  if (!serverId || state.queue.length === 0) return;
  const start = Math.max(0, state.queueIndex - SEED_BACK);
  seedQueueResolver(serverId, state.queue.slice(start, state.queueIndex + SEED_AHEAD + 1));
});
