import { describe, expect, it, beforeEach } from 'vitest';
import { onInvoke } from '@/test/mocks/tauri';
import { useAuthStore } from '@/store/authStore';
import { beginAlbumBrowseTrace, emitAlbumBrowseDebug } from './albumBrowseDebug';

describe('albumBrowseDebug', () => {
  beforeEach(() => {
    useAuthStore.setState({ loggingMode: 'normal' });
  });

  it('forwards JSON to frontend_debug_log in debug mode', () => {
    useAuthStore.setState({ loggingMode: 'debug' });
    let captured: unknown;
    onInvoke('frontend_debug_log', args => {
      captured = args;
      return undefined;
    });
    beginAlbumBrowseTrace({ serverId: 'srv' });
    emitAlbumBrowseDebug('catalog_chunk_done', { albums: 200 });
    expect(captured).toEqual({
      scope: 'albums-browse',
      message: expect.stringContaining('"step":"catalog_chunk_done"'),
    });
  });

  it('is a no-op when logging mode is not debug', () => {
    let invoked = false;
    onInvoke('frontend_debug_log', () => {
      invoked = true;
      return undefined;
    });
    emitAlbumBrowseDebug('page_mount');
    expect(invoked).toBe(false);
  });
});
