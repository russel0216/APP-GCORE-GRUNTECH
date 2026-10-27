/**
 * Reading a QR code from the camera (2026-10-27, Marketing: the exhibition
 * badge scanner). The browser's own BarcodeDetector where it has one (Chrome
 * on Android), else jsQR — VENDORED in `public/jsqr/` (README.txt there says
 * which build and its integrity) and loaded with a script tag only when the
 * scanner first needs it (iPhone Safari has no BarcodeDetector). The main
 * bundle carries neither.
 */

type JsQr = (data: Uint8ClampedArray, width: number, height: number, options?: { inversionAttempts?: string }) => { data: string } | null;

interface Detector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}

let jsqrLoading: Promise<JsQr> | null = null;

function loadJsQr(): Promise<JsQr> {
  const existing = (window as unknown as { jsQR?: JsQr }).jsQR;
  if (existing) return Promise.resolve(existing);
  if (!jsqrLoading) {
    jsqrLoading = new Promise<JsQr>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/jsqr/jsQR.js';
      s.async = true;
      s.onload = () => {
        const fn = (window as unknown as { jsQR?: JsQr }).jsQR;
        if (fn) resolve(fn);
        else reject(new Error('The QR reader did not load'));
      };
      s.onerror = () => reject(new Error('The QR reader could not be loaded — check the connection'));
      document.head.appendChild(s);
    });
    jsqrLoading.catch(() => {
      jsqrLoading = null;
    });
  }
  return jsqrLoading;
}

async function nativeDetector(): Promise<Detector | null> {
  const Ctor = (window as unknown as { BarcodeDetector?: { new (o: { formats: string[] }): Detector; getSupportedFormats?: () => Promise<string[]> } }).BarcodeDetector;
  if (!Ctor) return null;
  try {
    const formats = (await Ctor.getSupportedFormats?.()) ?? ['qr_code'];
    if (!formats.includes('qr_code')) return null;
    return new Ctor({ formats: ['qr_code'] });
  } catch {
    return null;
  }
}

/** A reader: one call per frame (a video, an image), the QR's text or null. */
export interface QrReader {
  read(source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement, width: number, height: number): Promise<string | null>;
}

export async function qrReader(): Promise<QrReader> {
  const native = await nativeDetector();
  // jsQR is loaded either way: a native detector that refuses a frame falls back to it.
  const jsqr = native ? null : await loadJsQr();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return {
    async read(source, width, height) {
      if (!width || !height) return null;
      if (native) {
        try {
          const hits = await native.detect(source);
          if (hits[0]?.rawValue) return hits[0].rawValue;
          return null;
        } catch {
          // fall through to jsQR below
        }
      }
      const fn = jsqr ?? (await loadJsQr());
      if (!ctx) return null;
      // A badge fills a fraction of the frame; 960 px across is plenty and keeps a phone quick.
      const scale = Math.min(1, 960 / Math.max(width, height));
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return fn(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
    },
  };
}

/** Reads a QR from a photo file (the scanner's "take a photo" fallback). */
export async function readQrFromFile(file: File): Promise<string | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('That picture could not be read'));
      img.src = url;
    });
    const reader = await qrReader();
    // Try the whole picture, then smaller copies — jsQR finds a small code more easily scaled down.
    for (const max of [img.naturalWidth, 1600, 1000, 700]) {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
      const text = await reader.read(c, c.width, c.height);
      if (text) return text;
    }
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
