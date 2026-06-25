const CTP_COLORS = [
  'var(--ctp-rosewater)', 'var(--ctp-flamingo)', 'var(--ctp-pink)', 'var(--ctp-mauve)',
  'var(--ctp-red)', 'var(--ctp-maroon)', 'var(--ctp-peach)', 'var(--ctp-yellow)',
  'var(--ctp-green)', 'var(--ctp-teal)', 'var(--ctp-sky)', 'var(--ctp-sapphire)',
  'var(--ctp-blue)', 'var(--ctp-lavender)',
];

/** Stable Catppuccin-palette colour for a genre name — same hash on the Genres page and album detail. */
export function genreColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return CTP_COLORS[h % CTP_COLORS.length];
}
