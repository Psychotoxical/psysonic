import type { ImgHTMLAttributes } from 'react';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_CACHED_IMAGE_PREPARE_MARGIN } from '../components/CachedImage';
import { resolveIntersectionScrollRoot } from '../utils/ui/resolveIntersectionScrollRoot';
import { coverEnsureBump } from './ensureQueue';
import { coverPrefetchBumpPriority } from './prefetchRegistry';
import { coverStorageKeyFromRef } from './storageKeys';
import { resolveCoverDisplayTier } from './tiers';
import { coverImgSrc } from './imgSrc';
import { useCoverArt } from './useCoverArt';
import type { CoverArtRef, CoverPrefetchPriority, CoverSurfaceKind } from './types';

export type CoverArtImageProps = {
  coverRef: CoverArtRef;
  displayCssPx: number;
  surface?: CoverSurfaceKind;
  fullRes?: boolean;
  className?: string;
  alt?: string;
  fetchQueueBias?: number;
  observeRootMargin?: string;
  observeScrollRootId?: string;
  ensurePriority?: CoverPrefetchPriority;
} & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'>;

export function CoverArtImage({
  coverRef,
  displayCssPx,
  surface,
  fullRes,
  className,
  alt,
  fetchQueueBias: _fetchQueueBias,
  observeRootMargin = DEFAULT_CACHED_IMAGE_PREPARE_MARGIN,
  observeScrollRootId,
  ensurePriority: ensurePriorityProp,
  onError: restOnError,
  ...rest
}: CoverArtImageProps) {
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
  }, [coverRef.cacheEntityId, coverRef.cacheKind, coverRef.fetchCoverArtId, displayCssPx, surface, fullRes]);

  useEffect(() => {
    const el = imgRef.current;
    if (!el) return;

    const root =
      (observeScrollRootId
        ? (document.getElementById(observeScrollRootId) as Element | null)
        : null) ?? resolveIntersectionScrollRoot(el);

    const tier = resolveCoverDisplayTier(displayCssPx, { surface, fullRes });
    const storageKey = coverStorageKeyFromRef(coverRef, tier);
    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setEnsurePriority('high');
            coverPrefetchBumpPriority(coverRef, 'high');
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
  }, [coverRef, displayCssPx, surface, fullRes, observeRootMargin, observeScrollRootId]);

  const { src, provisional, onImgError } = useCoverArt(coverRef, displayCssPx, {
    surface,
    fullRes,
    ensurePriority,
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
