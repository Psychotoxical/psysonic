import { Star } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { Track } from '../store/playerStoreTypes';

export type DurationMode = 'total' | 'remaining' | 'eta';

export function formatTime(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function formatQueueReplayGainParts(track: Track, t: TFunction): string[] {
  const parts: string[] = [];
  const fmtDb = (db: number) => `${db >= 0 ? '+' : ''}${db.toFixed(1)}`;
  if (track.replayGainTrackDb != null) {
    parts.push(t('queue.rgTrack', { db: fmtDb(track.replayGainTrackDb) }));
  }
  if (track.replayGainAlbumDb != null) {
    parts.push(t('queue.rgAlbum', { db: fmtDb(track.replayGainAlbumDb) }));
  }
  if (track.replayGainPeak != null) {
    parts.push(t('queue.rgPeak', { pk: track.replayGainPeak.toFixed(3) }));
  }
  return parts;
}

export function renderStars(rating?: number) {
  if (!rating) return null;
  const stars = [];
  for (let i = 1; i <= 5; i++) {
    stars.push(
      <Star
        key={i}
        size={12}
        fill={i <= rating ? 'var(--ctp-yellow)' : 'none'}
        color={i <= rating ? 'var(--ctp-yellow)' : 'var(--text-muted)'}
      />
    );
  }
  return <div style={{ display: 'flex', gap: '2px', alignItems: 'center' }}>{stars}</div>;
}
