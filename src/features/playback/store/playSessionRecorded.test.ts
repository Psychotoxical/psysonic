import { describe, expect, it, vi } from 'vitest';
import { emitPlaySessionRecorded, onPlaySessionRecorded } from '@/features/playback/store/playSessionRecorded';

describe('playSessionRecorded', () => {
  it('notifies subscribers when a listen is persisted', () => {
    const listener = vi.fn();
    const unsub = onPlaySessionRecorded(listener);
    const detail = { serverId: 's1', trackId: 't1', startedAtMs: 123 };
    emitPlaySessionRecorded(detail);
    expect(listener).toHaveBeenCalledWith(detail);
    unsub();
    listener.mockClear();
    emitPlaySessionRecorded(detail);
    expect(listener).not.toHaveBeenCalled();
  });
});
