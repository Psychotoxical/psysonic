import type { ImgHTMLAttributes } from 'react';
import type React from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DEFAULT_CACHED_IMAGE_PREPARE_MARGIN } from '../components/CachedImage';
import { resolveIntersectionScrollRoot } from '../utils/ui/resolveIntersectionScrollRoot';
import { coverEnsureQueued, coverEnsureReprioritize } from './ensureQueue';
import { coverPrefetchBumpPriority } from './prefetchRegistry';
import { coverServerReachable } from './reachability';
import { coverStorageKeyFromRef } from './storageKeys';
import { resolveCoverDisplayTier } from './tiers';
import { coverImgSrc } from './imgSrc';
import { useCoverArt } from './useCoverArt';
import type { CoverArtRef, CoverPrefetchPriority, CoverSurfaceKind } from './types';

export type CoverArtImageProps = {
  coverRef: CoverArtRef | null | undefined;
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

/**
 * Guard wrapper: with no `coverRef` we render a provisional placeholder and run
 * no hooks. The hook-bearing body lives in `CoverArtImageResolved`, which only
 * ever mounts with a non-null `coverRef` — so its hooks are unconditional.
 */
export function CoverArtImage(props: CoverArtImageProps) {
  if (!props.coverRef) {
    const {
      coverRef: _coverRef,
      displayCssPx: _displayCssPx,
      surface: _surface,
      fullRes: _fullRes,
      fetchQueueBias: _fetchQueueBias,
      observeRootMargin: _observeRootMargin,
      observeScrollRootId: _observeScrollRootId,
      ensurePriority: _ensurePriority,
      onError: _onError,
      className,
      alt,
      ...rest
    } = props;
    return (
      <div
        className={className}
        data-cover-provisional="true"
        role="img"
        aria-label={alt ?? ''}
        {...(rest as React.HTMLAttributes<HTMLDivElement>)}
      />
    );
  }
  return <CoverArtImageResolved {...props} coverRef={props.coverRef} />;
}

type CoverArtImageResolvedProps = Omit<CoverArtImageProps, 'coverRef'> & { coverRef: CoverArtRef };

function CoverArtImageResolved({
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
}: CoverArtImageResolvedProps) {
  const pinnedHigh = ensurePriorityProp === 'high';
  const [ensurePriority, setEnsurePriority] = useState<CoverPrefetchPriority>(
    ensurePriorityProp ?? 'middle',
  );
  const [seenViewport, setSeenViewport] = useState(false);
  const seenViewportRef = useRef(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const [imgLoadFailed, setImgLoadFailed] = useState(false);

  useEffect(() => {
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (ensurePriorityProp) setEnsurePriority(ensurePriorityProp);
  }, [ensurePriorityProp]);

  useEffect(() => {
    seenViewportRef.current = seenViewport;
  }, [seenViewport]);

  useEffect(() => {
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setImgLoadFailed(false);
  }, [coverRef.cacheEntityId, coverRef.cacheKind, coverRef.fetchCoverArtId, displayCssPx, surface, fullRes]);

  useLayoutEffect(() => {
    const el = imgRef.current;
    if (!el) return;

    const root =
      (observeScrollRootId
        ? (document.getElementById(observeScrollRootId) as Element | null)
        : null) ?? resolveIntersectionScrollRoot(el);

    const tier = resolveCoverDisplayTier(displayCssPx, { surface, fullRes });
    const storageKey = coverStorageKeyFromRef(coverRef, tier);
    const reachable = coverServerReachable(coverRef.serverScope);

    const queueEnsure = (priority: CoverPrefetchPriority) => {
      if (!reachable) return;
      void coverEnsureQueued(storageKey, coverRef, tier, priority);
    };

    const applyIntersecting = () => {
      seenViewportRef.current = true;
      setSeenViewport(true);
      setEnsurePriority('high');
      coverPrefetchBumpPriority(coverRef, 'high');
      coverEnsureReprioritize(storageKey, 'high');
      queueEnsure('high');
    };

    const applyLeftViewport = () => {
      if (!seenViewportRef.current || pinnedHigh) return;
      setEnsurePriority('middle');
      coverEnsureReprioritize(storageKey, 'middle');
      queueEnsure('middle');
    };

    const applyEntry = (entry: IntersectionObserverEntry) => {
      if (entry.isIntersecting) applyIntersecting();
      else applyLeftViewport();
    };

    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) applyEntry(entry);
      },
      {
        root: root ?? undefined,
        rootMargin: observeRootMargin,
        threshold: [0, 0.05, 0.15],
      },
    );
    observer.observe(el);

    const drainRecords = () => {
      for (const entry of observer.takeRecords()) applyEntry(entry);
    };
    drainRecords();

    let cancelled = false;
    const raf1 = requestAnimationFrame(() => {
      if (cancelled) return;
      drainRecords();
      requestAnimationFrame(() => {
        if (cancelled) return;
        drainRecords();
      });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
      observer.disconnect();
    };
  }, [
    coverRef,
    displayCssPx,
    surface,
    fullRes,
    observeRootMargin,
    observeScrollRootId,
    pinnedHigh,
  ]);

  const { src, provisional, onImgError } = useCoverArt(coverRef, displayCssPx, {
    surface,
    fullRes,
    ensurePriority,
    seenViewport,
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
