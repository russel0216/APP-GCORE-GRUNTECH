import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import { prisma } from '../prisma';

/**
 * The document engine (model §7).
 *
 * "All PDF Format have uniformity across all Menus." Every printable document
 * in G-Core renders through this one function, so branding, the signature
 * block and page numbering are identical everywhere by construction. A module
 * supplies content; it never draws a header.
 */

export interface PdfField {
  label: string;
  value: string;
}

export type PdfSection =
  | { kind: 'fields'; title?: string; columns?: 1 | 2 | 3; fields: PdfField[] }
  | { kind: 'table'; title?: string; head: string[]; rows: string[][]; widths?: number[]; align?: ('left' | 'right' | 'center')[] }
  | { kind: 'text'; title?: string; body: string }
  | { kind: 'spacer'; height?: number };

export interface Signatory {
  role: string;
  name?: string;
  position?: string;
  /**
   * When this person did their part — raised it, checked it, approved it.
   *
   * Printed under the name, the way a date goes beside a signature on paper.
   * That is what makes a stack of documents readable as a timeline: the gap
   * between "prepared" and "approved" is where the operation is waiting.
   *
   * Left off where nothing has happened yet, so an unsigned slot stays an
   * honest blank rather than borrowing the date of the document.
   */
  at?: Date | null;
}

export interface PdfDocumentSpec {
  title: string;
  documentNumber?: string;
  revision?: string;
  date?: Date;
  /** Customer / project reference line under the title. */
  reference?: string;
  sections: PdfSection[];
  /** Defaults to Prepared / Checked / Approved. */
  signatories?: Signatory[];
  /** Small print above the page number. */
  footerNote?: string;
}

const MARGIN = 42;
const INK = '#111111';
const MUTED = '#666666';
const RULE = '#cccccc';
const HEAD_BG = '#f0f0f0';

export async function renderDocument(spec: PdfDocumentSpec): Promise<Buffer> {
  const company = await prisma.company.findUnique({ where: { id: 'company' } });

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN, bottom: 64, left: MARGIN, right: MARGIN },
    bufferPages: true,
    info: {
      Title: spec.documentNumber ? `${spec.documentNumber} — ${spec.title}` : spec.title,
      Author: company?.name ?? 'G-CORE',
    },
  });

  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });

  drawHeader(doc, spec, company);
  for (const section of spec.sections) drawSection(doc, section);
  drawSignatures(doc, spec.signatories);
  paginate(doc, spec, company);

  doc.end();
  return done;
}

type Company = Awaited<ReturnType<typeof prisma.company.findUnique>>;

function drawHeader(doc: PDFKit.PDFDocument, spec: PdfDocumentSpec, company: Company) {
  const right = doc.page.width - MARGIN;
  let textLeft = MARGIN;

  if (company?.logoPath && fs.existsSync(company.logoPath)) {
    try {
      doc.image(company.logoPath, MARGIN, MARGIN - 4, { fit: [54, 54] });
      textLeft = MARGIN + 66;
    } catch {
      /* a broken logo must never stop a document printing */
    }
  }

  doc.fillColor(INK).font('Helvetica-Bold').fontSize(13);
  doc.text(company?.name ?? 'Company name not set', textLeft, MARGIN, { width: 300 });

  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
  const lines = [
    company?.address,
    [company?.city, company?.country].filter(Boolean).join(', '),
    company?.tin ? `TIN: ${company.tin}` : null,
    [company?.phone, company?.email].filter(Boolean).join('  ·  '),
  ].filter((l): l is string => Boolean(l && l.trim()));
  for (const line of lines) doc.text(line, textLeft, doc.y, { width: 300 });

  // Document identity block, right-aligned against the company block.
  const idTop = MARGIN;
  doc.font('Helvetica-Bold').fontSize(14).fillColor(INK);
  doc.text(spec.title.toUpperCase(), right - 230, idTop, { width: 230, align: 'right' });

  doc.font('Helvetica').fontSize(8).fillColor(MUTED);
  const meta: string[] = [];
  if (spec.documentNumber) meta.push(`No. ${spec.documentNumber}`);
  if (spec.revision) meta.push(`Rev. ${spec.revision}`);
  meta.push(formatDate(spec.date ?? new Date()));
  doc.text(meta.join('   ·   '), right - 230, doc.y + 1, { width: 230, align: 'right' });

  const ruleY = Math.max(doc.y, idTop + 46) + 8;
  doc.moveTo(MARGIN, ruleY).lineTo(right, ruleY).strokeColor(RULE).lineWidth(1).stroke();
  doc.y = ruleY + 10;

  if (spec.reference) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK);
    doc.text(spec.reference, MARGIN, doc.y, { width: right - MARGIN * 2 });
    doc.y += 4;
  }
}

