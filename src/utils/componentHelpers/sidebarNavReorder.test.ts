import { describe, expect, it } from 'vitest';
import { resolveStartRoute } from './sidebarNavReorder';
import { DEFAULT_SIDEBAR_ITEMS, type SidebarItemConfig } from '../../store/sidebarStore';

const hide = (items: SidebarItemConfig[], ...ids: string[]): SidebarItemConfig[] =>
  items.map(i => (ids.includes(i.id) ? { ...i, visible: false } : i));

const only = (...ids: string[]): SidebarItemConfig[] =>
  DEFAULT_SIDEBAR_ITEMS.map(i => ({ ...i, visible: ids.includes(i.id) }));

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
