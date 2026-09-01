/**
 * Psysonic Rewind poster renderer — assembles the render context (fonts,
 * covers, wordmark, background) and dispatches to one of the four layouts.
 * The layouts arrange components; they never re-define colors or effects.
 */

import { loadWordmark } from '@/features/album';
import { albumExportCoverRef, loadCoverBlobForExport } from '@/cover/integrations/export';
import { paintBackground, paintGrain } from './draw';
import { renderAlbumLayout } from './layouts/album';
import { renderArtistLayout } from './layouts/artist';
import { renderNerdLayout } from './layouts/nerd';
import { renderOverviewLayout } from './layouts/overview';
import {
  REWIND_COLORS,
  REWIND_DIMENSIONS,
  REWIND_FONT_DISPLAY,
  REWIND_FONT_TEXT,
  REWIND_SAFE,
  REWIND_TYPE,
} from './tokens';
import type { RewindData, RewindPosterFormat, RewindPosterLayout, RewindRenderContext, RewindStrings } from './types';

export type { RewindData, RewindPosterFormat, RewindPosterLayout, RewindStrings } from './types';

export interface RewindPosterOptions {
  data: RewindData;
  layout: RewindPosterLayout;
  format: RewindPosterFormat;
  strings: RewindStrings;
}

/** Where the radial hero glow sits per layout (fraction of w/h). */
const HERO_GLOW: Record<RewindPosterLayout, { x: number; y: number }> = {
  overview: { x: 0.3, y: 0.3 },
  artist: { x: 0.35, y: 0.36 },
  album: { x: 0.5, y: 0.34 },
  nerd: { x: 0.3, y: 0.28 },
};

/** How many top-album covers a layout draws. */
function coverCount(layout: RewindPosterLayout): number {
  return layout === 'overview' || layout === 'album' ? 5 : 0;
}

async function loadCovers(data: RewindData, count: number): Promise<Map<number, ImageBitmap>> {
  const covers = new Map<number, ImageBitmap>();
  const albums = data.recap.topAlbums.slice(0, count);
  await Promise.all(
    albums.map(async (album, i) => {
      if (!album.albumId) return;
      const ref = albumExportCoverRef({
        id: album.albumId,
        coverArt: album.coverArtId ?? undefined,
        serverId: album.serverId ?? undefined,
      });
      if (!ref) return;
      try {
        const blob = await loadCoverBlobForExport(ref, i === 0 ? 640 : 320);
        if (blob) covers.set(i, await createImageBitmap(blob));
      } catch {
        // §11: a missing cover falls back to the waveform tile.
      }
    }),
  );
  return covers;
}

/**
 * §8: one or two dominant cover colours, mixed very subtly into the gradient.
 * Saturation-weighted average over a downsampled cover; null for grey covers.
 */
function extractCoverTint(cover: ImageBitmap): string | null {
  const size = 12;
  const probe = document.createElement('canvas');
  probe.width = size;
  probe.height = size;
  const ctx = probe.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(cover, 0, 0, size, size);
  let r = 0;
  let g = 0;
  let b = 0;
  let weight = 0;
  try {
    const pixels = ctx.getImageData(0, 0, size, size).data;
    for (let i = 0; i < pixels.length; i += 4) {
      const max = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
      const min = Math.min(pixels[i], pixels[i + 1], pixels[i + 2]);
      const saturation = max - min;
      const lift = saturation * (max / 255);
      r += pixels[i] * lift;
      g += pixels[i + 1] * lift;
      b += pixels[i + 2] * lift;
      weight += lift;
    }
  } catch {
    return null;
  }
  if (weight < 1) return null;
  return `rgb(${Math.round(r / weight)}, ${Math.round(g / weight)}, ${Math.round(b / weight)})`;
}

/** Best-effort font warm-up so canvas text uses the brand faces, not system-ui. */
async function ensureFonts(): Promise<void> {
  try {
    await Promise.all([
      document.fonts.load(`800 100px ${REWIND_FONT_DISPLAY}`),
      document.fonts.load(`700 32px ${REWIND_FONT_DISPLAY}`),
      document.fonts.load(`600 26px ${REWIND_FONT_TEXT}`),
    ]);
  } catch {
    // Canvas falls back to the stack's system faces.
  }
}

export async function renderRewindPoster(opts: RewindPosterOptions): Promise<HTMLCanvasElement> {
  const { layout, format, data, strings } = opts;
  const dims = REWIND_DIMENSIONS[format];
  const canvas = document.createElement('canvas');
  canvas.width = dims.w;
  canvas.height = dims.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d unavailable');

  await ensureFonts();
  const [covers, wordmark] = await Promise.all([
    loadCovers(data, coverCount(layout)),
    loadWordmark(REWIND_COLORS.brightPurple).catch(() => null),
  ]);

  const glow = HERO_GLOW[layout];
  const heroCover = layout === 'album' ? covers.get(0) : undefined;
  paintBackground(
    ctx,
    dims.w,
    dims.h,
    { x: dims.w * glow.x, y: dims.h * glow.y, r: Math.max(dims.w, dims.h) * 0.55 },
    heroCover ? extractCoverTint(heroCover) : null,
  );

  const rc: RewindRenderContext = {
    ctx,
    w: dims.w,
    h: dims.h,
    format,
    type: REWIND_TYPE[format],
    strings,
    data,
    seed: data.year * 97 + layout.length,
    covers,
    wordmark,
    pad: REWIND_SAFE.x,
    contentBottom: dims.h - REWIND_SAFE.bottom - REWIND_TYPE[format].footer * 2 - 34,
  };

  switch (layout) {
    case 'overview':
      renderOverviewLayout(rc);
      break;
    case 'artist':
      renderArtistLayout(rc);
      break;
    case 'album':
      renderAlbumLayout(rc);
      break;
    case 'nerd':
      renderNerdLayout(rc);
      break;
  }

  paintGrain(ctx, dims.w, dims.h, rc.seed + 7);
  return canvas;
}

export async function exportRewindPosterBlob(opts: RewindPosterOptions): Promise<Blob> {
  const canvas = await renderRewindPoster(opts);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob returned null'))), 'image/png');
  });
}
