export const TRANSIENT_UI_CLOSE_EVENT = 'psy:close-transient-ui';
export const TRANSIENT_UI_OPEN_EVENT = 'psy:open-transient-ui';

/** Ask independently-owned menus and popovers to dismiss before a covering UI opens. */
export function requestTransientUiClose(): void {
  window.dispatchEvent(new Event(TRANSIENT_UI_CLOSE_EVENT));
}

/** Dismiss sibling layers, then let covering surfaces yield before a new layer opens. */
export function prepareTransientUiOpen(): void {
  requestTransientUiClose();
  window.dispatchEvent(new Event(TRANSIENT_UI_OPEN_EVENT));
}
