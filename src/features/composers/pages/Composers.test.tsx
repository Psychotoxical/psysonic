import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';

const hoisted = vi.hoisted(() => ({
  composers: [] as { id: string; name: string; albumCount: number }[],
}));

vi.mock('@/features/composers/hooks/useComposerCatalog', () => ({
  useComposerCatalog: () => ({
    composers: hoisted.composers,
    loading: false,
    loadError: null,
    reload: vi.fn(),
    serverId: 'srv-a',
    scopeKey: 'srv-a',
  }),
}));

vi.mock('@/features/offline', () => ({
  useOfflineBrowseContext: () => ({ active: false }),
  offlineLocalBrowseEnabled: vi.fn(() => false),
}));

// Same reason as the grid mock below: the windowed list path renders nothing
// without layout. This flag is the app's own escape hatch to the plain path.
vi.mock('@/lib/perf/perfFlags', async importOriginal => ({
  ...(await importOriginal<object>()),
  usePerfProbeFlags: () => ({ disableMainstageVirtualLists: true }),
}));

// jsdom reports no layout, so the real virtualizer renders an empty spacer and
// no cells. Render every item instead — this suite asserts on filtering, not on
// windowing behaviour.
vi.mock('@/ui/VirtualCardGrid', () => ({
  VirtualCardGrid: <T,>({ items, renderItem, itemKey }: {
    items: readonly T[];
    renderItem: (item: T) => React.ReactNode;
    itemKey?: (item: T, index: number) => string;
  }) => (
    <div>
      {items.map((item, index) => (
        <React.Fragment key={itemKey?.(item, index) ?? index}>{renderItem(item)}</React.Fragment>
      ))}
    </div>
  ),
}));

import Composers from '@/features/composers/pages/Composers';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { resetAllStores } from '@/test/helpers/storeReset';

describe('Composers letter filter', () => {
  beforeEach(() => {
    resetAllStores();
    // Names that fall outside A–Z: a leading quote, a leading bracket, and a
    // non-ASCII initial. All three are unreachable while the bar stops at Z.
    hoisted.composers = [
      { id: 'c1', name: '"quoted tester"', albumCount: 1 },
      { id: 'c2', name: '[traditional]', albumCount: 37 },
      { id: 'c3', name: 'Ølsen Tester', albumCount: 1 },
      { id: 'c4', name: 'Alice Tester', albumCount: 2 },
      { id: 'c5', name: 'Bob Tester', albumCount: 3 },
    ];
  });

  it('offers an Other bucket in the letter bar', async () => {
    const view = renderWithProviders(<Composers />);

    expect(await view.findByRole('button', { name: 'Other' })).toBeInTheDocument();
  });

  it('filters to the names that start with neither a letter nor a digit', async () => {
    const view = renderWithProviders(<Composers />);
    const user = userEvent.setup();

    expect(await view.findByText('Alice Tester')).toBeInTheDocument();

    await user.click(await view.findByRole('button', { name: 'Other' }));

    expect(await view.findByText('"quoted tester"')).toBeInTheDocument();
    expect(view.getByText('[traditional]')).toBeInTheDocument();
    expect(view.getByText('Ølsen Tester')).toBeInTheDocument();
    expect(view.queryByText('Alice Tester')).not.toBeInTheDocument();
    expect(view.queryByText('Bob Tester')).not.toBeInTheDocument();
  });

  it('puts the Other group after Z in the list view, not between O and P', async () => {
    // A plain string sort of the bucket keys lands 'OTHER' next to 'O'.
    hoisted.composers = [
      { id: 'c1', name: '[traditional]', albumCount: 37 },
      { id: 'c2', name: 'Olive Tester', albumCount: 1 },
      { id: 'c3', name: 'Paul Tester', albumCount: 1 },
      { id: 'c4', name: 'Zoe Tester', albumCount: 1 },
    ];

    const view = renderWithProviders(<Composers />);
    const user = userEvent.setup();

    // The view toggle carries only an icon and a tooltip attribute, no accessible name.
    const listViewBtn = view.container.querySelector<HTMLButtonElement>('[data-tooltip="List view"]');
    expect(listViewBtn).not.toBeNull();
    await user.click(listViewBtn!);

    const headings = await view.findAllByRole('heading', { level: 3 });
    expect(headings.map(h => h.textContent)).toEqual(['O', 'P', 'Z', 'Other']);
  });
});
