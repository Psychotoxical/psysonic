import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';

export interface ColDef {
  readonly key: string;
  readonly i18nKey?: string | null;
  readonly minWidth: number;
  readonly defaultWidth: number;
  readonly required: boolean;
  /** If true the column uses minmax(minWidth, 1fr) instead of a fixed px width. */
  readonly flex?: boolean;
}

/** Shared flex title column — room for play/preview/cover controls + readable title text. */
export const TRACK_TITLE_FLEX_COL = {
  minWidth: 240,
  defaultWidth: 320,
  flex: true as const,
};

function flexColumnMin(c: ColDef, widths: Record<string, number>): number {
  const w = widths[c.key];
  if (typeof w === 'number' && w >= c.minWidth) return w;
  if (c.defaultWidth >= c.minWidth) return c.defaultWidth;
  return c.minWidth;
}

function fixedColumnWidth(c: ColDef, widths: Record<string, number>): number {
  const w = widths[c.key];
  return typeof w === 'number' && w > 0 ? w : c.defaultWidth;
}

function loadPrefs(
  storageKey: string,
  columns: readonly ColDef[],
): { widths: Record<string, number>; visible: Set<string> } {
  const defaultWidths: Record<string, number> = Object.fromEntries(
    columns.map(c => [c.key, c.defaultWidth]),
  );
  const defaultVisible = new Set<string>(columns.map(c => c.key));
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return { widths: defaultWidths, visible: defaultVisible };
    const parsed = JSON.parse(raw) as { widths?: Record<string, number>; visible?: string[]; known?: string[] };
    const visible = new Set<string>(parsed.visible ?? [...defaultVisible]);
    columns.filter(c => c.required).forEach(c => visible.add(c.key));
    // Auto-show columns that are new since prefs were last saved.
    // "known" tracks every column seen at save time; absent = newly added column → default to visible.
    if (parsed.known) {
      const known = new Set<string>(parsed.known);
      columns.filter(c => !c.required && !known.has(c.key)).forEach(c => visible.add(c.key));
    }
    const widths = { ...defaultWidths, ...(parsed.widths ?? {}) };
    const durationCol = columns.find(c => c.key === 'duration');
    if (durationCol && typeof widths.duration === 'number' && widths.duration < durationCol.minWidth) {
      widths.duration = defaultWidths.duration;
    }
    // Flex title columns persisted `0` before resizable flex mins — seed a usable default.
    columns.forEach(c => {
      if (!c.flex || c.defaultWidth < c.minWidth) return;
      const w = widths[c.key];
      if (typeof w !== 'number' || w < c.minWidth) {
        widths[c.key] = c.defaultWidth;
      }
    });
    return { widths, visible };
  } catch {
    return { widths: defaultWidths, visible: defaultVisible };
  }
}

function savePrefs(storageKey: string, widths: Record<string, number>, visible: Set<string>) {
  const known = Object.keys(widths);
  localStorage.setItem(storageKey, JSON.stringify({ widths, visible: [...visible], known }));
}

