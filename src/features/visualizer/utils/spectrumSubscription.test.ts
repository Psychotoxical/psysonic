import { beforeEach, describe, expect, it, vi } from 'vitest';

const { setActiveMock } = vi.hoisted(() => ({ setActiveMock: vi.fn(async () => undefined) }));
vi.mock('@/lib/api/audio', () => ({ audioSpectrumSetActive: setActiveMock }));

import {
  _resetSpectrumFeedForTest,
  _spectrumFeedRefCountForTest,
  acquireSpectrumFeed,
  setSpectrumFeedParams,
} from './spectrumSubscription';

const R = 0.65;
/** Feed params at a given rate, with the default responsiveness. */
const at = (fps: number) => ({ fps, responsiveness: R });

/** The module serialises boundary calls through a promise chain. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('spectrumSubscription', () => {
  beforeEach(() => {
    setActiveMock.mockClear();
    _resetSpectrumFeedForTest();
  });

  it('tells Rust to start on the first watcher only', async () => {
    acquireSpectrumFeed(at(60));
    acquireSpectrumFeed(at(60));
    await settle();

    expect(setActiveMock).toHaveBeenCalledTimes(1);
    expect(setActiveMock).toHaveBeenCalledWith({ active: true, fps: 60, responsiveness: R });
    expect(_spectrumFeedRefCountForTest()).toBe(2);
  });

  it('tells Rust to stop only when the last watcher leaves', async () => {
    const a = acquireSpectrumFeed(at(60));
    const b = acquireSpectrumFeed(at(60));
    await settle();
    setActiveMock.mockClear();

    a();
    await settle();
    expect(setActiveMock).not.toHaveBeenCalled();

    b();
    await settle();
    expect(setActiveMock).toHaveBeenCalledWith({ active: false, fps: 60, responsiveness: R });
    expect(_spectrumFeedRefCountForTest()).toBe(0);
  });

  it('ignores a repeated release so a double cleanup cannot unbalance the count', async () => {
    const release = acquireSpectrumFeed(at(60));
    acquireSpectrumFeed(at(60));
    await settle();
    setActiveMock.mockClear();

    release();
    release();
    release();
    await settle();

    expect(_spectrumFeedRefCountForTest()).toBe(1);
    expect(setActiveMock).not.toHaveBeenCalled();
  });

  it('never drives the count below zero', async () => {
    const release = acquireSpectrumFeed(at(60));
    release();
    await settle();
    expect(_spectrumFeedRefCountForTest()).toBe(0);
  });

  it('restarts the feed cleanly after everyone has left', async () => {
    acquireSpectrumFeed(at(45))();
    await settle();
    setActiveMock.mockClear();

    acquireSpectrumFeed(at(45));
    await settle();
    expect(setActiveMock).toHaveBeenCalledWith({ active: true, fps: 45, responsiveness: R });
  });

  it('pushes a rate change to Rust without dropping the subscription', async () => {
    acquireSpectrumFeed(at(60));
    await settle();
    setActiveMock.mockClear();

    setSpectrumFeedParams(at(30));
    await settle();

    expect(setActiveMock).toHaveBeenCalledTimes(1);
    expect(setActiveMock).toHaveBeenCalledWith({ active: true, fps: 30, responsiveness: R });
    expect(_spectrumFeedRefCountForTest()).toBe(1);
  });

  it('ignores a rate change to the rate already in use', async () => {
    acquireSpectrumFeed(at(60));
    await settle();
    setActiveMock.mockClear();

    setSpectrumFeedParams(at(60));
    await settle();
    expect(setActiveMock).not.toHaveBeenCalled();
  });

  it('does not start the feed when the rate changes with no watchers', async () => {
    setSpectrumFeedParams(at(30));
    await settle();
    expect(setActiveMock).not.toHaveBeenCalled();
  });

  it('survives a rejected boundary call', async () => {
    setActiveMock.mockRejectedValueOnce(new Error('no tauri host'));
    const release = acquireSpectrumFeed(at(60));
    await settle();

    // The chain must stay usable — a failed start cannot wedge later calls.
    release();
    await settle();
    expect(setActiveMock).toHaveBeenLastCalledWith({ active: false, fps: 60, responsiveness: R });
  });
});
