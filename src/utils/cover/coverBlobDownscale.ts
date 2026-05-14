/**
 * Client-side thumbnail path when a larger cover blob is already in cache:
 * avoids a second HTTP getCoverArt for a smaller `size=` variant.
 */

export async function downscaleCoverBlob(
  blob: Blob,
  maxPx: number,
  signal?: AbortSignal,
): Promise<Blob | null> {
  if (typeof document === 'undefined' || signal?.aborted || maxPx < 16) return null;

  let bmp: ImageBitmap | undefined;
  try {
    bmp = await createImageBitmap(blob);
    if (signal?.aborted) return null;
    const w = bmp.width;
    const h = bmp.height;
    if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h)) return null;

    const maxDim = Math.max(w, h);
    /** Skip encode work when already suitable for tiny list thumbs. */
    if (maxDim <= maxPx * 1.02) return null;

    const scale = maxPx / maxDim;
    const dw = Math.max(1, Math.round(w * scale));
    const dh = Math.max(1, Math.round(h * scale));

    const canvas = document.createElement('canvas');
    canvas.width = dw;
    canvas.height = dh;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, dw, dh);

    if (signal?.aborted) return null;

    return await new Promise<Blob | null>(resolve => {
      if (signal?.aborted) {
        resolve(null);
        return;
      }
      const finish = (b: Blob | null) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(signal?.aborted ? null : b);
      };
      const onAbort = () => finish(null);
      signal?.addEventListener('abort', onAbort, { once: true });
      canvas.toBlob(b => finish(b ?? null), 'image/jpeg', 0.88);
    });
  } catch {
    return null;
  } finally {
    try {
      bmp?.close();
    } catch {
      /* noop */
    }
  }
}
