import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Play, Star, ExternalLink, X, ChevronLeft, Download, ListPlus, Info } from 'lucide-react';
import { getAlbum, getArtist, getArtistInfo, setRating, buildCoverArtUrl, coverArtCacheKey, buildDownloadUrl, star, unstar, SubsonicSong, SubsonicAlbum } from '../api/subsonic';
import { usePlayerStore } from '../store/playerStore';
import { useAuthStore } from '../store/authStore';
import { useNavigate } from 'react-router-dom';
import { open } from '@tauri-apps/plugin-shell';
import { writeFile } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import AlbumCard from '../components/AlbumCard';
import CachedImage, { useCachedUrl } from '../components/CachedImage';
import { useTranslation } from 'react-i18next';

function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .substring(0, 200) || 'download';
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatSize(bytes?: number): string {
  if (!bytes) return '';
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function codecLabel(song: { suffix?: string; bitRate?: number; samplingRate?: number }): string {
  const parts: string[] = [];
  if (song.suffix) parts.push(song.suffix.toUpperCase());
  if (song.bitRate) parts.push(`${song.bitRate} kbps`);
  if (song.samplingRate) parts.push(`${(song.samplingRate / 1000).toFixed(1)} kHz`);
  return parts.join(' · ');
}

/** Strip dangerous tags/attributes from server-provided HTML (e.g. artist bios from Last.fm) */
function sanitizeHtml(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, iframe, object, embed, form, input, button, select, base, meta, link').forEach(el => el.remove());
  doc.querySelectorAll('*').forEach(el => {
    Array.from(el.attributes).forEach(attr => {
      const name = attr.name.toLowerCase();
      const val = attr.value.toLowerCase().trim();
      if (name.startsWith('on') || (name === 'href' && (val.startsWith('javascript:') || val.startsWith('data:'))) || (name === 'src' && (val.startsWith('javascript:') || val.startsWith('data:')))) {
        el.removeAttribute(attr.name);
      }
    });
  });
  return doc.body.innerHTML;
}

function StarRating({ value, onChange }: { value: number; onChange: (r: number) => void }) {
  const { t } = useTranslation();
  const [hover, setHover] = useState(0);
  return (
    <div className="star-rating" role="radiogroup" aria-label={t('albumDetail.ratingLabel')}>
      {[1,2,3,4,5].map(n => (
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

interface BioModalProps { bio: string; onClose: () => void; }
function BioModal({ bio, onClose }: BioModalProps) {
  const { t } = useTranslation();
  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={t('albumDetail.bioModal')}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label={t('albumDetail.bioClose')}><X size={18} /></button>
        <h3 style={{ marginBottom: '1rem', fontFamily: 'var(--font-display)' }}>{t('albumDetail.bioModal')}</h3>
        <div className="artist-bio" dangerouslySetInnerHTML={{ __html: sanitizeHtml(bio) }} data-selectable />
      </div>
    </div>
  );
}

export default function AlbumDetail() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const auth = useAuthStore();
  const playTrack = usePlayerStore(s => s.playTrack);
  const enqueue = usePlayerStore(s => s.enqueue);
  const openContextMenu = usePlayerStore(s => s.openContextMenu);
  const [album, setAlbum] = useState<Awaited<ReturnType<typeof getAlbum>> | null>(null);
  const [relatedAlbums, setRelatedAlbums] = useState<SubsonicAlbum[]>([]);
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [bio, setBio] = useState<string | null>(null);
  const [bioOpen, setBioOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [isStarred, setIsStarred] = useState(false);
  const [starredSongs, setStarredSongs] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setRelatedAlbums([]);
    getAlbum(id).then(async data => {
      setAlbum(data);
      setIsStarred(!!data.album.starred);
      const initialStarred = new Set<string>();
      data.songs.forEach(s => { if (s.starred) initialStarred.add(s.id); });
      setStarredSongs(initialStarred);
      setLoading(false);
      try {
        const artistData = await getArtist(data.album.artistId);
        setRelatedAlbums(artistData.albums.filter(a => a.id !== id));
      } catch (e) {
        console.error('Failed to fetch related albums', e);
      }
    }).catch(() => setLoading(false));
  }, [id]);

  const handlePlayAll = () => {
    if (!album) return;
    const tracks = album.songs.map(s => ({
      id: s.id, title: s.title, artist: s.artist, album: s.album,
      albumId: s.albumId, artistId: s.artistId, duration: s.duration, coverArt: s.coverArt, track: s.track,
      year: s.year, bitRate: s.bitRate, suffix: s.suffix, userRating: s.userRating,
    }));
    if (tracks[0]) playTrack(tracks[0], tracks);
  };

  const handleEnqueueAll = () => {
    if (!album) return;
    const tracks = album.songs.map(s => ({
      id: s.id, title: s.title, artist: s.artist, album: s.album,
      albumId: s.albumId, artistId: s.artistId, duration: s.duration, coverArt: s.coverArt, track: s.track,
      year: s.year, bitRate: s.bitRate, suffix: s.suffix, userRating: s.userRating,
    }));
    enqueue(tracks);
  };

  const handlePlaySong = (song: SubsonicSong) => {
    const track = {
      id: song.id, title: song.title, artist: song.artist, album: song.album,
      albumId: song.albumId, artistId: song.artistId, duration: song.duration, coverArt: song.coverArt,
      track: song.track, year: song.year, bitRate: song.bitRate,
      suffix: song.suffix, userRating: song.userRating
    };
    playTrack(track, [track]);
  };

  const handleRate = async (songId: string, rating: number) => {
    setRatings(r => ({ ...r, [songId]: rating }));
    await setRating(songId, rating);
  };

  const handleBio = async () => {
    if (!album) return;
    if (bio) { setBioOpen(true); return; }
    const info = await getArtistInfo(album.album.artistId);
    setBio(info.biography ?? t('albumDetail.noBio'));
    setBioOpen(true);
  };

  const handleDownload = async (albumName: string, albumId: string) => {
    setDownloadProgress(0);
    try {
      const url = buildDownloadUrl(albumId);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const contentLength = response.headers.get('Content-Length');
      const total = contentLength ? parseInt(contentLength, 10) : 0;
      const chunks: Uint8Array<ArrayBuffer>[] = [];

      if (total && response.body) {
        const reader = response.body.getReader();
        let received = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          setDownloadProgress(Math.round((received / total) * 100));
        }
      } else {
        const buffer = await response.arrayBuffer() as ArrayBuffer;
        chunks.push(new Uint8Array(buffer));
        setDownloadProgress(100);
      }

      const blob = new Blob(chunks);
      if (auth.downloadFolder) {
        const buffer = await blob.arrayBuffer();
        const path = await join(auth.downloadFolder, `${sanitizeFilename(albumName)}.zip`);
        await writeFile(path, new Uint8Array(buffer));
      } else {
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = `${sanitizeFilename(albumName)}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
      }
    } catch (e) {
      console.error('Download failed:', e);
      setDownloadProgress(null);
    } finally {
      // keep bar visible at 100% for 3 seconds so user sees completion
      setTimeout(() => setDownloadProgress(null), 60000);
    }
  };

  const toggleStar = async () => {
    if (!album) return;
    const currentlyStarred = isStarred;
    setIsStarred(!currentlyStarred);
    try {
      if (currentlyStarred) await unstar(album.album.id);
      else await star(album.album.id);
    } catch (e) {
      console.error('Failed to toggle star', e);
      setIsStarred(currentlyStarred);
    }
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

  // Hooks must be called unconditionally — derive from nullable album state
  const coverUrl = album?.album.coverArt ? buildCoverArtUrl(album.album.coverArt, 400) : '';
  const coverKey = album?.album.coverArt ? coverArtCacheKey(album.album.coverArt, 400) : '';
  const resolvedCoverUrl = useCachedUrl(coverUrl, coverKey);

  if (loading) return <div className="loading-center"><div className="spinner" /></div>;
  if (!album) return <div className="empty-state">{t('albumDetail.notFound')}</div>;

  const { album: info, songs } = album;
  const totalDuration = songs.reduce((acc, s) => acc + s.duration, 0);
  const hasVariousArtists = songs.some(s => s.artist !== info.artist);
  const totalSize = songs.reduce((acc, s) => acc + (s.size ?? 0), 0);

  return (
    <div className="album-detail animate-fade-in">
      {bioOpen && bio && <BioModal bio={bio} onClose={() => setBioOpen(false)} />}

      <div className="album-detail-header">
        {resolvedCoverUrl && (
          <div
            className="album-detail-bg"
            style={{ backgroundImage: `url(${resolvedCoverUrl})` }}
            aria-hidden="true"
          />
        )}
        <div className="album-detail-overlay" aria-hidden="true" />

        <div style={{ position: 'relative', zIndex: 1 }}>
          <button className="btn btn-ghost" onClick={() => navigate(-1)} style={{ marginBottom: '1rem', gap: '6px' }}>
            <ChevronLeft size={16} /> {t('albumDetail.back')}
          </button>
          <div className="album-detail-hero">
            {coverUrl ? (
              <CachedImage className="album-detail-cover" src={coverUrl} cacheKey={coverKey} alt={`${info.name} Cover`} />
            ) : (
              <div className="album-detail-cover album-cover-placeholder">♪</div>
            )}
            <div className="album-detail-meta">
              <span className="badge" style={{ marginBottom: '0.5rem' }}>{t('common.album')}</span>
              <h1 className="album-detail-title">{info.name}</h1>
              <p className="album-detail-artist">
                <button
                  className="album-detail-artist-link"
                  data-tooltip={t('albumDetail.goToArtist', { artist: info.artist })}
                  onClick={() => navigate(`/artist/${info.artistId}`)}
                >
                  {info.artist}
                </button>
              </p>
              <div className="album-detail-info">
                {info.year && <span>{info.year}</span>}
                {info.genre && <span>· {info.genre}</span>}
                <span>· {songs.length} Tracks</span>
                <span>· {formatDuration(totalDuration)}</span>
                {info.recordLabel && (
                  <>
                    <span style={{ margin: '0 4px' }}>·</span>
                    <button
                      className="album-detail-artist-link"
                      data-tooltip={t('albumDetail.moreLabelAlbums', { label: info.recordLabel })}
                      onClick={() => navigate(`/label/${encodeURIComponent(info.recordLabel!)}`)}
                    >
                      {info.recordLabel}
                    </button>
                  </>
                )}
              </div>
              <div className="album-detail-actions">
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <button className="btn btn-primary" id="album-play-all-btn" onClick={handlePlayAll}>
                    <Play size={16} fill="currentColor" /> {t('albumDetail.playAll')}
                  </button>
                  <button
                    className="btn btn-surface"
                    onClick={handleEnqueueAll}
                    data-tooltip={t('albumDetail.enqueueTooltip')}
                  >
                    <ListPlus size={16} /> {t('albumDetail.enqueue')}
                  </button>
                </div>

                <button
                  className="btn btn-ghost"
                  id="album-star-btn"
                  onClick={toggleStar}
                  data-tooltip={isStarred ? t('albumDetail.favoriteRemove') : t('albumDetail.favoriteAdd')}
                  style={{ color: isStarred ? 'var(--accent)' : 'inherit', border: isStarred ? '1px solid var(--accent)' : undefined }}
                >
                  <Star size={16} fill={isStarred ? "currentColor" : "none"} />
                  {t('albumDetail.favorite')}
                </button>

                <button className="btn btn-ghost" id="album-bio-btn" onClick={handleBio}>
                  <ExternalLink size={16} /> {t('albumDetail.artistBio')}
                </button>
                {downloadProgress !== null ? (
                  <div className="download-progress-wrap">
                    <Download size={14} />
                    <div className="download-progress-bar">
                      <div className="download-progress-fill" style={{ width: `${downloadProgress}%` }} />
                    </div>
                    <span className="download-progress-pct">{downloadProgress}%</span>
                  </div>
                ) : (
                  <button className="btn btn-ghost" id="album-download-btn" onClick={() => handleDownload(info.name, info.id)}>
                    <Download size={16} /> {t('albumDetail.download')}{totalSize > 0 ? ` · ${formatSize(totalSize)}` : ''}
                  </button>
                )}
                <span className="download-hint">
                  <Info size={12} />
                  {t('albumDetail.downloadHintShort')}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="tracklist">
        <div className={`tracklist-header${hasVariousArtists ? ' tracklist-va' : ''}`}>
          <div style={{ textAlign: 'center' }}>#</div>
          <div>{t('albumDetail.trackTitle')}</div>
          {hasVariousArtists && <div>{t('albumDetail.trackArtist')}</div>}
          <div>{t('albumDetail.trackFormat')}</div>
          <div style={{ textAlign: 'center' }}>{t('albumDetail.trackFavorite')}</div>
          <div>{t('albumDetail.trackRating')}</div>
          <div style={{ textAlign: 'right' }}>{t('albumDetail.trackDuration')}</div>
        </div>

        {(() => {
          const discs = new Map<number, SubsonicSong[]>();
          songs.forEach(song => {
            const disc = song.discNumber ?? 1;
            if (!discs.has(disc)) discs.set(disc, []);
            discs.get(disc)!.push(song);
          });
          const discNums = Array.from(discs.keys()).sort((a, b) => a - b);
          const isMultiDisc = discNums.length > 1;

          return discNums.map(discNum => (
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
                  className={`track-row${hasVariousArtists ? ' track-row-va' : ''}`}
                  onDoubleClick={() => handlePlaySong(song)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    const track = {
                      id: song.id, title: song.title, artist: song.artist, album: song.album,
                      albumId: song.albumId, artistId: song.artistId, duration: song.duration, coverArt: song.coverArt, track: song.track,
                      year: song.year, bitRate: song.bitRate, suffix: song.suffix, userRating: song.userRating,
                    };
                    openContextMenu(e.clientX, e.clientY, track, 'album-song');
                  }}
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
                  <div className="track-num" style={{ textAlign: 'center' }}>{song.track ?? i + 1}</div>
                  <div className="track-info">
                    <span className="track-title" data-tooltip={song.title}>{song.title}</span>
                  </div>
                  {hasVariousArtists && (
                    <div className="track-artist-cell">
                      <span className="track-artist">{song.artist}</span>
                    </div>
                  )}
                  <div className="track-meta" style={{ display: 'flex', alignItems: 'center' }}>
                    {(song.suffix || song.bitRate) && (
                      <span className="track-codec" style={{ marginTop: 0 }}>
                        {codecLabel(song)}
                        {song.size ? <span className="track-size"> · {formatSize(song.size)}</span> : null}
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <button
                      className="btn btn-ghost"
                      onClick={(e) => toggleSongStar(song, e)}
                      data-tooltip={starredSongs.has(song.id) ? t('albumDetail.favoriteRemove') : t('albumDetail.favoriteAdd')}
                      style={{ padding: '4px', height: 'auto', minHeight: 'unset', color: starredSongs.has(song.id) ? 'var(--accent)' : 'var(--text-muted)' }}
                    >
                      <Star size={14} fill={starredSongs.has(song.id) ? "currentColor" : "none"} />
                    </button>
                  </div>
                  <StarRating
                    value={ratings[song.id] ?? song.userRating ?? 0}
                    onChange={r => handleRate(song.id, r)}
                  />
                  <div className="track-duration" style={{ textAlign: 'right' }}>
                    {formatDuration(song.duration)}
                  </div>
                </div>
              ))}
            </div>
          ));
        })()}

        {/* Total row */}
        <div className={`tracklist-total${hasVariousArtists ? ' tracklist-va' : ''}`}>
          <span className="tracklist-total-label">{t('albumDetail.trackTotal')}</span>
          <span className="tracklist-total-value">{formatDuration(totalDuration)}</span>
        </div>
      </div>

      {relatedAlbums.length > 0 && (
        <div style={{ padding: '0 var(--space-6) var(--space-8)' }}>
          <div style={{ borderTop: '1px solid var(--border-subtle)', marginBottom: '2rem' }} />
          <h2 className="section-title" style={{ marginBottom: '1rem' }}>{t('albumDetail.moreByArtist', { artist: info.artist })}</h2>
          <div className="album-grid-wrap">
            {relatedAlbums.map(a => <AlbumCard key={a.id} album={a} />)}
          </div>
        </div>
      )}
    </div>
  );
}
