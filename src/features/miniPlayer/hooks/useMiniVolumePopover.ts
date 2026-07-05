import { useMiniAnchoredPopover } from '@/features/miniPlayer/hooks/useMiniAnchoredPopover';

/** Open-state, refs, and fixed positioning of the portaled mini-player volume
 *  popover. Thin wrapper over {@link useMiniAnchoredPopover} that preserves the
 *  `volume*` field names its consumer expects. */
export function useMiniVolumePopover() {
  const { open, setOpen, popStyle, btnRef, popRef } = useMiniAnchoredPopover(40, 150);
  return {
    volumeOpen: open,
    setVolumeOpen: setOpen,
    volumePopStyle: popStyle,
    volumeBtnRef: btnRef,
    volumePopRef: popRef,
  };
}
