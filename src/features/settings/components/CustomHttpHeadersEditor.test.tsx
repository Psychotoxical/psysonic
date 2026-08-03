import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { CustomHttpHeadersEditor } from './CustomHttpHeadersEditor';

function render(open = true) {
  return renderWithProviders(
    <CustomHttpHeadersEditor
      headers={[{ name: '', value: '' }]}
      applyTo="public"
      open={open}
      onOpenChange={() => {}}
      onHeadersChange={() => {}}
      onApplyToChange={() => {}}
    />,
  );
}

describe('CustomHttpHeadersEditor', () => {
  it('keeps the header row out of the two-column form grid', () => {
    const { container } = render();

    // `form-row` is a two-column grid. This row has three children — name,
    // value, remove — so the third wrapped onto its own line and stretched to
    // a full column, reading as another input rather than a button.
    expect(container.querySelector('.form-row')).toBeNull();
  });

  it('leaves the row buttons outlined', () => {
    render();

    // These are ordinary actions, so they keep the outline `.btn-ghost` gives
    // them rather than opting out of it.
    for (const name of [/remove/i, /add header/i]) {
      expect(screen.getByRole('button', { name })).not.toHaveClass('btn-ghost--flat');
    }
  });

  it('keeps the disclosure toggle flat', () => {
    render(false);

    // The section header reads as a heading, not as a button — it is one of
    // the deliberate opt-outs from the ghost outline.
    expect(screen.getByRole('button')).toHaveClass('btn-ghost--flat');
  });
});
