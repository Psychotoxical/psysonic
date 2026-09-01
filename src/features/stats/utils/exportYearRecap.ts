import { loadWordmark } from '@/features/album';
import { albumExportCoverRef, loadCoverBlobForExport } from '@/cover/integrations/export';
import type { PlaySessionHeatmapDay, PlaySessionYearRecap } from '@/lib/api/library';
import {
  listeningPersona,
  losslessPercent,
  splitHoursMinutes,
  type ListeningPersona,
} from './yearRecapDerive';

export type RecapPosterFormat = 'story' | 'square';
export type RecapPosterPalette = 'midnight' | 'daylight';

/** Localised copy the poster draws. Kept as data so the renderer stays pure. */
export interface RecapPosterStrings {
  kicker: string;
  title: string;
  hoursLabel: string;
  daysLabel: string;
  playsLabel: string;
  newArtistsLabel: string;
  topArtists: string;
  topAlbums: string;
  losslessLabel: string;
  personaLabel: string | null;
  privacy: string;
}

export interface RecapPosterOptions {
  recap: PlaySessionYearRecap;
  heatmap: PlaySessionHeatmapDay[];
  year: number;
  listeningDayCount: number;
  format: RecapPosterFormat;
  palette: RecapPosterPalette;
  strings: RecapPosterStrings;
}

const DIMENSIONS: Record<RecapPosterFormat, { w: number; h: number }> = {
  story: { w: 1080, h: 1920 },
  square: { w: 1080, h: 1080 },
};

/** Curated poster palettes — deliberately theme-independent so shared images
 *  stay recognisable as Psysonic regardless of the exporter's theme. */
const PALETTES: Record<RecapPosterPalette, {
  bgTop: string;
  bgBottom: string;
  fg: string;
  muted: string;
  accent: string;
  cell: string;
}> = {
  midnight: {
    bgTop: '#101223',
    bgBottom: '#1D1136',
    fg: '#F2F0FF',
    muted: '#9A94C2',
    accent: '#A78BFA',
    cell: '#2A2547',
  },
  daylight: {
    bgTop: '#FAF7F2',
    bgBottom: '#EDE4FF',
    fg: '#221A3D',
    muted: '#6F6890',
    accent: '#7C3AED',
    cell: '#DCD4EE',
  },
};

const FONT_DISPLAY = '"Space Grotesk", "Inter", system-ui, sans-serif';
const FONT_TEXT = '"Inter", system-ui, sans-serif';

export function personaForPoster(recap: PlaySessionYearRecap): ListeningPersona | null {
  return listeningPersona(recap.hourlyPlayCounts);
}

