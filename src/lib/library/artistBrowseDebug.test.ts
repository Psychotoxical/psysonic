import { describe, expect, it, beforeEach } from 'vitest';
import { onInvoke } from '@/test/mocks/tauri';
import { useAuthStore } from '@/store/authStore';
import { setPsyLabDebugTrace } from '@/lib/perf/psyLabDebugTraces';
import { beginArtistsBrowseTrace, emitArtistsBrowseDebug } from './artistBrowseDebug';

describe('artistBrowseDebug', () => {
  beforeEach(() => {
    useAuthStore.setState({ loggingMode: 'normal' });
    onInvoke('set_psylab_artists_browse_trace', () => undefined);
    setPsyLabDebugTrace('artistsBrowse', false);
  });

  it('forwards JSON to frontend_debug_log when debug mode and PsyLab trace are on', () => {
    useAuthStore.setState({ loggingMode: 'debug' });
    setPsyLabDebugTrace('artistsBrowse', true);
    let captured: unknown;
    onInvoke('frontend_debug_log', args => {
      captured = args;
      return undefined;
    });
    beginArtistsBrowseTrace({ serverId: 'srv' });
    emitArtistsBrowseDebug('catalog_chunk_done', { artists: 200 });
    expect(captured).toEqual({
      scope: 'artists-browse',
      message: expect.stringContaining('"step":"catalog_chunk_done"'),
    });
  });

  it('is a no-op when logging mode is not debug', () => {
    setPsyLabDebugTrace('artistsBrowse', true);
    let invoked = false;
    onInvoke('frontend_debug_log', () => {
      invoked = true;
      return undefined;
    });
    emitArtistsBrowseDebug('page_mount');
    expect(invoked).toBe(false);
  });

  it('is a no-op when PsyLab artists browse trace is off', () => {
    useAuthStore.setState({ loggingMode: 'debug' });
    let invoked = false;
    onInvoke('frontend_debug_log', () => {
      invoked = true;
      return undefined;
    });
    emitArtistsBrowseDebug('page_mount');
    expect(invoked).toBe(false);
  });
});
