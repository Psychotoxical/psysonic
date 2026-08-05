/// <reference types="vite/client" />

declare global {
  interface Window {
    __psyHidden?: boolean;
    __psyBlurred?: boolean;
    __psyStartMinimizedToTray?: boolean;
    __psyUseCustomTitlebar?: boolean;
    __psyIsTilingWm?: boolean;
  }
}

export {};
