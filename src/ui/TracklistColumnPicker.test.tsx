import { describe, it, expect, vi } from 'vitest';
import React, { useRef, useState } from 'react';
import { screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TFunction } from 'i18next';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { TracklistColumnPicker } from '@/ui/TracklistColumnPicker';
import type { ColDef } from '@/lib/hooks/useTracklistColumns';

const COLUMNS: readonly ColDef[] = [
  { key: 'title', i18nKey: 'title', minWidth: 100, defaultWidth: 200, required: true },
  { key: 'artist', i18nKey: 'artist', minWidth: 80, defaultWidth: 150, required: false },
  { key: 'album', i18nKey: 'album', minWidth: 80, defaultWidth: 150, required: false },
];

// Passthrough translator: returns the key so assertions are translation-agnostic.
const passthroughT = ((k: string) => k) as unknown as TFunction;

function Harness({
  initialOpen = false,
  toggleColumn = vi.fn(),
  resetColumns = vi.fn(),
}: {
  initialOpen?: boolean;
  toggleColumn?: (key: string) => void;
  resetColumns?: () => void;
}) {
  const [open, setOpen] = useState(initialOpen);
  const pickerRef = useRef<HTMLDivElement>(null);
  return (
    <TracklistColumnPicker
      allColumns={COLUMNS}
      pickerRef={pickerRef}
      pickerOpen={open}
      setPickerOpen={setOpen}
      colVisible={new Set(['title', 'artist', 'album'])}
      toggleColumn={toggleColumn}
      resetColumns={resetColumns}
      t={passthroughT}
    />
  );
}

describe('TracklistColumnPicker', () => {
  it('opens the menu from the trigger and lists only non-required columns', async () => {
    renderWithProviders(<Harness />);

    // Closed: only the trigger button exists.
    await userEvent.click(screen.getByRole('button'));

    expect(screen.getByText('albumDetail.columns')).toBeInTheDocument();
    expect(screen.getByText('albumDetail.artist')).toBeInTheDocument();
    expect(screen.getByText('albumDetail.album')).toBeInTheDocument();
    // Required columns are not offered in the menu.
    expect(screen.queryByText('albumDetail.title')).not.toBeInTheDocument();
  });

  it('toggles a column without closing the menu', async () => {
    const toggleColumn = vi.fn();
    renderWithProviders(<Harness initialOpen toggleColumn={toggleColumn} />);

    await userEvent.click(screen.getByText('albumDetail.artist'));

    expect(toggleColumn).toHaveBeenCalledWith('artist');
    // Menu stays open so several columns can be toggled in one pass.
    expect(screen.getByText('albumDetail.columns')).toBeInTheDocument();
  });

  it('calls resetColumns from the reset action', async () => {
    const resetColumns = vi.fn();
    renderWithProviders(<Harness initialOpen resetColumns={resetColumns} />);

    await userEvent.click(screen.getByText('albumDetail.resetColumns'));

    expect(resetColumns).toHaveBeenCalledOnce();
  });

  it('closes on Escape', () => {
    renderWithProviders(<Harness initialOpen />);
    expect(screen.getByText('albumDetail.columns')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByText('albumDetail.columns')).not.toBeInTheDocument();
  });

  it('closes on an outside mousedown', () => {
    renderWithProviders(<Harness initialOpen />);
    expect(screen.getByText('albumDetail.columns')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByText('albumDetail.columns')).not.toBeInTheDocument();
  });

  it('stays open on a mousedown inside the menu', () => {
    renderWithProviders(<Harness initialOpen />);

    fireEvent.mouseDown(screen.getByText('albumDetail.artist'));

    expect(screen.getByText('albumDetail.columns')).toBeInTheDocument();
  });
});
