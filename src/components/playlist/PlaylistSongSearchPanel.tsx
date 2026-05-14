import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ListPlus, X } from 'lucide-react';
import { buildCoverArtUrl, coverArtCacheKey } from '../../api/subsonicStreamUrl';
import type { SubsonicSong } from '../../api/subsonicTypes';
import { usePlayerStore } from '../../store/playerStore';
import { songToTrack } from '../../utils/playback/songToTrack';
import { formatTrackTime } from '../../utils/format/formatDuration';
import CachedImage from '../CachedImage';
import { AddToPlaylistSubmenu } from '../ContextMenu';

function PlaylistSearchResultThumb({ coverArt }: { coverArt: string }) {
  const src = useMemo(() => buildCoverArtUrl(coverArt, 40), [coverArt]);
  const cacheKey = useMemo(() => coverArtCacheKey(coverArt, 40), [coverArt]);
  return <CachedImage src={src} cacheKey={cacheKey} alt="" className="playlist-search-thumb" />;
}

interface Props {
  query: string;
  setQuery: (v: string) => void;
  searching: boolean;
  searchResults: SubsonicSong[];
  setSearchResults: React.Dispatch<React.SetStateAction<SubsonicSong[]>>;
  selectedSearchIds: Set<string>;
  setSelectedSearchIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  searchPlPickerOpen: boolean;
  setSearchPlPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  contextMenuSongId: string | null;
  setContextMenuSongId: React.Dispatch<React.SetStateAction<string | null>>;
  addSong: (song: SubsonicSong) => void;
}

export default function PlaylistSongSearchPanel({
  query, setQuery, searching, searchResults, setSearchResults,
  selectedSearchIds, setSelectedSearchIds,
  searchPlPickerOpen, setSearchPlPickerOpen,
  contextMenuSongId, setContextMenuSongId,
  addSong,
}: Props) {
  const { t } = useTranslation();
  const openContextMenu = usePlayerStore(s => s.openContextMenu);

  return (
    <div className="playlist-search-panel">
      <div className="playlist-search-input-wrap">
        <input
          className="input"
          placeholder={t('playlists.searchPlaceholder')}
          value={query}
          onChange={e => setQuery(e.target.value)}
          autoFocus
        />
        {query && (
          <button className="live-search-clear" onClick={() => { setQuery(''); setSearchResults([]); }}>
            <X size={14} />
          </button>
        )}
      </div>
      {searching && <div style={{ textAlign: 'center', padding: '0.75rem' }}><div className="spinner" /></div>}
      {!searching && query && searchResults.length === 0 && (
        <div className="empty-state" style={{ padding: '0.5rem 0' }}>{t('playlists.noResults')}</div>
      )}
      {selectedSearchIds.size > 0 && (
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.4rem 0.75rem', background: 'color-mix(in srgb, var(--accent) 10%, transparent)', borderRadius: 'var(--radius-sm)', margin: '0.25rem 0' }}>
          <span style={{ fontSize: 13, color: 'var(--accent)', fontWeight: 600, flex: 1 }}>
            {t('common.bulkSelected', { count: selectedSearchIds.size })}
          </span>
          <button
            className="btn btn-sm btn-ghost"
            style={{ fontSize: 12 }}
            onClick={() => setSelectedSearchIds(new Set())}
          >
            {t('common.clearSelection')}
          </button>
          <div style={{ position: 'relative' }}>
            <button
              className="btn btn-sm btn-primary"
              style={{ fontSize: 12 }}
              onClick={() => setSearchPlPickerOpen(v => !v)}
            >
              <ListPlus size={13} /> {t('contextMenu.addToPlaylist')}
            </button>
            {searchPlPickerOpen && (
              <AddToPlaylistSubmenu
                songIds={[...selectedSearchIds]}
                dropDown
                onDone={() => { setSearchPlPickerOpen(false); setSelectedSearchIds(new Set()); }}
              />
            )}
          </div>
          <button
            className="btn btn-sm btn-primary"
            style={{ fontSize: 12 }}
            onClick={() => {
              searchResults
                .filter(s => selectedSearchIds.has(s.id))
                .forEach(s => addSong(s));
              setSelectedSearchIds(new Set());
            }}
          >
            <Check size={13} /> {t('playlists.addSelected')}
          </button>
        </div>
      )}
      {searchResults.map(song => {
        const isSelected = selectedSearchIds.has(song.id);
          return (
            <div
              key={song.id}
              className={`playlist-search-row${isSelected ? ' playlist-search-row--selected' : ''}${contextMenuSongId === song.id ? ' context-active' : ''}`}
              style={{ cursor: 'pointer' }}
              onClick={() => addSong(song)}
              onContextMenu={e => {
                e.preventDefault();
                setContextMenuSongId(song.id);
                openContextMenu(e.clientX, e.clientY, songToTrack(song), 'album-song');
              }}
            >
            <input
              type="checkbox"
              className="playlist-search-checkbox"
              checked={isSelected}
              onClick={e => e.stopPropagation()}
              onChange={() => setSelectedSearchIds(prev => {
                const next = new Set(prev);
                next.has(song.id) ? next.delete(song.id) : next.add(song.id);
                return next;
              })}
            />
            <PlaylistSearchResultThumb coverArt={song.coverArt ?? ''} />
            <div className="playlist-search-info">
              <span className="playlist-search-title">{song.title}</span>
              <span className="playlist-search-artist">{song.artist} · <span className="playlist-search-album">{song.album}</span></span>
            </div>
            <span className="playlist-search-duration">{formatTrackTime(song.duration ?? 0)}</span>
          </div>
        );
      })}
    </div>
  );
}
