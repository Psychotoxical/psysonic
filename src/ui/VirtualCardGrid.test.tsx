import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { VirtualCardGrid, type VirtualCardGridProps } from './VirtualCardGrid';

type GridItem = { id: string };

const ITEMS: GridItem[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

// jsdom reports every element as 0 px wide, and a 0 px container derives one
// column on its own — which would make the single-column assertion below pass
// with or without the override it exists to prove. Pin a desktop width so the
// derived count is six and the two paths are actually distinguishable.
const CONTAINER_WIDTH_PX = 1200;
const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => CONTAINER_WIDTH_PX,
  });
});

afterAll(() => {
  if (originalClientWidth) {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
  }
});

function renderGrid(props: Partial<VirtualCardGridProps<GridItem>> = {}) {
  return render(
    <VirtualCardGrid
      items={ITEMS}
      itemKey={item => item.id}
      renderItem={item => <div data-testid="cell">{item.id}</div>}
      rowVariant="album"
      disableVirtualization
      layoutSignal={ITEMS.length}
      {...props}
    />,
  );
}

describe('VirtualCardGrid', () => {
  // `computeCardGridColumnCount` floors its cap at four columns, so a
  // full-width row is unreachable through container width alone — the table
  // view depends on this override existing.
  it('pins the layout to one column when asked', () => {
    const { container } = renderGrid({ singleColumn: true, wrapClassName: 'probe-wrap' });
    const wrap = container.querySelector('.probe-wrap') as HTMLElement;
    expect(wrap.style.gridTemplateColumns).toBe('repeat(1, minmax(0, 1fr))');
  });

  it('derives the column count from width when it is not pinned', () => {
    const { container } = renderGrid({ wrapClassName: 'probe-wrap' });
    const wrap = container.querySelector('.probe-wrap') as HTMLElement;
    expect(wrap.style.gridTemplateColumns).toBe('repeat(6, minmax(0, 1fr))');
  });

  // A caller that wraps the grid in an ARIA table needs its rows to stay owned
  // by that table across the layout wrappers this component inserts.
  it('marks its layout wrappers as presentational on request', () => {
    const { container } = renderGrid({ presentationalWrappers: true, wrapClassName: 'probe-wrap' });
    expect(container.querySelector('.probe-wrap')?.getAttribute('role')).toBe('presentation');
  });

  it('leaves the wrappers without a role by default', () => {
    const { container } = renderGrid({ wrapClassName: 'probe-wrap' });
    expect(container.querySelector('.probe-wrap')?.getAttribute('role')).toBeNull();
  });
});
