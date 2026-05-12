import { buildCoverArtUrl } from '../api/subsonicStreamUrl';
import { getAlbumList } from '../api/subsonicLibrary';
import type { SubsonicAlbum } from '../api/subsonicTypes';
import { writeFile } from '@tauri-apps/plugin-fs';
import { downloadDir, join } from '@tauri-apps/api/path';
import { useAuthStore } from '../store/authStore';
// Catppuccin Macchiato palette
const M = {
  crust:    '#181926',
  mantle:   '#1e2030',
  base:     '#24273a',
  surface0: '#363a4f',
  surface1: '#494d64',
  surface2: '#5b6078',
  text:     '#cad3f5',
  subtext1: '#b8c0e0',
  subtext0: '#a5adcb',
  mauve:    '#c6a0f6',
  lavender: '#b7bdf8',
  overlay2: '#939ab7',
};

const W          = 1080;
const PAD        = 56;
const COVER_SIZE = 52;
const ROW_H      = 72;
const COVER_PAD  = (ROW_H - COVER_SIZE) / 2;
const TEXT_X     = PAD + COVER_SIZE + 18;
const TEXT_W     = W - TEXT_X - PAD;
const HEADER_H   = 260;
const FOOTER_H   = 72;
const MAX_PER_PAGE = 20;

function clampText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (ctx.measureText(t + '…').width > maxW && t.length > 0) t = t.slice(0, -1);
  return t + '…';
}

async function loadImage(url: string): Promise<ImageBitmap | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await createImageBitmap(await res.blob());
  } catch { return null; }
}

async function loadLogo(): Promise<HTMLImageElement | null> {
  try {
    const res = await fetch('/psysonic-inapp-logo.svg');
    if (!res.ok) return null;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  } catch { return null; }
}

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

