import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const player = {
    volume: 0.5,
    setVolume: vi.fn((v: number) => {
      player.volume = v;
    }),
  };
  return { player };
});

vi.mock('@/features/playback/store/playerStore', () => ({
  usePlayerStore: { getState: () => hoisted.player },
}));

import { executeCliPlayerCommand } from '@/config/shortcutDispatch';

const navigate = vi.fn();

beforeEach(() => {
  hoisted.player.volume = 0.5;
  hoisted.player.setVolume.mockClear();
  navigate.mockClear();
});

describe('executeCliPlayerCommand volume-relative', () => {
  it('raises volume by delta percent and clamps at 1', () => {
    executeCliPlayerCommand({
      payload: { command: 'volume-relative', deltaPercent: 10 },
      navigate,
    });
    expect(hoisted.player.setVolume).toHaveBeenCalledWith(0.6);
  });

  it('lowers volume by delta percent and clamps at 0', () => {
    hoisted.player.volume = 0.03;
    executeCliPlayerCommand({
      payload: { command: 'volume-relative', deltaPercent: -10 },
      navigate,
    });
    expect(hoisted.player.setVolume).toHaveBeenCalledWith(0);
  });
});

describe('executeCliPlayerCommand set-volume', () => {
  it('sets absolute percent', () => {
    executeCliPlayerCommand({
      payload: { command: 'set-volume', percent: 40 },
      navigate,
    });
    expect(hoisted.player.setVolume).toHaveBeenCalledWith(0.4);
  });
});
