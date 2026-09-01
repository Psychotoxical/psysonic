/**
 * §5 reusable poster components. Every draw function returns the next free y
 * so the layouts stay a simple top-down composition; none of them re-defines
 * colors, fonts, or effects (§12).
 */

import { drawCard, drawDivider, drawGlowText, fillRoundRect, fitText, strokeRoundRect } from './draw';
import { drawEqualizerBars, drawIcon, drawIconBadge, drawWaveform, type RewindIcon } from './motifs';
import { REWIND_COLORS, REWIND_FONT_DISPLAY, REWIND_FONT_TEXT } from './tokens';
import type { RewindRenderContext } from './types';

const C = REWIND_COLORS;

/** Uppercase + letter-spacing helper; letterSpacing needs a recent engine, so guard it. */
function withTracking(ctx: CanvasRenderingContext2D, px: number, fn: () => void): void {
  const styled = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  const prev = styled.letterSpacing;
  if (prev !== undefined) styled.letterSpacing = `${px}px`;
  fn();
  if (prev !== undefined) styled.letterSpacing = prev;
}

/** §5 RecapHeader — wordmark left, year right. Returns the y below it. */
export function drawHeader(rc: RewindRenderContext): number {
  const { ctx, w, pad, wordmark } = rc;
  const logoH = 42;
  let y = rc.h >= 1400 ? 60 : 52;
  if (wordmark) {
    const ratio = wordmark.naturalWidth / wordmark.naturalHeight || 4.4;
    ctx.drawImage(wordmark, pad, y, Math.round(logoH * ratio), logoH);
  }
  ctx.font = `700 ${Math.round(logoH * 0.78)}px ${REWIND_FONT_DISPLAY}`;
  ctx.fillStyle = C.textSecondary;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(rc.data.year), w - pad, y + logoH / 2);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  y += logoH + (rc.format === 'story' ? 40 : 28);
  return y;
}

/** Kicker line + level-2 title. */
export function drawKickerTitle(rc: RewindRenderContext, y: number, title: string): number {
  const { ctx, pad, type } = rc;
  ctx.fillStyle = C.primaryPurple;
  ctx.font = `700 ${type.section}px ${REWIND_FONT_TEXT}`;
  withTracking(ctx, 5, () => {
    ctx.fillText(rc.strings.kicker.toLocaleUpperCase(), pad, y + type.section);
  });
  y += type.section + (rc.format === 'story' ? 18 : 12);
  ctx.fillStyle = C.textPrimary;
  const maxWidth = rc.w - pad * 2;
  let size = type.spotlight;
  const minSize = Math.round(type.spotlight * 0.65);
  ctx.font = `700 ${size}px ${REWIND_FONT_DISPLAY}`;
  // Shrink-to-fit before ellipsizing — a cut year headline reads broken.
  while (size > minSize && ctx.measureText(title).width > maxWidth) {
    size -= 2;
    ctx.font = `700 ${size}px ${REWIND_FONT_DISPLAY}`;
  }
  ctx.fillText(fitText(ctx, title, maxWidth), pad, y + size);
  return y + size + (rc.format === 'story' ? 36 : 24);
}

/** §5 HeroStat — glowing number, stacked label, waveform to the right. */
export function drawHeroStat(
  rc: RewindRenderContext,
  y: number,
  value: string,
  labelLines: string[],
): number {
  const { ctx, pad, type, w } = rc;
  const size = type.hero;
  const baseline = y + size * 0.82;
  const valueW = drawGlowText(
    ctx,
    value,
    pad,
    baseline,
    `800 ${size}px ${REWIND_FONT_DISPLAY}`,
    size,
  );

  ctx.fillStyle = C.textPrimary;
  ctx.font = `700 ${type.heroLabel}px ${REWIND_FONT_DISPLAY}`;
  const labelX = pad + valueW + Math.round(size * 0.18);
  const lineH = type.heroLabel * 1.08;
  const labelMidBase = baseline - size * 0.32 - ((labelLines.length - 1) * lineH) / 2;
  labelLines.forEach((line, i) => {
    ctx.fillText(line, labelX, labelMidBase + i * lineH);
  });

  const waveX = Math.max(labelX + 260, w * 0.55);
  drawWaveform(ctx, waveX, y - size * 0.1, w - waveX - pad * 0.4, size * 1.1, rc.seed + 11);
  return y + size * 0.98;
}

