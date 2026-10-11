/**
 * A picture of what the person is looking at, taken in the browser for the
 * Help box (2026-10-11): the visible part of the page, as a JPEG.
 *
 * The page is redrawn from its own DOM by html-to-image — no screen-sharing
 * prompt, nothing leaves the browser until the ticket is sent. The library is
 * loaded only when a screenshot is taken, so the main bundle never carries it.
 * `exclude` keeps the Help box itself (and the toasts) out of the picture.
 *
 * Web fonts are embedded when they can be read; a font that cannot be fetched
 * is not worth losing the picture over, so the second try skips them.
 */
export async function captureScreen(exclude: (el: Element) => boolean): Promise<Blob> {
  const { toBlob } = await import('html-to-image');
  const width = window.innerWidth;
  const height = window.innerHeight;
  const options = {
    width,
    height,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    backgroundColor: getComputedStyle(document.body).backgroundColor || '#ffffff',
    // The window scrolls the page; the copy is shifted so the picture is what is on screen.
    style: { transform: `translate(${-window.scrollX}px, ${-window.scrollY}px)`, transformOrigin: 'top left' },
    filter: (node: HTMLElement) => !(node instanceof Element && exclude(node)),
  };
  let blob: Blob | null = null;
  try {
    blob = await withTimeout(toBlob(document.body, options), 20_000);
  } catch {
    blob = await withTimeout(toBlob(document.body, { ...options, skipFonts: true }), 20_000);
  }
  if (!blob) throw new Error('The screenshot could not be taken');
  return blob;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The screenshot took too long')), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
