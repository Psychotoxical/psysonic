import React, { useEffect, useState } from 'react';
import { getRandomSongs, SubsonicSong, star, unstar } from '../api/subsonic';
import { usePlayerStore } from '../store/playerStore';
import { Play, HandMetal, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

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
  const enqueue = usePlayerStore(s => s.enqueue);
  const [starredSongs, setStarredSongs] = useState<Set<string>>(new Set());

  const fetchSongs = () => {
    setLoading(true);
    getRandomSongs(50)
      .then(fetched => {
        setSongs(fetched);
        const st = new Set<string>();
        fetched.forEach(s => { if (s.starred) st.add(s.id); });
        setStarredSongs(st);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  useEffect(() => {
    fetchSongs();
  }, []);

  const handlePlayAll = () => {
    if (songs.length > 0) playTrack(songs[0], songs);
  };

  const toggleSongStar = async (song: SubsonicSong, e: React.MouseEvent) => {
    e.stopPropagation();
    const currentlyStarred = starredSongs.has(song.id);
    const nextStarred = new Set(starredSongs);
    if (currentlyStarred) nextStarred.delete(song.id);
    else nextStarred.add(song.id);
    setStarredSongs(nextStarred);

    try {
      if (currentlyStarred) await unstar(song.id, 'song');
      else await star(song.id, 'song');
    } catch (err) {
      console.error('Failed to toggle song star', err);
      setStarredSongs(new Set(starredSongs));
    }
  };

  return (
    <div className="content-body animate-fade-in">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <h1 className="page-title">{t('randomMix.title')}</h1>

        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn-surface" onClick={fetchSongs} disabled={loading} data-tooltip={t('randomMix.remixTooltip')}>
            <RefreshCw size={18} className={loading ? 'spin' : ''} /> {t('randomMix.remix')}
          </button>
          <button className="btn btn-primary" onClick={handlePlayAll} disabled={loading || songs.length === 0}>
            <Play size={18} fill="currentColor" /> {t('randomMix.playAll')}
          </button>
        </div>
      </div>

      {loading && songs.length === 0 ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
          <div className="spinner" />
        </div>
      ) : (
        <div className="tracklist">
          <div className="tracklist-header" style={{ gridTemplateColumns: '36px 1fr 1fr 1fr 60px 80px' }}>
            <span></span>
            <span>{t('randomMix.trackTitle')}</span>
            <span>{t('randomMix.trackArtist')}</span>
            <span>{t('randomMix.trackAlbum')}</span>
            <span style={{ textAlign: 'center' }}>{t('randomMix.trackFavorite')}</span>
            <span style={{ textAlign: 'right' }}>{t('randomMix.trackDuration')}</span>
          </div>

          {songs.map((song) => (
            <div
              key={song.id}
              className="track-row"
              style={{ gridTemplateColumns: '36px 1fr 1fr 1fr 60px 80px' }}
              onDoubleClick={() => playTrack(song, songs)}
              role="row"
              draggable
              onDragStart={e => {
                e.dataTransfer.effectAllowed = 'copy';
                const track = {
                  id: song.id, title: song.title, artist: song.artist, album: song.album,
                  albumId: song.albumId, artistId: song.artistId, duration: song.duration, coverArt: song.coverArt, track: song.track,
                  year: song.year, bitRate: song.bitRate, suffix: song.suffix, userRating: song.userRating,
                };
                e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'song', track }));
              }}
            >
              <button
                className="btn btn-ghost"
                style={{ padding: 4 }}
                onClick={(e) => { e.stopPropagation(); playTrack(song, songs); }}
                data-tooltip={t('randomMix.play')}
              >
                <Play size={14} fill="currentColor" />
              </button>

              <div className="track-info">
                <span className="track-title" data-tooltip={song.title}>{song.title}</span>
              </div>

              <div className="track-artist-cell">
                <span className="track-artist" data-tooltip={song.artist}>{song.artist}</span>
              </div>

              <div className="track-info">
                <span className="track-title" style={{ fontSize: '0.85rem', color: 'var(--subtext0)' }} data-tooltip={song.album}>{song.album}</span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <button
                  className="btn btn-ghost"
                  onClick={(e) => toggleSongStar(song, e)}
                  data-tooltip={starredSongs.has(song.id) ? t('randomMix.favoriteRemove') : t('randomMix.favoriteAdd')}
                  style={{ padding: '4px', height: 'auto', minHeight: 'unset', color: starredSongs.has(song.id) ? 'var(--accent)' : 'var(--text-muted)' }}
                >
                  <HandMetal size={14} fill={starredSongs.has(song.id) ? "currentColor" : "none"} />
                </button>
              </div>

              <span className="track-duration" style={{ textAlign: 'right' }}>
                {formatDuration(song.duration)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
