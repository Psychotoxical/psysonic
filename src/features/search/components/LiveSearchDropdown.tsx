import { type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Users, Disc3, Music, Database, Globe } from 'lucide-react';
import { useNavigateToAlbum, albumArtistDisplayName } from '@/features/album';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useLiveSearchScopeStore } from '@/store/liveSearchScopeStore';
import { songToTrack } from '@/lib/media/songToTrack';
import { showToast } from '@/lib/dom/toast';
import type { SearchResults } from '@/lib/api/subsonicTypes';
import ShareSearchResults from '@/features/search/components/ShareSearchResults';
import {
  LiveSearchAlbumThumb,
  LiveSearchSongThumb,
  LiveSearchArtistThumb,
} from '@/features/search/components/liveSearchResultThumbs';
import type { useShareSearch } from '@/features/search/hooks/useShareSearch';

export type LiveSearchSource = 'local' | 'network';

interface LiveSearchDropdownProps {
  dropdownRef: RefObject<HTMLDivElement | null>;
  results: SearchResults | null;
  searchSource: LiveSearchSource | null;
  activeIndex: number;
  loading: boolean;
  share: ReturnType<typeof useShareSearch>;
  setOpen: (open: boolean) => void;
}

/** Live-search results overlay: source badge, share match, and the artist/album/song sections. */
export default function LiveSearchDropdown({
  dropdownRef,
  results,
  searchSource,
  activeIndex,
  loading,
  share,
  setOpen,
}: LiveSearchDropdownProps) {
  const { t } = useTranslation();
  const query = useLiveSearchScopeStore(s => s.query);
  const setQuery = useLiveSearchScopeStore(s => s.setQuery);
  const navigate = useNavigate();
  const navigateToAlbum = useNavigateToAlbum();
  const enqueue = usePlayerStore(state => state.enqueue);
  const openContextMenu = usePlayerStore(state => state.openContextMenu);
  const ctxIsOpen = usePlayerStore(state => state.contextMenu.isOpen);
  const ctxItemId = usePlayerStore(state => (state.contextMenu.item as { id?: string } | null)?.id);
  const ctxType   = usePlayerStore(state => state.contextMenu.type);

  const hasResults =
    !!share.shareMatch ||
    (results && (results.artists.length || results.albums.length || results.songs.length));

  return (
    <div className="live-search-dropdown" id="search-results" role="listbox" ref={dropdownRef}>
      {searchSource && !share.shareMatch && (
        <div
          className={`live-search-source live-search-source--${searchSource}`}
          data-tooltip={t(
            searchSource === 'local'
              ? 'search.localIndexBadgeTooltip'
              : 'search.networkSearchBadgeTooltip',
          )}
          data-tooltip-pos="bottom"
        >
          {searchSource === 'local' ? (
            <Database size={12} aria-hidden />
          ) : (
            <Globe size={12} aria-hidden />
          )}
          <span>
            {t(
              searchSource === 'local'
                ? 'search.localIndexBadge'
                : 'search.networkSearchBadge',
            )}
          </span>
        </div>
      )}

      {!hasResults && !loading && (
        <div className="search-empty">{t('search.noResults', { query: query.trim() })}</div>
      )}

      {share.shareMatch && (
        <ShareSearchResults
          variant="desktop"
          shareMatch={share.shareMatch}
          shareServerLabel={share.shareServerLabel}
          shareCoverServer={share.shareCoverServer}
          activeIndex={activeIndex}
          shareQueueBusy={share.shareQueueBusy}
          onEnqueue={() => void share.enqueueShareMatch()}
          onOpenAlbum={share.openShareAlbum}
          onOpenArtist={share.openShareArtist}
          onOpenComposer={share.openShareComposer}
          onContextMenu={(e, item, type) => openContextMenu(e.clientX, e.clientY, item, type)}
          shareTrackSong={share.shareTrackSong}
          shareTrackResolving={share.shareTrackResolving}
          shareTrackUnavailable={share.shareTrackUnavailable}
          shareAlbum={share.shareAlbum}
          shareAlbumResolving={share.shareAlbumResolving}
          shareAlbumUnavailable={share.shareAlbumUnavailable}
          shareArtist={share.shareArtist}
          shareArtistResolving={share.shareArtistResolving}
          shareArtistUnavailable={share.shareArtistUnavailable}
          shareComposer={share.shareComposer}
          shareComposerResolving={share.shareComposerResolving}
          shareComposerUnavailable={share.shareComposerUnavailable}
        />
      )}

      {(() => {
        if (share.shareMatch) return null;
        let idx = 0;
        return <>
          {results?.artists.length ? (
            <div className="search-section">
              <div className="search-section-label"><Users size={12} /> {t('search.artists')}</div>
              {results.artists.map(a => {
                const i = idx++;
                const isCtxActive = ctxIsOpen && ctxType === 'artist' && ctxItemId === a.id;
                return (
                  <button key={a.id} className={`search-result-item${activeIndex === i ? ' active' : ''}${isCtxActive ? ' context-active' : ''}`}
                    onClick={() => { navigate(`/artist/${a.id}`); setOpen(false); setQuery(''); }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      openContextMenu(e.clientX, e.clientY, a, 'artist');
                    }}
                    role="option" aria-selected={activeIndex === i}>
                    <LiveSearchArtistThumb artist={a} />
                    <div>
                      <div className="search-result-name">{a.name}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : null}

          {results?.albums.length ? (
            <div className="search-section">
              <div className="search-section-label"><Disc3 size={12} /> {t('search.albums')}</div>
              {results.albums.map(a => {
                const i = idx++;
                const isCtxActive = ctxIsOpen && ctxType === 'album' && ctxItemId === a.id;
                return (
                  <button key={a.id} className={`search-result-item${activeIndex === i ? ' active' : ''}${isCtxActive ? ' context-active' : ''}`}
                    onClick={() => { navigateToAlbum(a.id); setOpen(false); setQuery(''); }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      openContextMenu(e.clientX, e.clientY, a, 'album');
                    }}
                    role="option" aria-selected={activeIndex === i}>
                    {a.coverArt ? (
                      <LiveSearchAlbumThumb albumId={a.id} coverArt={a.coverArt} />
                    ) : (
                      <div className="search-result-icon"><Disc3 size={14} /></div>
                    )}
                    <div>
                      <div className="search-result-name">{a.name}</div>
                      <div className="search-result-sub">{albumArtistDisplayName(a)}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : null}

          {results?.songs.length ? (
            <div className="search-section">
              <div className="search-section-label"><Music size={12} /> {t('search.songs')}</div>
              {results.songs.map(s => {
                const i = idx++;
                const isCtxActive = ctxIsOpen && ctxType === 'song' && ctxItemId === s.id;
                return (
                  <button key={s.id} className={`search-result-item${activeIndex === i ? ' active' : ''}${isCtxActive ? ' context-active' : ''}`}
                    onClick={() => {
                      const track = songToTrack(s);
                      enqueue([track]);
                      showToast(t('search.addedToQueueToast', { title: track.title }), 2200, 'info');
                      setOpen(false); setQuery('');
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      // Keep the dropdown open — context menu portal renders above it,
                      // and closing here would yank the list out from under the user.
                      openContextMenu(e.clientX, e.clientY, songToTrack(s), 'song');
                    }}
                    role="option" aria-selected={activeIndex === i}>
                    <LiveSearchSongThumb song={s} />
                    <div>
                      <div className="search-result-name">{s.title}</div>
                      <div className="search-result-sub">{s.artist} · {s.album}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : null}
        </>;
      })()}
    </div>
  );
}
