import { star, unstar } from '../api/subsonicStarRating';
import { getGenres } from '../api/subsonicGenres';
import type { SubsonicSong, SubsonicGenre } from '../api/subsonicTypes';
import { RANDOM_MIX_SIZE_OPTIONS } from '../store/authStoreDefaults';
import { songToTrack } from '../utils/songToTrack';
import React, { useEffect, useMemo, useState } from 'react';
import { usePlayerStore } from '../store/playerStore';
import { usePreviewStore } from '../store/previewStore';
import { useAuthStore } from '../store/authStore';
import { Play, RefreshCw, ChevronDown, ChevronRight, ChevronUp, Heart, Square, AudioLines } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useDragDrop } from '../contexts/DragDropContext';
import { useIsMobile } from '../hooks/useIsMobile';
import { useOrbitSongRowBehavior } from '../hooks/useOrbitSongRowBehavior';
import {
  fetchRandomMixSongsUntilFull,
  getMixMinRatingsConfigFromAuth,
} from '../utils/mixRatingFilter';
import { AUDIOBOOK_GENRES, filterRandomMixSongs, formatRandomMixDuration } from '../utils/randomMixHelpers';
import RandomMixHeader from '../components/randomMix/RandomMixHeader';
import RandomMixFiltersPanel from '../components/randomMix/RandomMixFiltersPanel';
import RandomMixGenrePanel from '../components/randomMix/RandomMixGenrePanel';

