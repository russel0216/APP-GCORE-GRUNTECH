/**
 * A QR code for a link, drawn in the browser (2026-11-13: the Employment
 * Examination's link, scanned with the applicant's phone). qrcode-generator
 * 1.4.4 is VENDORED in web/public/qrcode/ (README.txt: the build and its
 * integrity) and loaded with a script tag only when a link is shown, as jsQR
 * is for the badge scanner — no bundle carries it.
 */

interface QrInstance {
  addData: (data: string) => void;
  make: () => void;
  createSvgTag: (opts: { cellSize?: number; margin?: number; scalable?: boolean }) => string;
}
type QrFactory = (typeNumber: number, errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H') => QrInstance;

let loading: Promise<QrFactory> | null = null;

function loadQr(): Promise<QrFactory> {
  const existing = (window as unknown as { qrcode?: QrFactory }).qrcode;
  if (existing) return Promise.resolve(existing);
  if (!loading) {
    loading = new Promise<QrFactory>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/qrcode/qrcode.js';
      s.async = true;
      s.onload = () => {
        const fn = (window as unknown as { qrcode?: QrFactory }).qrcode;
        if (fn) resolve(fn);
        else reject(new Error('The QR maker did not load'));
      };
      s.onerror = () => reject(new Error('The QR maker could not be loaded — check the connection'));
      document.head.appendChild(s);
    });
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

/** The link as an SVG QR code (scalable, black on white), for an <img> or a download. */
export async function qrSvg(text: string): Promise<string> {
  const qrcode = await loadQr();
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  // The margin is in pixels: four cells of quiet zone, as the standard asks.
  return qr.createSvgTag({ cellSize: 6, margin: 24, scalable: true });
}

/** The same as a data: URL, for an <img src>. */
export async function qrDataUrl(text: string): Promise<string> {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(await qrSvg(text))}`;
}
