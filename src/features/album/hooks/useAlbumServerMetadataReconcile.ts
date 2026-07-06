import { useEffect, useRef } from 'react';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import { shouldAttemptSubsonicForServer } from '@/lib/network/subsonicNetworkGuard';
import {
  albumIsStarred,
  albumUserRating,
  applyAlbumServerMetadataPatch,
  diffAlbumServerMetadata,
  fetchAlbumServerMetadataForReconcile,
  patchAlbumStarToIndexFromReconcile,
} from '@/lib/library/albumServerMetadataReconcile';
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
  /** Clear optimistic star/rating overrides after server metadata is applied. */
  onReconcileApplied?: (albumId: string) => void;
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
  onReconcileApplied,
}: Args): void {
  const reconciledKeyRef = useRef<string | null>(null);
  const inFlightKeyRef = useRef<string | null>(null);
  const albumRef = useRef(album);

  useEffect(() => {
    albumRef.current = album;
  }, [album]);

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

    inFlightKeyRef.current = reconcileKey;
    const snapshot = album;
    let cancelled = false;

    void (async () => {
      try {
        if (userMutationInFlightRef.current) return;
        const fetched = await fetchAlbumServerMetadataForReconcile(serverId, albumId);
        if (cancelled || !fetched || userMutationInFlightRef.current) return;

        const current = albumRef.current;
        if (
          !current
          || current.id !== albumId
          || albumIsStarred(current) !== albumIsStarred(snapshot)
          || albumUserRating(current) !== albumUserRating(snapshot)
        ) {
          return;
        }

        const patch = diffAlbumServerMetadata(current, fetched.server);
        if (!patch) return;

        setAlbum(prev =>
          prev && prev.album.id === albumId
            ? { ...prev, album: applyAlbumServerMetadataPatch(prev.album, patch) }
            : prev,
        );

        patchAlbumStarToIndexFromReconcile(serverId, albumId, patch);

        onReconcileApplied?.(albumId);
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
      if (inFlightKeyRef.current === reconcileKey) {
        inFlightKeyRef.current = null;
      }
    };
  }, [enabled, serverId, albumId, album, setAlbum, userMutationInFlightRef, onReconcileApplied]);
}
