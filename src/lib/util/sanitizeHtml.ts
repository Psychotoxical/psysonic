/**
 * Strip dangerous tags / attributes from server-provided HTML (artist & album
 * biographies). Removes embedded/active elements and `on*` / `javascript:` /
 * `data:` handlers before the result is fed to `dangerouslySetInnerHTML`.
 */
export function sanitizeHtml(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, iframe, object, embed, form, input, button, select, base, meta, link').forEach(el => el.remove());
  doc.querySelectorAll('*').forEach(el => {
    Array.from(el.attributes).forEach(attr => {
      const name = attr.name.toLowerCase();
      const val = attr.value.toLowerCase().trim();
      if (
        name.startsWith('on') ||
        (name === 'href' && (val.startsWith('javascript:') || val.startsWith('data:'))) ||
        (name === 'src' && (val.startsWith('javascript:') || val.startsWith('data:')))
      ) {
        el.removeAttribute(attr.name);
      }
    });
  });
  return doc.body.innerHTML;
}