async function renderPage(
  albums: SubsonicAlbum[],
  covers: (ImageBitmap | null)[],
  logo: HTMLImageElement | null,
  now: Date,
  totalCount: number,
  pageNum: number,
  totalPages: number,
  globalOffset: number,
): Promise<Blob> {
  const H = HEADER_H + albums.length * ROW_H + FOOTER_H;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  // Background
  ctx.fillStyle = M.base;
  ctx.fillRect(0, 0, W, H);

  const headerGrad = ctx.createLinearGradient(0, 0, 0, HEADER_H);
  headerGrad.addColorStop(0, M.mantle);
  headerGrad.addColorStop(1, M.base);
  ctx.fillStyle = headerGrad;
  ctx.fillRect(0, 0, W, HEADER_H);

  // Logo
  const LOGO_H = 52;
  const logoY = 44;
  if (logo) {
    const logoW = logo.naturalWidth && logo.naturalHeight
      ? Math.round(LOGO_H * (logo.naturalWidth / logo.naturalHeight))
      : LOGO_H * 4;
    ctx.drawImage(logo, W / 2 - logoW / 2, logoY, logoW, LOGO_H);
  }

  // Title
  ctx.textAlign = 'center';
  ctx.font = '700 42px system-ui, sans-serif';
  ctx.fillStyle = M.text;
  ctx.fillText('Die neuesten Alben', W / 2, logoY + LOGO_H + 52);

  // Date + page indicator
  const dateStr = now.toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' });
  const pageStr = totalPages > 1 ? `  ·  Teil ${pageNum} / ${totalPages}` : '';
  ctx.font = '400 18px system-ui, sans-serif';
  ctx.fillStyle = M.subtext0;
  ctx.fillText(dateStr + pageStr, W / 2, logoY + LOGO_H + 82);

  // Count badge (total, only on first page)
  if (pageNum === 1) {
    const badgeText = `${totalCount} ${totalCount !== 1 ? 'Alben' : 'Album'}`;
    ctx.font = '600 13px system-ui, sans-serif';
    const badgeW = ctx.measureText(badgeText).width + 24;
    const badgeX = W / 2 - badgeW / 2;
    const badgeY = logoY + LOGO_H + 102;
    roundRect(ctx, badgeX, badgeY, badgeW, 24, 12);
    ctx.fillStyle = M.surface0;
    ctx.fill();
    ctx.fillStyle = M.mauve;
    ctx.fillText(badgeText, W / 2, badgeY + 16);
  }

  // Divider
  ctx.strokeStyle = M.surface1;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, HEADER_H - 16);
  ctx.lineTo(W - PAD, HEADER_H - 16);
  ctx.stroke();

  // Album rows
  for (let i = 0; i < albums.length; i++) {
    const album = albums[i];
    const cover = covers[i];
    const rowY = HEADER_H + i * ROW_H;
    const coverY = rowY + COVER_PAD;
    const globalIdx = globalOffset + i;

    if (i % 2 === 0) {
      ctx.fillStyle = 'rgba(54,58,79,0.35)';
      ctx.fillRect(0, rowY, W, ROW_H);
    }

    // Index
    ctx.textAlign = 'right';
    ctx.font = '500 13px system-ui, sans-serif';
    ctx.fillStyle = M.surface2;
    ctx.fillText(String(globalIdx + 1), PAD - 12, coverY + COVER_SIZE / 2 + 5);

    // Cover
    roundRect(ctx, PAD, coverY, COVER_SIZE, COVER_SIZE, 8);
    ctx.fillStyle = M.surface0;
    ctx.fill();
    if (cover) {
      ctx.save();
      roundRect(ctx, PAD, coverY, COVER_SIZE, COVER_SIZE, 8);
      ctx.clip();
      ctx.drawImage(cover, PAD, coverY, COVER_SIZE, COVER_SIZE);
      ctx.restore();
    } else {
      ctx.font = '28px system-ui';
      ctx.fillStyle = M.surface2;
      ctx.textAlign = 'center';
      ctx.fillText('♪', PAD + COVER_SIZE / 2, coverY + COVER_SIZE / 2 + 10);
    }

    // Text row
    ctx.textAlign = 'left';
    ctx.font = '600 17px system-ui, sans-serif';
    const lineY = coverY + COVER_SIZE / 2 + 6;
    const sep = '  —  ';

    const artistClamp = clampText(ctx, album.artist, TEXT_W * 0.42);
    const artistW = ctx.measureText(artistClamp).width;
    const sepW = ctx.measureText(sep).width;
    const remaining = TEXT_W - artistW - sepW;
    const albumClamp = clampText(ctx, album.name, remaining * 0.65);
    const albumW = ctx.measureText(albumClamp).width;

    ctx.fillStyle = M.mauve;
    ctx.fillText(artistClamp, TEXT_X, lineY);
    ctx.fillStyle = M.overlay2;
    ctx.fillText(sep, TEXT_X + artistW, lineY);
    ctx.fillStyle = M.text;
    ctx.fillText(albumClamp, TEXT_X + artistW + sepW, lineY);

    if (album.year || album.genre) {
      ctx.font = '400 15px system-ui, sans-serif';
      let cx = TEXT_X + artistW + sepW + albumW;
      if (album.year) {
        ctx.fillStyle = M.subtext0;
        const yearPart = `  (${album.year})`;
        ctx.fillText(yearPart, cx, lineY);
        cx += ctx.measureText(yearPart).width;
      }
      if (album.genre) {
        ctx.fillStyle = M.subtext0;
        const dashPart = '  —  ';
        ctx.fillText(dashPart, cx, lineY);
        cx += ctx.measureText(dashPart).width;
        ctx.fillStyle = M.lavender;
        ctx.fillText(clampText(ctx, album.genre, TEXT_X + TEXT_W - cx), cx, lineY);
      }
    }

    if (i < albums.length - 1) {
      ctx.strokeStyle = M.surface0;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD, rowY + ROW_H);
      ctx.lineTo(W - PAD, rowY + ROW_H);
      ctx.stroke();
    }
  }

  // Footer
  ctx.textAlign = 'center';
  ctx.font = '400 13px system-ui, sans-serif';
  ctx.fillStyle = M.overlay2;
  ctx.fillText('www.psysonic.de', W / 2, H - FOOTER_H / 2 + 6);

  return new Promise(resolve => canvas.toBlob(b => resolve(b!), 'image/png'));
}

export async function exportNewAlbumsImage(since: number): Promise<{ count: number; paths: string[] } | null> {
  const albums = await getAlbumList('newest', 500);
  if (albums.length === 0) return null;

  const newAlbums = since > 0
    ? albums.filter(a => a.created && new Date(a.created).getTime() >= since)
    : albums;

  if (newAlbums.length === 0) return null;

  newAlbums.sort((a, b) => a.artist.localeCompare(b.artist, 'de') || a.name.localeCompare(b.name, 'de'));

  // Chunk into pages
  const pages: SubsonicAlbum[][] = [];
  for (let i = 0; i < newAlbums.length; i += MAX_PER_PAGE) {
    pages.push(newAlbums.slice(i, i + MAX_PER_PAGE));
  }

  const now = new Date();
  const logo = await loadLogo();
  const { downloadFolder } = useAuthStore.getState();
  const folder = downloadFolder || await downloadDir();
  const timestamp = now.toISOString().slice(0, 10);
  const paths: string[] = [];

  for (let p = 0; p < pages.length; p++) {
    const page = pages[p];
    const covers = await Promise.all(
      page.map(a => a.coverArt ? loadImage(buildCoverArtUrl(a.coverArt, 160)) : Promise.resolve(null))
    );

    const blob = await renderPage(page, covers, logo, now, newAlbums.length, p + 1, pages.length, p * MAX_PER_PAGE);
    const suffix = pages.length > 1 ? `-${p + 1}` : '';
    const filename = `psysonic-new-albums-${timestamp}${suffix}.png`;
    const filePath = await join(folder, filename);
    await writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
    paths.push(filePath);
  }

  return { count: newAlbums.length, paths };
}
