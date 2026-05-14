import { buildCoverArtUrl, coverArtCacheKey } from '../../api/subsonicStreamUrl';
import type { SubsonicAlbum } from '../../api/subsonicTypes';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getCachedBlob } from '../imageCache';
import PsysonicLogo from '../../components/PsysonicLogo';

export type ExportFormat = 'story' | 'square' | 'twitter';
export type ExportGridSize = 3 | 4 | 5;

export interface ExportAlbumCardOptions {
  albums: SubsonicAlbum[];
  format: ExportFormat;
  gridSize: ExportGridSize;
  /** Footer label like "Top Albums". */
  title: string;
  /** Footer secondary label like the period or "Most Played". */
  periodLabel?: string;
  /** Footer-right text shown next to the wordmark, usually a period or count. */
  meta?: string;
  /** Optional explicit accent override; defaults to the document's `--accent`. */
  accent?: string;
  /** Optional explicit background override; defaults to the document's `--bg-primary`. */
  background?: string;
  /** Set to true while rendering a low-res preview. Skips slow font/quality settings. */
  preview?: boolean;
}

const DIMENSIONS: Record<ExportFormat, { w: number; h: number }> = {
  story:   { w: 1080, h: 1920 },
  square:  { w: 1080, h: 1080 },
  twitter: { w: 1200, h: 675 },
};

const PREVIEW_MAX_WIDTH = 540;

