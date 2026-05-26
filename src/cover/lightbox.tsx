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
  }, [open, ref?.coverArtId, ref?.serverScope]);

  useEffect(() => {
    if (open) return;
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
