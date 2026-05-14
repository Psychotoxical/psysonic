import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { APP_MAIN_SCROLL_VIEWPORT_ID } from '../constants/appScroll';
import { acquireUrl, getCachedBlob, releaseUrl, subscribeCoverUpgraded } from '../utils/imageCache';

interface CachedImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  src: string;
  cacheKey: string;
  /**
   * Added to the viewport-based score when waiting for a `getCachedBlob` **network** slot.
   * Use to order tiers (e.g. search: artist thumbs before album thumbs) without changing layout.
   */
  fetchQueueBias?: number;
  /**
   * How far beyond the app scroll viewport `IntersectionObserver` expands the root.
   * Larger = priority / slot ordering updates while the row is still off-screen → less
   * empty flash when it hits the viewport. CSS margin syntax (`440px`, `10% 0`, …).
   */
  observeRootMargin?: string;
}

/** Search UI: load artist avatars before album covers when many requests compete. */
export const FETCH_QUEUE_BIAS_SEARCH_ARTIST_OVER_ALBUM = 1_000_000_000;

/** Default IO lead — slightly before visible to reduce scroll-in jitter (tune per `CachedImage`). */
export const DEFAULT_CACHED_IMAGE_PREPARE_MARGIN = '440px';

/** Blob URL paired with the `cacheKey` it was acquired for (`useCachedUrl`). */
type ResolvedSlice = { key: string | null; url: string };

/**
 * Returns a shared, refcounted object URL for a cached image. Multiple
 * consumers of the same cacheKey see the exact same URL string, so the
 * browser's decoded-image cache hits across instances — critical on
 * Chromium/WebView2 (Windows), which keys decode results by URL.
 *
 * @param fallbackToFetch  If true (default), returns the raw fetchUrl while the
 *   blob is still resolving — useful for <img> tags so the browser starts
 *   loading immediately.  Pass false for CSS background-image consumers that
 *   should only see a stable blob URL (prevents a double crossfade).
 */
