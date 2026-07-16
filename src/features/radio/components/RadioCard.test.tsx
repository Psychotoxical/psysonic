import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import RadioCard from './RadioCard';

vi.mock('@/lib/dnd/DragDropContext', () => ({
  useDragDrop: () => ({ isDragging: false, payload: null }),
  useDragSource: () => ({}),
}));

describe('RadioCard', () => {
  it('shows collision-aware source provenance and source-specific controls', () => {
    renderWithProviders(
      <RadioCard
        s={{ id: 'radio-1', serverId: 'office', name: 'Test FM', streamUrl: 'https://radio.test' }}
        isActive={false}
        isPlaying={false}
        deleteConfirmId={null}
        isFavorite={false}
        isManual={false}
        canManage={false}
        sourceLabel="bob@office.test"
        dropIndicator={null}
        onPlay={() => undefined}
        onDelete={() => undefined}
        onEdit={() => undefined}
        onFavoriteToggle={() => undefined}
        onDragEnter={() => undefined}
        onDragLeave={() => undefined}
        onDropOnto={() => undefined}
        onCardMouseLeave={() => undefined}
      />,
    );

    expect(screen.getByText('bob@office.test')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });
});
