import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ndListLosslessAlbumsPage } from '@/lib/api/navidromeBrowse';
import AlbumRow from '@/features/album/components/AlbumRow';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { runLocalLosslessAlbums } from '@/lib/library/browseTextSearch';
import { LOSSLESS_MODE_QUERY } from '@/lib/library/losslessMode';
import { useBrowseLibraryScope } from '@/store/useBrowseLibraryScope';

interface Props {
  disableArtwork?: boolean;
  artworkSize?: number;
  windowArtworkByViewport?: boolean;
  initialArtworkBudget?: number;
}

const TARGET_ALBUMS = 20;

export default function LosslessAlbumsRail({
  disableArtwork = false,
  artworkSize,
  windowArtworkByViewport,
  initialArtworkBudget,
}: Props) {
  const { t } = useTranslation();
  const activeServerId = useAuthStore(s => s.activeServerId);
  const browseScope = useBrowseLibraryScope();
  const browseServerId = browseScope.anchorServerId || activeServerId || '';
  const indexEnabled = useLibraryIndexStore(s => s.isIndexEnabled(browseServerId));
  const [albums, setAlbums] = useState<SubsonicAlbum[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (indexEnabled && browseServerId) {
        const local = await runLocalLosslessAlbums(
          browseServerId,
          TARGET_ALBUMS,
          0,
          browseScope.pairs,
        );
        if (cancelled) return;
        if (local && local.albums.length > 0) {
          setAlbums(local.albums);
          return;
        }
      }
      if (browseScope.multiServer) {
        setAlbums([]);
        return;
      }
      try {
        const page = await ndListLosslessAlbumsPage({ targetNewAlbums: TARGET_ALBUMS });
        if (cancelled) return;
        setAlbums(page.entries.map(e => e.album));
      } catch {
        if (!cancelled) setAlbums([]);
      }
    })();
    return () => { cancelled = true; };
  }, [browseScope.fingerprint, browseScope.multiServer, browseScope.pairs, browseServerId, indexEnabled]);

  if (albums.length === 0) return null;

  return (
    <AlbumRow
      title={t('home.losslessAlbums')}
      titleLink="/lossless-albums"
      albums={albums}
      disableArtwork={disableArtwork}
      artworkSize={artworkSize}
      windowArtworkByViewport={windowArtworkByViewport}
      initialArtworkBudget={initialArtworkBudget}
      albumLinkQuery={LOSSLESS_MODE_QUERY}
    />
  );
}