export function useTracklistColumns(columns: readonly ColDef[], storageKey: string) {
  const [colWidths, setColWidths] = useState<Record<string, number>>(
    () => loadPrefs(storageKey, columns).widths,
  );
  const [colVisible, setColVisible] = useState<Set<string>>(
    () => loadPrefs(storageKey, columns).visible,
  );
  const [pickerOpen, setPickerOpen] = useState(false);

  const tracklistRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  // Refs to avoid stale closures in drag/save handlers
  const colWidthsRef = useRef(colWidths);
  const colVisibleRef = useRef(colVisible);
  useEffect(() => { colWidthsRef.current = colWidths; }, [colWidths]);
  useEffect(() => { colVisibleRef.current = colVisible; }, [colVisible]);

  const visibleCols = useMemo(
    () => columns.filter(c => colVisible.has(c.key)),
    [columns, colVisible],
  );

  const gridTemplate = useMemo(
    () =>
      visibleCols
        .map(c => {
          if (c.flex) return `minmax(${flexColumnMin(c, colWidths)}px, 1fr)`;
          // Defensive fallback: a column added since the last persist would have
          // no saved width, leaving the grid template with `undefinedpx` and
          // collapsing the row visually until the user resets defaults.
          return `${fixedColumnWidth(c, colWidths)}px`;
        })
        .join(' '),
    [visibleCols, colWidths],
  );

  // Minimum total width so the grid never squishes below its current column sizes.
  // When .tracklist is narrower, overflow-x: auto triggers a scrollbar.
  // Formula (box-sizing: border-box): colSum + gaps + left/right padding (12px each = 24px)
  const gridMinWidth = useMemo(() => {
    const gapPx = 12; // --space-3
    const boxPaddingH = 24; // var(--space-3) * 2
    const colSum = visibleCols.reduce<number>(
      (s, c) => s + (c.flex ? flexColumnMin(c, colWidths) : fixedColumnWidth(c, colWidths)),
      0,
    );
    const gaps = Math.max(0, visibleCols.length - 1) * gapPx;
    return colSum + gaps + boxPaddingH;
  }, [visibleCols, colWidths]);

  const gridStyle = useMemo(
    () => ({ gridTemplateColumns: gridTemplate, minWidth: `${gridMinWidth}px` }),
    [gridTemplate, gridMinWidth],
  );

  // Excel-style column resize:
  //   direction =  1 → right-edge handle: drag right → column grows, 1fr title shrinks
  //   direction = -1 → left-edge handle : drag right → next px col shrinks, 1fr title grows
  const startResize = useCallback(
    (e: React.MouseEvent, colIndex: number, direction: 1 | -1 = 1) => {
      e.preventDefault();
      e.stopPropagation();

      const visCols = visibleCols; // stable for the drag duration
      const colDef = visCols[colIndex];
      const colKey = colDef.key;
      const colDefFull = columns.find(c => c.key === colKey)!;
      const colMin = colDefFull.minWidth;
      const startX = e.clientX;
      const startW = fixedColumnWidth(colDefFull, colWidths);

      let maxW = Infinity;
      const el = tracklistRef.current;
      if (el) {
        const style = getComputedStyle(el);
        const paddingH = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        const containerW = el.clientWidth - paddingH;
        const headerEl = el.querySelector('.tracklist-header') as HTMLElement | null;
        const gapPx = headerEl
          ? parseFloat(getComputedStyle(headerEl).columnGap) || 12
          : 12;
        const totalGaps = (visCols.length - 1) * gapPx;
        const widthsNow = colWidthsRef.current;
        const otherFixed = visCols
          .filter((_, i) => i !== colIndex)
          .reduce<number>(
            (s, c) => s + (c.flex ? flexColumnMin(c, widthsNow) : fixedColumnWidth(c, widthsNow)),
            0,
          );
        maxW = Math.max(colMin, containerW - totalGaps - otherFixed);
      }

      const onMove = (me: MouseEvent) => {
        const delta = me.clientX - startX;
        const newW = Math.min(Math.max(colMin, startW + direction * delta), maxW);
        setColWidths(prev => ({ ...prev, [colKey]: newW }));
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        savePrefs(storageKey, colWidthsRef.current, colVisibleRef.current);
      };

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [columns, visibleCols, colWidths, storageKey],
  );

  // Drag the flex (title) column min width — persisted in colWidths[key].
  const startFlexColumnResize = useCallback(
    (e: React.MouseEvent, colIndex: number, direction: 1 | -1 = 1) => {
      e.preventDefault();
      e.stopPropagation();

      const visCols = visibleCols;
      const colDef = visCols[colIndex];
      if (!colDef?.flex) return;

      const colKey = colDef.key;
      const colMin = colDef.minWidth;
      const startX = e.clientX;
      const startW = flexColumnMin(colDef, colWidths);

      let maxW = Infinity;
      const el = tracklistRef.current;
      if (el) {
        const style = getComputedStyle(el);
        const paddingH = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        const containerW = el.clientWidth - paddingH;
        const headerEl = el.querySelector('.tracklist-header') as HTMLElement | null;
        const gapPx = headerEl
          ? parseFloat(getComputedStyle(headerEl).columnGap) || 12
          : 12;
        const totalGaps = (visCols.length - 1) * gapPx;
        const widthsNow = colWidthsRef.current;
        const otherFixed = visCols
          .filter((_, i) => i !== colIndex)
          .reduce<number>(
            (s, c) => s + (c.flex ? flexColumnMin(c, widthsNow) : fixedColumnWidth(c, widthsNow)),
            0,
          );
        maxW = Math.max(colMin, containerW - totalGaps - otherFixed);
      }

      const onMove = (me: MouseEvent) => {
        const delta = me.clientX - startX;
        const newW = Math.min(Math.max(colMin, startW + direction * delta), maxW);
        setColWidths(prev => ({ ...prev, [colKey]: newW }));
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        savePrefs(storageKey, colWidthsRef.current, colVisibleRef.current);
      };

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [visibleCols, colWidths, storageKey],
  );

  const toggleColumn = useCallback(
    (key: string) => {
      const def = columns.find(c => c.key === key)!;
      if (def.required) return;
      setColVisible(prev => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        savePrefs(storageKey, colWidthsRef.current, next);
        return next;
      });
    },
    [columns, storageKey],
  );

  const resetColumns = useCallback(() => {
    const defaultWidths = Object.fromEntries(columns.map(c => [c.key, c.defaultWidth]));
    const defaultVisible = new Set(columns.map(c => c.key));
    setColWidths(defaultWidths);
    setColVisible(defaultVisible);
    localStorage.removeItem(storageKey);
  }, [columns, storageKey]);

  // Note: outside-click / Escape close is handled inside TracklistColumnPicker,
  // because its menu is portalled out of `pickerRef` and a wrapper-only check
  // would close it on every in-menu click.

  return {
    colWidths,
    colVisible,
    visibleCols,
    gridStyle,
    startResize,
    startFlexColumnResize,
    toggleColumn,
    resetColumns,
    pickerOpen,
    setPickerOpen,
    pickerRef,
    tracklistRef,
  };
}
