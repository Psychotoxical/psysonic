import React, { useCallback, useEffect, useRef, useState } from 'react';
import AlbumCard from '../components/AlbumCard';
import { ndListLosslessAlbumsPage } from '../api/navidromeBrowse';
import type { SubsonicAlbum } from '../api/subsonic';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../store/authStore';

const PAGE_TARGET_ALBUMS = 24;

export default function LosslessAlbums() {
  const { t } = useTranslation();
  const activeServerId = useAuthStore(s => s.activeServerId);

  const [albums, setAlbums] = useState<SubsonicAlbum[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [unsupported, setUnsupported] = useState(false);

  /** Pagination cursor + dedupe set, kept across loadMore calls so each page
   *  resumes the song-stream walk where the previous one left off. Reset to
   *  a fresh pair whenever the active server changes. */
  const songCursor = useRef(0);
  const seenIds = useRef<Set<string>>(new Set());
  /** Re-entrancy guard. The IntersectionObserver can fire repeatedly while a
   *  previous loadMore is still in flight (fast scroll, sentinel re-entering
   *  the rootMargin band) — without this guard, two concurrent calls would
   *  read the same songCursor, fetch the same song page, and push duplicate
   *  album entries because each captures its own snapshot of the seen-Set
   *  reference. */
  const inFlight = useRef(false);
  const observerTarget = useRef<HTMLDivElement>(null);

  const loadMore = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const page = await ndListLosslessAlbumsPage({
        startSongOffset: songCursor.current,
        seenAlbumIds: seenIds.current,
        targetNewAlbums: PAGE_TARGET_ALBUMS,
      });
      songCursor.current = page.nextSongOffset;
      setAlbums(prev => [...prev, ...page.entries.map(e => e.album)]);
      setHasMore(!page.done);
    } catch {
      setUnsupported(true);
      setHasMore(false);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  /** Reset state and trigger the initial load on server change. The async
   *  block carries a local `cancelled` flag because React StrictMode in dev
   *  double-invokes effects — without the flag, the first invocation's result
   *  would land in state alongside the second, doubling every album. */
  useEffect(() => {
    let cancelled = false;

    songCursor.current = 0;
    seenIds.current = new Set();
    inFlight.current = false;
    setAlbums([]);
    setHasMore(true);
    setUnsupported(false);
    setLoading(true);

    (async () => {
      inFlight.current = true;
      try {
        const page = await ndListLosslessAlbumsPage({
          startSongOffset: 0,
          seenAlbumIds: seenIds.current,
          targetNewAlbums: PAGE_TARGET_ALBUMS,
        });
        if (cancelled) return;
        songCursor.current = page.nextSongOffset;
        setAlbums(page.entries.map(e => e.album));
        setHasMore(!page.done);
      } catch {
        if (cancelled) return;
        setUnsupported(true);
        setHasMore(false);
      } finally {
        inFlight.current = false;
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [activeServerId]);

  useEffect(() => {
    if (!hasMore) return;
    /** Sentinel only renders once `albums.length > 0` (the spinner takes its
     *  spot during the initial load), so the observer effect must re-run when
     *  that transition happens — otherwise the ref is null on first attempt
     *  and never reconnects, leaving infinite-scroll dead after the first
     *  page. Both `loading` and `albums.length` cover the relevant transitions. */
    const node = observerTarget.current;
    if (!node) return;
    const obs = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting) loadMore(); },
      { rootMargin: '200px' },
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [hasMore, loadMore, loading, albums.length]);

  return (
    <div className="content-body animate-fade-in">
      <div className="page-sticky-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>
          {t('home.losslessAlbums')}
        </h1>
      </div>

      {unsupported ? (
        <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          {t('losslessAlbums.unsupported')}
        </div>
      ) : loading && albums.length === 0 ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
          <div className="spinner" />
        </div>
      ) : albums.length === 0 ? (
        <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          {t('losslessAlbums.empty')}
        </div>
      ) : (
        <>
          <div className="album-grid-wrap">
            {albums.map(a => (
              <AlbumCard key={a.id} album={a} />
            ))}
          </div>
          <div ref={observerTarget} style={{ height: '20px', margin: '2rem 0', display: 'flex', justifyContent: 'center' }}>
            {loading && hasMore && <div className="spinner" style={{ width: 20, height: 20 }} />}
          </div>
        </>
      )}
    </div>
  );
}
