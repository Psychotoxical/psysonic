/// <reference types="vite/client" />

declare global {
  interface Window {
    __psyHidden?: boolean;
    __psyBlurred?: boolean;
    __psyStartMinimizedToTray?: boolean;
    __psyIsTilingWm?: boolean;
    __psyLifecycleGeneration?: number;
  }
}

export {};
