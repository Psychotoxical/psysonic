import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { passesMixMinRatings, type MixMinRatingsConfig } from '@/features/playback/utils/mixRatingFilter';

export const AUDIOBOOK_GENRES = [
  'hörbuch', 'hoerbuch', 'hörspiel', 'hoerspiel',
  'audiobook', 'audio book', 'spoken word', 'spokenword',
  'podcast', 'kapitel', 'krimi', 'speech',
  'comedy', 'literature',
];

export function formatRandomMixDuration(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

interface FilterArgs {
  excludeAudiobooks: boolean;
  customGenreBlacklist: string[];
  mixRatingCfg: MixMinRatingsConfig;
}

export function filterRandomMixSongs(songs: SubsonicSong[], args: FilterArgs): SubsonicSong[] {
  const { excludeAudiobooks, customGenreBlacklist, mixRatingCfg } = args;
  return songs.filter(song => {
    if (!passesMixMinRatings(song, mixRatingCfg)) return false;
    const matchesExcludedText = (text: string) => {
      const t = text.toLowerCase();
      if (excludeAudiobooks && AUDIOBOOK_GENRES.some(ag => t.includes(ag))) return true;
      if (customGenreBlacklist.some(bg => t.includes(bg.toLowerCase()))) return true;
      return false;
    };
    if (song.genre && matchesExcludedText(song.genre)) return false;
    if (song.title && matchesExcludedText(song.title)) return false;
    if (song.album && matchesExcludedText(song.album)) return false;
    if (song.artist && matchesExcludedText(song.artist)) return false;
    return true;
  });
}