export function useCachedUrl(
  fetchUrl: string,
  cacheKey: string,
  fallbackToFetch = true,
  getPriority?: () => number,
): string {
  // `buildCoverArtUrl` rotates salt/token on every call — `fetchUrl` is a new
  // string each render though the logical image is unchanged (`cacheKey`). If
  // `fetchUrl` were an effect dependency, cleanup would run every frame, call
  // `releaseUrl`, revoke the blob, and break <img> until onError hides it.
  const fetchUrlRef = useRef(fetchUrl);
  fetchUrlRef.current = fetchUrl;

  // Pair blob URL with the `cacheKey` it belongs to. After `cacheKey` changes,
  // React keeps old state for one render — returning that stale blob URL made
  // `<img src>` point at a released object URL (broken image) until effects ran.
  const [resolvedSlice, setResolvedSlice] = useState<ResolvedSlice>(() => {
    if (!fetchUrl) return { key: null, url: '' };
    const sync = acquireUrl(cacheKey);
    return sync ? { key: cacheKey, url: sync } : { key: null, url: '' };
  });
  // Tracks whichever cacheKey we currently hold a refcount on, so we know
  // exactly what to release on cleanup or when keys change.
  const ownedKeyRef = useRef<string | null>(
    resolvedSlice.key === cacheKey && resolvedSlice.url ? cacheKey : null,
  );

  const getPriorityRef = useRef(getPriority);
  getPriorityRef.current = getPriority;

  useEffect(() => {
    const release = () => {
      if (ownedKeyRef.current) {
        releaseUrl(ownedKeyRef.current);
        ownedKeyRef.current = null;
      }
    };

    const currentUrl = fetchUrlRef.current;
    if (!currentUrl) {
      release();
      setResolvedSlice({ key: null, url: '' });
      return release;
    }

    // Same logical image as last run — only `cacheKey` drives this effect.
    if (ownedKeyRef.current === cacheKey) {
      return release;
    }

    // Different key than we're currently holding: drop the old one.
    release();

    // Fast path: blob is hot in memory → grab the shared URL synchronously.
    const sync = acquireUrl(cacheKey);
    if (sync) {
      ownedKeyRef.current = cacheKey;
      setResolvedSlice({ key: cacheKey, url: sync });
      return release;
    }

    // Slow path: fetch (or read from IDB), then acquire.
    setResolvedSlice({ key: cacheKey, url: '' });
    const controller = new AbortController();
    getCachedBlob(currentUrl, cacheKey, controller.signal, () => getPriorityRef.current?.() ?? 0).then(blob => {
      if (controller.signal.aborted || !blob) return;
      const url = acquireUrl(cacheKey);
      if (!url) return;
      ownedKeyRef.current = cacheKey;
      setResolvedSlice({ key: cacheKey, url });
    });
    return () => {
      controller.abort();
      release();
    };
  }, [cacheKey]);

  useEffect(() => {
    if (!fetchUrl || !fallbackToFetch) return;
    let cancelled = false;
    const unsub = subscribeCoverUpgraded(cacheKey, () => {
      if (cancelled) return;
      const refreshed = acquireUrl(cacheKey);
      if (refreshed) {
        ownedKeyRef.current = cacheKey;
        setResolvedSlice({ key: cacheKey, url: refreshed });
      }
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [cacheKey, fetchUrl, fallbackToFetch]);

  const matched =
    resolvedSlice.key === cacheKey && resolvedSlice.url ? resolvedSlice.url : '';
  return fallbackToFetch ? (matched || fetchUrl) : matched;
}

export default function CachedImage({
  src,
  cacheKey,
  fetchQueueBias = 0,
  observeRootMargin = DEFAULT_CACHED_IMAGE_PREPARE_MARGIN,
  style,
  onLoad,
  onError,
  ...props
}: CachedImageProps) {
  const [fallbackSrc, setFallbackSrc] = useState<string | undefined>(undefined);
  const imgRef = useRef<HTMLImageElement>(null);
  /**
   * Drives disk/network waiter ordering only. We intentionally do **not** gate
   * `useCachedUrl` on intersection — relying on IO to “arm” loading proved brittle
   * (custom scroll roots, content-visibility, horizontal rails) and led to blank covers.
   */
  const priorityRef = useRef(0);
  const getViewportImagePriority = useCallback(
    () => fetchQueueBias + priorityRef.current,
    [fetchQueueBias],
  );

  useEffect(() => {
    const el = imgRef.current;
    if (!el) return;
    const root =
      typeof document !== 'undefined'
        ? (document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID) as Element | null)
        : null;
    const updateFromEntry = (entry: IntersectionObserverEntry) => {
      if (entry.isIntersecting) {
        const r = entry.boundingClientRect;
        const rootEl = entry.rootBounds;
        const vh = (rootEl?.height ?? window.innerHeight) || 1;
        const originTop = rootEl?.top ?? 0;
        const vc = originTop + vh * 0.5;
        const cy = r.top + r.height * 0.5;
        const dist = Math.abs(cy - vc);
        priorityRef.current = entry.intersectionRatio * 1e7 - dist * 1e3;
      } else {
        priorityRef.current = -1e12;
      }
    };
    const observer = new IntersectionObserver(
      entries => { for (const e of entries) updateFromEntry(e); },
      {
        root: root ?? undefined,
        rootMargin: observeRootMargin,
        threshold: [0, 0.02, 0.1, 0.25, 0.5, 0.75, 1],
      },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [observeRootMargin]);

  // Same as Hero/PlayerBar: show the salted fetch URL while IndexedDB/network resolves,
  // then swap to the shared blob URL — avoids an <img> with no src and opacity stuck at 0.
  // Priority still applies to the slow path inside getCachedBlob.
  const resolvedSrc = useCachedUrl(src, cacheKey, true, getViewportImagePriority);
  const [loaded, setLoaded] = useState(false);

  // Reset only when the logical image changes (cacheKey), not on fetchUrl→blobUrl
  // URL upgrades within the same image — avoids the end-of-load flash.
  // useLayoutEffect: one paint with `loaded` still true + a stale/wrong `src`
  // showed a broken-cover flash in the player bar when switching tracks (#606).
  useLayoutEffect(() => {
    setLoaded(false);
    setFallbackSrc(undefined);
  }, [cacheKey]);

  const isFallback = fallbackSrc !== undefined;
  const finalSrc = fallbackSrc ?? (resolvedSrc || undefined);

  // Browsers sometimes skip `load` for cache hits / lazy + horizontal scroll — unstick opacity.
  useEffect(() => {
    if (!finalSrc) return;
    let alive = true;
    const id = requestAnimationFrame(() => {
      if (!alive) return;
      const img = imgRef.current;
      if (img?.complete && img.naturalWidth > 0) {
        setLoaded(true);
      }
    });
    return () => {
      alive = false;
      cancelAnimationFrame(id);
    };
  }, [finalSrc]);

  const handleError = (e: React.SyntheticEvent<HTMLImageElement>) => {
    if (onError) {
      // Caller wants custom error handling (e.g. hide the element)
      onError(e);
    } else {
      // Nullify the DOM-level handler first to prevent any infinite loop
      e.currentTarget.onerror = null;
      setFallbackSrc('/logo-psysonic.png');
    }
  };

  const fallbackStyle: React.CSSProperties = isFallback
    ? { objectFit: 'contain', background: 'var(--bg-card, var(--ctp-surface0, #313244))', padding: '15%' }
    : {};

  return (
    <img
      ref={imgRef}
      src={finalSrc}
      style={{ ...style, opacity: loaded ? 1 : 0, ...fallbackStyle }}
      onLoad={e => { setLoaded(true); onLoad?.(e); }}
      onError={handleError}
      {...props}
    />
  );
}
