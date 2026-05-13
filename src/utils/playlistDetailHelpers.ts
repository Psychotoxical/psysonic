import type { SubsonicSong } from '../api/subsonicTypes';
import { formatHumanHoursMinutes } from './formatHumanDuration';

export function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .substring(0, 200) || 'download';
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatSize(bytes?: number): string {
  if (!bytes) return '';
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function totalDurationLabel(songs: SubsonicSong[]): string {
  const total = songs.reduce((acc, s) => acc + (s.duration ?? 0), 0);
  return formatHumanHoursMinutes(total);
}

export const SMART_PREFIX = 'psy-smart-';

export function isSmartPlaylistName(name: string): boolean {
  return (name ?? '').toLowerCase().startsWith(SMART_PREFIX);
}

export function displayPlaylistName(name: string): string {
  const n = name ?? '';
  if (isSmartPlaylistName(n)) return n.slice(SMART_PREFIX.length);
  return n;
}

export function codecLabel(song: SubsonicSong, showBitrate: boolean): string {
  const parts: string[] = [];
  if (song.suffix) parts.push(song.suffix.toUpperCase());
  if (showBitrate && song.bitRate) parts.push(`${song.bitRate} kbps`);
  return parts.join(' · ');
}
