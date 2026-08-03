import { beforeEach, describe, expect, it } from 'vitest';
import {
  availableNpCards,
  DEFAULT_NP_LAYOUT,
  useNpLayoutStore,
} from './nowPlayingLayoutStore';

beforeEach(() => {
  useNpLayoutStore.setState({
    cards: DEFAULT_NP_LAYOUT.map(card => ({ ...card })),
  });
});

describe('availableNpCards', () => {
  it('removes the optional visualizer card while the feature is disabled', () => {
    const cards = DEFAULT_NP_LAYOUT.map(card => ({ ...card }));
    const available = availableNpCards(cards, { visualizerEnabled: false });
    expect(available.some(card => card.id === 'visualizer')).toBe(false);
    expect(available).toHaveLength(cards.length - 1);
  });

  it('preserves the saved visualizer placement for re-enabling', () => {
    const cards = DEFAULT_NP_LAYOUT.map(card => card.id === 'visualizer'
      ? { ...card, column: 'right' as const, visible: false }
      : { ...card });

    availableNpCards(cards, { visualizerEnabled: false });
    expect(availableNpCards(cards, { visualizerEnabled: true }))
      .toContainEqual({ id: 'visualizer', column: 'right', visible: false });
  });
});

describe('moveCard', () => {
  it('maps a visible drop index without shifting a disabled visualizer card', () => {
    const visibleCardIds = availableNpCards(
      useNpLayoutStore.getState().cards,
      { visualizerEnabled: false },
    ).filter(card => card.visible).map(card => card.id);

    useNpLayoutStore.getState().moveCard('album', 'left', 2, visibleCardIds);

    const leftCards = useNpLayoutStore.getState().cards
      .filter(card => card.column === 'left')
      .map(card => card.id);
    expect(leftCards).toEqual(['visualizer', 'topSongs', 'credits', 'album']);
  });
});