export interface MiniStat {
  icon: RewindIcon;
  value: string;
  label: string;
}

/** §5 MiniStat — a row of icon-badged stat cards. */
export function drawMiniStatRow(rc: RewindRenderContext, y: number, stats: MiniStat[]): number {
  const { ctx, pad, w, type } = rc;
  const gap = 20;
  const cardW = (w - pad * 2 - gap * (stats.length - 1)) / stats.length;
  const cardH = rc.format === 'story' ? 108 : 96;
  stats.forEach((stat, i) => {
    const x = pad + i * (cardW + gap);
    drawCard(ctx, x, y, cardW, cardH);
    const badgeR = 27;
    drawIconBadge(ctx, stat.icon, x + 24 + badgeR, y + cardH / 2, badgeR);
    const textX = x + 24 + badgeR * 2 + 18;
    ctx.fillStyle = C.textPrimary;
    ctx.font = `700 ${type.statValue}px ${REWIND_FONT_DISPLAY}`;
    ctx.fillText(fitText(ctx, stat.value, x + cardW - textX - 12), textX, y + cardH / 2 - 4);
    ctx.fillStyle = C.textSecondary;
    ctx.font = `500 ${type.statLabel}px ${REWIND_FONT_TEXT}`;
    ctx.fillText(fitText(ctx, stat.label, x + cardW - textX - 12), textX, y + cardH / 2 + type.statLabel + 6);
  });
  return y + cardH;
}

/** Big value over a small uppercase label, divided columns (§7/§9 stat rows). */
export function drawInlineStatRow(
  rc: RewindRenderContext,
  y: number,
  stats: { value: string; label: string }[],
): number {
  const { ctx, pad, w, type } = rc;
  const valueSize = Math.round(type.statValue * 1.1);
  const labelFont = `600 ${Math.round(type.statLabel * 0.92)}px ${REWIND_FONT_TEXT}`;
  // Column widths follow the measured content so a long label ("verschiedene
  // Titel") is not squeezed into an even split next to a short one.
  const widths = stats.map(stat => {
    ctx.font = `700 ${valueSize}px ${REWIND_FONT_DISPLAY}`;
    const valueW = ctx.measureText(stat.value).width;
    ctx.font = labelFont;
    return Math.max(valueW, ctx.measureText(stat.label.toLocaleUpperCase()).width);
  });
  const totalW = widths.reduce((a, b) => a + b, 0);
  const free = w - pad * 2 - totalW;
  const gap = Math.max(36, free / Math.max(1, stats.length - 1) - 1);
  let x = pad;
  stats.forEach((stat, i) => {
    const colW = widths[i];
    ctx.fillStyle = C.textPrimary;
    ctx.font = `700 ${valueSize}px ${REWIND_FONT_DISPLAY}`;
    ctx.fillText(fitText(ctx, stat.value, colW + gap * 0.6), x, y + valueSize);
    ctx.fillStyle = C.textSecondary;
    ctx.font = labelFont;
    withTracking(ctx, 1.5, () => {
      ctx.fillText(
        fitText(ctx, stat.label.toLocaleUpperCase(), colW + gap * 0.6),
        x,
        y + valueSize + type.statLabel + 10,
      );
    });
    if (i > 0) drawDivider(ctx, x - gap / 2, y + 6, valueSize + type.statLabel);
    x += colW + gap;
  });
  return y + valueSize + type.statLabel + 18;
}

/** §4 level-3 section headline. */
export function drawSectionLabel(
  rc: RewindRenderContext,
  x: number,
  y: number,
  text: string,
  maxWidth?: number,
): number {
  const { ctx, type } = rc;
  ctx.fillStyle = C.primaryPurple;
  ctx.font = `700 ${type.section}px ${REWIND_FONT_TEXT}`;
  withTracking(ctx, 3, () => {
    const label = text.toLocaleUpperCase();
    ctx.fillText(maxWidth ? fitText(ctx, label, maxWidth) : label, x, y + type.section);
  });
  return y + type.section + 16;
}

