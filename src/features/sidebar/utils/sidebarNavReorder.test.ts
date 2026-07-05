import { describe, expect, it } from 'vitest';
import { applySidebarReorderById, resolveStartRoute } from '@/features/sidebar/utils/sidebarNavReorder';
import { DEFAULT_SIDEBAR_ITEMS, type SidebarItemConfig } from '@/features/sidebar/store/sidebarStore';

const hide = (items: SidebarItemConfig[], ...ids: string[]): SidebarItemConfig[] =>
  items.map(i => (ids.includes(i.id) ? { ...i, visible: false } : i));

const only = (...ids: string[]): SidebarItemConfig[] =>
  DEFAULT_SIDEBAR_ITEMS.map(i => ({ ...i, visible: ids.includes(i.id) }));

const ids = (items: SidebarItemConfig[]): string[] => items.map(i => i.id);

describe('applySidebarReorderById', () => {
  it('moves a library item to before the target by id', () => {
    // Default order has artists(8) then composers, genres(10). Move genres up.
    const next = applySidebarReorderById(
      DEFAULT_SIDEBAR_ITEMS, 'library', 'genres',
      { id: 'artists', before: true, section: 'library' },
    );
    expect(next).not.toBeNull();
    const order = ids(next!);
    expect(order.indexOf('genres')).toBe(order.indexOf('artists') - 1);
    expect(next!.length).toBe(DEFAULT_SIDEBAR_ITEMS.length);
  });

  it('moves a library item to after the target by id', () => {
    const next = applySidebarReorderById(
      DEFAULT_SIDEBAR_ITEMS, 'library', 'artists',
      { id: 'genres', before: false, section: 'library' },
    );
    const order = ids(next!);
    expect(order.indexOf('artists')).toBe(order.indexOf('genres') + 1);
  });

  it('reorders correctly even when a hidden/gated item sits between the rows', () => {
    // The #1164 class: luckyMix is present in the stored list but hidden from
    // render. An index-based reorder desynced here; the id-based one must not.
    // Move genres to just before artists; luckyMix must keep its absolute slot.
    const luckyMixIdx = DEFAULT_SIDEBAR_ITEMS.findIndex(i => i.id === 'luckyMix');
    const next = applySidebarReorderById(
      DEFAULT_SIDEBAR_ITEMS, 'library', 'genres',
      { id: 'artists', before: true, section: 'library' },
    );
    const order = ids(next!);
    expect(order.indexOf('genres')).toBe(order.indexOf('artists') - 1);
    expect(order.indexOf('luckyMix')).toBe(luckyMixIdx); // untouched anchor
  });

  it('returns null on an unknown dragged id (defensive guard)', () => {
    expect(applySidebarReorderById(
      DEFAULT_SIDEBAR_ITEMS, 'library', 'does-not-exist',
      { id: 'artists', before: true, section: 'library' },
    )).toBeNull();
  });

  it('returns null on an unknown target id (defensive guard)', () => {
    expect(applySidebarReorderById(
      DEFAULT_SIDEBAR_ITEMS, 'library', 'genres',
      { id: 'does-not-exist', before: true, section: 'library' },
    )).toBeNull();
  });

  it('returns null when the section does not match the drop target', () => {
    expect(applySidebarReorderById(
      DEFAULT_SIDEBAR_ITEMS, 'library', 'genres',
      { id: 'statistics', before: true, section: 'system' },
    )).toBeNull();
  });

  it('returns null when an id does not belong to the claimed section', () => {
    // 'statistics' is a system item — cannot be reordered as a library row.
    expect(applySidebarReorderById(
      DEFAULT_SIDEBAR_ITEMS, 'system', 'statistics',
      { id: 'genres', before: true, section: 'system' },
    )).toBeNull();
  });

  it('returns null for a conserved (non-reorderable) id', () => {
    expect(applySidebarReorderById(
      DEFAULT_SIDEBAR_ITEMS, 'library', 'losslessAlbums',
      { id: 'genres', before: true, section: 'library' },
    )).toBeNull();
  });

  it('returns null on a no-op drop (onto itself or its own edge)', () => {
    expect(applySidebarReorderById(
      DEFAULT_SIDEBAR_ITEMS, 'library', 'artists',
      { id: 'artists', before: true, section: 'library' },
    )).toBeNull();
    // Dropping artists before composers — the row right after it — changes nothing.
    expect(applySidebarReorderById(
      DEFAULT_SIDEBAR_ITEMS, 'library', 'artists',
      { id: 'composers', before: true, section: 'library' },
    )).toBeNull();
  });

  it('does not mutate the input array', () => {
    const snapshot = ids(DEFAULT_SIDEBAR_ITEMS);
    applySidebarReorderById(
      DEFAULT_SIDEBAR_ITEMS, 'library', 'genres',
      { id: 'artists', before: true, section: 'library' },
    );
    expect(ids(DEFAULT_SIDEBAR_ITEMS)).toEqual(snapshot);
  });
});

describe('resolveStartRoute', () => {
  it('falls back to the first visible library item when Mainstage is hidden', () => {
    const items = hide(DEFAULT_SIDEBAR_ITEMS, 'mainstage');
    expect(resolveStartRoute(items, 'hub', false)).toBe('/new-releases');
  });

  it('skips Mainstage ("/") even if it is still flagged visible', () => {
    // Resolver is only consulted when Mainstage is hidden, but it must never
    // hand back "/" — that would redirect the index route onto itself.
    expect(resolveStartRoute(DEFAULT_SIDEBAR_ITEMS, 'hub', false)).toBe('/new-releases');
  });

  it('returns null when no library item is visible (caller renders empty Mainstage)', () => {
    const items = DEFAULT_SIDEBAR_ITEMS.map(i => ({ ...i, visible: false }));
    expect(resolveStartRoute(items, 'hub', false)).toBeNull();
  });

  it('honours sidebar order — first visible entry wins', () => {
    expect(resolveStartRoute(only('favorites', 'artists'), 'hub', false)).toBe('/artists');
    expect(resolveStartRoute(only('favorites'), 'hub', false)).toBe('/favorites');
  });

  it('skips luckyMix when it is not available', () => {
    const items = only('luckyMix', 'genres');
    // separate mode surfaces luckyMix, but availability gate is off → next item
    expect(resolveStartRoute(items, 'separate', false)).toBe('/genres');
    expect(resolveStartRoute(items, 'separate', true)).toBe('/lucky-mix');
  });

  it('respects randomNavMode hub/separate gating', () => {
    // randomPicker (Build a Mix) only exists in hub mode; randomMix only in separate.
    expect(resolveStartRoute(only('randomPicker'), 'hub', false)).toBe('/random');
    expect(resolveStartRoute(only('randomPicker'), 'separate', false)).toBeNull();
    expect(resolveStartRoute(only('randomMix'), 'separate', false)).toBe('/random/mix');
    expect(resolveStartRoute(only('randomMix'), 'hub', false)).toBeNull();
  });
});
