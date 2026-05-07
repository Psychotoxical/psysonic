import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ndListLosslessAlbumsPage } from '../api/navidromeBrowse';
import AlbumRow from './AlbumRow';
import type { SubsonicAlbum } from '../api/subsonic';
import { useAuthStore } from '../store/authStore';

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
  const [albums, setAlbums] = useState<SubsonicAlbum[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const page = await ndListLosslessAlbumsPage({ targetNewAlbums: TARGET_ALBUMS });
        if (cancelled) return;
        setAlbums(page.entries.map(e => e.album));
      } catch {
        if (!cancelled) setAlbums([]);
      }
    })();
    return () => { cancelled = true; };
  }, [activeServerId]);

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
    />
  );
}
