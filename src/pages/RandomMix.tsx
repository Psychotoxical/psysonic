import React, { useEffect, useMemo, useState } from 'react';
import { getGenres, SubsonicSong, SubsonicGenre, star, unstar } from '../api/subsonic';
import { usePlayerStore, songToTrack } from '../store/playerStore';
import { useAuthStore } from '../store/authStore';
import { Play, RefreshCw, ChevronDown, ChevronUp, Heart } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useDragDrop } from '../contexts/DragDropContext';
import { useIsMobile } from '../hooks/useIsMobile';
import {
  fetchRandomMixSongsUntilFull,
  getMixMinRatingsConfigFromAuth,
  passesMixMinRatings,
} from '../utils/mixRatingFilter';

const AUDIOBOOK_GENRES = [
  'hörbuch', 'hoerbuch', 'hörspiel', 'hoerspiel',
  'audiobook', 'audio book', 'spoken word', 'spokenword',
  'podcast', 'kapitel', 'thriller', 'krimi', 'speech',
  'fantasy', 'comedy', 'literature',
];


function formatDuration(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function RandomMix() {
  const { t } = useTranslation();
  const [songs, setSongs] = useState<SubsonicSong[]>([]);
  const [loading, setLoading] = useState(true);
  const playTrack = usePlayerStore(s => s.playTrack);
  const openContextMenu = usePlayerStore(s => s.openContextMenu);
  const contextMenuOpen = usePlayerStore(s => s.contextMenu.isOpen);
  const currentTrack = usePlayerStore(s => s.currentTrack);
  const isPlaying = usePlayerStore(s => s.isPlaying);
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

  const fetchSongs = () => {
    setLoading(true);
    setSongs([]);
    fetchRandomMixSongsUntilFull(getMixMinRatingsConfigFromAuth())
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

  const filteredSongs = songs.filter(song => {
    if (!excludeAudiobooks) return true;
    const checkText = (text: string) => {
      const t = text.toLowerCase();
      if (AUDIOBOOK_GENRES.some(ag => t.includes(ag))) return true;
      if (customGenreBlacklist.some(bg => t.includes(bg.toLowerCase()))) return true;
      return false;
    };
    if (song.genre && checkText(song.genre)) return false;
    if (song.title && checkText(song.title)) return false;
    if (song.album && checkText(song.album)) return false;
    if (song.artist && checkText(song.artist)) return false;
    if (!passesMixMinRatings(song, mixRatingCfg)) return false;
    return true;
  });

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

  const loadGenreMix = async (genre: string) => {
    setGenreMixLoading(true);
    setGenreMixComplete(false);
    setGenreMixSongs([]);
    try {
      const list = await fetchRandomMixSongsUntilFull(getMixMinRatingsConfigFromAuth(), {
        genre,
        timeout: 45000,
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <h1 className="page-title">{t('randomMix.title')}</h1>

        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            className="btn btn-surface"
            onClick={selectedGenre ? () => loadGenreMix(selectedGenre) : fetchSongs}
            disabled={selectedGenre ? genreMixLoading : loading}
            data-tooltip={selectedGenre
              ? t('randomMix.remixTooltipGenre', { genre: selectedGenre })
              : t('randomMix.remixTooltip')
            }
          >
            <RefreshCw size={18} className={(selectedGenre ? genreMixLoading : loading) ? 'spin' : ''} />
            {selectedGenre ? t('randomMix.remixGenre', { genre: selectedGenre }) : t('randomMix.remix')}
          </button>
          {(() => {
            const isGenreLoading = selectedGenre && !genreMixComplete;
            const isDisabled = loading || (selectedGenre ? !genreMixComplete || genreMixSongs.length === 0 : filteredSongs.length === 0);
            return (
              <button
                className={`btn ${isGenreLoading ? 'btn-surface' : 'btn-primary'}`}
                onClick={handlePlayAll}
                disabled={isDisabled}
              >
                {isGenreLoading ? (
                  <><div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> {Math.min(genreMixSongs.length, 50)} / 50</>
                ) : (
                  <><Play size={18} fill="currentColor" /> {t('randomMix.playAll')}</>
                )}
              </button>
            );
          })()}
        </div>
      </div>

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
        {/* Left: Blacklist */}
        <div style={{ background: 'var(--bg-card)', padding: '1rem 1.25rem' }}>
          {isMobile ? (
            <button
              className="btn btn-ghost"
              style={{ width: '100%', justifyContent: 'space-between', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', padding: '0' }}
              onClick={() => setFiltersExpanded(v => !v)}
            >
              {t('randomMix.filterPanelTitle')}
              {filtersExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          ) : (
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
              {t('randomMix.filterPanelTitle')}
            </div>
          )}
          {(!isMobile || filtersExpanded) && (
            <div style={{ marginTop: isMobile ? '0.75rem' : 0 }}>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: '0.75rem', lineHeight: 1.5 }}>
                {t('randomMix.filterPanelDesc')}
              </p>

              <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', cursor: 'pointer', fontSize: 13, marginBottom: '0.75rem' }}>
                <input
                  type="checkbox"
                  checked={excludeAudiobooks}
                  onChange={e => setExcludeAudiobooks(e.target.checked)}
                  style={{ marginTop: 2 }}
                />
                <div>
                  <div style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{t('randomMix.excludeAudiobooks')}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{t('randomMix.excludeAudiobooksDesc')}</div>
                </div>
              </label>

              <button
                className="btn btn-ghost"
                style={{ fontSize: 12, padding: '3px 8px', marginBottom: blacklistOpen ? '0.5rem' : 0 }}
                onClick={() => setBlacklistOpen(v => !v)}
              >
                {blacklistOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                {t('randomMix.blacklistToggle')} ({customGenreBlacklist.length})
              </button>

              {blacklistOpen && (
                <div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginBottom: '0.5rem', minHeight: 24 }}>
                    {customGenreBlacklist.length === 0 ? (
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t('settings.randomMixBlacklistEmpty')}</span>
                    ) : (
                      customGenreBlacklist.map(genre => (
                        <span key={genre} style={{
                          display: 'inline-flex', alignItems: 'center', gap: 3,
                          background: 'color-mix(in srgb, var(--accent) 15%, transparent)',
                          color: 'var(--accent)', borderRadius: 'var(--radius-sm)',
                          padding: '1px 7px', fontSize: 11, fontWeight: 500,
                        }}>
                          {genre}
                          <button
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0, lineHeight: 1, fontSize: 13 }}
                            onClick={() => setCustomGenreBlacklist(customGenreBlacklist.filter(g => g !== genre))}
                          >×</button>
                        </span>
                      ))
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: '0.4rem' }}>
                    <input
                      className="input"
                      type="text"
                      value={newGenre}
                      onChange={e => setNewGenre(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && newGenre.trim()) {
                          const trimmed = newGenre.trim();
                          if (!customGenreBlacklist.includes(trimmed)) setCustomGenreBlacklist([...customGenreBlacklist, trimmed]);
                          setNewGenre('');
                        }
                      }}
                      placeholder={t('settings.randomMixBlacklistPlaceholder')}
                      style={{ fontSize: 12 }}
                    />
                    <button
                      className="btn btn-ghost"
                      style={{ fontSize: 12, padding: '4px 10px', flexShrink: 0 }}
                      onClick={() => {
                        const trimmed = newGenre.trim();
                        if (trimmed && !customGenreBlacklist.includes(trimmed)) setCustomGenreBlacklist([...customGenreBlacklist, trimmed]);
                        setNewGenre('');
                      }}
                      disabled={!newGenre.trim()}
                    >{t('settings.randomMixBlacklistAdd')}</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: Genre Mix */}
        <div style={{ background: 'var(--bg-card)', padding: '1rem 1.25rem' }}>
          {isMobile ? (
            <button
              className="btn btn-ghost"
              style={{ width: '100%', justifyContent: 'space-between', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', padding: '0' }}
              onClick={() => setGenreMixExpanded(v => !v)}
            >
              {t('randomMix.genreMixTitle')}
              {genreMixExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          ) : (
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
              {t('randomMix.genreMixTitle')}
            </div>
          )}
          {(!isMobile || genreMixExpanded) && (
            <div style={{ marginTop: isMobile ? '0.75rem' : 0 }}>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: '0.75rem' }}>{t('randomMix.genreMixDesc')}</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center' }}>
                {serverGenres.length === 0 ? (
                  <div className="spinner" style={{ width: 14, height: 14 }} />
                ) : displayedGenres.length === 0 ? (
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('randomMix.genreMixNoGenres')}</span>
                ) : (
                  <>
                    <button
                      className={`btn ${selectedGenre === null ? 'btn-primary' : 'btn-surface'}`}
                      style={{ fontSize: 12, padding: '4px 12px' }}
                      onClick={() => { setSelectedGenre(null); setGenreMixSongs([]); setGenreMixComplete(false); fetchSongs(); }}
                      disabled={genreMixLoading}
                    >
                      {t('randomMix.genreMixAll')}
                    </button>
                    {displayedGenres.map(genre => (
                      <button
                        key={genre}
                        className={`btn ${selectedGenre === genre ? 'btn-primary' : 'btn-surface'}`}
                        style={{ fontSize: 12, padding: '4px 12px' }}
                        onClick={() => { setSelectedGenre(genre); loadGenreMix(genre); }}
                        disabled={genreMixLoading}
                      >
                        {genre}
                      </button>
                    ))}
                    {allAvailableGenres.length > 20 && (
                      <button
                        className="btn btn-ghost"
                        style={{ fontSize: 12, padding: '4px 10px', flexShrink: 0 }}
                        onClick={shuffleDisplayedGenres}
                        disabled={genreMixLoading}
                        data-tooltip={t('randomMix.shuffleGenres')}
                      >
                        <RefreshCw size={12} />
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
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
            <div className="tracklist">
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
                    className={`track-row${isCurrentTrack ? ' active' : ''}${contextMenuSongId === song.id ? ' context-active' : ''}`}
                    style={{ gridTemplateColumns: '60px minmax(150px, 1fr) minmax(80px, 1fr) minmax(80px, 1fr) 70px 65px' }}
                    onClick={e => { if ((e.target as HTMLElement).closest('button, a, input')) return; playTrack(track, queueSongs); }}
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
                    <div className={`track-num${isCurrentTrack ? ' track-num-active' : ''}`} style={{ cursor: 'pointer' }} onClick={e => { e.stopPropagation(); playTrack(track, queueSongs); }}>
                      {isCurrentTrack && isPlaying && <span className="track-num-eq"><div className="eq-bars"><span className="eq-bar" /><span className="eq-bar" /><span className="eq-bar" /></div></span>}
                      <span className="track-num-play"><Play size={13} fill="currentColor" /></span>
                      <span className="track-num-number">{idx + 1}</span>
                    </div>
                    <div className="track-info"><span className="track-title">{song.title}</span></div>
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
                    <div className="track-duration">{formatDuration(song.duration)}</div>
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
        <div className="tracklist">
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
                className={`track-row${isCurrentTrack ? ' active' : ''}${contextMenuSongId === song.id ? ' context-active' : ''}`}
                style={{ gridTemplateColumns: '60px minmax(150px, 1fr) minmax(80px, 1fr) minmax(80px, 1fr) 120px 70px 65px' }}
                onClick={e => { if ((e.target as HTMLElement).closest('button, a, input')) return; playTrack(track, queueSongs); }}
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
                <div className={`track-num${isCurrentTrack ? ' track-num-active' : ''}`} style={{ cursor: 'pointer' }} onClick={e => { e.stopPropagation(); playTrack(track, queueSongs); }}>
                  {isCurrentTrack && isPlaying && <span className="track-num-eq"><div className="eq-bars"><span className="eq-bar" /><span className="eq-bar" /><span className="eq-bar" /></div></span>}
                  <span className="track-num-play"><Play size={13} fill="currentColor" /></span>
                  <span className="track-num-number">{idx + 1}</span>
                </div>

                <div className="track-info">
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

                <div className="track-duration">{formatDuration(song.duration)}</div>
              </div>
            );
          })}
        </div>
      ))}

    </div>
  );
}