/** §5 RankedList — #1 dominant, the rest compact. Returns the next y. */
export function drawRankedList(
  rc: RewindRenderContext,
  x: number,
  y: number,
  maxWidth: number,
  items: { name: string }[],
  opts?: { rowGap?: number; heroSize?: number; uppercase?: boolean },
): number {
  const { ctx, type } = rc;
  if (items.length === 0) return y;
  const heroSize = opts?.heroSize ?? Math.round(type.spotlight * 0.82);
  const rowGap = opts?.rowGap ?? Math.round(type.listRow * 1.45);

  ctx.font = `800 ${heroSize}px ${REWIND_FONT_DISPLAY}`;
  ctx.fillStyle = C.primaryPurple;
  const heroRank = '1';
  const rankW = ctx.measureText(heroRank).width;
  ctx.fillText(heroRank, x, y + heroSize);
  ctx.fillStyle = C.textPrimary;
  const heroName = opts?.uppercase ? items[0].name.toLocaleUpperCase() : items[0].name;
  ctx.fillText(fitText(ctx, heroName, maxWidth - rankW - 24), x + rankW + 24, y + heroSize);
  y += heroSize + Math.round(rowGap * 0.55);

  ctx.font = `600 ${type.listRow}px ${REWIND_FONT_TEXT}`;
  for (let i = 1; i < items.length; i++) {
    ctx.fillStyle = C.mutedPurple;
    ctx.fillText(String(i + 1), x + 6, y + type.listRow);
    ctx.fillStyle = C.textPrimary;
    const name = opts?.uppercase ? items[i].name.toLocaleUpperCase() : items[i].name;
    ctx.fillText(fitText(ctx, name, maxWidth - 60), x + 60, y + type.listRow);
    y += rowGap;
  }
  return y;
}

