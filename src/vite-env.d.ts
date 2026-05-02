/// <reference types="vite/client" />

declare global {
  interface Window {
    __psyHidden?: boolean;
    __psyBlurred?: boolean;
  }
}

export {};
