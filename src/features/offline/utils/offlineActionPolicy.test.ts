import { describe, expect, it } from 'vitest';
import { offlineActionPolicy } from '@/features/offline/utils/offlineActionPolicy';

describe('offlineActionPolicy', () => {
  it('allows all mutations when offline browse is inactive', () => {
    const p = offlineActionPolicy('albumDetail', false);
    expect(p.canFavorite).toBe(true);
    expect(p.canDownload).toBe(true);
    expect(p.canPinOffline).toBe(true);
    expect(p.canAddToPlaylist).toBe(true);
  });

  it('blocks server mutations when offline browse is active', () => {
    const p = offlineActionPolicy('albumDetail', true);
    expect(p.canFavorite).toBe(false);
    expect(p.canRate).toBe(false);
    expect(p.canDownload).toBe(false);
    expect(p.canPinOffline).toBe(false);
    expect(p.canAddToPlaylist).toBe(false);
    expect(p.canShowBio).toBe(false);
  });

  it('applies same read-only policy to context menu surfaces', () => {
    expect(offlineActionPolicy('contextMenuAlbum', true).canFavorite).toBe(false);
    expect(offlineActionPolicy('contextMenuSong', true).canAddToPlaylist).toBe(false);
  });

  it('blocks rating and favorite in player bar when offline browse is active', () => {
    const p = offlineActionPolicy('playerBar', true);
    expect(p.canRate).toBe(false);
    expect(p.canFavorite).toBe(false);
  });
});
