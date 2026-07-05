import { useMiniAnchoredPopover } from '@/features/miniPlayer/hooks/useMiniAnchoredPopover';

/** Open-state, refs, and fixed positioning of the portaled mini-player
 *  crossfade settings popover (seconds slider + trim-silence toggle). Opened by
 *  right-click on the crossfade toolbar button. */
export function useMiniCrossfadePopover() {
  const { open, setOpen, popStyle, btnRef, popRef } = useMiniAnchoredPopover(190, 120);
  return {
    crossfadeOpen: open,
    setCrossfadeOpen: setOpen,
    crossfadePopStyle: popStyle,
    crossfadeBtnRef: btnRef,
    crossfadePopRef: popRef,
  };
}
