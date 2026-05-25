/** Omit `src` until URL is ready — React 19 rejects `src=""` on `<img>`. */
export function coverImgSrc(url: string): string | undefined {
  return url.length > 0 ? url : undefined;
}
