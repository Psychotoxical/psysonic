import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibrarySyncIdlePayload } from '@/lib/api/library/dto';

const rebuildMock = vi.fn();
let idleHandler: ((payload: LibrarySyncIdlePayload) => void) | undefined;

vi.mock('@/generated/bindings', () => ({
  commands: {
    libraryClusterRebuild: (...args: unknown[]) => rebuildMock(...args),
  },
}));

vi.mock('@/lib/api/library/events', () => ({
  subscribeLibrarySyncIdle: vi.fn(async (handler: (payload: LibrarySyncIdlePayload) => void) => {
    idleHandler = handler;
    return () => {
      idleHandler = undefined;
    };
  }),
}));

vi.mock('@/lib/server/serverIndexKey', () => ({
  resolveIndexKey: (id: string) => `key:${id}`,
}));

import { initClusterRebuildOnSync } from './clusterRebuildOnSync';

function idlePayload(overrides: Partial<LibrarySyncIdlePayload> = {}): LibrarySyncIdlePayload {
  return {
    serverId: 'srv-1',
    libraryScope: 'default',
    kind: 'delta_sync',
    ok: true,
    error: null,
    ...overrides,
  };
}

describe('initClusterRebuildOnSync', () => {
  beforeEach(() => {
    rebuildMock.mockReset();
    rebuildMock.mockResolvedValue({ status: 'ok', data: 1 });
    idleHandler = undefined;
  });

  it('rebuilds cluster once on ok:true sync idle', async () => {
    const stop = initClusterRebuildOnSync();
    await Promise.resolve();

    idleHandler!(idlePayload());
    await vi.waitFor(() => expect(rebuildMock).toHaveBeenCalledOnce());

    expect(rebuildMock).toHaveBeenCalledWith('key:srv-1');
    stop();
  });

  it('does not rebuild on ok:false sync idle', async () => {
    const stop = initClusterRebuildOnSync();
    await Promise.resolve();

    idleHandler!(idlePayload({ ok: false, error: 'boom' }));
    await Promise.resolve();

    expect(rebuildMock).not.toHaveBeenCalled();
    stop();
  });

  it('dedupes concurrent rebuilds for the same server', async () => {
    let release!: () => void;
    rebuildMock.mockImplementation(
      () =>
        new Promise(resolve => {
          release = () => resolve({ status: 'ok', data: 1 });
        }),
    );

    const stop = initClusterRebuildOnSync();
    await Promise.resolve();

    idleHandler!(idlePayload());
    idleHandler!(idlePayload());
    idleHandler!(idlePayload());

    expect(rebuildMock).toHaveBeenCalledOnce();

    release();
    await vi.waitFor(() => expect(rebuildMock.mock.calls).toHaveLength(1));

    idleHandler!(idlePayload());
    await vi.waitFor(() => expect(rebuildMock).toHaveBeenCalledTimes(2));

    stop();
  });
});
