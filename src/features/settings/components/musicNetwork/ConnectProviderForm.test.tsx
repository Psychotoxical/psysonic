import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { ConnectProviderForm } from './ConnectProviderForm';

describe('ConnectProviderForm', () => {
  it('leaves the connect buttons outlined', () => {
    renderWithProviders(
      <ConnectProviderForm connectedPresetIds={[]} onConnect={async () => {}} />,
    );

    // `.btn-ghost` carries its own outline; `btn-ghost--flat` removes it and is
    // meant for icons repeated per list row or a close cross on a framed
    // surface. A connect action is neither, so it must not opt out.
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button).not.toHaveClass('btn-ghost--flat');
    }
  });
});