export default function RandomMix() {
  const { t } = useTranslation();
  const [songs, setSongs] = useState<SubsonicSong[]>([]);
  const [loading, setLoading] = useState(true);
  const playTrack = usePlayerStore(s => s.playTrack);
  const { orbitActive, queueHint, addTrackToOrbit } = useOrbitSongRowBehavior();
  const openContextMenu = usePlayerStore(s => s.openContextMenu);
  const contextMenuOpen = usePlayerStore(s => s.contextMenu.isOpen);
  const currentTrack = usePlayerStore(s => s.currentTrack);
  const isPlaying = usePlayerStore(s => s.isPlaying);
  const previewingId = usePreviewStore(s => s.previewingId);
  const previewAudioStarted = usePreviewStore(s => s.audioStarted);
  const starredOverrides = usePlayerStore(s => s.starredOverrides);
  const setStarredOverride = usePlayerStore(s => s.setStarredOverride);
  const [contextMenuSongId, setContextMenuSongId] = useState<string | null>(null);
  const isMobile = useIsMobile();
  const psyDrag = useDragDrop();
  const [starredSongs, setStarredSongs] = useState<Set<string>>(new Set());
  const {
    excludeAudiobooks,
    setExcludeAudiobooks,
    customGenreBlacklist,
    setCustomGenreBlacklist,
    mixMinRatingFilterEnabled,
    mixMinRatingSong,
    mixMinRatingAlbum,
    mixMinRatingArtist,
    randomMixSize,
    setRandomMixSize,
  } = useAuthStore();

  const mixRatingCfg = useMemo(
    () => ({
      enabled: mixMinRatingFilterEnabled,
      minSong: mixMinRatingSong,
      minAlbum: mixMinRatingAlbum,
      minArtist: mixMinRatingArtist,
    }),
    [mixMinRatingFilterEnabled, mixMinRatingSong, mixMinRatingAlbum, mixMinRatingArtist]
  );
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const [addedGenre, setAddedGenre] = useState<string | null>(null);
  const [addedArtist, setAddedArtist] = useState<string | null>(null);

  // Blacklist panel state
  const [blacklistOpen, setBlacklistOpen] = useState(false);
  const [newGenre, setNewGenre] = useState('');

  // Mobile collapsible panels
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [genreMixExpanded, setGenreMixExpanded] = useState(false);

  // Genre Mix state
  const [serverGenres, setServerGenres] = useState<SubsonicGenre[]>([]);
  const [allAvailableGenres, setAllAvailableGenres] = useState<string[]>([]);
  const [displayedGenres, setDisplayedGenres] = useState<string[]>([]);
  const [selectedGenre, setSelectedGenre] = useState<string | null>(null);
  const [genreMixSongs, setGenreMixSongs] = useState<SubsonicSong[]>([]);
  const [genreMixLoading, setGenreMixLoading] = useState(false);
  const [genreMixComplete, setGenreMixComplete] = useState(false);

  const fetchSongs = (overrideSize?: number) => {
    setLoading(true);
    setSongs([]);
    fetchRandomMixSongsUntilFull(getMixMinRatingsConfigFromAuth(), { targetSize: overrideSize ?? randomMixSize })
      .then(list => {
        setSongs(list);
        const st = new Set<string>();
        list.forEach(s => { if (s.starred) st.add(s.id); });
        setStarredSongs(st);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  useEffect(() => {
    if (!contextMenuOpen) setContextMenuSongId(null);
  }, [contextMenuOpen]);

  useEffect(() => {
    fetchSongs();
    getGenres().then(data => {
      setServerGenres(data);
      const audiobookLower = AUDIOBOOK_GENRES.map(g => g.toLowerCase());
      const available = data
        .filter(g => g.songCount > 0 && !audiobookLower.some(ab => g.value.toLowerCase().includes(ab)))
        .sort((a, b) => b.songCount - a.songCount)
        .map(g => g.value);
      setAllAvailableGenres(available);
      setDisplayedGenres(available.slice(0, 20));
    }).catch(() => {});
  }, [musicLibraryFilterVersion]);

  const filteredSongs = filterRandomMixSongs(songs, { excludeAudiobooks, customGenreBlacklist, mixRatingCfg });

  const handlePlayAll = () => {
    if (selectedGenre && genreMixSongs.length > 0) {
      playTrack(songToTrack(genreMixSongs[0]), genreMixSongs.map(songToTrack));
    } else if (filteredSongs.length > 0) {
      playTrack(songToTrack(filteredSongs[0]), filteredSongs.map(songToTrack));
    }
  };

  const toggleSongStar = async (song: SubsonicSong, e: React.MouseEvent) => {
    e.stopPropagation();
    const currentlyStarred = song.id in starredOverrides ? starredOverrides[song.id] : starredSongs.has(song.id);
    const nextStarred = new Set(starredSongs);
    if (currentlyStarred) nextStarred.delete(song.id);
    else nextStarred.add(song.id);
    setStarredSongs(nextStarred);
    setStarredOverride(song.id, !currentlyStarred);

    try {
      if (currentlyStarred) await unstar(song.id, 'song');
      else await star(song.id, 'song');
    } catch (err) {
      console.error('Failed to toggle song star', err);
      setStarredSongs(new Set(starredSongs));
      setStarredOverride(song.id, currentlyStarred);
    }
  };

  const loadGenreMix = async (genre: string, overrideSize?: number) => {
    setGenreMixLoading(true);
    setGenreMixComplete(false);
    setGenreMixSongs([]);
    try {
      const list = await fetchRandomMixSongsUntilFull(getMixMinRatingsConfigFromAuth(), {
        genre,
        timeout: 45000,
        targetSize: overrideSize ?? randomMixSize,
      });
      setGenreMixSongs(list);
    } catch {}
    setGenreMixLoading(false);
    setGenreMixComplete(true);
  };

  const shuffleDisplayedGenres = () => {
    const shuffled = [...allAvailableGenres].sort(() => Math.random() - 0.5);
    setDisplayedGenres(shuffled.slice(0, 20));
    setSelectedGenre(null);
    setGenreMixSongs([]);
    setGenreMixComplete(false);
  };


  return (
    <div className="content-body animate-fade-in">
      <RandomMixHeader
        selectedGenre={selectedGenre}
        loading={loading}
        genreMixLoading={genreMixLoading}
        genreMixComplete={genreMixComplete}
        genreMixSongsLength={genreMixSongs.length}
        filteredSongsLength={filteredSongs.length}
        randomMixSize={randomMixSize}
        onRefresh={selectedGenre ? () => loadGenreMix(selectedGenre) : () => fetchSongs()}
        onPlayAll={handlePlayAll}
      />

      {/* ── Filter + Genre Mix panel ─────────────────────────────── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr',
        gap: '1px',
        background: 'var(--border)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        marginBottom: '2rem',
        overflow: 'hidden',
      }}>
        <RandomMixFiltersPanel
          isMobile={isMobile}
          filtersExpanded={filtersExpanded}
          setFiltersExpanded={setFiltersExpanded}
          randomMixSize={randomMixSize}
          setRandomMixSize={setRandomMixSize}
          selectedGenre={selectedGenre}
          loadGenreMix={loadGenreMix}
          fetchSongs={fetchSongs}
          excludeAudiobooks={excludeAudiobooks}
          setExcludeAudiobooks={setExcludeAudiobooks}
          blacklistOpen={blacklistOpen}
          setBlacklistOpen={setBlacklistOpen}
          customGenreBlacklist={customGenreBlacklist}
          setCustomGenreBlacklist={setCustomGenreBlacklist}
          newGenre={newGenre}
          setNewGenre={setNewGenre}
        />

        <RandomMixGenrePanel
          isMobile={isMobile}
          genreMixExpanded={genreMixExpanded}
          setGenreMixExpanded={setGenreMixExpanded}
          serverGenresLength={serverGenres.length}
          displayedGenres={displayedGenres}
          allAvailableGenresLength={allAvailableGenres.length}
          selectedGenre={selectedGenre}
          genreMixLoading={genreMixLoading}
          onSelectAll={() => { setSelectedGenre(null); setGenreMixSongs([]); setGenreMixComplete(false); fetchSongs(); }}
          onSelectGenre={genre => { setSelectedGenre(genre); loadGenreMix(genre); }}
          onShuffle={shuffleDisplayedGenres}
        />
      </div>

      {/* Genre Mix tracklist (shown when a genre is selected) */}
      {(genreMixLoading || genreMixSongs.length > 0) && (
        <div style={{ marginBottom: '2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
              {selectedGenre} Mix
              {genreMixLoading && <div className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />}
            </span>
          </div>
          {genreMixLoading && genreMixSongs.length === 0 ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}><div className="spinner" /></div>
          ) : (
            <div className="tracklist" data-preview-loc="randomMix">
              <div className="tracklist-header" style={{ gridTemplateColumns: '60px minmax(150px, 1fr) minmax(80px, 1fr) minmax(80px, 1fr) 70px 65px' }}>
                <div></div>
                <div>{t('randomMix.trackTitle')}</div>
                <div>{t('randomMix.trackArtist')}</div>
                <div>{t('randomMix.trackAlbum')}</div>
                <div className="col-center">{t('randomMix.trackFavorite')}</div>
                <div className="col-center">{t('randomMix.trackDuration')}</div>
              </div>
              {genreMixSongs.map((song, idx) => {
                const track = songToTrack(song);
                const queueSongs = genreMixSongs.map(songToTrack);
                const isCurrentTrack = currentTrack?.id === song.id;
                const artist = song.artist;
                const isArtistBlocked = !!artist && customGenreBlacklist.some(bg => artist.toLowerCase().includes(bg.toLowerCase()));
                const isArtistJustAdded = addedArtist === artist;
                return (
                  <div
                    key={song.id}
                    className={`track-row track-row-with-actions${isCurrentTrack ? ' active' : ''}${contextMenuSongId === song.id ? ' context-active' : ''}`}
                    style={{ gridTemplateColumns: '60px minmax(150px, 1fr) minmax(80px, 1fr) minmax(80px, 1fr) 70px 65px' }}
                    onClick={e => { if ((e.target as HTMLElement).closest('button, a, input')) return; if (orbitActive) { queueHint(); return; } playTrack(track, queueSongs); }}
                    onDoubleClick={orbitActive ? e => { if ((e.target as HTMLElement).closest('button, a, input')) return; addTrackToOrbit(song.id); } : undefined}
                    role="row"
                    onContextMenu={e => { e.preventDefault(); setContextMenuSongId(song.id); openContextMenu(e.clientX, e.clientY, track, 'song'); }}
                    onMouseDown={e => {
                      if (e.button !== 0) return;
                      e.preventDefault();
                      const sx = e.clientX, sy = e.clientY;
                      const onMove = (me: MouseEvent) => {
                        if (Math.abs(me.clientX - sx) > 5 || Math.abs(me.clientY - sy) > 5) {
                          document.removeEventListener('mousemove', onMove);
                          document.removeEventListener('mouseup', onUp);
                          psyDrag.startDrag({ data: JSON.stringify({ type: 'song', track }), label: song.title }, me.clientX, me.clientY);
                        }
                      };
                      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
                      document.addEventListener('mousemove', onMove);
                      document.addEventListener('mouseup', onUp);
                    }}
                  >
                    <div className={`track-num${isCurrentTrack ? ' track-num-active' : ''}`}>
                      {isCurrentTrack && isPlaying ? (
                        <span className="track-num-eq"><AudioLines className="eq-bars" size={14} /></span>
                      ) : (
                        <span className="track-num-number">{idx + 1}</span>
                      )}
                    </div>
                    <div className="track-info track-info-suggestion">
                      <button
                        type="button"
                        className="playlist-suggestion-play-btn"
                        onClick={e => { e.stopPropagation(); if (orbitActive) { queueHint(); return; } playTrack(track, queueSongs); }}
                        data-tooltip={t('common.play')}
                        aria-label={t('common.play')}
                      >
                        <Play size={10} fill="currentColor" strokeWidth={0} className="playlist-suggestion-play-icon" />
                      </button>
                      <button
                        type="button"
                        className={`playlist-suggestion-preview-btn${previewingId === song.id ? ' is-previewing' : ''}${previewingId === song.id && previewAudioStarted ? ' audio-started' : ''}`}
                        onClick={e => { e.stopPropagation(); usePreviewStore.getState().startPreview({ id: song.id, title: song.title, artist: song.artist, coverArt: song.coverArt, duration: song.duration }, 'randomMix'); }}
                        data-tooltip={previewingId === song.id ? t('playlists.previewStop') : t('playlists.preview')}
                        aria-label={previewingId === song.id ? t('playlists.previewStop') : t('playlists.preview')}
                      >
                        <svg className="playlist-suggestion-preview-ring" viewBox="0 0 24 24" aria-hidden="true">
                          <circle cx="12" cy="12" r="10.5" className="playlist-suggestion-preview-ring-track" />
                          <circle cx="12" cy="12" r="10.5" className="playlist-suggestion-preview-ring-progress" />
                        </svg>
                        {previewingId === song.id
                          ? <Square size={9} fill="currentColor" strokeWidth={0} className="playlist-suggestion-preview-icon" />
                          : <ChevronRight size={14} className="playlist-suggestion-preview-icon playlist-suggestion-preview-icon-play" />}
                      </button>
                      <span className="track-title">{song.title}</span>
                    </div>
                    <div className="track-artist-cell">
                      {artist ? (
                        <button
                          className={`rm-artist-btn${isArtistBlocked ? ' is-blocked' : isArtistJustAdded ? ' just-added' : ''}`}
                          onClick={() => {
                            if (isArtistBlocked) return;
                            if (!customGenreBlacklist.some(bg => artist.toLowerCase().includes(bg.toLowerCase()))) {
                              setCustomGenreBlacklist([...customGenreBlacklist, artist]);
                              setAddedArtist(artist);
                              setTimeout(() => setAddedArtist(null), 1500);
                            }
                          }}
                          data-tooltip={isArtistBlocked ? t('randomMix.artistBlocked') : isArtistJustAdded ? t('randomMix.artistAddedToBlacklist') : t('randomMix.artistClickHint')}
                        >{artist}</button>
                      ) : <span className="track-artist">—</span>}
                    </div>
                    <div className="track-info">
                      <span className="track-title" style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{song.album ?? '—'}</span>
                    </div>
                    <div className="track-star-cell">
                      <button
                        className="btn btn-ghost track-star-btn"
                        onClick={e => toggleSongStar(song, e)}
                        data-tooltip={(song.id in starredOverrides ? starredOverrides[song.id] : starredSongs.has(song.id)) ? t('randomMix.favoriteRemove') : t('randomMix.favoriteAdd')}
                        style={{ color: (song.id in starredOverrides ? starredOverrides[song.id] : starredSongs.has(song.id)) ? 'var(--color-star-active, var(--accent))' : 'var(--color-star-inactive, var(--text-muted))' }}
                      >
                        <Heart size={14} fill={(song.id in starredOverrides ? starredOverrides[song.id] : starredSongs.has(song.id)) ? 'currentColor' : 'none'} />
                      </button>
                    </div>
                    <div className="track-duration">{formatRandomMixDuration(song.duration)}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {!selectedGenre && (loading && songs.length === 0 ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
          <div className="spinner" />
        </div>
      ) : (
        <div className="tracklist" data-preview-loc="randomMix">
          <div className="tracklist-header" style={{ gridTemplateColumns: '60px minmax(150px, 1fr) minmax(80px, 1fr) minmax(80px, 1fr) 120px 70px 65px' }}>
            <div></div>
            <div>{t('randomMix.trackTitle')}</div>
            <div>{t('randomMix.trackArtist')}</div>
            <div>{t('randomMix.trackAlbum')}</div>
            <div data-tooltip={t('randomMix.genreClickHint')} data-tooltip-wrap style={{ cursor: 'help' }}>
              {t('randomMix.trackGenre')} <span style={{ color: 'var(--accent)', fontWeight: 700, fontSize: 13 }}>ⓘ</span>
            </div>
            <div className="col-center">{t('randomMix.trackFavorite')}</div>
            <div className="col-center">{t('randomMix.trackDuration')}</div>
          </div>

          {filteredSongs.map((song, idx) => {
            const track = songToTrack(song);
            const queueSongs = filteredSongs.map(songToTrack);
            const isCurrentTrack = currentTrack?.id === song.id;
            const artist = song.artist;
            const genre = song.genre;
            const isArtistBlocked = !!artist && customGenreBlacklist.some(bg => artist.toLowerCase().includes(bg.toLowerCase()));
            const isArtistJustAdded = addedArtist === artist;
            const isGenreBlocked = !!genre && (
              AUDIOBOOK_GENRES.some(ag => genre.toLowerCase().includes(ag)) ||
              customGenreBlacklist.some(bg => genre.toLowerCase().includes(bg.toLowerCase()))
            );
            const isGenreJustAdded = addedGenre === genre;
            return (
              <div
                key={song.id}
                className={`track-row track-row-with-actions${isCurrentTrack ? ' active' : ''}${contextMenuSongId === song.id ? ' context-active' : ''}`}
                style={{ gridTemplateColumns: '60px minmax(150px, 1fr) minmax(80px, 1fr) minmax(80px, 1fr) 120px 70px 65px' }}
                onClick={e => { if ((e.target as HTMLElement).closest('button, a, input')) return; if (orbitActive) { queueHint(); return; } playTrack(track, queueSongs); }}
                onDoubleClick={orbitActive ? e => { if ((e.target as HTMLElement).closest('button, a, input')) return; addTrackToOrbit(song.id); } : undefined}
                role="row"
                onContextMenu={e => {
                  e.preventDefault();
                  setContextMenuSongId(song.id);
                  openContextMenu(e.clientX, e.clientY, track, 'song');
                }}
                onMouseDown={e => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  const sx = e.clientX, sy = e.clientY;
                  const onMove = (me: MouseEvent) => {
                    if (Math.abs(me.clientX - sx) > 5 || Math.abs(me.clientY - sy) > 5) {
                      document.removeEventListener('mousemove', onMove);
                      document.removeEventListener('mouseup', onUp);
                      psyDrag.startDrag({ data: JSON.stringify({ type: 'song', track }), label: song.title }, me.clientX, me.clientY);
                    }
                  };
                  const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
                  document.addEventListener('mousemove', onMove);
                  document.addEventListener('mouseup', onUp);
                }}
              >
                <div className={`track-num${isCurrentTrack ? ' track-num-active' : ''}`}>
                  {isCurrentTrack && isPlaying ? (
                    <span className="track-num-eq"><AudioLines className="eq-bars" size={14} /></span>
                  ) : (
                    <span className="track-num-number">{idx + 1}</span>
                  )}
                </div>

                <div className="track-info track-info-suggestion">
                  <button
                    type="button"
                    className="playlist-suggestion-play-btn"
                    onClick={e => { e.stopPropagation(); if (orbitActive) { queueHint(); return; } playTrack(track, queueSongs); }}
                    data-tooltip={t('common.play')}
                    aria-label={t('common.play')}
                  >
                    <Play size={10} fill="currentColor" strokeWidth={0} className="playlist-suggestion-play-icon" />
                  </button>
                  <button
                    type="button"
                    className={`playlist-suggestion-preview-btn${previewingId === song.id ? ' is-previewing' : ''}${previewingId === song.id && previewAudioStarted ? ' audio-started' : ''}`}
                    onClick={e => { e.stopPropagation(); usePreviewStore.getState().startPreview({ id: song.id, title: song.title, artist: song.artist, coverArt: song.coverArt, duration: song.duration }, 'randomMix'); }}
                    data-tooltip={previewingId === song.id ? t('playlists.previewStop') : t('playlists.preview')}
                    aria-label={previewingId === song.id ? t('playlists.previewStop') : t('playlists.preview')}
                  >
                    <svg className="playlist-suggestion-preview-ring" viewBox="0 0 24 24" aria-hidden="true">
                      <circle cx="12" cy="12" r="10.5" className="playlist-suggestion-preview-ring-track" />
                      <circle cx="12" cy="12" r="10.5" className="playlist-suggestion-preview-ring-progress" />
                    </svg>
                    {previewingId === song.id
                      ? <Square size={9} fill="currentColor" strokeWidth={0} className="playlist-suggestion-preview-icon" />
                      : <ChevronRight size={14} className="playlist-suggestion-preview-icon playlist-suggestion-preview-icon-play" />}
                  </button>
                  <span className="track-title">{song.title}</span>
                </div>

                <div className="track-artist-cell">
                  {artist ? (
                    <button
                      className={`rm-artist-btn${isArtistBlocked ? ' is-blocked' : isArtistJustAdded ? ' just-added' : ''}`}
                      onClick={() => {
                        if (isArtistBlocked) return;
                        if (!customGenreBlacklist.some(bg => artist.toLowerCase().includes(bg.toLowerCase()))) {
                          setCustomGenreBlacklist([...customGenreBlacklist, artist]);
                          setAddedArtist(artist);
                          setTimeout(() => setAddedArtist(null), 1500);
                        }
                      }}
                      data-tooltip={isArtistBlocked ? t('randomMix.artistBlocked') : isArtistJustAdded ? t('randomMix.artistAddedToBlacklist') : t('randomMix.artistClickHint')}
                    >{artist}</button>
                  ) : <span className="track-artist">—</span>}
                </div>

                <div className="track-info">
                  <span className="track-title" style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{song.album ?? '—'}</span>
                </div>

                <div>
                  {genre ? (
                    <button
                      className={`rm-genre-chip${isGenreBlocked ? ' is-blocked' : isGenreJustAdded ? ' just-added' : ''}`}
                      onClick={() => {
                        if (isGenreBlocked) return;
                        if (!customGenreBlacklist.some(bg => genre.toLowerCase().includes(bg.toLowerCase()))) {
                          setCustomGenreBlacklist([...customGenreBlacklist, genre]);
                          setAddedGenre(genre);
                          setTimeout(() => setAddedGenre(null), 1500);
                        }
                      }}
                      data-tooltip={isGenreBlocked ? t('randomMix.genreBlocked') : isGenreJustAdded ? t('randomMix.genreAddedToBlacklist') : t('randomMix.genreClickHint')}
                    >{genre}</button>
                  ) : <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>—</span>}
                </div>

                <div className="track-star-cell">
                  <button
                    className="btn btn-ghost track-star-btn"
                    onClick={e => toggleSongStar(song, e)}
                    data-tooltip={(song.id in starredOverrides ? starredOverrides[song.id] : starredSongs.has(song.id)) ? t('randomMix.favoriteRemove') : t('randomMix.favoriteAdd')}
                    style={{ color: (song.id in starredOverrides ? starredOverrides[song.id] : starredSongs.has(song.id)) ? 'var(--color-star-active, var(--accent))' : 'var(--color-star-inactive, var(--text-muted))' }}
                  >
                    <Heart size={14} fill={(song.id in starredOverrides ? starredOverrides[song.id] : starredSongs.has(song.id)) ? 'currentColor' : 'none'} />
                  </button>
                </div>

                <div className="track-duration">{formatRandomMixDuration(song.duration)}</div>
              </div>
            );
          })}
        </div>
      ))}

    </div>
  );
}
