import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { renderChangelogBody } from '@/features/whatsNew/utils/changelogMarkdown';

describe('renderChangelogBody', () => {
  it('renders ## section headings', () => {
    render(<div>{renderChangelogBody('## Highlights\n\n### Theme Store\n- Item')}</div>);
    expect(screen.getByRole('heading', { level: 2, name: 'Highlights' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Theme Store' })).toBeInTheDocument();
  });
});
