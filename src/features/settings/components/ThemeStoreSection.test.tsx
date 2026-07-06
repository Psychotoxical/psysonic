import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { ThemeStoreSection } from '@/features/settings/components/ThemeStoreSection';
import { useInstalledThemesStore } from '@/store/installedThemesStore';
import type { FetchRegistryResult, Registry, RegistryTheme } from '@/lib/themes/themeRegistry';

// Control the registry the store browses so pagination/refresh are deterministic.
vi.mock('@/lib/themes/themeRegistry', () => ({
  fetchRegistry: vi.fn(),
  fetchThemeCss: vi.fn(async () => 'css'),
  assetUrl: (p: string) => `https://raw.example/${p}`,
}));

import { fetchRegistry } from '@/lib/themes/themeRegistry';

const fetchRegistryMock = vi.mocked(fetchRegistry);

/** A registry with `n` themes named `Theme 01`…`Theme NN` (zero-padded so the
 *  component's alphabetical sort matches numeric order). */
function makeRegistry(n: number): Registry {
  const themes = Array.from({ length: n }, (_, i) => {
    const num = String(i + 1).padStart(2, '0');
    return {
      id: `t${num}`,
      name: `Theme ${num}`,
      author: 'Tester',
      version: '1.0.0',
      description: `Description ${num}`,
      mode: (i % 2 === 0 ? 'dark' : 'light') as 'dark' | 'light',
      css: `themes/t${num}/theme.css`,
      thumbnail: `themes/t${num}/thumb.png`,
      tags: [],
    };
  });
  return { schemaVersion: 1, generatedAt: '2026-06-07T00:00:00Z', themes };
}

const rows = (container: HTMLElement) => container.querySelectorAll('.theme-store-row');

/** Visible theme names in row order (the first span in each row is the name). */
const rowNames = (container: HTMLElement) =>
  [...container.querySelectorAll('.theme-store-row')].map(r => r.querySelector('span')?.textContent);

function mkTheme(id: string, name: string, extra: Partial<RegistryTheme> = {}): RegistryTheme {
  return {
    id,
    name,
    author: 'Tester',
    version: '1.0.0',
    description: `Description ${id}`,
    mode: 'dark',
    css: `themes/${id}/theme.css`,
    thumbnail: `themes/${id}/thumb.webp`,
    tags: [],
    ...extra,
  };
}

function registryOf(themes: RegistryTheme[]): Registry {
  return { schemaVersion: 1, generatedAt: '2026-06-08T00:00:00Z', themes };
}

/** Open the sort dropdown and pick an option by its visible label. */
async function selectSort(
  user: ReturnType<typeof userEvent.setup>,
  container: HTMLElement,
  optionLabel: string,
) {
  await user.click(container.querySelector('.custom-select-trigger') as HTMLElement);
  // The option closes the list on mousedown, so fire it directly.
  fireEvent.mouseDown(await screen.findByRole('option', { name: optionLabel }));
}

