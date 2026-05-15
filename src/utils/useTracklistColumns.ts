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
          if (c.flex) return `minmax(${c.minWidth}px, 1fr)`;
          // Defensive fallback: a column added since the last persist would have
          // no saved width, leaving the grid template with `undefinedpx` and
          // collapsing the row visually until the user resets defaults.
          const w = colWidths[c.key];
          return `${typeof w === 'number' && w > 0 ? w : c.defaultWidth}px`;
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
      (s, c) => {
        if (c.flex) return s + c.minWidth;
        const w = colWidths[c.key];
        return s + (typeof w === 'number' && w > 0 ? w : c.defaultWidth);
      },
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
      const colMin = columns.find(c => c.key === colKey)!.minWidth;
      const startX = e.clientX;
      const startW = colWidths[colKey];

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
        const otherFixed = visCols
          .filter((_, i) => i !== colIndex)
          .reduce<number>((s, c) => s + (c.flex ? c.minWidth : colWidths[c.key]), 0);
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

  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pickerOpen]);

  return {
    colWidths,
    colVisible,
    visibleCols,
    gridStyle,
    startResize,
    toggleColumn,
    resetColumns,
    pickerOpen,
    setPickerOpen,
    pickerRef,
    tracklistRef,
  };
}
