import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { APP_MAIN_SCROLL_VIEWPORT_ID } from '@/constants/appScroll';

interface BackToTopButtonProps {
  /** Id of the scroll viewport to watch/scroll. Defaults to the main route scroller. */
  viewportId?: string;
  /** Show the button once the viewport is scrolled past this many pixels. */
  threshold?: number;
}

/**
 * A floating "back to top" affordance for long pages. Watches a scroll viewport
 * (the overlay-scroll element wrapping the routes by default) and, once it is
 * scrolled past `threshold`, shows a button that smooth-scrolls it back to the
 * top — reusing the same `getElementById(...).scrollTo` pattern AppShell uses
 * for its route-change scroll reset.
 *
 * The button is portalled into `.app-shell-route-host` and positioned
 * `absolute` against it: the scroll viewport itself sets `contain: paint`, which
 * would otherwise make a `position: fixed` child resolve against the *scrolling*
 * box (so it would drift with the content). The route host is a non-contained,
 * `position: relative` ancestor that spans exactly the content area (between the
 * sidebar and queue, above the player bar), so the button stays pinned to the
 * visible viewport corner regardless of scroll.
 */
export default function BackToTopButton({
  viewportId = APP_MAIN_SCROLL_VIEWPORT_ID,
  threshold = 400,
}: BackToTopButtonProps) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    // React Compiler set-state-in-effect rule: state set from a DOM/layout measurement.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHost(document.querySelector<HTMLElement>('.app-shell-route-host'));
    const el = document.getElementById(viewportId);
    if (!el) return;
    const onScroll = () => setVisible(el.scrollTop > threshold);
    onScroll(); // sync immediately (e.g. switching back to an already-scrolled tab)
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [viewportId, threshold]);

  if (!visible || !host) return null;

  return createPortal(
    <button
      type="button"
      className="back-to-top-btn"
      onClick={() =>
        document.getElementById(viewportId)?.scrollTo({ top: 0, behavior: 'smooth' })
      }
      aria-label={t('common.backToTop')}
      data-tooltip={t('common.backToTop')}
      data-tooltip-pos="left"
    >
      <ArrowUp size={18} aria-hidden="true" />
    </button>,
    host,
  );
}
