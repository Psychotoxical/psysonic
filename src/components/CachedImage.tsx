import React, { useCallback, useEffect, useRef, useState } from 'react';
import { APP_MAIN_SCROLL_VIEWPORT_ID } from '../constants/appScroll';
import { acquireUrl, getCachedBlob, releaseUrl } from '../utils/imageCache';

interface CachedImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
  src: string;
  cacheKey: string;
}

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

  // Synchronously acquire on first render when the blob is already hot. This
  // makes the very first <img src> a blob URL, avoiding a fetchUrl→blobUrl
  // swap that would trigger a redundant network request and decode pass.
  const [resolved, setResolved] = useState(() => fetchUrl ? (acquireUrl(cacheKey) ?? '') : '');
  // Tracks whichever cacheKey we currently hold a refcount on, so we know
  // exactly what to release on cleanup or when keys change.
  const ownedKeyRef = useRef<string | null>(resolved ? cacheKey : null);

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
      setResolved('');
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
      setResolved(sync);
      return release;
    }

    // Slow path: fetch (or read from IDB), then acquire.
    setResolved('');
    const controller = new AbortController();
    getCachedBlob(currentUrl, cacheKey, controller.signal, () => getPriorityRef.current?.() ?? 0).then(blob => {
      if (controller.signal.aborted || !blob) return;
      const url = acquireUrl(cacheKey);
      if (!url) return;
      ownedKeyRef.current = cacheKey;
      setResolved(url);
    });
    return () => {
      controller.abort();
      release();
    };
  }, [cacheKey]);

  return fallbackToFetch ? (resolved || fetchUrl) : resolved;
}

export default function CachedImage({ src, cacheKey, style, onLoad, onError, ...props }: CachedImageProps) {
  const [fallbackSrc, setFallbackSrc] = useState<string | undefined>(undefined);
  const imgRef = useRef<HTMLImageElement>(null);
  /**
   * Drives disk/network waiter ordering only. We intentionally do **not** gate
   * `useCachedUrl` on intersection — relying on IO to “arm” loading proved brittle
   * (custom scroll roots, content-visibility, horizontal rails) and led to blank covers.
   */
  const priorityRef = useRef(0);
  const getViewportImagePriority = useCallback(() => priorityRef.current, []);

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
        rootMargin: '300px',
        threshold: [0, 0.02, 0.1, 0.25, 0.5, 0.75, 1],
      },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Same as Hero/PlayerBar: show the salted fetch URL while IndexedDB/network resolves,
  // then swap to the shared blob URL — avoids an <img> with no src and opacity stuck at 0.
  // Priority still applies to the slow path inside getCachedBlob.
  const resolvedSrc = useCachedUrl(src, cacheKey, true, getViewportImagePriority);
  const [loaded, setLoaded] = useState(false);

  // Reset only when the logical image changes (cacheKey), not on fetchUrl→blobUrl
  // URL upgrades within the same image — avoids the end-of-load flash.
  useEffect(() => {
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
      style={{ ...style, opacity: loaded ? 1 : 0, transition: 'opacity 0.15s ease', ...fallbackStyle }}
      onLoad={e => { setLoaded(true); onLoad?.(e); }}
      onError={handleError}
      {...props}
    />
  );
}
