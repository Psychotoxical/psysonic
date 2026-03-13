import React, { useEffect, useState } from 'react';
import AlbumRow from '../components/AlbumRow';
import ArtistRow from '../components/ArtistRow';
import { getStarred, SubsonicAlbum, SubsonicArtist, SubsonicSong } from '../api/subsonic';
import { usePlayerStore } from '../store/playerStore';
import { Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export default function Favorites() {
  const { t } = useTranslation();
  const [albums, setAlbums] = useState<SubsonicAlbum[]>([]);
  const [artists, setArtists] = useState<SubsonicArtist[]>([]);
  const [songs, setSongs] = useState<SubsonicSong[]>([]);
  const [loading, setLoading] = useState(true);

  const { playTrack } = usePlayerStore();

  useEffect(() => {
    getStarred()
      .then(res => {
        setAlbums(res.albums);
        setArtists(res.artists);
        setSongs(res.songs);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="content-body" style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
        <div className="spinner" />
      </div>
    );
  }

  const hasAnyFavorites = albums.length > 0 || artists.length > 0 || songs.length > 0;

  return (
    <div className="content-body animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '3rem' }}>
      <div style={{ marginBottom: '-1.5rem' }}>
        <h1 className="page-title">{t('favorites.title')}</h1>
      </div>

      {!hasAnyFavorites ? (
        <div className="empty-state">{t('favorites.empty')}</div>
      ) : (
        <>
          {artists.length > 0 && (
            <ArtistRow title={t('favorites.artists')} artists={artists} />
          )}

          {albums.length > 0 && (
            <AlbumRow title={t('favorites.albums')} albums={albums} />
          )}

          {songs.length > 0 && (
            <section className="album-row-section">
              <div className="album-row-header" style={{ marginBottom: '1rem' }}>
                <h2 className="section-title" style={{ marginBottom: 0 }}>{t('favorites.songs')}</h2>
              </div>
              <div className="tracklist" style={{ padding: 0 }}>
                {songs.map((song) => (
                  <div
                    key={song.id}
                    className="track-row"
                    style={{ gridTemplateColumns: '36px 1fr 60px' }}
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
                    >
                      <Play size={14} fill="currentColor" />
                    </button>
                    <div className="track-info">
                      <span className="track-title" title={song.title}>{song.title}</span>
                      <span className="track-artist">{song.artist}</span>
                    </div>
                    <span className="track-duration" style={{ textAlign: 'right' }}>
                      {Math.floor(song.duration / 60)}:{(song.duration % 60).toString().padStart(2, '0')}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