export async function renderYearRecapCanvas(opts: RecapPosterOptions): Promise<HTMLCanvasElement> {
  const { recap, heatmap, year, format, strings } = opts;
  const pal = PALETTES[opts.palette];
  const dims = DIMENSIONS[format];
  const w = dims.w;
  const h = dims.h;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d unavailable');

  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, pal.bgTop);
  bg.addColorStop(1, pal.bgBottom);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  const pad = Math.round(w * 0.074);
  let y = pad;

  // The square runs much tighter than the story, so it uses compact metrics —
  // and every section below the stat row checks the content budget before
  // drawing, so nothing can ever run into the fixed footer band again.
  const compact = format === 'square';
  const footerTopY = h - pad - 50;
  const contentBottom = footerTopY - 14;

  // ── Header: wordmark left, year right ─────────────────────────────────
  const logo = await loadWordmark(pal.accent).catch(() => null);
  const logoH = 44;
  if (logo) {
    const ratio = logo.naturalWidth / logo.naturalHeight || 4.4;
    ctx.drawImage(logo, pad, y, Math.round(logoH * ratio), logoH);
  }
  ctx.font = `700 ${logoH * 0.75}px ${FONT_DISPLAY}`;
  ctx.fillStyle = pal.muted;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(year), w - pad, y + logoH / 2);
  y += logoH + Math.round(h * (compact ? 0.016 : 0.028));

  // ── Kicker + title ────────────────────────────────────────────────────
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `600 26px ${FONT_TEXT}`;
  ctx.fillStyle = pal.accent;
  ctx.fillText(strings.kicker.toUpperCase(), pad, y + 26);
  y += 26 + (compact ? 10 : 16);
  ctx.font = `700 56px ${FONT_DISPLAY}`;
  ctx.fillStyle = pal.fg;
  ctx.fillText(fitText(ctx, strings.title, w - pad * 2), pad, y + 56);
  y += 56 + Math.round(h * (compact ? 0.019 : 0.03));

  // ── Big hours number + stat row ───────────────────────────────────────
  const time = splitHoursMinutes(recap.totalListenedSec);
  const bigSize = compact ? 100 : 150;
  ctx.font = `800 ${bigSize}px ${FONT_DISPLAY}`;
  ctx.fillStyle = pal.accent;
  ctx.fillText(time.hours.toLocaleString(), pad, y + bigSize);
  const hoursW = ctx.measureText(time.hours.toLocaleString()).width;
  ctx.font = `600 30px ${FONT_TEXT}`;
  ctx.fillStyle = pal.muted;
  ctx.fillText(strings.hoursLabel, pad + hoursW + 20, y + bigSize - 10);
  y += bigSize + Math.round(h * (compact ? 0.017 : 0.026));

  const stats: { value: string; label: string }[] = [
    { value: opts.listeningDayCount.toLocaleString(), label: strings.daysLabel },
    { value: sumPlays(recap).toLocaleString(), label: strings.playsLabel },
    { value: recap.newArtistCount.toLocaleString(), label: strings.newArtistsLabel },
  ];
  const statW = Math.floor((w - pad * 2) / stats.length);
  stats.forEach((s, i) => {
    const x = pad + i * statW;
    ctx.font = `700 44px ${FONT_DISPLAY}`;
    ctx.fillStyle = pal.fg;
    ctx.fillText(s.value, x, y + 44);
    ctx.font = `500 22px ${FONT_TEXT}`;
    ctx.fillStyle = pal.muted;
    ctx.fillText(fitText(ctx, s.label, statW - 24), x, y + 44 + 32);
  });
  y += 44 + 32 + Math.round(h * (compact ? 0.022 : 0.032));

  // ── Top artists (left) and top-album covers (right / below) ──────────
  const artists = recap.topArtists.slice(0, 5);
  if (artists.length > 0) {
    ctx.font = `700 24px ${FONT_TEXT}`;
    ctx.fillStyle = pal.accent;
    ctx.fillText(strings.topArtists.toUpperCase(), pad, y + 24);
    y += 24 + 14;
    const rowH = compact ? 38 : 42;
    artists.forEach((a, i) => {
      ctx.font = `700 28px ${FONT_TEXT}`;
      ctx.fillStyle = pal.muted;
      ctx.fillText(String(i + 1), pad, y + 28);
      ctx.font = `600 28px ${FONT_TEXT}`;
      ctx.fillStyle = pal.fg;
      ctx.fillText(fitText(ctx, a.name, w - pad * 2 - 46), pad + 46, y + 28);
      y += rowH;
    });
    y += Math.round(h * (compact ? 0.008 : 0.012));
  }

  // Covers row — only when at least a small tile still fits above the footer.
  const albums = recap.topAlbums.slice(0, 5).filter(a => a.albumId);
  const coverBudget = contentBottom - y - 38;
  if (albums.length > 0 && coverBudget >= 96) {
    ctx.font = `700 24px ${FONT_TEXT}`;
    ctx.fillStyle = pal.accent;
    ctx.fillText(strings.topAlbums.toUpperCase(), pad, y + 24);
    y += 24 + 14;
    const coverGap = 16;
    const coverSize = Math.min(
      compact ? 112 : 168,
      Math.floor((w - pad * 2 - coverGap * (albums.length - 1)) / albums.length),
      coverBudget,
    );
    const covers = await Promise.all(
      albums.map(async a => {
        const ref = albumExportCoverRef({
          id: a.albumId ?? '',
          coverArt: a.coverArtId ?? undefined,
          serverId: a.serverId ?? undefined,
        });
        if (!ref) return null;
        try {
          const blob = await loadCoverBlobForExport(ref, coverSize);
          return blob ? await createImageBitmap(blob) : null;
        } catch {
          return null;
        }
      }),
    );
    covers.forEach((cover, i) => {
      const x = pad + i * (coverSize + coverGap);
      if (cover) {
        ctx.drawImage(cover, x, y, coverSize, coverSize);
      } else {
        ctx.fillStyle = pal.cell;
        ctx.fillRect(x, y, coverSize, coverSize);
      }
    });
    y += coverSize + Math.round(h * (compact ? 0.019 : 0.03));
  }

  // ── Heatmap grid (story only — square runs out of room) ───────────────
  if (format === 'story' && y + 140 <= contentBottom) {
    y = drawHeatmap(ctx, heatmap, year, pad, y, w - pad * 2, pal);
    y += Math.round(h * 0.028);
  }

  // ── Lossless bar + persona line (each only when it fits the budget) ───
  const lossless = losslessPercent(recap.losslessListenedSec, recap.totalListenedSec);
  if (lossless !== null && lossless > 0 && y + 50 <= contentBottom) {
    ctx.font = `600 24px ${FONT_TEXT}`;
    ctx.fillStyle = pal.fg;
    ctx.fillText(`${lossless}% ${strings.losslessLabel}`, pad, y + 24);
    y += 24 + 12;
    const barW = w - pad * 2;
    ctx.fillStyle = pal.cell;
    fillRoundRect(ctx, pad, y, barW, 14, 7);
    ctx.fillStyle = pal.accent;
    fillRoundRect(ctx, pad, y, Math.max(14, Math.round(barW * (lossless / 100))), 14, 7);
    y += 14 + Math.round(h * 0.022);
  }
  if (strings.personaLabel && y + 24 <= contentBottom) {
    ctx.font = `600 24px ${FONT_TEXT}`;
    ctx.fillStyle = pal.muted;
    ctx.fillText(`${strings.personaLabel}`, pad, y + 24);
  }

  // ── Footer: privacy line + site ───────────────────────────────────────
  ctx.textAlign = 'center';
  ctx.font = `500 20px ${FONT_TEXT}`;
  ctx.fillStyle = pal.muted;
  ctx.fillText(fitText(ctx, strings.privacy, w - pad * 2), w / 2, h - pad - 30);
  ctx.font = `600 20px ${FONT_TEXT}`;
  ctx.fillStyle = pal.accent;
  ctx.fillText('www.psysonic.de', w / 2, h - pad);

  return canvas;
}