describe('ThemeStoreSection — pagination & refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useInstalledThemesStore.setState({ themes: [] });
    // jsdom has no layout engine; goToPage() scrolls the list back up.
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows only one page of themes and a pager when the catalogue is large', async () => {
    fetchRegistryMock.mockResolvedValue({ registry: makeRegistry(30), stale: false });
    const { container } = renderWithProviders(<ThemeStoreSection />);

    await screen.findByText('Theme 01');
    // PAGE_SIZE is 12 → 30 themes span 3 pages.
    expect(rows(container)).toHaveLength(12);
    expect(screen.getByRole('button', { name: '1', current: 'page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3' })).toBeInTheDocument();
    // Page-2 themes are not rendered yet.
    expect(screen.queryByText('Theme 13')).not.toBeInTheDocument();
  });

  it('does not paginate when everything fits on one page', async () => {
    fetchRegistryMock.mockResolvedValue({ registry: makeRegistry(8), stale: false });
    const { container } = renderWithProviders(<ThemeStoreSection />);

    await screen.findByText('Theme 01');
    expect(rows(container)).toHaveLength(8);
    expect(screen.queryByLabelText('Next page')).not.toBeInTheDocument();
    expect(screen.queryByText(/page 1 of/i)).not.toBeInTheDocument();
  });

  it('navigates between pages and disables prev/next at the bounds', async () => {
    fetchRegistryMock.mockResolvedValue({ registry: makeRegistry(30), stale: false });
    const { container } = renderWithProviders(<ThemeStoreSection />);
    const user = userEvent.setup();

    await screen.findByText('Theme 01');
    expect(screen.getByLabelText('Previous page')).toBeDisabled();

    await user.click(screen.getByLabelText('Next page'));
    expect(screen.getByRole('button', { name: '2', current: 'page' })).toBeInTheDocument();
    expect(screen.getByText('Theme 13')).toBeInTheDocument();
    expect(screen.queryByText('Theme 01')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Previous page')).toBeEnabled();

    await user.click(screen.getByLabelText('Next page'));
    expect(screen.getByRole('button', { name: '3', current: 'page' })).toBeInTheDocument();
    expect(rows(container)).toHaveLength(6); // 30 - 24
    expect(screen.getByLabelText('Next page')).toBeDisabled();
  });

  it('filters the catalogue by the search query', async () => {
    fetchRegistryMock.mockResolvedValue({ registry: makeRegistry(30), stale: false });
    const { container } = renderWithProviders(<ThemeStoreSection />);
    const user = userEvent.setup();

    await screen.findByText('Theme 01');
    await user.type(screen.getByRole('searchbox'), 'Theme 05');

    await waitFor(() => expect(rows(container)).toHaveLength(1));
    expect(screen.getByText('Theme 05')).toBeInTheDocument();
    expect(screen.queryByText('Theme 04')).not.toBeInTheDocument();
  });

  it('resets to the first page when the search query changes', async () => {
    fetchRegistryMock.mockResolvedValue({ registry: makeRegistry(30), stale: false });
    renderWithProviders(<ThemeStoreSection />);
    const user = userEvent.setup();

    await screen.findByText('Theme 01');
    await user.click(screen.getByLabelText('Next page'));
    expect(screen.getByRole('button', { name: '2', current: 'page' })).toBeInTheDocument();

    // 'theme' matches all 30 names, so the catalogue is unchanged in size — but
    // the page must snap back to 1 so the user isn't stranded past the end.
    await user.type(screen.getByRole('searchbox'), 'theme');
    await waitFor(() => expect(screen.getByRole('button', { name: '1', current: 'page' })).toBeInTheDocument());
    expect(screen.getByText('Theme 01')).toBeInTheDocument();
  });

  it('keeps the list mounted while refreshing (no scroll-resetting unmount)', async () => {
    const reg = makeRegistry(30);
    let resolveRefresh!: (v: FetchRegistryResult) => void;
    const pending = new Promise<FetchRegistryResult>(res => { resolveRefresh = res; });
    fetchRegistryMock
      .mockResolvedValueOnce({ registry: reg, stale: false }) // initial load
      .mockReturnValueOnce(pending); // manual refresh, held pending

    const { container } = renderWithProviders(<ThemeStoreSection />);
    const user = userEvent.setup();

    await screen.findByText('Theme 01');
    expect(container.querySelector('.animate-spin')).toBeNull();

    await user.click(screen.getByLabelText('Refresh'));

    // The whole point of the fix: refreshing must NOT swap the list for the
    // full-page loading placeholder (which collapses the scroll viewport and
    // jumps it to the top). The rows stay; only the icon spins.
    expect(rows(container)).toHaveLength(12);
    expect(screen.queryByText(/loading themes/i)).not.toBeInTheDocument();
    expect(container.querySelector('.animate-spin')).not.toBeNull();

    resolveRefresh({ registry: reg, stale: false });
    await waitFor(() => expect(container.querySelector('.animate-spin')).toBeNull());
    expect(rows(container)).toHaveLength(12);
  });

  it('shows an offline banner and hides the toolbar when the registry is unavailable', async () => {
    fetchRegistryMock.mockRejectedValue(new Error('offline'));
    renderWithProviders(<ThemeStoreSection />);

    expect(await screen.findByText('The Theme Store is offline')).toBeInTheDocument();
    // No catalogue to browse → the search/filter toolbar is not rendered.
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('defaults to newest and sorts alphabetically', async () => {
    const themes = [
      mkTheme('a', 'Alpha', { updatedAt: '2026-06-01T00:00:00Z' }),
      mkTheme('b', 'Bravo', { updatedAt: '2026-06-05T00:00:00Z' }),
      mkTheme('c', 'Charlie', { updatedAt: '2026-06-03T00:00:00Z' }),
    ];
    fetchRegistryMock.mockResolvedValue({ registry: registryOf(themes), stale: false });
    const { container } = renderWithProviders(<ThemeStoreSection />);
    const user = userEvent.setup();

    await screen.findByText('Bravo');
    // Default sort is newest first: Bravo (06-05) > Charlie (06-03) > Alpha (06-01).
    expect(rowNames(container)).toEqual(['Bravo', 'Charlie', 'Alpha']);

    // Alphabetical.
    await selectSort(user, container, 'Alphabetical');
    await waitFor(() => expect(rowNames(container)).toEqual(['Alpha', 'Bravo', 'Charlie']));
  });

  it('jumps directly to a page via the numbered pager', async () => {
    fetchRegistryMock.mockResolvedValue({ registry: makeRegistry(30), stale: false });
    renderWithProviders(<ThemeStoreSection />);
    const user = userEvent.setup();

    await screen.findByText('Theme 01');
    await user.click(screen.getByRole('button', { name: '3' }));

    // Page 3 holds items 25–30; page 1 is gone and page 3 is marked current.
    expect(screen.getByText('Theme 25')).toBeInTheDocument();
    expect(screen.queryByText('Theme 01')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3', current: 'page' })).toBeInTheDocument();
  });

  it('shows an expandable changelog with only the latest version for themes that ship one', async () => {
    const themes = [
      mkTheme('with', 'With Log', {
        changelog: { '1.0.0': ['First release'], '1.2.0': ['Newer note', 'Another newer note'] },
      }),
      mkTheme('without', 'No Log'),
    ];
    fetchRegistryMock.mockResolvedValue({ registry: registryOf(themes), stale: false });
    const { container } = renderWithProviders(<ThemeStoreSection />);
    const user = userEvent.setup();

    await screen.findByText('With Log');

    // Exactly one row (the one shipping a changelog) exposes the toggle.
    const toggles = screen.getAllByRole('button', { name: "What's new" });
    expect(toggles).toHaveLength(1);

    // Collapsed by default — entry text is not rendered yet.
    const toggle = toggles[0];
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Newer note')).not.toBeInTheDocument();

    // Expanding shows only the latest version (1.2.0); older entries are hidden.
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = container.querySelector('#theme-changelog-with') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.textContent).toContain('v1.2.0');
    expect(panel.textContent).toContain('Newer note');
    expect(panel.textContent).not.toContain('v1.0.0');
    expect(panel.textContent).not.toContain('First release');
  });

  it('floats installed themes with a pending update to the top of the list', async () => {
    // Alpha is the newest by date and would normally lead; Zulu is older but has
    // an installed copy on an earlier version, so it should be pinned first.
    const themes = [
      mkTheme('alpha', 'Alpha', { updatedAt: '2026-06-10T00:00:00Z', version: '1.0.0' }),
      mkTheme('zulu', 'Zulu', { updatedAt: '2026-06-01T00:00:00Z', version: '2.0.0' }),
    ];
    useInstalledThemesStore.setState({
      themes: [
        {
          id: 'zulu',
          name: 'Zulu',
          author: 'Tester',
          version: '1.0.0', // installed older than registry 2.0.0 → update available
          description: '',
          mode: 'dark',
          css: 'x',
          installedAt: 0,
        },
      ],
    });
    fetchRegistryMock.mockResolvedValue({ registry: registryOf(themes), stale: false });
    const { container } = renderWithProviders(<ThemeStoreSection />);

    await screen.findByText('Zulu');
    // Without the pin, newest-first would order Alpha (06-10) before Zulu (06-01).
    expect(rowNames(container)).toEqual(['Zulu', 'Alpha']);
  });
});
