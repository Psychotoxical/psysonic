import type { QueueItemRef, Track } from '@/lib/media/trackTypes';
import {
  looksLikeGeneratedProfileId,
  resolveStorageServerIndexKey,
  serverIndexKeyForProfile,
} from '@/lib/server/serverIndexKey';
import { useAuthStore } from '@/store/authStore';
import { queueTrackIdentityKey } from '@/features/playback/utils/playback/queueIdentity';

export type AnalysisTrackRef = Readonly<{
  trackId: string;
  serverIndexKey: string | null;
}>;

function resolveAnalysisServerIndexKey(serverIdOrIndexKey: string): string | null {
  const candidate = serverIdOrIndexKey.trim();
  const indexKey = resolveStorageServerIndexKey(candidate);
  if (!indexKey) return null;
  const servers = useAuthStore.getState().servers;
  if (servers?.some(s => s.id === candidate || serverIndexKeyForProfile(s) === candidate)) {
    return indexKey;
  }
  // An unresolved generated profile id is not a library server key. Letting it
  // reach enrichment produces a `(server_id, track_id)` foreign-key failure.
  return looksLikeGeneratedProfileId(candidate) ? null : indexKey;
}

export function analysisTrackRef(
  trackId: string,
  serverIdOrIndexKey?: string | null,
): AnalysisTrackRef {
  return {
    trackId,
    serverIndexKey: serverIdOrIndexKey
      ? resolveAnalysisServerIndexKey(serverIdOrIndexKey)
      : null,
  };
}

export function analysisTrackRefForTrack(
  track: Pick<Track, 'id' | 'serverId'>,
  queueRef?: Pick<QueueItemRef, 'serverId'> | null,
): AnalysisTrackRef {
  return analysisTrackRef(track.id, queueRef?.serverId ?? track.serverId);
}

export function analysisTrackRefForQueueItem(
  ref: Pick<QueueItemRef, 'trackId' | 'serverId'>,
): AnalysisTrackRef {
  return analysisTrackRef(ref.trackId, ref.serverId);
}

export function analysisTrackRefKey(ref: AnalysisTrackRef): string {
  return queueTrackIdentityKey(ref.trackId, ref.serverIndexKey);
}
