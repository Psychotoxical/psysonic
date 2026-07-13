import { describe, expect, it, beforeEach } from 'vitest';
import {
  DEFAULT_PLAYER_BAR_LAYOUT_ITEMS,
  DEFAULT_PLAYER_BAR_TRACK_INFO_MODE,
  PLAYER_BAR_LAYOUT_ZONES,
  usePlayerBarLayoutStore,
  type PlayerBarLayoutItemConfig,
} from '@/features/playback/store/playerBarLayoutStore';

type State = ReturnType<typeof usePlayerBarLayoutStore.getState>;

/**
 * Drives the persist middleware's rehydrate hook against a stored snapshot.
 * That hook is the risky path: a layout persisted by an older version knows
 * nothing about items added later, and a corrupted entry must not be able to
 * drop a button or leave the track-info picker on an unrenderable value.
 */
function rehydrate(stored: Partial<Record<'items' | 'trackInfoMode', unknown>>): State {
  const state = { ...usePlayerBarLayoutStore.getState(), ...stored } as State;
  usePlayerBarLayoutStore.persist.getOptions().onRehydrateStorage?.(state)?.(state, undefined);
  return state;
}

const ids = (items: PlayerBarLayoutItemConfig[]) => items.map(i => i.id);

describe('playerBarLayoutStore', () => {
  beforeEach(() => {
    usePlayerBarLayoutStore.getState().reset();
  });

  it('starts with every item visible in declared order', () => {
    const items = usePlayerBarLayoutStore.getState().items;
    expect(ids(items)).toEqual([
      'stop', 'starRating', 'favorite', 'lastfmLove', 'playbackRate', 'equalizer', 'miniPlayer',
    ]);
    expect(items.every(i => i.visible)).toBe(true);
    expect(usePlayerBarLayoutStore.getState().trackInfoMode).toBe(DEFAULT_PLAYER_BAR_TRACK_INFO_MODE);
  });

  it('places stop in the transport zone and the rest in actions', () => {
    expect(PLAYER_BAR_LAYOUT_ZONES.stop).toBe('transport');
    expect(ids(DEFAULT_PLAYER_BAR_LAYOUT_ITEMS)
      .filter(id => id !== 'stop')
      .every(id => PLAYER_BAR_LAYOUT_ZONES[id] === 'actions')).toBe(true);
  });

  it('toggleItem flips the matching id without disturbing the others', () => {
    usePlayerBarLayoutStore.getState().toggleItem('equalizer');
    const items = usePlayerBarLayoutStore.getState().items;
    expect(items.find(i => i.id === 'equalizer')?.visible).toBe(false);
    expect(items.filter(i => i.id !== 'equalizer').every(i => i.visible)).toBe(true);
  });

  it('reset restores items and the track-info mode together', () => {
    const { toggleItem, setTrackInfoMode, reset } = usePlayerBarLayoutStore.getState();
    toggleItem('favorite');
    toggleItem('stop');
    setTrackInfoMode('titleAlbum');
    reset();
    const state = usePlayerBarLayoutStore.getState();
    expect(state.items).toEqual(DEFAULT_PLAYER_BAR_LAYOUT_ITEMS);
    expect(state.trackInfoMode).toBe(DEFAULT_PLAYER_BAR_TRACK_INFO_MODE);
  });

  describe('rehydrate', () => {
    it('adds items the stored layout predates, without losing the stored choices', () => {
      // A layout persisted before 'stop' existed: it must come back, visible.
      const state = rehydrate({
        items: [
          { id: 'starRating', visible: true },
          { id: 'equalizer', visible: false },
        ],
      });
      expect(ids(state.items)).toContain('stop');
      expect(state.items.find(i => i.id === 'stop')?.visible).toBe(true);
      expect(state.items.find(i => i.id === 'equalizer')?.visible).toBe(false);
    });

    it('keeps the stored order rather than forcing the default one', () => {
      const state = rehydrate({
        items: [
          { id: 'miniPlayer', visible: true },
          { id: 'equalizer', visible: true },
        ],
      });
      expect(ids(state.items).slice(0, 2)).toEqual(['miniPlayer', 'equalizer']);
    });

    it('drops unknown and malformed entries', () => {
      const state = rehydrate({
        items: [{ id: 'ghostButton', visible: true }, null, { visible: true }],
      });
      expect(ids(state.items).sort()).toEqual(ids(DEFAULT_PLAYER_BAR_LAYOUT_ITEMS).sort());
    });

    it('falls back to the default track-info mode on an unknown or missing value', () => {
      expect(rehydrate({ trackInfoMode: 'everything' }).trackInfoMode)
        .toBe(DEFAULT_PLAYER_BAR_TRACK_INFO_MODE);
      expect(rehydrate({ trackInfoMode: undefined }).trackInfoMode)
        .toBe(DEFAULT_PLAYER_BAR_TRACK_INFO_MODE);
    });

    it('keeps a valid stored track-info mode', () => {
      expect(rehydrate({ trackInfoMode: 'titleAlbum' }).trackInfoMode).toBe('titleAlbum');
    });
  });
});
