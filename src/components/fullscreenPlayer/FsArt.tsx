import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Music } from 'lucide-react';
import { useCachedUrl } from '../CachedImage';

// Album art box — crossfades layers so old art stays visible while new loads.
// Uses 300px thumbnails (portrait fallback uses 500px separately).
//
// Why onLoad instead of new Image() preload:
//   React batches setLayers(add invisible) + rAF setLayers(make visible) into one
//   commit, so the browser never sees opacity:0 and the CSS transition never fires.
//   Using the DOM img's own onLoad guarantees the element was painted at opacity:0
//   before we flip it to 1.
export const FsArt = memo(function FsArt({ fetchUrl, cacheKey }: { fetchUrl: string; cacheKey: string }) {
  // true = show raw fetchUrl immediately as fallback while blob resolves.
  // PlayerBar uses 128px; FS player uses 300px — different cache keys, no warm hit.
  // Showing the URL directly avoids the multi-second blank wait.
  const blobUrl = useCachedUrl(fetchUrl, cacheKey, true);

  const [layers, setLayers] = useState<Array<{ src: string; id: number; vis: boolean }>>([]);
  const counter = useRef(0);
  const cleanupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!blobUrl) return;
    const id = ++counter.current;
    setLayers(prev => [...prev, { src: blobUrl, id, vis: false }]);
  }, [blobUrl]);

  const handleLoad = useCallback((id: number) => {
    if (cleanupTimer.current) clearTimeout(cleanupTimer.current);
    setLayers(prev => prev.map(l => ({ ...l, vis: l.id === id })));
    cleanupTimer.current = setTimeout(() => setLayers(prev => prev.filter(l => l.id === id)), 400);
  }, []);

  if (layers.length === 0) {
    return <div className="fs-art fs-art-placeholder"><Music size={40} /></div>;
  }

  return (
    <>
      {layers.map(l => (
        <img
          key={l.id}
          src={l.src}
          className="fs-art"
          style={{ opacity: l.vis ? 1 : 0 }}
          onLoad={() => handleLoad(l.id)}
          alt=""
          decoding="async"
        />
      ))}
    </>
  );
});
