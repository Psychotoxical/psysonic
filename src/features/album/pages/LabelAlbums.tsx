import { search, searchForServer } from '@/lib/api/subsonicSearch';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router';
import { ChevronLeft } from 'lucide-react';
import AlbumCard from '@/features/album/components/AlbumCard';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/store/authStore';
import { usePerfProbeFlags } from '@/lib/perf/perfFlags';
import { albumGridWarmCovers } from '@/cover/layoutSizes';
import { VirtualCardGrid } from '@/ui/VirtualCardGrid';
import { readDetailServerId } from '@/lib/navigation/detailServerScope';

export default function LabelAlbums() {
  const { t } = useTranslation();
  const perfFlags = usePerfProbeFlags();
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [albums, setAlbums] = useState<SubsonicAlbum[]>([]);
  const [loading, setLoading] = useState(true);
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const ownerServerId = readDetailServerId(searchParams, activeServerId);
  const invalidExplicitServer = searchParams.has('server') && !ownerServerId;

  useEffect(() => {
    if (!name) return;
    let cancelled = false;
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    if (invalidExplicitServer) {
      setAlbums([]);
      setLoading(false);
      return;
    }

    // Search for the label name and ask for a large number of albums
    const options = { albumCount: 200, artistCount: 0, songCount: 0 };
    const request = ownerServerId
      ? searchForServer(ownerServerId, name, options)
      : search(name, options);
    request
      .then(res => {
        if (cancelled) return;
        // Filter out albums that don't match the record label exactly if possible,
        // to avoid unrelated search hits. We do case-insensitive comparison.
        const matches = res.albums.filter(a =>
          a.recordLabel?.toLowerCase() === name.toLowerCase()
        );
        // Fallback: if Navidrome's search doesn't return the exact label in the recordLabel field
        // (or it's not indexed exactly as typed), just show all album matches
        // as a decent best-effort if our strict filter yields nothing.
        setAlbums(matches.length > 0 ? matches : res.albums);
      })
      .catch(error => { if (!cancelled) console.error(error); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [invalidExplicitServer, name, musicLibraryFilterVersion, ownerServerId]);

  return (
    <div className="animate-fade-in" style={{ padding: '0 var(--space-6)' }}>
      <button className="btn btn-ghost" onClick={() => navigate(-1)} style={{ margin: '1rem 0', gap: '6px' }}>
        <ChevronLeft size={16} /> {t('common.back')}
      </button>

      <h1 className="page-title" style={{ marginBottom: '2rem' }}>
        Label: <span style={{ color: 'var(--accent)' }}>{name}</span>
      </h1>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
          <div className="spinner" />
        </div>
      ) : albums.length === 0 ? (
        <div className="empty-state">{t('common.noAlbums')}</div>
      ) : (
        <VirtualCardGrid
          items={albums}
          itemKey={a => `${a.serverId ?? ownerServerId ?? ''}\u0000${a.id}`}
          rowVariant="album"
          disableVirtualization={perfFlags.disableMainstageVirtualLists}
          layoutSignal={albums.length}
          warmGridCovers={albumGridWarmCovers()}
          renderItem={a => <AlbumCard album={a} />}
        />
      )}
    </div>
  );
}
