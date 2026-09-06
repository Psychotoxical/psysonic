import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const player = {
    volume: 0.5,
    currentTrack: null as { id: string; serverId?: string } | null,
    setVolume: vi.fn((v: number) => {
      player.volume = v;
    }),
  };
  return { player, queueSongRating: vi.fn(), queueSongStar: vi.fn() };
});

vi.mock('@/features/playback/store/playerStore', () => ({
  usePlayerStore: { getState: () => hoisted.player },
}));
vi.mock('@/features/playback/store/pendingStarSync', () => ({
  queueSongRating: hoisted.queueSongRating,
  queueSongStar: hoisted.queueSongStar,
}));

import {
  DEFAULT_GLOBAL_SHORTCUTS,
  GLOBAL_SHORTCUT_ACTIONS,
  executeCliPlayerCommand,
  executeRuntimeAction,
  type GlobalAction,
} from '@/config/shortcutActions';

const navigate = vi.fn();

beforeEach(() => {
  hoisted.player.volume = 0.5;
  hoisted.player.currentTrack = null;
  hoisted.player.setVolume.mockClear();
  hoisted.queueSongRating.mockClear();
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

describe('executeCliPlayerCommand set-rating-current', () => {
  it('routes the rating to the current track owner', () => {
    hoisted.player.currentTrack = { id: 'shared', serverId: 'srv-b' };

    executeCliPlayerCommand({
      payload: { command: 'set-rating-current', stars: 4 },
      navigate,
    });

    expect(hoisted.queueSongRating).toHaveBeenCalledWith('shared', 4, 'srv-b');
  });
});

const CURRENT_TRACK_RATING_ACTIONS = [1, 2, 3, 4, 5].map(
  rating => [`rate-current-track-${rating}` as GlobalAction, rating] as const,
);

describe('current track rating shortcut actions', () => {
  it.each(CURRENT_TRACK_RATING_ACTIONS)('routes %s to the current track owner', (action, rating) => {
    hoisted.player.currentTrack = { id: 'shared', serverId: 'srv-b' };

    executeRuntimeAction(action, { navigate, previewPolicy: 'ignore' });

    expect(hoisted.queueSongRating).toHaveBeenCalledWith('shared', rating, 'srv-b');
  });

  it('exposes every rating as an unbound global shortcut', () => {
    const ratingActions = GLOBAL_SHORTCUT_ACTIONS
      .filter(({ id }) => id.startsWith('rate-current-track-'))
      .map(({ id, defaultBinding }) => [id, defaultBinding]);

    expect(ratingActions).toEqual(CURRENT_TRACK_RATING_ACTIONS.map(([id]) => [id, null]));
    for (const [id] of CURRENT_TRACK_RATING_ACTIONS) {
      expect(DEFAULT_GLOBAL_SHORTCUTS).not.toHaveProperty(id);
    }
  });
});
