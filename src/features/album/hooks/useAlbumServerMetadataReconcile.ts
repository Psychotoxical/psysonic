import { useEffect, useRef } from 'react';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import { shouldAttemptSubsonicForServer } from '@/lib/network/subsonicNetworkGuard';
import {
  applyAlbumServerMetadataPatch,
  fetchAlbumServerMetadataPatch,
} from '@/lib/library/albumServerMetadataReconcile';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import type { ResolvedAlbum } from '@/store/mediaResolver';

interface Args {
  serverId: string;
  albumId: string;
  album: SubsonicAlbum | undefined;
  setAlbum: React.Dispatch<React.SetStateAction<ResolvedAlbum | null>>;
  /** Skip while offline browse or explicit offline-only policy. */
  enabled: boolean;
  /** When true, skip applying server metadata (user toggled star/rating). */
  userMutationInFlightRef: React.RefObject<boolean>;
}

/**
 * After album detail paints from the local index, reconcile album-level
 * favorite + rating against the server in the background.
 */
export function useAlbumServerMetadataReconcile({
  serverId,
  albumId,
  album,
  setAlbum,
  enabled,
  userMutationInFlightRef,
}: Args): void {
  const reconciledKeyRef = useRef<string | null>(null);
  const inFlightKeyRef = useRef<string | null>(null);

  useEffect(() => {
    reconciledKeyRef.current = null;
    inFlightKeyRef.current = null;
  }, [serverId, albumId]);

  useEffect(() => {
    if (!enabled || !serverId || !albumId || !album || album.id !== albumId) return;
    if (!shouldAttemptSubsonicForServer(serverId)) return;
    if (userMutationInFlightRef.current) return;

    const reconcileKey = `${serverId}:${albumId}`;
    if (reconciledKeyRef.current === reconcileKey) return;
    if (inFlightKeyRef.current === reconcileKey) return;

    inFlightKeyRef.current = reconcileKey;
    const snapshot = album;
    let cancelled = false;

    void (async () => {
      try {
        if (userMutationInFlightRef.current) return;
        const patch = await fetchAlbumServerMetadataPatch(serverId, albumId, snapshot);
        if (cancelled || !patch || userMutationInFlightRef.current) return;

        setAlbum(prev =>
          prev && prev.album.id === albumId
            ? { ...prev, album: applyAlbumServerMetadataPatch(prev.album, patch) }
            : prev,
        );

        usePlayerStore.setState(s => {
          const starredOverrides = { ...s.starredOverrides };
          const userRatingOverrides = { ...s.userRatingOverrides };
          delete starredOverrides[albumId];
          delete userRatingOverrides[albumId];
          return { starredOverrides, userRatingOverrides };
        });
        reconciledKeyRef.current = reconcileKey;
      } catch {
        /* offline / transient — keep local; allow retry */
      } finally {
        if (inFlightKeyRef.current === reconcileKey) {
          inFlightKeyRef.current = null;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, serverId, albumId, album, setAlbum, userMutationInFlightRef]);
}
