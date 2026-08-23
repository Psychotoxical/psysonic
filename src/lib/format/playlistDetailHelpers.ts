import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { formatHumanHoursMinutes } from '@/lib/format/formatHumanDuration';
import { formatMb } from '@/lib/format/formatBytes';

export function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .substring(0, 200) || 'download';
}

export function formatSize(bytes?: number): string {
  return bytes ? formatMb(bytes) : '';
}

export function totalDurationLabel(songs: SubsonicSong[]): string {
  const total = songs.reduce((acc, s) => acc + (s.duration ?? 0), 0);
  return formatHumanHoursMinutes(total);
}

export function codecLabel(song: SubsonicSong, showBitrate: boolean): string {
  const parts: string[] = [];
  if (song.suffix) parts.push(song.suffix.toUpperCase());
  if (showBitrate && song.bitRate) parts.push(`${song.bitRate} kbps`);
  return parts.join(' · ');
}
