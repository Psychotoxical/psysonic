import type { ImgHTMLAttributes } from 'react';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_CACHED_IMAGE_PREPARE_MARGIN } from '../components/CachedImage';
import { resolveIntersectionScrollRoot } from '../utils/ui/resolveIntersectionScrollRoot';
import { coverEnsureBump } from './ensureQueue';
import { coverPrefetchBumpPriority } from './prefetchRegistry';
import { coverArtRef } from './ref';
import { coverStorageKey } from './storageKeys';
import { resolveCoverDisplayTier } from './tiers';
import { coverImgSrc } from './imgSrc';
import { useCoverArt } from './useCoverArt';
import type { DiskCoverIdHints } from './diskPeekIds';
import type { CoverArtId, CoverPrefetchPriority, CoverServerScope, CoverSurfaceKind } from './types';

export type CoverArtImageProps = {
  coverArtId: CoverArtId | null | undefined;
  displayCssPx: number;
  serverScope?: CoverServerScope;
  surface?: CoverSurfaceKind;
  fullRes?: boolean;
  className?: string;
  alt?: string;
  fetchQueueBias?: number;
  observeRootMargin?: string;
  observeScrollRootId?: string;
  /** Initial ensure tier — use `high` for hero / above-the-fold cells. */
  ensurePriority?: CoverPrefetchPriority;
  /** Extra ids to probe in `cover-cache` when the primary folder is empty. */
  diskIdHints?: DiskCoverIdHints;
  /** Library SQLite row — supplies `albumId` when Subsonic only sent `mf-*`. */
  libraryTrackId?: string;
} & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'>;

export function CoverArtImage({
  coverArtId,
  displayCssPx,
  serverScope,
  surface,
  fullRes,
  className,
  alt,
  fetchQueueBias: _fetchQueueBias,
  observeRootMargin = DEFAULT_CACHED_IMAGE_PREPARE_MARGIN,
  observeScrollRootId,
  ensurePriority: ensurePriorityProp,
  diskIdHints,
  libraryTrackId,
  onError: restOnError,
  ...rest
}: CoverArtImageProps) {
  const scope = serverScope ?? { kind: 'active' };
  const [ensurePriority, setEnsurePriority] = useState<CoverPrefetchPriority>(
    ensurePriorityProp ?? 'middle',
  );
  const imgRef = useRef<HTMLImageElement>(null);
  const [imgLoadFailed, setImgLoadFailed] = useState(false);

  useEffect(() => {
    if (ensurePriorityProp) setEnsurePriority(ensurePriorityProp);
  }, [ensurePriorityProp]);

  useEffect(() => {
    setImgLoadFailed(false);
  }, [coverArtId, displayCssPx, serverScope, surface, fullRes]);

  useEffect(() => {
    const el = imgRef.current;
    if (!el || !coverArtId) return;

    const root =
      (observeScrollRootId
        ? (document.getElementById(observeScrollRootId) as Element | null)
        : null) ?? resolveIntersectionScrollRoot(el);

    const ref = coverArtRef(coverArtId, scope);
    const tier = resolveCoverDisplayTier(displayCssPx, { surface, fullRes });
    const storageKey = coverStorageKey(scope, coverArtId, tier);
    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setEnsurePriority('high');
            coverPrefetchBumpPriority(ref, 'high');
            coverEnsureBump(storageKey, 'high');
          }
        }
      },
      {
        root: root ?? undefined,
        rootMargin: observeRootMargin,
        threshold: [0, 0.05, 0.15],
      },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [coverArtId, scope, displayCssPx, surface, fullRes, observeRootMargin, observeScrollRootId]);

  const { src, provisional, onImgError } = useCoverArt(coverArtId, displayCssPx, {
    serverScope: scope,
    surface,
    fullRes,
    ensurePriority,
    diskIdHints,
    libraryTrackId,
    alt,
  });

  const imgSrc = coverImgSrc(src);

  if (!imgSrc || imgLoadFailed) {
    return (
      <div
        ref={imgRef as React.RefObject<HTMLDivElement | null>}
        className={className}
        data-cover-provisional="true"
        data-observe-root-margin={observeRootMargin}
        data-observe-scroll-root={observeScrollRootId}
        role="img"
        aria-label={alt ?? ''}
        {...(rest as React.HTMLAttributes<HTMLDivElement>)}
      />
    );
  }

  return (
    <img
      ref={imgRef}
      src={imgSrc}
      className={className}
      alt={alt ?? ''}
      data-cover-provisional={provisional ? 'true' : undefined}
      data-observe-root-margin={observeRootMargin}
      data-observe-scroll-root={observeScrollRootId}
      {...rest}
      onError={e => {
        setImgLoadFailed(true);
        onImgError?.();
        restOnError?.(e);
      }}
    />
  );
}
