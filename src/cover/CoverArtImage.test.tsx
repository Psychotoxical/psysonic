import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CoverArtImage } from './CoverArtImage';
import { useCoverArt } from './useCoverArt';
import type { CoverArtRef } from './types';
import { COVER_SCOPE_ACTIVE } from './types';

// The hook-guard split (PR #1165) moved every hook into `CoverArtImageResolved`,
// which only mounts with a non-null `coverRef`. The wrapper itself runs no hooks.
// We mock the hook and the side-effecting cover modules so the test exercises
// only the wrapper's branching + prop forwarding, deterministically.
vi.mock('./useCoverArt', () => ({ useCoverArt: vi.fn() }));
vi.mock('./ensureQueue', () => ({
  coverEnsureQueued: vi.fn(() => Promise.resolve({ hit: false })),
  coverEnsureReprioritize: vi.fn(),
}));
vi.mock('./prefetchRegistry', () => ({ coverPrefetchBumpPriority: vi.fn() }));
vi.mock('./reachability', () => ({ coverServerReachable: () => false }));

const mockedUseCoverArt = vi.mocked(useCoverArt);

function ref(overrides: Partial<CoverArtRef> = {}): CoverArtRef {
  return {
    cacheKind: 'album',
    cacheEntityId: 'al-1',
    fetchCoverArtId: 'al-1',
    serverScope: COVER_SCOPE_ACTIVE,
    ...overrides,
  };
}

function setHandle(src: string, provisional = !src) {
  mockedUseCoverArt.mockReturnValue({
    src,
    storageKey: 'k',
    cacheKey: 'k',
    tier: 128,
    provisional,
    onImgError: vi.fn(),
  });
}

describe('CoverArtImage — hook-guard split (PR #1165)', () => {
  beforeEach(() => {
    mockedUseCoverArt.mockReset();
    setHandle('');
  });

  it('renders a provisional placeholder and runs no hooks when coverRef is missing', () => {
    render(
      <CoverArtImage
        coverRef={null}
        displayCssPx={80}
        className="cover-x"
        alt="My album"
      />,
    );
    const placeholder = screen.getByRole('img', { name: 'My album' });
    expect(placeholder.tagName).toBe('DIV');
    expect(placeholder).toHaveAttribute('data-cover-provisional', 'true');
    expect(placeholder).toHaveClass('cover-x');
    // The whole point of the split: the wrapper must not touch the hook.
    expect(mockedUseCoverArt).not.toHaveBeenCalled();
  });

  it('forwards passthrough props on the missing-ref placeholder', () => {
    render(
      <CoverArtImage
        coverRef={undefined}
        displayCssPx={80}
        className="cover-x"
        alt=""
        data-testid="ph"
      />,
    );
    expect(screen.getByTestId('ph')).toHaveAttribute('aria-label', '');
  });

  it('renders an <img> with the resolved src once coverRef is present', () => {
    setHandle('blob:cover-src', false);
    render(
      <CoverArtImage
        coverRef={ref()}
        displayCssPx={80}
        className="cover-x"
        alt="My album"
      />,
    );
    const img = screen.getByRole('img', { name: 'My album' });
    expect(img.tagName).toBe('IMG');
    expect(img).toHaveAttribute('src', 'blob:cover-src');
    expect(img).toHaveClass('cover-x');
    expect(mockedUseCoverArt).toHaveBeenCalled();
  });

  it('renders a provisional placeholder with a ref present but no src yet', () => {
    setHandle('', true);
    render(
      <CoverArtImage coverRef={ref()} displayCssPx={80} className="cover-x" alt="" />,
    );
    const placeholder = screen.getByRole('img');
    expect(placeholder.tagName).toBe('DIV');
    expect(placeholder).toHaveAttribute('data-cover-provisional', 'true');
  });

  it('renders correctly when coverRef toggles null↔present', () => {
    // The guard split keeps the hook-bearing body (CoverArtImageResolved) on a
    // separate element type from the placeholder div, so toggling coverRef swaps
    // the element rather than changing one component's hook count. (The old
    // early-return-before-hooks shape was a static rules-of-hooks lint violation,
    // not a runtime crash in React 19 — this is regression coverage either way.)
    setHandle('blob:cover-src', false);
    const { rerender } = render(
      <CoverArtImage coverRef={null} displayCssPx={80} className="cover-x" alt="cover" />,
    );
    expect(screen.getByRole('img').tagName).toBe('DIV');

    // null → present: placeholder div → resolved <img>.
    rerender(
      <CoverArtImage coverRef={ref()} displayCssPx={80} className="cover-x" alt="cover" />,
    );
    expect(screen.getByRole('img').tagName).toBe('IMG');

    // present → null: hook-bearing body unmounts cleanly back to the placeholder.
    rerender(
      <CoverArtImage coverRef={null} displayCssPx={80} className="cover-x" alt="cover" />,
    );
    expect(screen.getByRole('img').tagName).toBe('DIV');
  });
});
