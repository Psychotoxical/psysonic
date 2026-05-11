/**
 * Characterization tests for `previewStore`.
 *
 * Pattern demonstration: drives the store through its public action surface
 * with the real Zustand instance, and uses the `onInvoke` helper to stub the
 * Tauri commands the actions call. Aims to lock current behaviour before
 * playerStore-adjacent refactoring lands in Phase 2.
 *
 * Scope here is intentionally narrow — the internal `_on*` event handlers
 * plus `stopPreview`. `startPreview` adds dependencies on authStore /
 * orbitStore and is covered in its own follow-up suite once we settle on a
 * provider strategy for cross-store reads.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { usePreviewStore } from './previewStore';
import { onInvoke, invokeMock } from '@/test/mocks/tauri';

function resetStore() {
  usePreviewStore.setState({
    previewingId: null,
    previewingTrack: null,
    elapsed: 0,
    duration: 30,
    audioStarted: false,
  });
}

describe('previewStore — event handlers', () => {
  beforeEach(resetStore);

  describe('_onStart', () => {
    it('flips audioStarted to true when the id matches the active preview', () => {
      usePreviewStore.setState({
        previewingId: 'song-1',
        previewingTrack: { id: 'song-1', title: 't', artist: 'a' },
      });

      usePreviewStore.getState()._onStart('song-1');

      expect(usePreviewStore.getState().audioStarted).toBe(true);
      expect(usePreviewStore.getState().previewingId).toBe('song-1');
    });

    it('takes over the previewingId when the engine fires start for an unknown id', () => {
      usePreviewStore.setState({ previewingId: null });

      usePreviewStore.getState()._onStart('song-99');

      const state = usePreviewStore.getState();
      expect(state.previewingId).toBe('song-99');
      expect(state.elapsed).toBe(0);
      expect(state.audioStarted).toBe(true);
    });
  });

  describe('_onProgress', () => {
    it('updates elapsed + duration when the id matches', () => {
      usePreviewStore.setState({ previewingId: 'song-1' });

      usePreviewStore.getState()._onProgress('song-1', 12.5, 30);

      const state = usePreviewStore.getState();
      expect(state.elapsed).toBe(12.5);
      expect(state.duration).toBe(30);
    });

    it('ignores progress for a stale id', () => {
      usePreviewStore.setState({ previewingId: 'song-1', elapsed: 5 });

      usePreviewStore.getState()._onProgress('song-stale', 99, 30);

      expect(usePreviewStore.getState().elapsed).toBe(5);
    });
  });

  describe('_onEnd', () => {
    it('clears state when the id matches', () => {
      usePreviewStore.setState({
        previewingId: 'song-1',
        previewingTrack: { id: 'song-1', title: 't', artist: 'a' },
        elapsed: 27,
        audioStarted: true,
      });

      usePreviewStore.getState()._onEnd('song-1');

      const state = usePreviewStore.getState();
      expect(state.previewingId).toBeNull();
      expect(state.previewingTrack).toBeNull();
      expect(state.elapsed).toBe(0);
      expect(state.audioStarted).toBe(false);
    });

    it('ignores end events for a stale id', () => {
      usePreviewStore.setState({ previewingId: 'song-1', elapsed: 5, audioStarted: true });

      usePreviewStore.getState()._onEnd('song-stale');

      expect(usePreviewStore.getState().previewingId).toBe('song-1');
      expect(usePreviewStore.getState().audioStarted).toBe(true);
    });
  });
});

describe('previewStore — stopPreview', () => {
  beforeEach(resetStore);

  it('returns early without invoking when no preview is active', async () => {
    await usePreviewStore.getState().stopPreview();

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('invokes audio_preview_stop when a preview is active', async () => {
    usePreviewStore.setState({ previewingId: 'song-1' });
    onInvoke('audio_preview_stop', () => undefined);

    await usePreviewStore.getState().stopPreview();

    expect(invokeMock).toHaveBeenCalledWith('audio_preview_stop');
  });

  it('falls back to clearing state locally if invoke rejects', async () => {
    usePreviewStore.setState({
      previewingId: 'song-1',
      previewingTrack: { id: 'song-1', title: 't', artist: 'a' },
      audioStarted: true,
    });
    onInvoke('audio_preview_stop', () => {
      throw new Error('engine offline');
    });

    await usePreviewStore.getState().stopPreview();

    const state = usePreviewStore.getState();
    expect(state.previewingId).toBeNull();
    expect(state.previewingTrack).toBeNull();
    expect(state.audioStarted).toBe(false);
  });
});