function sectionTitle(doc: PDFKit.PDFDocument, title?: string) {
  if (!title) return;
  ensureSpace(doc, 40);
  // Explicit gaps rather than moveDown fractions: moveDown scales with whatever
  // font happens to be current, which left headings sitting ~3pt above their
  // own content — cramped on the page, and close enough to merge with it when
  // the PDF is parsed by anything that groups text into lines.
  doc.y += 10;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(title.toUpperCase(), MARGIN, doc.y);
  doc.y += 7;
}

function drawSection(doc: PDFKit.PDFDocument, section: PdfSection) {
  switch (section.kind) {
    case 'spacer':
      doc.y += section.height ?? 12;
      return;

    case 'text':
      sectionTitle(doc, section.title);
      ensureSpace(doc, 40);
      doc.font('Helvetica').fontSize(9).fillColor(INK);
      doc.text(section.body, MARGIN, doc.y, {
        width: doc.page.width - MARGIN * 2,
        align: 'justify',
      });
      doc.moveDown(0.5);
      return;

    case 'fields': {
      sectionTitle(doc, section.title);
      const cols = section.columns ?? 2;
      const usable = doc.page.width - MARGIN * 2;
      const colWidth = usable / cols;
      let col = 0;
      let rowTop = doc.y;
      let rowHeight = 0;

      for (const field of section.fields) {
        if (col === 0) {
          ensureSpace(doc, 30);
          rowTop = doc.y;
          rowHeight = 0;
        }
        const x = MARGIN + col * colWidth;
        doc.font('Helvetica').fontSize(7).fillColor(MUTED);
        doc.text(field.label.toUpperCase(), x, rowTop, { width: colWidth - 10 });
        doc.font('Helvetica-Bold').fontSize(9).fillColor(INK);
        doc.text(field.value || '—', x, doc.y, { width: colWidth - 10 });
        rowHeight = Math.max(rowHeight, doc.y - rowTop);
        col = (col + 1) % cols;
        if (col === 0) doc.y = rowTop + rowHeight + 6;
        else doc.y = rowTop;
      }
      if (col !== 0) doc.y = rowTop + rowHeight + 6;
      return;
    }

    case 'table': {
      sectionTitle(doc, section.title);
      const usable = doc.page.width - MARGIN * 2;
      const widths =
        section.widths && section.widths.length === section.head.length
          ? normalise(section.widths, usable)
          : section.head.map(() => usable / section.head.length);
      const align = section.align ?? section.head.map(() => 'left' as const);

      drawTableHead(doc, section.head, widths, align);
      for (const row of section.rows) {
        const height = rowHeight(doc, row, widths);
        if (doc.y + height > doc.page.height - 84) {
          doc.addPage();
          drawTableHead(doc, section.head, widths, align);
        }
        drawTableRow(doc, row, widths, align, height);
      }
      doc.moveDown(0.5);
      return;
    }
  }
}

function normalise(widths: number[], usable: number): number[] {
  const total = widths.reduce((a, b) => a + b, 0);
  return widths.map((w) => (w / total) * usable);
}

function drawTableHead(
  doc: PDFKit.PDFDocument,
  head: string[],
  widths: number[],
  align: ('left' | 'right' | 'center')[],
) {
  ensureSpace(doc, 40);
  const top = doc.y;
  const height = 16;
  doc.rect(MARGIN, top, widths.reduce((a, b) => a + b, 0), height).fill(HEAD_BG);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(7.5);
  let x = MARGIN;
  head.forEach((cell, i) => {
    doc.text(cell.toUpperCase(), x + 4, top + 5, { width: widths[i] - 8, align: align[i] });
    x += widths[i];
  });
  doc.y = top + height;
}

function rowHeight(doc: PDFKit.PDFDocument, row: string[], widths: number[]): number {
  doc.font('Helvetica').fontSize(8.5);
  let tallest = 0;
  row.forEach((cell, i) => {
    tallest = Math.max(tallest, doc.heightOfString(cell ?? '', { width: widths[i] - 8 }));
  });
  return tallest + 8;
}

