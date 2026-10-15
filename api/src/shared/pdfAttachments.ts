import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { prisma } from '../prisma';
import { attachmentPath } from './attachments';
import { formatDate, renderDocument, type PdfRow } from './pdf';

/**
 * A document printed WITH its attachments (2026-10-12, the owner's call:
 * "when print or save as the quotation, it also includes the attached
 * documents"; the sales order the same, so its approvers' copy carries the
 * customer's PO).
 *
 * The document's own pages come first, unchanged — their "Page n of m" is
 * the document's own count; then, when anything is attached, one
 * "Attachments" page in the house dress naming every file and what became
 * of it; then each printable file in upload order: a PDF's pages copied in
 * whole (pdf-lib — pdfkit cannot read a PDF), an image on an A4 page of its
 * own, fitted inside the 36pt margins and never enlarged past its pixels.
 * Anything else (Word, Excel, CAD, a zip) cannot be drawn and is only
 * listed — converting Office files would need LibreOffice on a host shared
 * with a safety-critical system. A PDF that cannot be read (encrypted,
 * broken) is listed, never fatal: the document still prints.
 */

export interface AttachedFile {
  id: string;
  fileName: string;
  storedName: string;
  mimeType: string;
  size: number;
  uploadedAt: Date;
  uploadedBy: { name: string } | null;
}

/** A4 in points, and the house margin. */
const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 36;
/** Room kept under an image for its caption. */
const CAPTION = 18;

