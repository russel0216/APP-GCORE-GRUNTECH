/**
 * The first page of a PDF as a picture, for the attachment tiles
 * (2026-10-12). pdf.js is VENDORED in `public/pdfjs/` (README.txt there says
 * which build and its integrity) and loaded only when a PDF tile first comes
 * into view — the main bundle never carries it, and npm never resolves it
 * (this sandbox cannot re-resolve the lockfile). A browser's own PDF viewer
 * cannot be shown as a thumbnail everywhere (mobile Chrome and headless
 * have none), so the page is drawn onto a canvas instead.
 */
type PdfJs = {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (src: { data: ArrayBuffer; isEvalSupported?: boolean }) => {
    promise: Promise<{
      getPage: (n: number) => Promise<{
        getViewport: (o: { scale: number }) => { width: number; height: number };
        render: (o: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => { promise: Promise<void> };
      }>;
      destroy: () => Promise<void>;
    }>;
  };
};

let loading: Promise<PdfJs> | null = null;

function pdfjs(): Promise<PdfJs> {
  if (!loading) {
    const src = '/pdfjs/pdf.min.mjs';
    loading = (import(/* @vite-ignore */ src) as Promise<PdfJs>).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
      return lib;
    });
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

/** Page 1 drawn `width` pixels wide (doubled for a sharp screen), as a PNG blob. */
export async function pdfFirstPage(bytes: ArrayBuffer, width = 360): Promise<Blob> {
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: bytes, isEvalSupported: false }).promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (width * 2) / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('no image'))), 'image/png'));
  } finally {
    void doc.destroy();
  }
}
