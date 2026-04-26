import React, { useEffect, useRef, useState } from 'react';
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
export function useCachedUrl(fetchUrl: string, cacheKey: string, fallbackToFetch = true): string {
  // Synchronously acquire on first render when the blob is already hot. This
  // makes the very first <img src> a blob URL, avoiding a fetchUrl→blobUrl
  // swap that would trigger a redundant network request and decode pass.
  const [resolved, setResolved] = useState(() => fetchUrl ? (acquireUrl(cacheKey) ?? '') : '');
  // Tracks whichever cacheKey we currently hold a refcount on, so we know
  // exactly what to release on cleanup or when keys change.
  const ownedKeyRef = useRef<string | null>(resolved ? cacheKey : null);

  useEffect(() => {
    const release = () => {
      if (ownedKeyRef.current) {
        releaseUrl(ownedKeyRef.current);
        ownedKeyRef.current = null;
      }
    };

    if (!fetchUrl) {
      release();
      setResolved('');
      return;
    }

    // Lazy initializer (or a previous run) already acquired the right key.
    if (ownedKeyRef.current === cacheKey) return release;

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
    getCachedBlob(fetchUrl, cacheKey, controller.signal).then(blob => {
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
  }, [fetchUrl, cacheKey]);

  return fallbackToFetch ? (resolved || fetchUrl) : resolved;
}

export default function CachedImage({ src, cacheKey, style, onLoad, onError, ...props }: CachedImageProps) {
  const [inView, setInView] = useState(false);
  const [fallbackSrc, setFallbackSrc] = useState<string | undefined>(undefined);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const el = imgRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setInView(true); observer.disconnect(); } },
      { rootMargin: '300px' }, // start fetching 300px before entering viewport
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Pass empty string when not yet in view so useCachedUrl skips the fetch entirely.
  // fallbackToFetch=false: avoid the fetchUrl→blobUrl src swap, which causes the browser
  // to start a server fetch, then abort it when we replace src with the blob URL —
  // visible in DevTools as a flood of "Pending / 0 B" requests on Chromium/WebView2.
  const resolvedSrc = useCachedUrl(inView ? src : '', cacheKey, false);
  const [loaded, setLoaded] = useState(false);

  // Reset only when the logical image changes (cacheKey), not on fetchUrl→blobUrl
  // URL upgrades within the same image — avoids the end-of-load flash.
  useEffect(() => {
    setLoaded(false);
    setFallbackSrc(undefined);
  }, [cacheKey]);

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

  const isFallback = fallbackSrc !== undefined;
  const finalSrc = fallbackSrc ?? (resolvedSrc || undefined);

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