/** Reads a `--var` from `document.documentElement`, with optional fallback. */
function readThemeVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Quick contrast check — returns true if the background is light. */
function isLight(hex: string): boolean {
  // Accepts `#RRGGBB`, `#RGB`, or `rgb(r, g, b)` — fall back to dark.
  const m = hex.match(/^#([0-9a-f]{6})$/i) || hex.match(/^#([0-9a-f]{3})$/i);
  if (!m) {
    const rgb = hex.match(/rgb\(\s*(\d+)\D+(\d+)\D+(\d+)/i);
    if (rgb) return (Number(rgb[1]) + Number(rgb[2]) + Number(rgb[3])) / 3 > 160;
    return false;
  }
  const v = m[1];
  const expand = v.length === 3 ? v.split('').map(c => c + c).join('') : v;
  const r = parseInt(expand.slice(0, 2), 16);
  const g = parseInt(expand.slice(2, 4), 16);
  const b = parseInt(expand.slice(4, 6), 16);
  return (r + g + b) / 3 > 160;
}

async function loadAlbumCover(album: SubsonicAlbum, size: number, signal?: AbortSignal): Promise<ImageBitmap | null> {
  if (!album.coverArt) return null;
  try {
    const blob = await getCachedBlob(buildCoverArtUrl(album.coverArt, size), coverArtCacheKey(album.coverArt, size), signal);
    if (!blob) return null;
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

/** Decodes the Psysonic wordmark SVG into an Image, ready for drawImage.
 *  `targetHeight` is informational — actual scaling happens at drawImage time. */
async function loadWordmark(color: string): Promise<HTMLImageElement> {
  const svgMarkup = getCachedLogoSvg(color);
  const blob = new Blob([svgMarkup], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Renders the PsysonicLogo component to an SVG string with a single solid
 *  color baked in (both gradient stops set to the same value), so the wordmark
 *  stays uniformly readable on the export background regardless of theme.
 *  The naive `var(--logo-color-start)` regex misses the nested fallback
 *  `var(--logo-color-start, var(--accent))` — we use exact-string replace. */
let cachedLogoSvgKey = '';
let cachedLogoSvg = '';
function getCachedLogoSvg(color: string): string {
  if (cachedLogoSvgKey === color && cachedLogoSvg) return cachedLogoSvg;
  const raw = renderToStaticMarkup(React.createElement(PsysonicLogo, { gradientIdSuffix: 'export' }));
  const swapped = raw
    .replace('var(--logo-color-start, var(--accent))', color)
    .replace('var(--logo-color-end, var(--ctp-blue))', color);
  cachedLogoSvg = swapped;
  cachedLogoSvgKey = color;
  return swapped;
}

/**
 * Renders a Pano-Scrobbler-style "Top Albums" image to a canvas and returns it
 * as a Blob (PNG). Caller is responsible for saving the blob to disk.
 *
 * The function reads accent + background colors from the active theme so the
 * exported image matches the in-app look. Cover art is loaded through the
 * existing IndexedDB cache (`getCachedBlob`), so repeated exports are cheap.
 */
export async function renderAlbumCardCanvas(opts: ExportAlbumCardOptions): Promise<HTMLCanvasElement> {
  const { albums, format, gridSize, preview } = opts;
  const dims = DIMENSIONS[format];
  const scale = preview ? Math.min(1, PREVIEW_MAX_WIDTH / dims.w) : 1;
  const w = Math.round(dims.w * scale);
  const h = Math.round(dims.h * scale);

  const accent = opts.accent ?? readThemeVar('--accent', '#CBA6F7');
  const bg = opts.background ?? readThemeVar('--bg-primary', '#1E1E2E');
  const fgPrimary = readThemeVar('--text-primary', isLight(bg) ? '#11111B' : '#CDD6F4');
  const fgMuted = readThemeVar('--text-muted', isLight(bg) ? '#444' : '#9399B2');

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d unavailable');

  // ── Background ─────────────────────────────────────────────────────────
  // Subtle vertical gradient: bg → bg with a slight accent tint at the bottom.
  const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
  bgGrad.addColorStop(0, bg);
  bgGrad.addColorStop(1, mixHex(bg, accent, 0.12));
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, w, h);

  // ── Layout ───────────────────────────────────────────────────────────────
  // Header / footer have format-specific minimum heights so the title and
  // logo never collide visually with the grid even when the grid is
  // height-bounded (Square, Twitter). Landscape (Twitter) needs the largest
  // proportional band because the card is short. Portrait (Story) the
  // smallest because there's already plenty of vertical room.
  const pad = Math.round(w * 0.045);
  const gap = Math.round(w * 0.012);
  const isLandscape = format === 'twitter';
  const isPortrait = format === 'story';
  // Story stacks logo above the meta-label, so it needs the most header room.
  const headerMinRatio = isPortrait ? 0.16 : isLandscape ? 0.18 : 0.13;
  // Square + Story have a URL footer; Twitter doesn't (URL lives in header).
  const footerMinRatio = isLandscape ? 0.05 : isPortrait ? 0.07 : 0.08;
  const headerMin = Math.round(h * headerMinRatio);
  const footerMin = Math.round(h * footerMinRatio);
  let headerH = headerMin;
  let footerH = footerMin;
  const horizontalTile = Math.floor((w - pad * 2 - gap * (gridSize - 1)) / gridSize);
  let availableH = h - headerH - footerH;
  let verticalTile = Math.floor((availableH - gap * (gridSize - 1)) / gridSize);
  let tileSize = Math.min(horizontalTile, verticalTile);
  // If we're width-bounded the grid leaves vertical slack — push header
  // (60%) and footer (40%) outward to absorb it. Header/footer content
  // stays anchored away from the grid edge so it can't drift in.
  const gridPxH0 = tileSize * gridSize + gap * (gridSize - 1);
  const verticalSlack = availableH - gridPxH0;
  if (verticalSlack > 0) {
    headerH += Math.round(verticalSlack * 0.6);
    footerH += verticalSlack - Math.round(verticalSlack * 0.6);
    availableH = h - headerH - footerH;
    verticalTile = Math.floor((availableH - gap * (gridSize - 1)) / gridSize);
    tileSize = Math.min(horizontalTile, verticalTile);
  }
  const gridPxW = tileSize * gridSize + gap * (gridSize - 1);
  const gridFinalH = tileSize * gridSize + gap * (gridSize - 1);
  const gridX = pad + Math.round((w - pad * 2 - gridPxW) / 2);
  const gridY = headerH + Math.round((h - headerH - footerH - gridFinalH) / 2);
  const headerHasSlack = verticalSlack > 0;

  // ── Header: format-specific ──────────────────────────────────────────────
  // Story (portrait):   logo centered, meta-label centered below it.
  // Twitter (landscape): logo left,    meta center,         url right (small).
  // Square:              logo left,    meta right.
  const logo = await loadWordmark(accent).catch(() => null);
  const logoRatio = logo ? (logo.naturalWidth / logo.naturalHeight || 4.4) : 4.4;
  const drawLogoAt = (lx: number, ly: number, lh: number) => {
    if (logo) {
      ctx.drawImage(logo, lx, ly, Math.round(lh * logoRatio), lh);
    } else {
      ctx.fillStyle = accent;
      ctx.font = `700 ${Math.round(lh * 0.78)}px "Space Grotesk", "Inter", system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('psysonic', lx, ly);
    }
  };

  // Header label is hardcoded English ("Top Albums") so a shared image is
  // legible to anyone, regardless of the exporter's UI language. Caller can
  // still override via `opts.meta` for special editions ("Top Albums 2026").
  const headerLabel = opts.meta ?? 'Top Albums';

  if (isPortrait) {
    // Story: stacked logo + label, both centered.
    const logoH = Math.max(36, Math.round(headerMin * 0.36));
    const logoW = Math.round(logoH * logoRatio);
    const metaSize = Math.max(18, Math.round(headerMin * 0.18));
    const stackGap = Math.round(headerMin * 0.08);
    const totalH = logoH + stackGap + metaSize;
    const stackTop = headerHasSlack
      ? Math.round(pad * 0.85)
      : Math.round((headerMin - totalH) / 2);
    const logoX = Math.round((w - logoW) / 2);
    drawLogoAt(logoX, stackTop, logoH);
    ctx.font = `500 ${metaSize}px "Inter", system-ui, sans-serif`;
    ctx.fillStyle = fgMuted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(headerLabel, Math.round(w / 2), stackTop + logoH + stackGap);
  } else if (isLandscape) {
    // Twitter: logo left, label centered, url right (smaller).
    const logoH = Math.max(30, Math.round(headerMin * 0.42));
    const headerCenterY = headerHasSlack
      ? Math.round(pad * 0.85) + Math.round(logoH / 2)
      : Math.round(headerMin / 2);
    drawLogoAt(pad, headerCenterY - Math.round(logoH / 2), logoH);
    const metaSize = Math.max(16, Math.round(headerMin * 0.22));
    ctx.font = `600 ${metaSize}px "Inter", system-ui, sans-serif`;
    ctx.fillStyle = fgPrimary;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(headerLabel, Math.round(w / 2), headerCenterY);
    const urlSize = Math.max(13, Math.round(headerMin * 0.16));
    ctx.font = `500 ${urlSize}px "Inter", system-ui, sans-serif`;
    ctx.fillStyle = fgMuted;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('www.psysonic.de', w - pad, headerCenterY);
  } else {
    // Square: logo left, label right.
    const logoH = Math.max(28, Math.round(headerMin * 0.40));
    const headerCenterY = headerHasSlack
      ? Math.round(pad * 0.85) + Math.round(logoH / 2)
      : Math.round(headerMin / 2);
    drawLogoAt(pad, headerCenterY - Math.round(logoH / 2), logoH);
    const metaSize = Math.max(14, Math.round(headerMin * 0.22));
    ctx.font = `500 ${metaSize}px "Inter", system-ui, sans-serif`;
    ctx.fillStyle = fgMuted;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(headerLabel, w - pad, headerCenterY);
  }

  // ── Tiles ────────────────────────────────────────────────────────────────
  const desiredTilePx = preview ? 256 : 600;
  const needed = gridSize * gridSize;
  const tilesAlbums = albums.slice(0, needed);
  const covers = await Promise.all(tilesAlbums.map(a => loadAlbumCover(a, desiredTilePx)));

  for (let i = 0; i < tilesAlbums.length; i++) {
    const album = tilesAlbums[i];
    const col = i % gridSize;
    const row = Math.floor(i / gridSize);
    const x = gridX + col * (tileSize + gap);
    const y = gridY + row * (tileSize + gap);

    // Cover or fallback panel.
    const cover = covers[i];
    if (cover) {
      ctx.drawImage(cover, x, y, tileSize, tileSize);
    } else {
      ctx.fillStyle = mixHex(bg, accent, 0.15);
      ctx.fillRect(x, y, tileSize, tileSize);
    }

    // Info strip — narrow bar at the bottom of the cover with the rank on
    // the left and the play-count on the right. Full-width strip integrates
    // visually into the cover (as opposed to a floating pill).
    const stripH = Math.max(20, Math.round(tileSize * 0.13));
    const stripY = y + tileSize - stripH;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.68)';
    ctx.fillRect(x, stripY, tileSize, stripH);

    const stripFontSize = Math.round(stripH * 0.52);
    const stripPadX = Math.round(stripH * 0.45);
    const stripCenterY = stripY + stripH / 2 + 1;

    // Rank on the left.
    ctx.font = `800 ${stripFontSize}px "Space Grotesk", "Inter", system-ui, sans-serif`;
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), x + stripPadX, stripCenterY);

    // Plays on the right (only when available).
    const plays = album.playCount;
    if (plays && plays > 0) {
      ctx.font = `600 ${stripFontSize}px "Inter", system-ui, sans-serif`;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
      ctx.textAlign = 'right';
      ctx.fillText(`${plays} Plays`, x + tileSize - stripPadX, stripCenterY);
    }
  }

  // ── Footer: URL centered (Story + Square only; Twitter has it in header) ─
  if (!isLandscape) {
    const urlSize = Math.max(13, Math.round(footerMin * 0.36));
    ctx.font = `500 ${urlSize}px "Inter", system-ui, sans-serif`;
    ctx.fillStyle = fgMuted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const footerCenterY = h - Math.round(footerMin / 2);
    ctx.fillText('www.psysonic.de', Math.round(w / 2), footerCenterY);
  }

  return canvas;
}

export async function exportAlbumCardBlob(opts: ExportAlbumCardOptions): Promise<Blob> {
  const canvas = await renderAlbumCardCanvas(opts);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob returned null'))), 'image/png');
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** Mixes two hex colors by `t` ∈ [0..1]. Falls back to `a` when parsing fails. */
function mixHex(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  if (!ca || !cb) return a;
  const r = Math.round(ca.r + (cb.r - ca.r) * t);
  const g = Math.round(ca.g + (cb.g - ca.g) * t);
  const bl = Math.round(ca.b + (cb.b - ca.b) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}

function hexToRgb(input: string): { r: number; g: number; b: number } | null {
  const trimmed = input.trim();
  const hex = trimmed.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let v = hex[1];
    if (v.length === 3) v = v.split('').map(c => c + c).join('');
    if (v.length === 6 || v.length === 8) {
      return {
        r: parseInt(v.slice(0, 2), 16),
        g: parseInt(v.slice(2, 4), 16),
        b: parseInt(v.slice(4, 6), 16),
      };
    }
  }
  const rgb = trimmed.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  return null;
}
