import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import CoverLightbox from './CoverLightbox';

describe('CoverLightbox', () => {
  it('renders the cover image with the supplied src and alt', () => {
    renderWithProviders(
      <CoverLightbox src="https://example/cover.jpg" alt="Album cover" onClose={vi.fn()} />,
    );

    const img = screen.getByRole('img', { name: 'Album cover' });
    expect(img).toHaveAttribute('src', 'https://example/cover.jpg');
  });

  it('calls onClose when the overlay is clicked', async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <CoverLightbox src="https://example/cover.jpg" alt="Album cover" onClose={onClose} />,
    );

    await userEvent.click(screen.getByRole('dialog'));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not call onClose when the image itself is clicked (stops propagation)', async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <CoverLightbox src="https://example/cover.jpg" alt="Album cover" onClose={onClose} />,
    );

    await userEvent.click(screen.getByRole('img', { name: 'Album cover' }));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    renderWithProviders(
      <CoverLightbox src="https://example/cover.jpg" alt="Album cover" onClose={onClose} />,
    );

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('ignores other keys', () => {
    const onClose = vi.fn();
    renderWithProviders(
      <CoverLightbox src="https://example/cover.jpg" alt="Album cover" onClose={onClose} />,
    );

    fireEvent.keyDown(window, { key: 'Enter' });
    fireEvent.keyDown(window, { key: 'a' });

    expect(onClose).not.toHaveBeenCalled();
  });
});
