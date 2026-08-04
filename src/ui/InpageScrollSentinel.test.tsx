import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import InpageScrollSentinel from './InpageScrollSentinel';

describe('InpageScrollSentinel', () => {
  it('exposes semantic pagination state to the benchmark runner', () => {
    const { container } = render(
      <InpageScrollSentinel bindSentinel={vi.fn()} loading itemCount={150} />,
    );

    const sentinel = container.querySelector('[data-benchmark-scroll-sentinel]');
    expect(sentinel).toHaveAttribute('data-benchmark-loading', 'true');
    expect(sentinel).toHaveAttribute('data-benchmark-item-count', '150');
  });
});