/** How an attachment will reach the paper, by what it is. */
export function attachmentKind(f: { fileName: string; mimeType: string }): 'pdf' | 'image' | 'other' {
  const ext = path.extname(f.fileName).toLowerCase();
  if (f.mimeType === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (/^image\/(jpeg|png|webp|gif)$/.test(f.mimeType) || ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return 'image';
  return 'other';
}

/**
 * Where an image of `w` × `h` pixels sits on a page of `pageW` × `pageH`:
 * fitted inside the margins (less the caption's room), never enlarged past
 * one point per pixel, centred across and set from the top. Pure.
 */
export function fitImage(w: number, h: number, pageW = A4.w, pageH = A4.h): { x: number; y: number; width: number; height: number } {
  const boxW = pageW - 2 * MARGIN;
  const boxH = pageH - 2 * MARGIN - CAPTION;
  const scale = Math.min(1, boxW / w, boxH / h);
  const width = w * scale;
  const height = h * scale;
  return { x: (pageW - width) / 2, y: pageH - MARGIN - height, width, height };
}

/** "1.2 MB", "340 KB". */
export function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The files of a record, in the order they were added. */
export async function attachedFiles(entityType: string, entityId: string): Promise<AttachedFile[]> {
  return prisma.attachment.findMany({
    where: { entityType, entityId },
    orderBy: { uploadedAt: 'asc' },
    select: {
      id: true,
      fileName: true,
      storedName: true,
      mimeType: true,
      size: true,
      uploadedAt: true,
      uploadedBy: { select: { name: true } },
    },
  });
}

/**
 * The document with its attachments behind it. `files` empty, the document
 * comes back as it was. `doc` names the document on the Attachments page.
 */
export async function withAttachments(
  pdf: Buffer,
  files: AttachedFile[],
  doc: { title: string; number: string; reference?: string },
): Promise<{ pdf: Buffer; printed: number; listed: number }> {
  if (!files.length) return { pdf, printed: 0, listed: 0 };

  // Read each file first, so the Attachments page can say what became of it.
  type Ready = { file: AttachedFile; pages?: PDFDocument; image?: { bytes: Uint8Array; png: boolean; w: number; h: number }; note: string };
  const ready: Ready[] = [];
  for (const file of files) {
    const kind = attachmentKind(file);
    let bytes: Buffer | null = null;
    try {
      bytes = fs.readFileSync(attachmentPath(file.storedName));
    } catch {
      bytes = null;
    }
    if (!bytes) {
      ready.push({ file, note: 'File missing on the server' });
      continue;
    }
    if (kind === 'pdf') {
      try {
        const src = await PDFDocument.load(bytes);
        const n = src.getPageCount();
        ready.push({ file, pages: src, note: `Printed — ${n} page${n === 1 ? '' : 's'}` });
      } catch {
        ready.push({ file, note: 'Could not be read (protected or damaged) — open it in G-CORE' });
      }
    } else if (kind === 'image') {
      try {
        const jpeg = file.mimeType === 'image/jpeg' || /\.jpe?g$/i.test(file.fileName);
        // EXIF-turned, and anything but a JPEG made a PNG (pdf-lib embeds those two only).
        const img = sharp(bytes).rotate();
        const out = jpeg ? await img.jpeg().toBuffer({ resolveWithObject: true }) : await img.png().toBuffer({ resolveWithObject: true });
        ready.push({
          file,
          image: { bytes: out.data, png: !jpeg, w: out.info.width, h: out.info.height },
          note: 'Printed — 1 page',
        });
      } catch {
        ready.push({ file, note: 'Could not be read — open it in G-CORE' });
      }
    } else {
      ready.push({ file, note: 'Not printable — open it in G-CORE' });
    }
  }

  const followPages = ready.reduce((n, r) => n + (r.pages ? r.pages.getPageCount() : r.image ? 1 : 0), 0);
  const rows: PdfRow[] = ready.map((r, i) => [
    String(i + 1),
    { title: r.file.fileName, body: sizeLabel(r.file.size) },
    `${r.file.uploadedBy?.name ?? '—'}\n${formatDate(r.file.uploadedAt)}`,
    r.note,
  ]);
  const listing = await renderDocument({
    title: 'Attachments',
    documentNumber: doc.number,
    reference: doc.reference ?? doc.title,
    sections: [
      {
        kind: 'text',
        body: followPages
          ? `${files.length} file${files.length === 1 ? ' is' : 's are'} attached to ${doc.title} ${doc.number}. ${followPages} page${followPages === 1 ? '' : 's'} follow${followPages === 1 ? 's' : ''}.`
          : `${files.length} file${files.length === 1 ? ' is' : 's are'} attached to ${doc.title} ${doc.number}. None of them can be printed here.`,
      },
      { kind: 'table', head: ['No.', 'File', 'Added by', 'On this paper'], rows, align: ['left', 'left', 'left', 'left'] },
    ],
  });

  const out = await PDFDocument.load(pdf);
  const append = async (src: PDFDocument) => {
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const p of pages) out.addPage(p);
  };
  await append(await PDFDocument.load(listing));
  let printed = 0;
  for (const r of ready) {
    if (r.pages) {
      await append(r.pages);
      printed += 1;
    } else if (r.image) {
      const embedded = r.image.png ? await out.embedPng(r.image.bytes) : await out.embedJpg(r.image.bytes);
      const page = out.addPage([A4.w, A4.h]);
      const at = fitImage(r.image.w, r.image.h);
      page.drawImage(embedded, at);
      const font = await out.embedFont('Helvetica');
      // pdf-lib's standard fonts are WinAnsi too: the name goes through the same stand-ins.
      page.drawText(winAnsi(r.file.fileName).slice(0, 120), { x: MARGIN, y: at.y - 12, size: 8, font });
      printed += 1;
    }
  }
  return { pdf: Buffer.from(await out.save()), printed, listed: files.length };
}

/** A file name drawn with a standard font: anything outside Latin-1 becomes '?'. */
function winAnsi(s: string): string {
  return s.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}

/**
 * Copies a record's files onto another (bytes copied, new rows, a caption
 * saying where from — the CAD plan's rule), so deleting the copy never
 * touches the original. Returns how many were copied; a file missing on
 * disk is skipped.
 */
export async function copyAttachments(
  from: { entityType: string; entityId: string },
  to: { entityType: string; entityId: string },
  caption: string,
  uploadedById: string,
): Promise<number> {
  const files = await prisma.attachment.findMany({ where: from, orderBy: { uploadedAt: 'asc' } });
  let copied = 0;
  for (const f of files) {
    const source = attachmentPath(f.storedName);
    if (!fs.existsSync(source)) continue;
    const storedName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(f.storedName).slice(0, 12)}`;
    const target = attachmentPath(storedName);
    fs.copyFileSync(source, target);
    try {
      await prisma.attachment.create({
        data: {
          entityType: to.entityType,
          entityId: to.entityId,
          fileName: f.fileName,
          storedName,
          mimeType: f.mimeType,
          size: f.size,
          capturedAt: f.capturedAt,
          caption: f.caption ? `${caption} — ${f.caption}` : caption,
          uploadedById,
        },
      });
      copied += 1;
    } catch (err) {
      fs.rmSync(target, { force: true });
      throw err;
    }
  }
  return copied;
}

/**
 * One document's pages, then another's — the designed costing, then its Scope
 * of Work chart (2026-10-13). Each keeps its own pages as drawn, its "Page n
 * of m" included. Saved without object streams, so a page's dictionary stays
 * readable to anything that scans the file (the verify scripts do).
 */
export async function appendPdf(main: Buffer, extra: Buffer): Promise<Buffer> {
  const out = await PDFDocument.load(main);
  const add = await PDFDocument.load(extra);
  const pages = await out.copyPages(add, add.getPageIndices());
  for (const page of pages) out.addPage(page);
  return Buffer.from(await out.save({ useObjectStreams: false }));
}
