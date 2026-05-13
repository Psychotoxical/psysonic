import type { TFunction } from 'i18next';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { search } from '../api/subsonicSearch';
import type { SubsonicSong } from '../api/subsonicTypes';
import { showToast } from './toast';
import { parseSpotifyCsv, type SpotifyCsvTrack } from './spotifyCsvImport';
import {
  cleanTrackTitle,
  similarityScore,
  calculateDynamicThreshold,
  processBatch,
} from './spotifyCsvMatch';

export interface CsvImportReport {
  added: number;
  notFound: SpotifyCsvTrack[];
  duplicates: number;
  duplicateTracks: SpotifyCsvTrack[];
  total: number;
  searchErrors?: SpotifyCsvTrack[];
}

export interface RunPlaylistCsvImportDeps {
  songs: SubsonicSong[];
  t: TFunction;
  savePlaylist: (updatedSongs: SubsonicSong[], prevCount?: number) => Promise<void>;
  setSongs: (next: SubsonicSong[]) => void;
  setCsvImporting: (v: boolean) => void;
  setCsvImportReport: (r: CsvImportReport | null) => void;
}

export async function runPlaylistCsvImport(deps: RunPlaylistCsvImportDeps): Promise<void> {
  const { songs, t, savePlaylist, setSongs, setCsvImporting, setCsvImportReport } = deps;

  try {
    const selected = await openDialog({
      filters: [{ name: 'CSV Files', extensions: ['csv'] }],
      multiple: false,
      title: 'Import Spotify Playlist CSV',
    });

    if (!selected || typeof selected !== 'string') return;

    setCsvImporting(true);
    const content = await readTextFile(selected);
    const csvTracks = parseSpotifyCsv(content);

    if (csvTracks.length === 0) {
      showToast(t('playlists.csvImportNoValidTracks'), 3000, 'error');
      setCsvImporting(false);
      return;
    }

    const existingIds = new Set(songs.map(s => s.id));
    const addedSongs: SubsonicSong[] = [];
    const notFound: SpotifyCsvTrack[] = [];
    const searchErrors: SpotifyCsvTrack[] = [];
    const duplicateTracks: SpotifyCsvTrack[] = [];
    let duplicateCount = 0;

    // Process in batches of 10 to balance speed/server load
    await processBatch(csvTracks, 10, async (track) => {
      try {
        // Retry: 2 attempts in case of network error
        let searchResult;
        let attempts = 0;
        const maxAttempts = 2;

        // Clean title before search to find matches despite version suffixes
        const cleanTitleForSearch = cleanTrackTitle(track.trackName);

        while (attempts < maxAttempts) {
          try {
            searchResult = await search(cleanTitleForSearch, { songCount: 40, artistCount: 0, albumCount: 0 });
            break;
          } catch (err) {
            attempts++;
            if (attempts >= maxAttempts) throw err;
            // Wait 500ms before retrying
            await new Promise(r => setTimeout(r, 500));
          }
        }

        if (!searchResult || searchResult.songs.length === 0) {
          notFound.push({
            ...track,
            score: 0,
            thresholdNeeded: 0.6, // Minimum threshold, nothing to compare
          });
          return null;
        }

        // Confidence scoring for each result
        // Clean CSV title for fair comparison
        const cleanCsvTitle = cleanTrackTitle(track.trackName);

        const scoredMatches = searchResult.songs.map(s => {
          // Fast ISRC path: if both have ISRC and they match, perfect score
          if (track.isrc && s.isrc && typeof s.isrc === 'string' && track.isrc.toUpperCase() === s.isrc.toUpperCase()) {
            return { song: s, score: 1.0, titleScore: 1.0, artistScore: 1.0, isrcMatch: true };
          }

          // Clean the result title as well
          const cleanResultTitle = cleanTrackTitle(s.title);

          const titleScore = similarityScore(cleanResultTitle, cleanCsvTitle);
          // Artist scoring: maximum score against any of the CSV artists
          const artistScore = s.artist
            ? Math.max(...track.artistNames.map(csvArtist =>
                similarityScore(s.artist || '', csvArtist)
              ))
            : 0;
          // If no album in CSV or local, use 1.0 (neutral) to avoid penalizing
          const albumScore = (s.album && track.albumName)
            ? similarityScore(s.album, track.albumName)
            : 1.0;

          // Dynamic weight: specific titles (>4 words) → more weight to title
          const titleWords = cleanCsvTitle.split(/\s+/).length;
          const isSpecificTitle = titleWords > 4;
          const titleWeight = isSpecificTitle ? 0.55 : 0.4;
          const artistWeight = isSpecificTitle ? 0.25 : 0.4;

          const totalScore = artistScore * artistWeight + titleScore * titleWeight + albumScore * 0.2;

          return { song: s, score: totalScore, titleScore, artistScore, albumScore, isrcMatch: false };
        }).sort((a, b) => b.score - a.score);

        // Use dynamic threshold based on match quality signals
        const bestMatch = scoredMatches[0];
        const secondMatch = scoredMatches[1];
        const titleWords = cleanCsvTitle.split(/\s+/).length;

        const threshold = calculateDynamicThreshold(bestMatch, secondMatch, titleWords);

        if (bestMatch.score < threshold) {
          notFound.push({
            ...track,
            score: bestMatch.score,
            thresholdNeeded: threshold,
          });
          return null;
        }

        // Check for duplicates
        if (existingIds.has(bestMatch.song.id)) {
          duplicateCount++;
          duplicateTracks.push(track);
          return null;
        }

        // Check for duplicates in tracks already queued for addition
        if (addedSongs.some(s => s.id === bestMatch.song.id)) {
          duplicateCount++;
          duplicateTracks.push(track);
          return null;
        }

        addedSongs.push(bestMatch.song);
        existingIds.add(bestMatch.song.id);
        return bestMatch.song;
      } catch {
        searchErrors.push(track);
        return null;
      }
    });

    if (addedSongs.length > 0) {
      const next = [...songs, ...addedSongs];
      setSongs(next);
      await savePlaylist(next);
    }

    // Auto-show report if there are not found tracks, duplicates, or search errors
    if (notFound.length > 0 || duplicateCount > 0 || searchErrors.length > 0) {
      // Small delay to let the toast appear first
      setTimeout(() => {
        setCsvImportReport({
          added: addedSongs.length,
          notFound,
          duplicates: duplicateCount,
          duplicateTracks,
          total: csvTracks.length,
          searchErrors,
        });
      }, 500);
    }

    const errorMsg = searchErrors.length > 0
      ? ` (${searchErrors.length} network errors - may retry)`
      : '';

    // Determine toast type based on results:
    // - success: all songs were added successfully
    // - warning: at least one added, but some not found/duplicates
    // - error: none added (all duplicates or not found)
    const hasAdded = addedSongs.length > 0;
    const hasIssues = notFound.length > 0 || duplicateCount > 0 || searchErrors.length > 0;

    let toastVariant: 'success' | 'warning' | 'error';
    if (hasAdded && !hasIssues) {
      toastVariant = 'success';
    } else if (hasAdded && hasIssues) {
      toastVariant = 'warning';
    } else {
      toastVariant = 'error';
    }

    showToast(
      t('playlists.csvImportToast', { added: addedSongs.length, notFound: notFound.length, duplicates: duplicateCount }) + errorMsg,
      5000,
      toastVariant
    );
  } catch (err) {
    console.error('CSV import failed:', err);
    showToast(t('playlists.csvImportFailed'), 3000, 'error');
  } finally {
    setCsvImporting(false);
  }
}
