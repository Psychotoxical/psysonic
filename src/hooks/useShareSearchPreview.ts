import { useEffect, useState } from 'react';
import type {
  SubsonicAlbum,
  SubsonicArtist,
  SubsonicSong,
} from '../api/subsonic';
import {
  resolveShareSearchAlbum,
  resolveShareSearchArtist,
  resolveShareSearchPayload,
} from '../utils/enqueueShareSearchPayload';
import type { ShareSearchMatch } from '../utils/shareSearch';

export interface ShareSearchPreviewState {
  shareTrackSong: SubsonicSong | null;
  shareTrackResolving: boolean;
  shareTrackUnavailable: boolean;
  shareAlbum: SubsonicAlbum | null;
  shareAlbumResolving: boolean;
  shareAlbumUnavailable: boolean;
  shareArtist: SubsonicArtist | null;
  shareArtistResolving: boolean;
  shareArtistUnavailable: boolean;
}

const EMPTY_PREVIEW: ShareSearchPreviewState = {
  shareTrackSong: null,
  shareTrackResolving: false,
  shareTrackUnavailable: false,
  shareAlbum: null,
  shareAlbumResolving: false,
  shareAlbumUnavailable: false,
  shareArtist: null,
  shareArtistResolving: false,
  shareArtistUnavailable: false,
};

export function useShareSearchPreview(shareMatch: ShareSearchMatch | null): ShareSearchPreviewState {
  const [preview, setPreview] = useState<ShareSearchPreviewState>(EMPTY_PREVIEW);

  useEffect(() => {
    let cancelled = false;
    setPreview(EMPTY_PREVIEW);

    if (shareMatch?.type === 'queueable' && shareMatch.payload.k === 'track') {
      setPreview({ ...EMPTY_PREVIEW, shareTrackResolving: true });
      void resolveShareSearchPayload(shareMatch.payload)
        .then(result => {
          if (cancelled) return;
          setPreview({
            ...EMPTY_PREVIEW,
            shareTrackSong: result.type === 'ok' ? (result.songs[0] ?? null) : null,
            shareTrackUnavailable: result.type !== 'ok' || result.songs.length === 0,
          });
        })
        .finally(() => {
          if (!cancelled) {
            setPreview(current => ({ ...current, shareTrackResolving: false }));
          }
        });
      return () => {
        cancelled = true;
      };
    }

    if (shareMatch?.type === 'artist') {
      setPreview({ ...EMPTY_PREVIEW, shareArtistResolving: true });
      void resolveShareSearchArtist(shareMatch.payload)
        .then(result => {
          if (cancelled) return;
          setPreview({
            ...EMPTY_PREVIEW,
            shareArtist: result.type === 'ok' ? result.artist : null,
            shareArtistUnavailable: result.type !== 'ok',
          });
        })
        .finally(() => {
          if (!cancelled) {
            setPreview(current => ({ ...current, shareArtistResolving: false }));
          }
        });
      return () => {
        cancelled = true;
      };
    }

    if (shareMatch?.type === 'album') {
      setPreview({ ...EMPTY_PREVIEW, shareAlbumResolving: true });
      void resolveShareSearchAlbum(shareMatch.payload)
        .then(result => {
          if (cancelled) return;
          setPreview({
            ...EMPTY_PREVIEW,
            shareAlbum: result.type === 'ok' ? result.album : null,
            shareAlbumUnavailable: result.type !== 'ok',
          });
        })
        .finally(() => {
          if (!cancelled) {
            setPreview(current => ({ ...current, shareAlbumResolving: false }));
          }
        });
      return () => {
        cancelled = true;
      };
    }

    return () => {
      cancelled = true;
    };
  }, [shareMatch]);

  return preview;
}
