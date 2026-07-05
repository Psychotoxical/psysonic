import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNavigateToAlbum } from '@/features/album';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/store/authStore';
import {
  activateShareSearchServer,
  enqueueShareSearchPayload,
} from '@/features/share/enqueueShareSearchPayload';
import type { ServerProfile } from '@/store/authStoreTypes';
import { findServerIdForShareUrl } from '@/lib/share/shareLink';
import { shareServerOriginLabel } from '@/lib/share/shareServerOriginLabel';
import { parseShareSearchText } from '@/lib/share/shareSearch';
import { serverIndexKeyFromUrl } from '@/lib/server/serverIndexKey';
import { useShareSearchPreview } from '@/features/search/hooks/useShareSearchPreview';

export function useShareSearch(query: string, onSuccess?: () => void) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const navigateToAlbum = useNavigateToAlbum();
  const servers = useAuthStore(s => s.servers);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const shareMatch = useMemo(() => parseShareSearchText(query), [query]);
  const shareServerLabel = useMemo(
    () => shareServerOriginLabel(shareMatch, servers, activeServerId),
    [shareMatch, servers, activeServerId],
  );
  const shareCoverServer = useMemo((): ServerProfile | null => {
    if (!shareMatch || shareMatch.type === 'unsupported') return null;
    const serverId = findServerIdForShareUrl(servers, shareMatch.payload.srv);
    if (!serverId || serverId === activeServerId) return null;
    return servers.find(s => s.id === serverId)
      ?? servers.find(s => serverIndexKeyFromUrl(s.url) === serverId)
      ?? null;
  }, [shareMatch, servers, activeServerId]);
  const preview = useShareSearchPreview(shareMatch);
  const [shareQueueBusy, setShareQueueBusy] = useState(false);

  const canQueueShareMatch =
    shareMatch?.type === 'queueable' &&
    (shareMatch.payload.k === 'queue' ||
      (!preview.shareTrackResolving && !!preview.shareTrackSong));

  const canOpenShareAlbum =
    shareMatch?.type === 'album' && !!preview.shareAlbum && !preview.shareAlbumResolving;
  const canOpenShareArtist =
    shareMatch?.type === 'artist' && !!preview.shareArtist && !preview.shareArtistResolving;
  const canOpenShareComposer =
    shareMatch?.type === 'composer' && !!preview.shareComposer && !preview.shareComposerResolving;

  const hasShareKeyboardTarget =
    canQueueShareMatch || canOpenShareAlbum || canOpenShareArtist || canOpenShareComposer;

  const openShareAlbum = useCallback(() => {
    if (shareMatch?.type !== 'album' || !preview.shareAlbum) return;
    if (!activateShareSearchServer(shareMatch.payload.srv, t)) return;
    navigateToAlbum(preview.shareAlbum.id);
    onSuccess?.();
  }, [shareMatch, preview.shareAlbum, navigateToAlbum, t, onSuccess]);

  const openShareArtist = useCallback(() => {
    if (shareMatch?.type !== 'artist' || !preview.shareArtist) return;
    if (!activateShareSearchServer(shareMatch.payload.srv, t)) return;
    navigate(`/artist/${preview.shareArtist.id}`);
    onSuccess?.();
  }, [shareMatch, preview.shareArtist, navigate, t, onSuccess]);

  const openShareComposer = useCallback(() => {
    if (shareMatch?.type !== 'composer' || !preview.shareComposer) return;
    if (!activateShareSearchServer(shareMatch.payload.srv, t)) return;
    navigate(`/composer/${preview.shareComposer.id}`);
    onSuccess?.();
  }, [shareMatch, preview.shareComposer, navigate, t, onSuccess]);

  const enqueueShareMatch = useCallback(async () => {
    if (shareMatch?.type !== 'queueable' || shareQueueBusy) return false;
    if (shareMatch.payload.k === 'track' && (!preview.shareTrackSong || preview.shareTrackResolving)) {
      return false;
    }
    setShareQueueBusy(true);
    const ok = await enqueueShareSearchPayload(shareMatch.payload, t);
    setShareQueueBusy(false);
    if (ok) onSuccess?.();
    return ok;
  }, [shareMatch, shareQueueBusy, preview.shareTrackSong, preview.shareTrackResolving, t, onSuccess]);

  return {
    shareMatch,
    shareServerLabel,
    shareCoverServer,
    shareQueueBusy,
    canQueueShareMatch,
    canOpenShareAlbum,
    canOpenShareArtist,
    canOpenShareComposer,
    hasShareKeyboardTarget,
    openShareAlbum,
    openShareArtist,
    openShareComposer,
    enqueueShareMatch,
    ...preview,
  };
}
