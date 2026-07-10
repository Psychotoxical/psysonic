import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onInvoke } from '@/test/mocks/tauri';
import { useAuthStore } from '@/store/authStore';
import { useOfflineStore } from '@/features/offline';
import { lyricsCache } from '@/features/lyrics/hooks/useLyrics';
import { useLyrics } from '@/features/lyrics/hooks/useLyrics';
import type { Track } from '@/lib/media/trackTypes';

/**
 * The embedded path reads a local file's tags through Rust and never touches the
 * server. These tests pin the chain from that LRC string to the word lines the
 * pane renders — the part `parseEnhancedLrc` unit tests cannot see.
 */

const ENHANCED_LRC = '[00:12.00]<00:12.00>Hello <00:12.90>world\n[00:14.00]<00:14.00>bye';
const PLAIN_LRC = '[00:12.00]Hello world\n[00:14.00]bye';

const track = { id: 'track-1', title: 'Song', artist: 'Artist', album: 'Album', duration: 20 } as Track;

function mockLocalFile() {
  vi.spyOn(useOfflineStore, 'getState').mockReturnValue({
    getLocalUrl: () => 'psysonic-local://C:/music/song.flac',
  } as unknown as ReturnType<typeof useOfflineStore.getState>);
}

beforeEach(() => {
  lyricsCache.clear();
  vi.restoreAllMocks();
  // A source must be enabled or the hook treats lyrics as switched off entirely.
  useAuthStore.setState({
    activeServerId: 'srv-a',
    youLyPlusEnabled: false,
    lyricsSources: [
      { id: 'server', enabled: true },
      { id: 'lrclib', enabled: false },
      { id: 'netease', enabled: false },
    ],
  });
});

describe('useLyrics — embedded Enhanced LRC', () => {
  it('turns inline word markers into word lines and keeps the text clean', async () => {
    mockLocalFile();
    onInvoke('get_embedded_lyrics', () => ENHANCED_LRC);

    const { result } = renderHook(() => useLyrics(track));

    await waitFor(() => expect(result.current.source).toBe('embedded'));

    expect(result.current.syncedLines?.map(l => l.text)).toEqual(['Hello world', 'bye']);
    expect(result.current.wordLines?.map(l => l.words.map(w => w.text))).toEqual([
      ['Hello ', 'world'],
      ['bye'],
    ]);
    // The markers must not survive into anything the pane renders.
    expect(JSON.stringify(result.current.syncedLines)).not.toContain('<00:');
    expect(JSON.stringify(result.current.wordLines)).not.toContain('<00:');
  });

  it('leaves word lines empty for plain LRC so the pane falls back to line sync', async () => {
    mockLocalFile();
    onInvoke('get_embedded_lyrics', () => PLAIN_LRC);

    const { result } = renderHook(() => useLyrics(track));

    await waitFor(() => expect(result.current.source).toBe('embedded'));
    expect(result.current.syncedLines).toHaveLength(2);
    expect(result.current.wordLines).toBeNull();
  });
});
