import type { SubsonicSong } from '../../api/subsonicTypes';
import { passesMixMinRatings, type MixMinRatingsConfig } from '../mix/mixRatingFilter';

export const AUDIOBOOK_GENRES = [
  'hörbuch', 'hoerbuch', 'hörspiel', 'hoerspiel',
  'audiobook', 'audio book', 'spoken word', 'spokenword',
  'podcast', 'kapitel', 'thriller', 'krimi', 'speech',
  'fantasy', 'comedy', 'literature',
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
    return true;
  });
}
