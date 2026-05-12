import { beforeEach, describe, expect, it, vi } from 'vitest';

const { touchPlayedMock } = vi.hoisted(() => ({
  touchPlayedMock: vi.fn(),
}));

vi.mock('./hotCacheStore', () => ({
  useHotCacheStore: { getState: () => ({ touchPlayed: touchPlayedMock }) },
}));

import { touchHotCacheOnPlayback } from './hotCacheTouch';

beforeEach(() => {
  touchPlayedMock.mockClear();
});

describe('touchHotCacheOnPlayback', () => {
  it('forwards a populated id pair to the hot-cache store', () => {
    touchHotCacheOnPlayback('t1', 'srv');
    expect(touchPlayedMock).toHaveBeenCalledWith('t1', 'srv');
  });

  it('skips when the trackId is empty', () => {
    touchHotCacheOnPlayback('', 'srv');
    expect(touchPlayedMock).not.toHaveBeenCalled();
  });

  it('skips when the serverId is empty', () => {
    touchHotCacheOnPlayback('t1', '');
    expect(touchPlayedMock).not.toHaveBeenCalled();
  });
});
