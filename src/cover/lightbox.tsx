import { useCallback, useEffect, useState, type ReactNode } from 'react';
import CoverLightbox from '@/ui/CoverLightbox';
import { buildCoverArtFetchUrl } from './fetchUrl';
import { coverImgSrc } from './imgSrc';
import { getDiskSrcForGrid } from './diskSrcLookup';
import { ensureCoverTierDiskSrc } from './resolveDisk';
import type { CoverArtRef } from './types';

/** Opening window: wait this long for the full-res 2000 tier before showing 800. */
const LIGHTBOX_FULLRES_WINDOW_MS = 500;

export function useCoverLightboxSrc(
  ref: CoverArtRef | null,
  opts?: { alt?: string },
): { open: () => void; lightbox: ReactNode; src: string; loading: boolean } {
  const [open, setOpen] = useState(false);
  const [src, setSrc] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !ref) return;
    let cancelled = false;
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    void (async () => {
      // Kick the full-res (2000) ensure — Rust downloads + stores `2000.webp`. Do
      // not block the open on it: race it against a short opening window. If the
      // 2000 lands in time, show it; otherwise show the warm 800 tier now and let
      // the 2000 finish + persist in the background, so the next open is full-res.
      const fullSrc = ensureCoverTierDiskSrc(ref, 2000);
      const winner = await Promise.race([
        fullSrc,
        new Promise<''>(resolve => {
          setTimeout(() => resolve(''), LIGHTBOX_FULLRES_WINDOW_MS);
        }),
      ]);
      if (cancelled) return;
      if (winner) {
        setSrc(winner);
      } else {
        setSrc(getDiskSrcForGrid(ref, 800) || buildCoverArtFetchUrl(ref, 2000));
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // Keyed on the ref's identity fields intentionally; depending on the `ref`
    // object itself would re-fetch the lightbox source on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ref?.cacheEntityId, ref?.cacheKind, ref?.fetchCoverArtId, ref?.serverScope]);

  useEffect(() => {
    if (open) return;
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSrc('');
    setLoading(false);
  }, [open]);

  const handleClose = useCallback(() => setOpen(false), []);
  const handleOpen = useCallback(() => setOpen(true), []);

  const lightbox = open && coverImgSrc(src) && !loading ? (
    <CoverLightbox src={src} alt={opts?.alt ?? ''} onClose={handleClose} />
  ) : null;

  return { open: handleOpen, lightbox, src, loading };
}
