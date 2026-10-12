import type { Response } from 'express';
import { manilaDayKey } from './day';

/**
 * The name a paper is saved under (2026-10-12, the owner's call: "on saving
 * to local workstation make the file name have a standard file name — for
 * example document numbering, author, document's date"). One shape for
 * every PDF the app sends:
 *
 *   <Kind> <Number> - <Author> - <YYYY-MM-DD>.pdf
 *   Quotation 0062602018 R0 - Carter Gasiong - 2026-10-08.pdf
 *   Sales Forecast - Carter Gasiong - 2026-10-12.pdf      (a list: who printed, today)
 *
 * The date is the document's own, on the Manila day; the author is who
 * prepared it. A part with nothing in it drops out rather than printing
 * "undefined"; a character a file system refuses becomes "-". Pure.
 */
export interface PaperName {
  kind: string;
  number?: string | null;
  /** A revision, printed " R<n>" after the number. */
  revision?: number | null;
  author?: string | null;
  date?: Date | string | null;
}

const REFUSED = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const MAX_LENGTH = 150;

function clean(s: string): string {
  return s.replace(REFUSED, '-').replace(/\s+/g, ' ').trim();
}

function dayOf(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  if (typeof d === 'string') return /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null;
  return Number.isNaN(d.getTime()) ? null : manilaDayKey(d);
}

export function paperFileName(p: PaperName, ext = 'pdf'): string {
  const head = clean(
    [p.kind, p.number ?? '', p.revision !== null && p.revision !== undefined ? `R${p.revision}` : ''].filter(Boolean).join(' '),
  );
  const parts = [head, clean(p.author ?? ''), dayOf(p.date) ?? ''].filter(Boolean);
  let base = parts.join(' - ') || 'Document';
  if (base.length > MAX_LENGTH) base = base.slice(0, MAX_LENGTH).trim();
  return `${base}.${ext}`;
}

/**
 * The header for a named paper: an ASCII `filename` (anything outside
 * plain ASCII as "_", for old browsers) and the exact name in `filename*`
 * (RFC 6266/5987), which every current browser prefers — so "Peñalosa"
 * saves as typed.
 */
export function contentDisposition(name: string, disposition: 'inline' | 'attachment' = 'inline'): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** A list's old file name ('sales-forecast.pdf') as its kind ('Sales Forecast'). */
export function kindOfFile(filename: string): string {
  return filename
    .replace(/\.[a-z0-9]+$/i, '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Sends a document's paper inline under the standard name. */
export function sendPaper(res: Response, pdf: Buffer | Uint8Array, name: PaperName): void {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', contentDisposition(paperFileName(name)));
  res.send(Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf));
}
