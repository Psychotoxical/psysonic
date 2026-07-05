import { useEffect, useState } from 'react';
import type { SubsonicAlbum, SubsonicArtist, SubsonicSong } from '@/lib/api/subsonicTypes';
import {
  resolveShareSearchAlbum,
  resolveShareSearchArtist,
  resolveShareSearchPayload,
} from '@/features/share/enqueueShareSearchPayload';
import type { ShareSearchMatch } from '@/lib/share/shareSearch';

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
  shareComposer: SubsonicArtist | null;
  shareComposerResolving: boolean;
  shareComposerUnavailable: boolean;
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
  shareComposer: null,
  shareComposerResolving: false,
  shareComposerUnavailable: false,
};

export function useShareSearchPreview(shareMatch: ShareSearchMatch | null): ShareSearchPreviewState {
  const [preview, setPreview] = useState<ShareSearchPreviewState>(EMPTY_PREVIEW);

  useEffect(() => {
    let cancelled = false;
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

    if (shareMatch?.type === 'composer') {
      setPreview({ ...EMPTY_PREVIEW, shareComposerResolving: true });
      void resolveShareSearchArtist(shareMatch.payload)
        .then(result => {
          if (cancelled) return;
          setPreview({
            ...EMPTY_PREVIEW,
            shareComposer: result.type === 'ok' ? result.artist : null,
            shareComposerUnavailable: result.type !== 'ok',
          });
        })
        .finally(() => {
          if (!cancelled) {
            setPreview(current => ({ ...current, shareComposerResolving: false }));
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
