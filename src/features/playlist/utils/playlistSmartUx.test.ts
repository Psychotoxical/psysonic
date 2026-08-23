import { describe, expect, it } from 'vitest';
import { playlistDetailControls, playlistTracksAreReadOnly } from './playlistSmartUx';

describe('playlist smart UX policy', () => {
  it('treats native and legacy-prefix smart playlists as read-only track sources', () => {
    expect(playlistTracksAreReadOnly({ name: 'Feishin mix', smart: true })).toBe(true);
    expect(playlistTracksAreReadOnly({ name: 'psy-smart-Legacy' })).toBe(true);
    expect(playlistTracksAreReadOnly({ name: 'psy-smart-Regular', smart: false })).toBe(false);
    expect(playlistTracksAreReadOnly({ name: 'Manual mix' })).toBe(false);
  });

  it('hides membership mutations while keeping metadata and cache-removal eligible', () => {
    expect(playlistDetailControls({ name: 'Native', smart: true })).toEqual({
      tracksReadOnly: true,
      showEditRules: true,
      showRefreshTracks: true,
      canAddTracks: false,
      canImportCsv: false,
      canReorderTracks: false,
      canRemoveTracks: false,
      canPinNewOfflineCache: false,
    });
    expect(playlistDetailControls({ name: 'Manual mix' }).canAddTracks).toBe(true);
    expect(playlistDetailControls({ name: 'Manual mix' }).showRefreshTracks).toBe(false);
  });
});
