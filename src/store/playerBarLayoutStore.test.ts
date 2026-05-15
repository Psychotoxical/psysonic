import { describe, expect, it, beforeEach } from 'vitest';
import {
  DEFAULT_PLAYER_BAR_LAYOUT_ITEMS,
  usePlayerBarLayoutStore,
} from './playerBarLayoutStore';

describe('playerBarLayoutStore', () => {
  beforeEach(() => {
    usePlayerBarLayoutStore.getState().reset();
  });

  it('starts with all five items visible in declared order', () => {
    const items = usePlayerBarLayoutStore.getState().items;
    expect(items.map(i => i.id)).toEqual([
      'starRating', 'favorite', 'lastfmLove', 'equalizer', 'miniPlayer',
    ]);
    expect(items.every(i => i.visible)).toBe(true);
  });

  it('toggleItem flips the matching id without disturbing the others', () => {
    usePlayerBarLayoutStore.getState().toggleItem('equalizer');
    const items = usePlayerBarLayoutStore.getState().items;
    expect(items.find(i => i.id === 'equalizer')?.visible).toBe(false);
    expect(items.find(i => i.id === 'starRating')?.visible).toBe(true);
    expect(items.find(i => i.id === 'miniPlayer')?.visible).toBe(true);
  });

  it('reset restores defaults after toggles', () => {
    const { toggleItem, reset } = usePlayerBarLayoutStore.getState();
    toggleItem('favorite');
    toggleItem('lastfmLove');
    reset();
    expect(usePlayerBarLayoutStore.getState().items).toEqual(DEFAULT_PLAYER_BAR_LAYOUT_ITEMS);
  });
});
