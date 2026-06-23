import React from 'react';
import { useTranslation } from 'react-i18next';

export default function StarRating({
  value,
  onChange,
  disabled = false,
  maxStars = 5,
  maxSelectable: maxSelectableProp,
  labelKey = 'albumDetail.ratingLabel',
  ariaLabel,
  className = '',
}: {
  value: number;
  onChange: (rating: number) => void;
  disabled?: boolean;
  /** Number of star buttons (1…maxStars). Default 5. */
  maxStars?: number;
  /** Highest selectable star (inclusive); higher stars are shown but disabled. */
  maxSelectable?: number;
  labelKey?: string;
  /** Overrides `t(labelKey)` for the radiogroup `aria-label` when set. */
  ariaLabel?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const stars = React.useMemo(
    () => Array.from({ length: Math.max(1, Math.min(5, maxStars)) }, (_, i) => i + 1),
    [maxStars]
  );
  const selectCap = Math.min(maxSelectableProp ?? stars.length, stars.length);
  const [hover, setHover] = React.useState(0);
  const [pulseStar, setPulseStar] = React.useState<number | null>(null);
  const [clearShrinkStar, setClearShrinkStar] = React.useState<number | null>(null);
  /** After clear: ignore hover so stars stay grey until pointer leaves widget or next click */
  const [suppressHoverPreview, setSuppressHoverPreview] = React.useState(false);
  const prevValueRef = React.useRef(value);
  const internalClickRef = React.useRef(false);

  const cappedValue = Math.min(Math.max(0, value), selectCap);

  React.useEffect(() => {
    // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (value > 0) setSuppressHoverPreview(false);
  }, [value]);

  // Keep keyboard-driven changes visually in sync with mouse click effects.
  React.useEffect(() => {
    const prev = prevValueRef.current;
    const next = value;
    prevValueRef.current = value;

    if (internalClickRef.current) {
      internalClickRef.current = false;
      return;
    }
    if (prev === next) return;

    setPulseStar(null);
    setClearShrinkStar(null);

    if (next > prev) {
      const star = Math.max(1, Math.min(selectCap, next));
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setPulseStar(star));
      });
      return;
    }

    if (next < prev) {
      const star = Math.max(1, Math.min(selectCap, prev));
      // React Compiler set-state-in-effect rule: state set from a timer/animation callback.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (next === 0) setSuppressHoverPreview(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setClearShrinkStar(star));
      });
    }
  }, [value, selectCap]);

  const effectiveHover = suppressHoverPreview ? 0 : Math.min(hover, selectCap);
  const filled = (n: number) => (effectiveHover || cappedValue) >= n;

  const handleStarClick = (n: number) => {
    if (disabled || n > selectCap) return;
    setSuppressHoverPreview(false);

    const next = cappedValue === n ? 0 : n;
    internalClickRef.current = true;
    onChange(next);
    setHover(0);

    setPulseStar(null);
    setClearShrinkStar(null);

    if (next === 0) {
      setSuppressHoverPreview(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setClearShrinkStar(n));
      });
    } else {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setPulseStar(n));
      });
    }
  };

  const handleContainerLeave = () => {
    setHover(0);
    setSuppressHoverPreview(false);
  };

  return (
    <div
      className={`star-rating${disabled ? ' star-rating--disabled' : ''}${suppressHoverPreview ? ' star-rating--suppress-hover' : ''} ${className}`.trim()}
      role="radiogroup"
      aria-label={ariaLabel ?? t(labelKey)}
      aria-disabled={disabled}
      onMouseLeave={disabled ? undefined : handleContainerLeave}
    >
      {stars.map(n => {
        const locked = n > selectCap;
        return (
          <button
            key={n}
            type="button"
            className={`star ${filled(n) ? 'filled' : ''}${pulseStar === n ? ' star--pulse' : ''}${clearShrinkStar === n ? ' star--clear-shrink' : ''}${locked ? ' star--locked' : ''}`}
            onMouseEnter={() =>
              !disabled && !suppressHoverPreview && !locked && setHover(n)
            }
            onClick={() => handleStarClick(n)}
            onAnimationEnd={e => {
              if (e.currentTarget !== e.target) return;
              const name = e.animationName;
              if (name === 'star-rating-star-pulse') {
                setPulseStar(s => (s === n ? null : s));
              }
              if (name === 'star-rating-star-clear-shrink') {
                setClearShrinkStar(s => (s === n ? null : s));
              }
            }}
            disabled={disabled || locked}
            aria-label={`${n}`}
            role="radio"
            aria-checked={filled(n)}
          >
            ★
          </button>
        );
      })}
    </div>
  );
}