/** Rounded cover tile with border and a soft glow for hero covers. */
export function drawCoverTile(
  rc: RewindRenderContext,
  x: number,
  y: number,
  size: number,
  cover: ImageBitmap | null,
  opts?: { glow?: boolean; label?: string; radius?: number },
): void {
  const { ctx, type, seed } = rc;
  const radius = opts?.radius ?? Math.max(10, Math.round(size * 0.055));
  ctx.save();
  if (opts?.glow) {
    ctx.shadowColor = 'rgba(167, 131, 255, 0.55)';
    ctx.shadowBlur = 34;
    ctx.fillStyle = C.card;
    fillRoundRect(ctx, x, y, size, size, radius);
    ctx.shadowBlur = 0;
  }
  ctx.beginPath();
  ctx.roundRect(x, y, size, size, radius);
  ctx.clip();
  if (cover) {
    ctx.drawImage(cover, x, y, size, size);
  } else {
    // §11 fallback: dark cover area with a waveform.
    ctx.fillStyle = C.gridInactive;
    ctx.fillRect(x, y, size, size);
    drawWaveform(ctx, x + size * 0.1, y + size * 0.3, size * 0.8, size * 0.4, seed + x, 0.5);
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(110, 80, 166, 0.6)';
  ctx.lineWidth = 1.5;
  strokeRoundRect(ctx, x + 0.75, y + 0.75, size - 1.5, size - 1.5, radius);
  if (opts?.label) {
    ctx.fillStyle = C.textSecondary;
    ctx.font = `600 ${Math.round(type.statLabel * 0.95)}px ${REWIND_FONT_TEXT}`;
    ctx.fillText(fitText(ctx, opts.label, size), x, y + size + type.statLabel + 8);
  }
}

/** §5 ActivityHeatmap — hour-of-day band, glow on the peak cluster. */
export function drawHourlyHeatband(
  rc: RewindRenderContext,
  x: number,
  y: number,
  width: number,
  rows: number,
): number {
  const { ctx, data, type, seed } = rc;
  const counts = data.recap.hourlyPlayCounts;
  const max = Math.max(...counts, 1);
  const peakHour = counts.indexOf(Math.max(...counts));
  const gap = 5;
  const cell = Math.floor((width - gap * 23) / 24);
  const rowRand = (h: number, r: number) => {
    // Deterministic per-cell shade so the rows read organic, not striped.
    const v = Math.sin(seed + h * 12.9898 + r * 78.233) * 43758.5453;
    return v - Math.floor(v);
  };
  for (let hour = 0; hour < 24; hour++) {
    const strength = counts[hour] / max;
    for (let r = 0; r < rows; r++) {
      const cellStrength = strength * (0.55 + 0.45 * rowRand(hour, r));
      const cx = x + hour * (cell + gap);
      const cy = y + r * (cell + gap);
      if (cellStrength < 0.04) {
        ctx.fillStyle = C.gridInactive;
        ctx.globalAlpha = 0.7;
      } else {
        ctx.fillStyle = C.primaryPurple;
        ctx.globalAlpha = 0.18 + 0.82 * cellStrength;
        if (hour === peakHour && cellStrength > 0.5) {
          ctx.shadowColor = 'rgba(167, 131, 255, 0.8)';
          ctx.shadowBlur = 14;
        }
      }
      fillRoundRect(ctx, cx, cy, cell, cell, 4);
      ctx.shadowBlur = 0;
    }
  }
  ctx.globalAlpha = 1;
  y += rows * (cell + gap) + 14;
  ctx.fillStyle = C.textSecondary;
  ctx.font = `500 ${Math.round(type.statLabel * 0.9)}px ${REWIND_FONT_TEXT}`;
  for (const hour of [0, 6, 12, 18, 24]) {
    const hx = x + Math.min(hour, 23.999) * (cell + gap) * (hour === 24 ? 1.0 : 1);
    const label = String(hour).padStart(2, '0');
    ctx.textAlign = hour === 0 ? 'left' : hour === 24 ? 'right' : 'center';
    ctx.fillText(label, hour === 24 ? x + width : hx, y + type.statLabel);
  }
  ctx.textAlign = 'left';
  return y + type.statLabel + 8;
}

/** §5 ProgressMeter — donut variant. */
export function drawLosslessDonut(
  rc: RewindRenderContext,
  cx: number,
  cy: number,
  radius: number,
  percent: number,
  label: string,
): void {
  const { ctx } = rc;
  ctx.save();
  ctx.lineWidth = Math.max(8, radius * 0.16);
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(110, 80, 166, 0.35)';
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
  if (percent > 0) {
    const start = -Math.PI / 2;
    ctx.strokeStyle = C.brightPurple;
    ctx.shadowColor = 'rgba(167, 131, 255, 0.7)';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, start, start + Math.PI * 2 * Math.min(1, percent / 100));
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  ctx.textAlign = 'center';
  ctx.fillStyle = C.textPrimary;
  const valueSize = Math.round(radius * 0.5);
  ctx.font = `700 ${valueSize}px ${REWIND_FONT_DISPLAY}`;
  ctx.fillText(`${percent}%`, cx, cy + (label ? -2 : valueSize * 0.35));
  if (label) {
    ctx.fillStyle = C.textSecondary;
    ctx.font = `600 ${Math.round(radius * 0.22)}px ${REWIND_FONT_TEXT}`;
    withTracking(ctx, 1.5, () => {
      ctx.fillText(label.toLocaleUpperCase(), cx, cy + radius * 0.42);
    });
  }
  ctx.textAlign = 'left';
  ctx.restore();
}

/** §5 ProgressMeter — slim bar variant. */
export function drawProgressBar(
  rc: RewindRenderContext,
  x: number,
  y: number,
  width: number,
  percent: number,
): number {
  const { ctx } = rc;
  const barH = 12;
  ctx.fillStyle = 'rgba(39, 33, 62, 0.9)';
  fillRoundRect(ctx, x, y, width, barH, barH / 2);
  if (percent > 0) {
    ctx.fillStyle = C.brightPurple;
    ctx.shadowColor = 'rgba(167, 131, 255, 0.7)';
    ctx.shadowBlur = 10;
    fillRoundRect(ctx, x, y, Math.max(barH, width * Math.min(1, percent / 100)), barH, barH / 2);
    ctx.shadowBlur = 0;
  }
  return y + barH;
}

/** §5 InsightCard — icon badge, uppercase title, short interpreted body. */
export function drawInsightCard(
  rc: RewindRenderContext,
  x: number,
  y: number,
  width: number,
  height: number,
  icon: RewindIcon,
  title: string,
  body: string | null,
): void {
  const { ctx, type } = rc;
  drawCard(ctx, x, y, width, height);
  const badgeR = Math.min(34, height * 0.24);
  drawIconBadge(ctx, icon, x + 28 + badgeR, y + height / 2, badgeR);
  const textX = x + 28 + badgeR * 2 + 22;
  const textW = x + width - textX - 20;
  ctx.fillStyle = C.brightPurple;
  ctx.font = `700 ${type.section}px ${REWIND_FONT_TEXT}`;
  const titleY = body ? y + height / 2 - 12 : y + height / 2 + type.section / 2 - 4;
  withTracking(ctx, 2, () => {
    ctx.fillText(fitText(ctx, title.toLocaleUpperCase(), textW), textX, titleY);
  });
  if (body) {
    ctx.fillStyle = C.textSecondary;
    ctx.font = `500 ${Math.round(type.body * 0.92)}px ${REWIND_FONT_TEXT}`;
    const words = body.split(' ');
    let line = '';
    let lineY = titleY + type.body + 10;
    for (const word of words) {
      const probe = line ? `${line} ${word}` : word;
      if (ctx.measureText(probe).width > textW && line) {
        ctx.fillText(line, textX, lineY);
        line = word;
        lineY += type.body * 1.25;
        if (lineY > y + height - 12) return;
      } else {
        line = probe;
      }
    }
    if (line) ctx.fillText(line, textX, lineY);
  }
}

/** §9 genre list — label, percent, slim bar per genre. */
export function drawGenreBars(
  rc: RewindRenderContext,
  x: number,
  y: number,
  width: number,
  genres: { name: string; percent: number }[],
): number {
  const { ctx, type } = rc;
  for (const genre of genres) {
    ctx.fillStyle = C.textPrimary;
    ctx.font = `700 ${Math.round(type.statLabel * 1.05)}px ${REWIND_FONT_TEXT}`;
    withTracking(ctx, 1.5, () => {
      ctx.fillText(fitText(ctx, genre.name.toLocaleUpperCase(), width - 90), x, y + type.statLabel);
    });
    ctx.textAlign = 'right';
    ctx.fillText(`${genre.percent}%`, x + width, y + type.statLabel);
    ctx.textAlign = 'left';
    y += type.statLabel + 10;
    ctx.fillStyle = 'rgba(39, 33, 62, 0.9)';
    fillRoundRect(ctx, x, y, width, 7, 3.5);
    ctx.fillStyle = C.primaryPurple;
    fillRoundRect(ctx, x, y, Math.max(7, width * (genre.percent / 100)), 7, 3.5);
    y += 7 + 20;
  }
  return y;
}

/** §5 PrivacyFooter — quiet privacy line + site, both centred. */
export function drawFooter(rc: RewindRenderContext, opts?: { withLock?: boolean }): void {
  const { ctx, w, h, pad, type } = rc;
  ctx.textAlign = 'center';
  ctx.fillStyle = C.textSecondary;
  ctx.font = `500 ${type.footer}px ${REWIND_FONT_TEXT}`;
  const privacy = fitText(ctx, rc.strings.privacy, w - pad * 2 - 40);
  const privacyY = h - pad - type.footer - 14;
  ctx.fillText(privacy, w / 2, privacyY);
  if (opts?.withLock) {
    const textW = ctx.measureText(privacy).width;
    drawIcon(ctx, 'lock', w / 2 - textW / 2 - 30, privacyY - type.footer + 2, 20, C.textSecondary);
  }
  ctx.fillStyle = C.primaryPurple;
  ctx.font = `600 ${type.footer}px ${REWIND_FONT_TEXT}`;
  ctx.fillText('www.psysonic.de', w / 2, h - pad);
  ctx.textAlign = 'left';
}

/** Building blocks re-exported for layouts that compose them directly. */
export { drawEqualizerBars };
export { drawCard };
