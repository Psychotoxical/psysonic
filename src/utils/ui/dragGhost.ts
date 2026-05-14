/**
 * Creates a slim, themed drag ghost and registers it via setDragImage.
 * The element is cleaned up when the drag completes (dragend).
 *
 * On Linux (WebKitGTK), the GTK drag subsystem captures the drag image
 * asynchronously — removing the element in the same tick or via
 * setTimeout(…, 0) causes the image to be gone before GTK reads it,
 * which makes GTK treat the entire drag as invalid (forbidden cursor).
 * Using a dragend listener ensures the element persists for the full
 * duration of the drag operation on all platforms.
 *
 * @param dataTransfer - the event's dataTransfer object
 * @param label        - primary text (track/album title)
 * @param opts.coverUrl - optional thumbnail URL (shown as 24×24 image)
 */
export function setDragGhost(
  dataTransfer: DataTransfer,
  label: string,
  opts: { coverUrl?: string } = {},
): void {
  const el = document.createElement('div');

  el.style.cssText = [
    'position:fixed',
    'left:-9999px',
    'top:-9999px',
    'display:flex',
    'align-items:center',
    'gap:8px',
    `padding:0 14px 0 ${opts.coverUrl ? '6px' : '10px'}`,
    'height:34px',
    'max-width:240px',
    'border-radius:17px',
    'background:var(--bg-card,#fff)',
    'border:1px solid var(--border,rgba(0,0,0,.12))',
    'border-left:3px solid var(--accent,#888)',
    'box-shadow:0 4px 20px rgba(0,0,0,.22)',
    'font-family:var(--font-ui,sans-serif)',
    'font-size:13px',
    'font-weight:500',
    'color:var(--text-primary,#222)',
    'pointer-events:none',
    'white-space:nowrap',
    'overflow:hidden',
    'z-index:99999',
  ].join(';');

  if (opts.coverUrl) {
    const img = document.createElement('img');
    img.src = opts.coverUrl;
    img.style.cssText = 'width:24px;height:24px;border-radius:4px;object-fit:cover;flex-shrink:0;';
    el.appendChild(img);
  } else {
    const dot = document.createElement('span');
    dot.style.cssText = 'width:6px;height:6px;border-radius:50%;background:var(--accent,#888);flex-shrink:0;';
    el.appendChild(dot);
  }

  const text = document.createElement('span');
  text.textContent = label;
  text.style.cssText = 'overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0;';
  el.appendChild(text);

  document.body.appendChild(el);
  dataTransfer.setDragImage(el, 20, 17);

  // Clean up the ghost element when the drag ends, not immediately.
  // This is critical for Linux/WebKitGTK where the drag image is
  // captured asynchronously by GTK — removing it sooner causes
  // the "forbidden" cursor and blocks the entire drop operation.
  const cleanup = () => {
    el.remove();
    document.removeEventListener('dragend', cleanup);
  };
  document.addEventListener('dragend', cleanup, { once: true });
}
