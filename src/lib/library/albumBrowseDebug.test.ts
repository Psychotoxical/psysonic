import { describe, expect, it, beforeEach } from 'vitest';
import { onInvoke } from '@/test/mocks/tauri';
import { useAuthStore } from '@/store/authStore';
import { setPsyLabDebugTrace } from '@/lib/perf/psyLabDebugTraces';
import { beginAlbumBrowseTrace, emitAlbumBrowseDebug } from './albumBrowseDebug';

describe('albumBrowseDebug', () => {
  beforeEach(() => {
    useAuthStore.setState({ loggingMode: 'normal' });
    onInvoke('set_psylab_albums_browse_trace', () => undefined);
    setPsyLabDebugTrace('albumsBrowse', false);
  });

  it('forwards JSON to frontend_debug_log when debug mode and PsyLab trace are on', () => {
    useAuthStore.setState({ loggingMode: 'debug' });
    setPsyLabDebugTrace('albumsBrowse', true);
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
    setPsyLabDebugTrace('albumsBrowse', true);
    let invoked = false;
    onInvoke('frontend_debug_log', () => {
      invoked = true;
      return undefined;
    });
    emitAlbumBrowseDebug('page_mount');
    expect(invoked).toBe(false);
  });

  it('is a no-op when PsyLab albums browse trace is off', () => {
    useAuthStore.setState({ loggingMode: 'debug' });
    let invoked = false;
    onInvoke('frontend_debug_log', () => {
      invoked = true;
      return undefined;
    });
    emitAlbumBrowseDebug('page_mount');
    expect(invoked).toBe(false);
  });
});
