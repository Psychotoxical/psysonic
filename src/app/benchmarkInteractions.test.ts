import { describe, expect, it } from 'vitest';
import { routeSupportsScrollPagination } from './benchmarkInteractions';

describe('routeSupportsScrollPagination', () => {
  it('covers shared sentinel routes including dynamic genre pages', () => {
    expect(routeSupportsScrollPagination('/albums')).toBe(true);
    expect(routeSupportsScrollPagination('/search/advanced')).toBe(true);
    expect(routeSupportsScrollPagination('/genres/Rock%20%26%20Roll')).toBe(true);
  });

  it('does not treat button-based or fixed-size pages as scroll pagination', () => {
    expect(routeSupportsScrollPagination('/most-played')).toBe(false);
    expect(routeSupportsScrollPagination('/random/albums')).toBe(false);
    expect(routeSupportsScrollPagination('/settings')).toBe(false);
  });
});
