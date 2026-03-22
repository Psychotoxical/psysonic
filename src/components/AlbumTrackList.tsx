import React from 'react';
import { Play, Star } from 'lucide-react';
import { SubsonicSong } from '../api/subsonic';
import { Track } from '../store/playerStore';
import { useTranslation } from 'react-i18next';

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function codecLabel(song: { suffix?: string; bitRate?: number }): string {
  const parts: string[] = [];
  if (song.suffix) parts.push(song.suffix.toUpperCase());
  if (song.bitRate) parts.push(`${song.bitRate} kbps`);
  return parts.join(' · ');
}

function StarRating({ value, onChange }: { value: number; onChange: (r: number) => void }) {
  const { t } = useTranslation();
  const [hover, setHover] = React.useState(0);
  return (
    <div className="star-rating" role="radiogroup" aria-label={t('albumDetail.ratingLabel')}>
      {[1, 2, 3, 4, 5].map(n => (
        <button
          key={n}
          className={`star ${(hover || value) >= n ? 'filled' : ''}`}
          onMouseEnter={() => setHover(n)}
          onMouseLeave={() => setHover(0)}
          onClick={() => onChange(n)}
          aria-label={`${n}`}
          role="radio"
          aria-checked={(hover || value) >= n}
        >
          ★
        </button>
      ))}
    </div>
  );
}

interface AlbumTrackListProps {
  songs: SubsonicSong[];
  hasVariousArtists: boolean;
  currentTrack: Track | null;
  isPlaying: boolean;
  hoveredSongId: string | null;
  setHoveredSongId: (id: string | null) => void;
  ratings: Record<string, number>;
  starredSongs: Set<string>;
  onPlaySong: (song: SubsonicSong) => void;
  onRate: (songId: string, rating: number) => void;
  onToggleSongStar: (song: SubsonicSong, e: React.MouseEvent) => void;
  onContextMenu: (x: number, y: number, track: Track, type: 'song' | 'album' | 'artist' | 'queue-item' | 'album-song') => void;
}

export default function AlbumTrackList({
  songs,
  hasVariousArtists,
  currentTrack,
  isPlaying,
  hoveredSongId,
  setHoveredSongId,
  ratings,
  starredSongs,
  onPlaySong,
  onRate,
  onToggleSongStar,
  onContextMenu,
}: AlbumTrackListProps) {
  const { t } = useTranslation();
  const totalDuration = songs.reduce((acc, s) => acc + s.duration, 0);

  const discs = new Map<number, SubsonicSong[]>();
  songs.forEach(song => {
    const disc = song.discNumber ?? 1;
    if (!discs.has(disc)) discs.set(disc, []);
    discs.get(disc)!.push(song);
  });
  const discNums = Array.from(discs.keys()).sort((a, b) => a - b);
  const isMultiDisc = discNums.length > 1;

  const makeTrack = (song: SubsonicSong): Track => ({
    id: song.id, title: song.title, artist: song.artist, album: song.album,
    albumId: song.albumId, artistId: song.artistId, duration: song.duration,
    coverArt: song.coverArt, track: song.track, year: song.year,
    bitRate: song.bitRate, suffix: song.suffix, userRating: song.userRating,
    starred: song.starred,
  });

  return (
    <div className="tracklist">
      <div className={`tracklist-header${hasVariousArtists ? ' tracklist-va' : ''}`}>
        <div className="col-center">#</div>
        <div>{t('albumDetail.trackTitle')}</div>
        {hasVariousArtists && <div>{t('albumDetail.trackArtist')}</div>}
        <div className="col-center">{t('albumDetail.trackFavorite')}</div>
        <div className="col-center">{t('albumDetail.trackRating')}</div>
        <div className="col-center">{t('albumDetail.trackDuration')}</div>
        <div>{t('albumDetail.trackFormat')}</div>
      </div>

      {discNums.map(discNum => (
        <div key={discNum}>
          {isMultiDisc && (
            <div className="disc-header">
              <span className="disc-icon">💿</span>
              CD {discNum}
            </div>
          )}
          {discs.get(discNum)!.map((song, i) => (
            <div
              key={song.id}
              className={`track-row${hasVariousArtists ? ' track-row-va' : ''}${currentTrack?.id === song.id ? ' active' : ''}`}
              onMouseEnter={() => setHoveredSongId(song.id)}
              onMouseLeave={() => setHoveredSongId(null)}
              onDoubleClick={() => onPlaySong(song)}
              onContextMenu={e => {
                e.preventDefault();
                onContextMenu(e.clientX, e.clientY, makeTrack(song), 'album-song');
              }}
              role="row"
              draggable
              onDragStart={e => {
                e.dataTransfer.effectAllowed = 'copy';
                e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'song', track: makeTrack(song) }));
              }}
            >
              <div
                className="track-num"
                style={{
                  cursor: hoveredSongId === song.id ? 'pointer' : 'default',
                  color: (hoveredSongId === song.id || currentTrack?.id === song.id) ? 'var(--accent)' : undefined,
                }}
                onClick={() => onPlaySong(song)}
              >
                {hoveredSongId === song.id && currentTrack?.id !== song.id
                  ? <Play size={13} fill="currentColor" />
                  : currentTrack?.id === song.id && isPlaying
                    ? <div className="eq-bars"><span className="eq-bar" /><span className="eq-bar" /><span className="eq-bar" /></div>
                    : currentTrack?.id === song.id
                      ? <Play size={13} fill="currentColor" />
                      : (song.track ?? i + 1)}
              </div>
              <div className="track-info">
                <span className="track-title">{song.title}</span>
              </div>
              {hasVariousArtists && (
                <div className="track-artist-cell">
                  <span className="track-artist">{song.artist}</span>
                </div>
              )}
              <div className="track-star-cell">
                <button
                  className="btn btn-ghost track-star-btn"
                  onClick={e => onToggleSongStar(song, e)}
                  data-tooltip={starredSongs.has(song.id) ? t('albumDetail.favoriteRemove') : t('albumDetail.favoriteAdd')}
                  style={{ color: starredSongs.has(song.id) ? 'var(--color-star-active, var(--accent))' : 'var(--color-star-inactive, var(--text-muted))' }}
                >
                  <Star size={14} fill={starredSongs.has(song.id) ? 'currentColor' : 'none'} />
                </button>
              </div>
              <StarRating
                value={ratings[song.id] ?? song.userRating ?? 0}
                onChange={r => onRate(song.id, r)}
              />
              <div className="track-duration">
                {formatDuration(song.duration)}
              </div>
              <div className="track-meta">
                {(song.suffix || song.bitRate) && (
                  <span className="track-codec">{codecLabel(song)}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      ))}

      <div className={`tracklist-total${hasVariousArtists ? ' tracklist-va' : ''}`}>
        <span className="tracklist-total-label">{t('albumDetail.trackTotal')}</span>
        <span className="tracklist-total-value">{formatDuration(totalDuration)}</span>
      </div>
    </div>
  );
}
