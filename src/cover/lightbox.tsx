import { useCallback, useEffect, useState, type ReactNode } from 'react';
import CoverLightbox from '../components/CoverLightbox';
import { buildCoverArtFetchUrl } from './fetchUrl';
import { coverImgSrc } from './imgSrc';
import { ensureCoverTierDiskSrc } from './resolveDisk';
import type { CoverArtRef } from './types';

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
      const diskSrc = await ensureCoverTierDiskSrc(ref, 2000);
      if (cancelled) return;
      if (diskSrc) {
        setSrc(diskSrc);
      } else {
        setSrc(buildCoverArtFetchUrl(ref, 2000));
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