function drawTableRow(
  doc: PDFKit.PDFDocument,
  row: string[],
  widths: number[],
  align: ('left' | 'right' | 'center')[],
  height: number,
) {
  const top = doc.y;
  doc.font('Helvetica').fontSize(8.5).fillColor(INK);
  let x = MARGIN;
  row.forEach((cell, i) => {
    doc.text(cell ?? '', x + 4, top + 4, { width: widths[i] - 8, align: align[i] });
    x += widths[i];
  });
  const bottom = top + height;
  doc
    .moveTo(MARGIN, bottom)
    .lineTo(MARGIN + widths.reduce((a, b) => a + b, 0), bottom)
    .strokeColor(RULE)
    .lineWidth(0.5)
    .stroke();
  doc.y = bottom;
}

function drawSignatures(doc: PDFKit.PDFDocument, signatories?: Signatory[]) {
  const people = signatories ?? [
    { role: 'Prepared by' },
    { role: 'Checked by' },
    { role: 'Approved by' },
  ];
  if (!people.length) return;

  // 66 before the date line was added under each name.
  const blockHeight = 76;
  ensureSpace(doc, blockHeight + 10);
  doc.y = Math.max(doc.y + 18, doc.page.height - 84 - blockHeight);

  const usable = doc.page.width - MARGIN * 2;
  const colWidth = usable / people.length;
  const top = doc.y;

  people.forEach((person, i) => {
    const x = MARGIN + i * colWidth;
    doc.font('Helvetica').fontSize(7).fillColor(MUTED);
    doc.text(person.role.toUpperCase(), x, top, { width: colWidth - 12 });

    const lineY = top + 34;
    doc
      .moveTo(x, lineY)
      .lineTo(x + colWidth - 18, lineY)
      .strokeColor(RULE)
      .lineWidth(0.8)
      .stroke();

    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK);
    doc.text(person.name ?? ' ', x, lineY + 4, { width: colWidth - 12 });
    if (person.position) {
      doc.font('Helvetica').fontSize(7).fillColor(MUTED);
      doc.text(person.position, x, doc.y, { width: colWidth - 12 });
    }
    if (person.at) {
      doc.font('Helvetica').fontSize(7).fillColor(MUTED);
      doc.text(formatDateTime(person.at), x, doc.y, { width: colWidth - 12 });
    }
  });
}

/**
 * Footer and "Page n of m" on every page. Done at the end because the total
 * page count is only known once the content is laid out.
 */
function paginate(doc: PDFKit.PDFDocument, spec: PdfDocumentSpec, company: Company) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);

    // The footer deliberately sits BELOW the bottom margin. PDFKit treats any
    // text past that margin as overflow and helpfully starts a new page — which
    // would then need its own footer, and so on. Dropping the margin for the
    // duration of the write is the documented way to stop that; without it a
    // two-page document silently becomes six.
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    const y = doc.page.height - 46;
    doc
      .moveTo(MARGIN, y - 8)
      .lineTo(doc.page.width - MARGIN, y - 8)
      .strokeColor(RULE)
      .lineWidth(0.5)
      .stroke();

    doc.font('Helvetica').fontSize(7).fillColor(MUTED);
    const left = spec.footerNote ?? company?.name ?? '';
    doc.text(left, MARGIN, y, { width: 320, lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, doc.page.width - MARGIN - 160, y, {
      width: 160,
      align: 'right',
      lineBreak: false,
    });
    if (spec.documentNumber) {
      doc.text(spec.documentNumber, MARGIN, y + 9, { width: 320, lineBreak: false });
    }

    doc.page.margins.bottom = bottomMargin;
  }
  // Leave the cursor on the last page so nothing is appended to page 1.
  doc.switchToPage(range.start + range.count - 1);
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number) {
  if (doc.y + needed > doc.page.height - 84) doc.addPage();
}

export function formatDate(d: Date): string {
  return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * Date and time to the minute, in Manila. A timestamp under a signature is
 * evidence, so it is printed in the timezone the business works in rather than
 * whatever the server happens to be set to.
 *
 * Built from parts rather than left to toLocaleString, which renders this as
 * "Sep 19, 2026, 15:40" — two commas doing different jobs, on a line that is
 * read at a glance.
 */
export function formatDateTime(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')} ${get('month')} ${get('year')}, ${get('hour')}:${get('minute')}`;
}


export function formatMoney(value: number | string, currency = 'PHP'): string {
  const n = typeof value === 'string' ? Number(value) : value;
  return new Intl.NumberFormat('en-PH', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0);
}
