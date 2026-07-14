import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import Modal from '@/ui/Modal';

describe('Modal', () => {
  const defaultProps = {
    open: true,
    onClose: vi.fn(),
    title: 'Test Modal',
    children: <p>Modal body content</p>,
  };

  it('renders nothing when open is false', () => {
    // Query the document, not the render container: Modal portals into
    // document.body, so the container is empty whether it is open or not.
    renderWithProviders(<Modal {...defaultProps} open={false} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders the dialog when open is true', () => {
    renderWithProviders(<Modal {...defaultProps} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('renders the title text', () => {
    renderWithProviders(<Modal {...defaultProps} />);
    expect(screen.getByText('Test Modal')).toBeInTheDocument();
  });

  it('renders children content', () => {
    renderWithProviders(<Modal {...defaultProps} />);
    expect(screen.getByText('Modal body content')).toBeInTheDocument();
  });

  it('has aria-modal="true" on the dialog', () => {
    renderWithProviders(<Modal {...defaultProps} />);
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
  });

  it('links the dialog to its title via aria-labelledby', () => {
    renderWithProviders(<Modal {...defaultProps} />);
    const dialog = screen.getByRole('dialog');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();

    const titleEl = document.getElementById(labelledBy!);
    expect(titleEl).toBeTruthy();
    expect(titleEl!.textContent).toContain('Test Modal');
  });

  it('uses a unique id per instance so multiple modals do not clash', () => {
    renderWithProviders(
      <>
        <Modal {...defaultProps} title="First" />
        <Modal {...defaultProps} title="Second" />
      </>,
    );

    const dialogs = screen.getAllByRole('dialog');
    const id1 = dialogs[0].getAttribute('aria-labelledby');
    const id2 = dialogs[1].getAttribute('aria-labelledby');
    expect(id1).not.toBe(id2);
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    renderWithProviders(<Modal {...defaultProps} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when the backdrop is clicked', async () => {
    const onClose = vi.fn();
    renderWithProviders(<Modal {...defaultProps} onClose={onClose} />);
    await userEvent.click(screen.getByRole('dialog').parentElement!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not call onClose when the dialog content is clicked', async () => {
    const onClose = vi.fn();
    renderWithProviders(<Modal {...defaultProps} onClose={onClose} />);
    await userEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose when the close button is clicked', async () => {
    const onClose = vi.fn();
    renderWithProviders(<Modal {...defaultProps} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('hides the close button when hideClose is true', () => {
    renderWithProviders(<Modal {...defaultProps} hideClose />);
    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
  });

  it('renders the subtitle when provided', () => {
    renderWithProviders(<Modal {...defaultProps} subtitle="v1.2.3" />);
    expect(screen.getByText('v1.2.3')).toBeInTheDocument();
  });

  it('renders the footer when provided', () => {
    renderWithProviders(
      <Modal {...defaultProps} footer={<button type="button">Save</button>} />,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });
});