export async function exportYearRecapBlob(opts: RecapPosterOptions): Promise<Blob> {
  const canvas = await renderYearRecapCanvas(opts);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob returned null'))), 'image/png');
  });
}

function sumPlays(recap: PlaySessionYearRecap): number {
  return recap.hourlyPlayCounts.reduce((acc, n) => acc + n, 0);
}

/** Ellipsizes `text` so it fits within `maxWidth` at the current ctx font. */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

function fillRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

/** 53×7 GitHub-style year grid. Returns the y just below the grid. */
function drawHeatmap(
  ctx: CanvasRenderingContext2D,
  heatmap: PlaySessionHeatmapDay[],
  year: number,
  x: number,
  y: number,
  maxWidth: number,
  pal: { accent: string; cell: string },
): number {
  const counts = new Map(heatmap.map(d => [d.date, d.trackPlayCount]));
  const max = Math.max(...heatmap.map(d => d.trackPlayCount), 1);
  const weeks = 53;
  const gap = 3;
  const cell = Math.floor((maxWidth - gap * (weeks - 1)) / weeks);
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const startDow = jan1.getUTCDay(); // 0 = Sunday
  const daysInYear = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86_400_000;

  for (let day = 0; day < daysInYear; day++) {
    const slot = startDow + day;
    const week = Math.floor(slot / 7);
    const dow = slot % 7;
    const date = new Date(Date.UTC(year, 0, 1 + day)).toISOString().slice(0, 10);
    const count = counts.get(date) ?? 0;
    if (count === 0) {
      ctx.fillStyle = pal.cell;
      ctx.globalAlpha = 0.55;
    } else {
      ctx.fillStyle = pal.accent;
      ctx.globalAlpha = 0.35 + 0.65 * Math.min(1, count / max);
    }
    ctx.fillRect(x + week * (cell + gap), y + dow * (cell + gap), cell, cell);
  }
  ctx.globalAlpha = 1;
  return y + 7 * cell + 6 * gap;
}
