import type React from 'react';
import type { TFunction } from 'i18next';
import { uploadArtistImage } from '../../api/subsonicPlaylists';
import { setRating, star, unstar } from '../../api/subsonicStarRating';
import type { SubsonicArtist } from '../../api/subsonicTypes';
import { useAuthStore } from '../../store/authStore';
import { copyEntityShareLink } from '../share/copyEntityShareLink';
import { invalidateCoverArt } from '../imageCache';
import { showToast } from '../ui/toast';

export interface RunArtistEntityRatingDeps {
  artist: SubsonicArtist | null;
  id: string | undefined;
  rating: number;
  artistEntityRatingSupport: string;
  activeServerId: string;
  t: TFunction;
  setArtistEntityRating: (v: number) => void;
  setArtist: React.Dispatch<React.SetStateAction<SubsonicArtist | null>>;
}

export async function runArtistEntityRating(deps: RunArtistEntityRatingDeps): Promise<void> {
  const { artist, id, rating, artistEntityRatingSupport, activeServerId, t, setArtistEntityRating, setArtist } = deps;
  if (!artist || artist.id !== id) return;
  const artistId = artist.id;
  const ratingAtStart = artist.userRating ?? 0;

  setArtistEntityRating(rating);

  if (artistEntityRatingSupport !== 'full') return;

  try {
    await setRating(artistId, rating);
    setArtist(a => (a && a.id === artistId ? { ...a, userRating: rating } : a));
  } catch (err) {
    setArtistEntityRating(ratingAtStart);
    useAuthStore.getState().setEntityRatingSupport(activeServerId, 'track_only');
    showToast(
      typeof err === 'string' ? err : err instanceof Error ? err.message : t('entityRating.saveFailed'),
      4500,
      'error',
    );
  }
}

export interface RunArtistToggleStarDeps {
  artist: SubsonicArtist | null;
  isStarred: boolean;
  setIsStarred: React.Dispatch<React.SetStateAction<boolean>>;
}

export async function runArtistToggleStar(deps: RunArtistToggleStarDeps): Promise<void> {
  const { artist, isStarred, setIsStarred } = deps;
  if (!artist) return;
  const currentlyStarred = isStarred;
  setIsStarred(!currentlyStarred);
  try {
    if (currentlyStarred) await unstar(artist.id, 'artist');
    else await star(artist.id, 'artist');
  } catch (e) {
    console.error('Failed to toggle star', e);
    setIsStarred(currentlyStarred);
  }
}

export interface RunArtistShareDeps {
  artist: SubsonicArtist;
  t: TFunction;
}

export async function runArtistShare(deps: RunArtistShareDeps): Promise<void> {
  const { artist, t } = deps;
  try {
    const ok = await copyEntityShareLink('artist', artist.id);
    if (ok) showToast(t('contextMenu.shareCopied'));
    else showToast(t('contextMenu.shareCopyFailed'), 4000, 'error');
  } catch {
    showToast(t('contextMenu.shareCopyFailed'), 4000, 'error');
  }
}

export interface RunArtistImageUploadDeps {
  e: React.ChangeEvent<HTMLInputElement>;
  artist: SubsonicArtist | null;
  t: TFunction;
  setUploading: (v: boolean) => void;
  setCoverRevision: React.Dispatch<React.SetStateAction<number>>;
}

export async function runArtistImageUpload(deps: RunArtistImageUploadDeps): Promise<void> {
  const { e, artist, t, setUploading, setCoverRevision } = deps;
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file || !artist) return;
  setUploading(true);
  try {
    await uploadArtistImage(artist.id, file);
    const coverId = artist.coverArt || artist.id;
    await invalidateCoverArt(coverId);
    // Also invalidate with bare artist.id in case coverArt differs
    if (artist.coverArt && artist.coverArt !== artist.id) {
      await invalidateCoverArt(artist.id);
    }
    setCoverRevision(r => r + 1);
    showToast(t('artistDetail.uploadImage'));
  } catch (err) {
    showToast(
      typeof err === 'string' ? err : err instanceof Error ? err.message : t('artistDetail.uploadImageError'),
      4000,
      'error',
    );
  } finally {
    setUploading(false);
  }
}
