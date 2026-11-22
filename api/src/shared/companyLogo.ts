import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { attachmentPath } from './attachments';

/**
 * The company logo (Company Settings) as the screens and papers use it
 * (2026-11-22). An uploaded logo may be print-sized — the owner's PNG was
 * 11.7 MB — so the top bar and every PDF take a reduced copy, never the file.
 */

/** The stored file, else the same file name in this install's upload folder
 *  (a copy of another install's database names that machine's folder). */
export function logoFile(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (fs.existsSync(stored)) return stored;
  const here = attachmentPath(path.win32.basename(stored));
  return fs.existsSync(here) ? here : null;
}

const memo = new Map<string, Buffer>();

/** A PNG of the logo at most `height` pixels tall, kept until the file changes. */
export async function logoImage(stored: string | null | undefined, height: number): Promise<Buffer | null> {
  const file = logoFile(stored);
  if (!file) return null;
  const stat = fs.statSync(file);
  const key = `${file}|${stat.mtimeMs}|${stat.size}|${height}`;
  const kept = memo.get(key);
  if (kept) return kept;
  const bytes = await sharp(file).rotate().resize({ height, withoutEnlargement: true }).png().toBuffer();
  for (const k of memo.keys()) if (k.startsWith(`${file}|`) && k.endsWith(`|${height}`)) memo.delete(k);
  memo.set(key, bytes);
  return bytes;
}

/**
 * The file a PDF draws: a reduced copy written beside the logo (600 px tall —
 * sharp at 56 pt), refreshed when the logo changes. Null when none is set or
 * it cannot be read; a broken logo never stops a document printing.
 */
export async function printLogoPath(stored: string | null | undefined): Promise<string | null> {
  try {
    const file = logoFile(stored);
    if (!file) return null;
    const stat = fs.statSync(file);
    const copy = attachmentPath(`${path.win32.basename(file).replace(/\.[^.]+$/, '')}.print-${Math.round(stat.mtimeMs)}.png`);
    if (!fs.existsSync(copy)) {
      const bytes = await logoImage(file, 600);
      if (!bytes) return null;
      fs.writeFileSync(copy, bytes);
    }
    return copy;
  } catch {
    return null;
  }
}
