import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const tryLoad = vi.hoisted(() => vi.fn());
vi.mock('@/lib/library/loadArtistDetailMultiScope', () => ({
  tryLoadArtistDetailMultiScope: tryLoad,
}));

import { useArtistAllTracks } from '@/features/artist/hooks/useArtistAllTracks';

const SCOPES = [{ serverId: 'srv-1', libraryId: null }];

function payload(songs: Array<Record<string, unknown>>) {
  return { artist: {}, albums: [], appearsOnAlbums: [], topSongs: songs, topTracksServerId: null, topTracksFingerprint: null };
}

interface Props {
  enabled: boolean;
  artistId: string;
  losslessOnly?: boolean;
}

function render(overrides: Partial<Props> = {}) {
  const initialProps: Props = {
    enabled: overrides.enabled ?? true,
    artistId: overrides.artistId ?? 'ar-1',
    losslessOnly: overrides.losslessOnly,
  };
  return renderHook(
    (props: Props) => useArtistAllTracks({
      scopes: SCOPES,
      serverId: 'srv-1',
      artistId: props.artistId,
      enabled: props.enabled,
      losslessOnly: props.losslessOnly,
    }),
    { initialProps },
  );
}

describe('useArtistAllTracks', () => {
  beforeEach(() => {
    tryLoad.mockReset().mockResolvedValue(payload([]));
  });

  // The artist page already pays for a five-track ranking on load. Fetching a
  // full discography for visitors who never open the tab would undo that.
  it('does not fetch until the tab is opened', () => {
    render({ enabled: false });
    expect(tryLoad).not.toHaveBeenCalled();
  });

  it('fetches without a top-tracks limit, which is what makes it the full list', async () => {
    render();
    await waitFor(() => expect(tryLoad).toHaveBeenCalledTimes(1));
    expect(tryLoad).toHaveBeenCalledWith(SCOPES, 'srv-1', 'ar-1', null);
  });

  // The loader ranks by play count for its other callers; a discography reads by
  // album instead, so the hook restores the order the query returned.
  it('orders the result by album, then track number, then title', async () => {
    tryLoad.mockResolvedValue(payload([
      { id: '3', album: 'Beta', track: 1, title: 'B1', playCount: 99 },
      { id: '1', album: 'Alpha', track: 2, title: 'A2', playCount: 1 },
      { id: '2', album: 'Alpha', track: 1, title: 'A1', playCount: 50 },
    ]));
    const { result } = render();
    await waitFor(() => expect(result.current.tracks).toHaveLength(3));
    expect(result.current.tracks.map(s => s.id)).toEqual(['2', '1', '3']);
  });

  it('sorts tracks without a number last within their album', async () => {
    tryLoad.mockResolvedValue(payload([
      { id: 'untracked', album: 'Alpha', title: 'Hidden' },
      { id: 'first', album: 'Alpha', track: 1, title: 'Opener' },
    ]));
    const { result } = render();
    await waitFor(() => expect(result.current.tracks).toHaveLength(2));
    expect(result.current.tracks.map(s => s.id)).toEqual(['first', 'untracked']);
  });

  it('reports a failed lookup instead of spinning forever', async () => {
    tryLoad.mockResolvedValue(null);
    const { result } = render();
    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(result.current.loading).toBe(false);
    expect(result.current.tracks).toEqual([]);
  });

  // A transient failure must not be remembered as "loaded", or the error would
  // stick until the user navigates to a different artist and back.
  it('retries after a failed load when the tab is reopened', async () => {
    tryLoad.mockResolvedValue(null);
    const { result, rerender } = render();
    await waitFor(() => expect(result.current.failed).toBe(true));

    tryLoad.mockResolvedValue(payload([{ id: 'ok', album: 'A', track: 1, title: 'Recovered' }]));
    rerender({ enabled: false, artistId: 'ar-1' });
    rerender({ enabled: true, artistId: 'ar-1' });

    await waitFor(() => expect(result.current.tracks.map(s => s.id)).toEqual(['ok']));
    expect(result.current.failed).toBe(false);
  });

  // Both discs of a double album restart at track 1, so track number alone
  // interleaves them.
  it('keeps a multi-disc album in disc order', async () => {
    tryLoad.mockResolvedValue(payload([
      { id: 'd2t1', album: 'Double', discNumber: 2, track: 1, title: 'Beta' },
      { id: 'd1t2', album: 'Double', discNumber: 1, track: 2, title: 'Zulu' },
      { id: 'd1t1', album: 'Double', discNumber: 1, track: 1, title: 'Alpha' },
    ]));
    const { result } = render();
    await waitFor(() => expect(result.current.tracks).toHaveLength(3));
    expect(result.current.tracks.map(s => s.id)).toEqual(['d1t1', 'd1t2', 'd2t1']);
  });

  // The tab sits next to one labelled "Lossless"; offering lossy tracks there
  // would hand the user exactly what the mode exists to hide, and playing one
  // would queue it.
  it('drops lossy tracks in lossless mode', async () => {
    tryLoad.mockResolvedValue(payload([
      { id: 'flac', album: 'A', track: 1, title: 'Keeper', suffix: 'flac' },
      { id: 'mp3', album: 'A', track: 2, title: 'Dropped', suffix: 'mp3' },
      { id: 'nosuffix', album: 'A', track: 3, title: 'Unknown' },
    ]));
    const { result } = render({ losslessOnly: true });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tracks.map(s => s.id)).toEqual(['flac']);
  });

  it('keeps every format when lossless mode is off', async () => {
    tryLoad.mockResolvedValue(payload([
      { id: 'flac', album: 'A', track: 1, title: 'One', suffix: 'flac' },
      { id: 'mp3', album: 'A', track: 2, title: 'Two', suffix: 'mp3' },
    ]));
    const { result } = render();
    await waitFor(() => expect(result.current.tracks).toHaveLength(2));
  });

  // The very first frame must not read as "nothing found" before the effect has
  // even started the request.
  it('reports loading on the first frame after the tab opens', () => {
    const { result } = render();
    expect(result.current.loading).toBe(true);
    expect(result.current.failed).toBe(false);
  });

  it('reports nothing pending while the tab is closed', () => {
    const { result } = render({ enabled: false });
    expect(result.current.loading).toBe(false);
  });

  // A failure on one artist must not strand another that had already loaded.
  it('still shows an artist that loaded before a different one failed', async () => {
    tryLoad.mockResolvedValue(payload([{ id: 'a1', album: 'A', track: 1, title: 'First' }]));
    const { result, rerender } = render();
    await waitFor(() => expect(result.current.tracks.map(s => s.id)).toEqual(['a1']));

    tryLoad.mockResolvedValue(null);
    rerender({ enabled: true, artistId: 'ar-2' });
    await waitFor(() => expect(result.current.failed).toBe(true));

    rerender({ enabled: true, artistId: 'ar-1' });
    await waitFor(() => expect(result.current.tracks.map(s => s.id)).toEqual(['a1']));
    expect(result.current.failed).toBe(false);
  });

  it('does not refetch when the tab is closed and reopened', async () => {
    const { rerender } = render();
    await waitFor(() => expect(tryLoad).toHaveBeenCalledTimes(1));
    rerender({ enabled: false, artistId: 'ar-1' });
    rerender({ enabled: true, artistId: 'ar-1' });
    await waitFor(() => expect(tryLoad).toHaveBeenCalledTimes(1));
  });

  // Without this the tab would briefly show the previous artist's discography
  // under the new artist's name.
  it('drops the previous artist tracks and refetches for a new one', async () => {
    tryLoad.mockResolvedValue(payload([{ id: 'old', album: 'A', track: 1, title: 'Old' }]));
    const { result, rerender } = render();
    await waitFor(() => expect(result.current.tracks).toHaveLength(1));

    tryLoad.mockResolvedValue(payload([{ id: 'new', album: 'B', track: 1, title: 'New' }]));
    rerender({ enabled: true, artistId: 'ar-2' });
    await waitFor(() => expect(result.current.tracks.map(s => s.id)).toEqual(['new']));
    expect(tryLoad).toHaveBeenCalledTimes(2);
    expect(tryLoad).toHaveBeenLastCalledWith(SCOPES, 'srv-1', 'ar-2', null);
  });
});
