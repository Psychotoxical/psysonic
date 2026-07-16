import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import SidebarLibraryPicker from '@/features/sidebar/components/SidebarLibraryPicker';

const folders = [
  { id: 'lib-a', name: 'Rock' },
  { id: 'lib-b', name: 'Jazz' },
  { id: 'lib-c', name: 'Classical' },
];

async function flushAnimationFrame(): Promise<void> {
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}

function renderPicker(
  over: Partial<ComponentProps<typeof SidebarLibraryPicker>> = {},
) {
  const onSelectionChange = vi.fn();
  const setLibraryDropdownOpen = vi.fn();
  const props = {
    selectedLibraryIds: [] as string[],
    selectionSummary: null as string | null,
    libraryDropdownOpen: true,
    setLibraryDropdownOpen,
    dropdownRect: { top: 0, left: 0, width: 240 },
    libraryTriggerRef: createRef<HTMLButtonElement>(),
    musicFolders: folders,
    onSelectionChange,
    ...over,
  };

  renderWithProviders(<SidebarLibraryPicker {...props} />);

  return { onSelectionChange, setLibraryDropdownOpen, props };
}

describe('SidebarLibraryPicker', () => {
  it('shows the folder name when exactly one library is selected', () => {
    renderPicker({
      selectedLibraryIds: ['lib-b'],
      selectionSummary: 'Jazz',
      libraryDropdownOpen: false,
    });

    expect(screen.getByText('Jazz')).toBeInTheDocument();
  });

  it('shows the multi-library count summary', () => {
    renderPicker({
      selectedLibraryIds: ['lib-a', 'lib-c'],
      selectionSummary: '2 libraries',
      libraryDropdownOpen: false,
    });

    expect(screen.getByText('2 libraries')).toBeInTheDocument();
  });

  it('clears the selection when All libraries is chosen', async () => {
    const user = userEvent.setup();
    const { onSelectionChange, setLibraryDropdownOpen } = renderPicker({
      selectedLibraryIds: ['lib-a'],
    });

    const panel = screen.getByRole('listbox', { name: 'Library scope' });
    await user.click(within(panel).getByRole('button', { name: 'All libraries' }));
    await flushAnimationFrame();

    expect(onSelectionChange).toHaveBeenCalledWith([]);
    expect(setLibraryDropdownOpen).toHaveBeenCalledWith(false);
  });

  it('exclusive-selects one library when its label is clicked', async () => {
    const user = userEvent.setup();
    const { onSelectionChange, setLibraryDropdownOpen } = renderPicker({
      selectedLibraryIds: ['lib-a', 'lib-b'],
    });

    const panel = screen.getByRole('listbox', { name: 'Library scope' });
    await user.click(within(panel).getByRole('button', { name: 'Classical' }));
    await flushAnimationFrame();

    expect(onSelectionChange).toHaveBeenCalledWith(['lib-c']);
    expect(setLibraryDropdownOpen).toHaveBeenCalledWith(false);
  });

  it('toggles a library on from the all-libraries state', async () => {
    const user = userEvent.setup();
    const { onSelectionChange } = renderPicker({ selectedLibraryIds: [] });

    const panel = screen.getByRole('listbox', { name: 'Library scope' });
    await user.click(within(panel).getByRole('button', { name: 'Include Jazz' }));

    expect(onSelectionChange).toHaveBeenCalledWith(['lib-b']);
  });

  it('appends a toggled-on library to the ordered selection', async () => {
    const user = userEvent.setup();
    const { onSelectionChange } = renderPicker({ selectedLibraryIds: ['lib-a'] });

    const panel = screen.getByRole('listbox', { name: 'Library scope' });
    await user.click(within(panel).getByRole('button', { name: 'Include Jazz' }));

    expect(onSelectionChange).toHaveBeenCalledWith(['lib-a', 'lib-b']);
  });

  it('removes a toggled-off library from the selection', async () => {
    const user = userEvent.setup();
    const { onSelectionChange } = renderPicker({ selectedLibraryIds: ['lib-a', 'lib-b'] });

    const panel = screen.getByRole('listbox', { name: 'Library scope' });
    await user.click(within(panel).getByRole('button', { name: 'Exclude Rock' }));

    expect(onSelectionChange).toHaveBeenCalledWith(['lib-b']);
  });
});
