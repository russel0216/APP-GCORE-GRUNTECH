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

/**
 * A table cell: plain text, or a bold title with regular text under it — the
 * way a quotation line prints its product title above its description.
 */
export type PdfCell = string | { title: string; body?: string };

export type PdfSection =
  | { kind: 'fields'; title?: string; columns?: 1 | 2 | 3; fields: PdfField[] }
  | { kind: 'table'; title?: string; head: string[]; rows: PdfCell[][]; widths?: number[]; align?: ('left' | 'right' | 'center')[] }
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

/**
 * Measured off the documents this is patterned on (P00340, REQ-00073), so the
 * output matches the paperwork the business already issues.
 *
 * The margin is the big one: 14pt, about 5mm, against the 42pt this used to
 * leave. On A4 that is 56pt of extra width per page — a whole column on a
 * purchase request — and it is the "maximise the print margin" the layout was
 * asked for. Every consumer printer manages 5mm; below about 12pt some start
 * clipping, which is why this does not go lower.
 */
const MARGIN = 14;
/** Where the footer block starts, measured up from the bottom edge. */
const FOOTER_TOP = 60;
const INK = '#111111';
const MUTED = '#666666';
const RULE = '#cccccc';
/** The slate band behind a table head, white text on it. */
const HEAD_BG = '#70798a';
const HEAD_INK = '#ffffff';

export async function renderDocument(input: PdfDocumentSpec): Promise<Buffer> {
  // Everything that reaches the page goes through pdfSafe first: the module's
  // content AND the company's own details, which an administrator types freely
  // into Settings and which print on every page of every document.
  const spec = safeSpec(input);
  const row = await prisma.company.findUnique({ where: { id: 'company' } });
  const company = row && safeCompany(row);

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
  drawSignoffs(doc, spec.signatories);
  paginate(doc, spec, company);

  doc.end();
  return done;
}

type Company = Awaited<ReturnType<typeof prisma.company.findUnique>>;

/**
 * The characters a standard PDF font can actually draw.
 *
 * PDFKit's built-in Helvetica speaks WinAnsiEncoding: Latin-1, plus the
 * handful of typographic marks WinAnsi parks in 0x80-0x9F (curly quotes,
 * dashes, the bullet, the euro, the ellipsis). Anything else is written out as
 * its UTF-16 code split into two bytes, so the peso sign (U+20B1) lands on the
 * page as a space followed by a plus-or-minus, in front of a price on a
 * customer's quotation. `formatMoney` avoids the peso sign for amounts; this
 * catches it, and its relatives, wherever else they come from: a line
 * description pasted from a spreadsheet, a company address typed on a phone,
 * a SCORO import.
 */
const WINANSI_EXTRA = new Set([
  0x0152, 0x0153, 0x0160, 0x0161, 0x0178, 0x017d, 0x017e, 0x0192, 0x02c6, 0x02dc, 0x2013, 0x2014,
  0x2018, 0x2019, 0x201a, 0x201c, 0x201d, 0x201e, 0x2020, 0x2021, 0x2022, 0x2026, 0x2030, 0x2039,
  0x203a, 0x20ac, 0x2122,
]);

/** Readable stand-ins for the characters people actually type that WinAnsi lacks. */
const STAND_INS: Record<string, string> = {
  '\u00a0': ' ', // no-break space
  '\u2007': ' ', // figure space
  '\u2009': ' ', // thin space
  '\u202f': ' ', // narrow no-break space (Intl puts these in dates and money)
  '\u200b': '', // zero-width space
  '\ufeff': '', // byte-order mark, pasted in from exported CSV
  '\u2010': '-', // hyphen
  '\u2011': '-', // non-breaking hyphen
  '\u2212': '-', // minus sign
  '\u2264': '<=',
  '\u2265': '>=',
  '\u2192': '->',
  '\u2190': '<-',
  '\u2713': 'x',
  '\u2714': 'x',
  '\u2715': 'x',
  '\u2716': 'x',
};

/**
 * Text as a standard PDF font can print it. Every string renderDocument puts
 * on a page passes through here, so a module never has to remember to.
 */
export function pdfSafe(text: string): string {
  if (!text) return text;
  let out = text.replace(/\u20b1\s*/g, 'PHP ');
  // Fast path: most text is plain ASCII and needs nothing more.
  if (!/[^\x00-\x7f]/.test(out)) return out;
  out = out.normalize('NFC');
  let result = '';
  for (const ch of out) {
    const code = ch.codePointAt(0)!;
    if (STAND_INS[ch] !== undefined) result += STAND_INS[ch];
    else if ((code <= 0xff && (code < 0x80 || code > 0x9f)) || WINANSI_EXTRA.has(code)) result += ch;
    else {
      // An accented letter outside Latin-1 keeps its base letter (s-cedilla
      // prints as "s"); anything else becomes "?", which at least reads as
      // "something was here" rather than as a different, wrong character.
      const base = ch.normalize('NFD')[0];
      result += base && base.codePointAt(0)! < 0x80 ? base : '?';
    }
  }
  return result;
}

function safeSection(section: PdfSection): PdfSection {
  const t = (v?: string) => (v === undefined ? v : pdfSafe(v));
  switch (section.kind) {
    case 'spacer':
      return section;
    case 'text':
      return { ...section, title: t(section.title), body: pdfSafe(section.body) };
    case 'fields':
      return {
        ...section,
        title: t(section.title),
        fields: section.fields.map((f) => ({ label: pdfSafe(f.label), value: pdfSafe(f.value ?? '') })),
      };
    case 'table':
      return {
        ...section,
        title: t(section.title),
        head: section.head.map(pdfSafe),
        rows: section.rows.map((r) =>
          r.map((c) =>
            typeof c === 'object' && c !== null
              ? { title: pdfSafe(c.title ?? ''), ...(c.body !== undefined ? { body: pdfSafe(c.body) } : {}) }
              : pdfSafe(c ?? ''),
          ),
        ),
      };
  }
}

function safeSpec(spec: PdfDocumentSpec): PdfDocumentSpec {
  const t = (v?: string) => (v === undefined ? v : pdfSafe(v));
  return {
    ...spec,
    title: pdfSafe(spec.title),
    documentNumber: t(spec.documentNumber),
    revision: t(spec.revision),
    reference: t(spec.reference),
    footerNote: t(spec.footerNote),
    sections: spec.sections.map(safeSection),
    signatories: spec.signatories?.map((p) => ({
      ...p,
      role: pdfSafe(p.role),
      name: t(p.name),
      position: t(p.position),
    })),
  };
}

function safeCompany<C extends NonNullable<Company>>(c: C): C {
  const out = { ...c };
  for (const key of Object.keys(out) as (keyof C)[]) {
    const v = out[key];
    if (typeof v === 'string' && key !== 'logoPath') out[key] = pdfSafe(v) as C[keyof C];
  }
  return out;
}

/** "http://www.gruntechnology.com/" -> "WWW.GRUNTECHNOLOGY.COM", as the footer prints it. */
function websiteForPrint(website?: string | null): string {
  if (!website) return '';
  return website
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toUpperCase();
}

/**
 * The strapline along the foot of every page, e.g.
 * "INDUSTRIAL UTILITY SOLUTIONS  WWW.GRUNTECHNOLOGY.COM" (carried over from
 * SCORO's quote layout). The website is added unless the tagline already
 * carries it, so an administrator can type either form into Settings.
 */
export function footerTagline(
  company: { documentTagline?: string | null; website?: string | null } | null,
): string {
  const tagline = company?.documentTagline?.trim() ?? '';
  if (!tagline) return '';
  const site = websiteForPrint(company?.website);
  if (!site || tagline.toUpperCase().includes(site)) return tagline;
  return `${tagline}  ${site}`;
}

/**
 * The document identifies itself top-left; the logo sits top-right.
 *
 * The company's name and address are NOT up here — they are in the footer,
 * which is where the documents this is patterned on put them. It is the right
 * way round: the first thing a reader needs is which document this is, and the
 * letterhead is what you check afterwards.
 */
function drawHeader(doc: PDFKit.PDFDocument, spec: PdfDocumentSpec, company: Company) {
  const right = doc.page.width - MARGIN;
  const top = MARGIN + 6;

  if (company?.logoPath && fs.existsSync(company.logoPath)) {
    try {
      doc.image(company.logoPath, right - 150, top - 6, { fit: [150, 56], align: 'right' });
    } catch {
      /* a broken logo must never stop a document printing */
    }
  }

  // "Purchase Request No. GT-PR-2026-0042" — one line, the way it is spoken.
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(13);
  doc.text(
    spec.documentNumber ? `${spec.title} No. ${spec.documentNumber}` : spec.title,
    MARGIN,
    top,
    { width: right - MARGIN - 170 },
  );

  doc.font('Helvetica').fontSize(10).fillColor(INK);
  doc.text(formatDate(spec.date ?? new Date()), MARGIN, doc.y + 3, { width: 300 });

  // Bold label, regular value, on one line each — as on the reference.
  const meta: [string, string][] = [];
  if (spec.revision) meta.push(['Revision:', spec.revision]);
  if (spec.reference) meta.push(['Reference:', spec.reference]);
  for (const [label, value] of meta) {
    const y = doc.y + 3;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK);
    // Wraps inside the space left of the logo, and the next line starts below
    // however many lines it took — a long reference used to overprint what
    // followed it.
    doc.text(label, MARGIN, y, { width: right - MARGIN - 170, continued: true });
    doc.font('Helvetica').text(` ${value}`);
    doc.y = Math.max(doc.y, y + 13);
  }

  // Clear of the logo whatever the header ran to.
  doc.y = Math.max(doc.y, top + 58) + 12;
}

function sectionTitle(doc: PDFKit.PDFDocument, title?: string) {
  if (!title) return;
  ensureSpace(doc, 40);
  // Explicit gaps rather than moveDown fractions: moveDown scales with whatever
  // font happens to be current, which left headings sitting ~3pt above their
  // own content — cramped on the page, and close enough to merge with it when
  // the PDF is parsed by anything that groups text into lines.
  doc.y += 10;
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(title.toUpperCase(), MARGIN, doc.y);
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
        doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED);
        doc.text(field.label.toUpperCase(), x, rowTop, { width: colWidth - 10 });
        doc.font('Helvetica-Bold').fontSize(10).fillColor(INK);
        doc.text(field.value || '—', x, doc.y + 1, { width: colWidth - 10 });
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
        if (doc.y + height > doc.page.height - FOOTER_TOP - 24) {
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
  ensureSpace(doc, 44);
  const top = doc.y;
  // 24pt and white on slate, as measured off the reference documents. A taller
  // band reads as a header rather than as a slightly shaded first row.
  const height = 24;
  doc.rect(MARGIN, top, widths.reduce((a, b) => a + b, 0), height).fill(HEAD_BG);
  doc.fillColor(HEAD_INK).font('Helvetica-Bold').fontSize(8.5);
  let x = MARGIN;
  head.forEach((cell, i) => {
    doc.text(cell.toUpperCase(), x + 8, top + 8, { width: widths[i] - 16, align: align[i] });
    x += widths[i];
  });
  doc.y = top + height;
}

function cellHeight(doc: PDFKit.PDFDocument, cell: PdfCell, width: number): number {
  if (typeof cell === 'object' && cell !== null) {
    doc.font('Helvetica-Bold').fontSize(9);
    const title = doc.heightOfString(cell.title || ' ', { width });
    doc.font('Helvetica').fontSize(9);
    return title + (cell.body ? 2 + doc.heightOfString(cell.body, { width }) : 0);
  }
  doc.font('Helvetica').fontSize(9);
  return doc.heightOfString(cell ?? '', { width });
}

function rowHeight(doc: PDFKit.PDFDocument, row: PdfCell[], widths: number[]): number {
  let tallest = 0;
  row.forEach((cell, i) => {
    tallest = Math.max(tallest, cellHeight(doc, cell, widths[i] - 16));
  });
  return tallest + 14;
}

function drawTableRow(
  doc: PDFKit.PDFDocument,
  row: PdfCell[],
  widths: number[],
  align: ('left' | 'right' | 'center')[],
  height: number,
) {
  const top = doc.y;
  doc.font('Helvetica').fontSize(9).fillColor(INK);
  let x = MARGIN;
  row.forEach((cell, i) => {
    const opts = { width: widths[i] - 16, align: align[i] };
    if (typeof cell === 'object' && cell !== null) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(cell.title, x + 8, top + 7, opts);
      if (cell.body) doc.font('Helvetica').fontSize(9).text(cell.body, x + 8, doc.y + 2, opts);
      doc.font('Helvetica').fontSize(9);
    } else {
      doc.text(cell ?? '', x + 8, top + 7, opts);
    }
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

/**
 * Who did what, and when — one line each, no signature rules.
 *
 *   REQUESTED BY :  Erwin Dela Pena, 18 Sep 2026, 3:40 PM
 *   APPROVED BY :   Grace Villanueva, Pending
 *
 * Patterned on the documents the business already issues. Ruled boxes to sign
 * in are for paper that gets signed by hand; these are approved in the system
 * and the record of that is the name and the timestamp, so a rule underneath
 * would be inviting a second, weaker signature over the top of a real one.
 *
 * An unapproved slot says "Pending" rather than sitting blank, because a blank
 * is indistinguishable from a step nobody bothered to fill in.
 */
function drawSignoffs(doc: PDFKit.PDFDocument, signatories?: Signatory[]) {
  const people = signatories ?? [];
  if (!people.length) return;

  const lineHeight = 15;
  const blockHeight = people.length * lineHeight + 6;
  ensureSpace(doc, blockHeight + 10);
  // Sits directly above the footer, wherever the content ended.
  doc.y = Math.max(doc.y + 20, doc.page.height - FOOTER_TOP - 10 - blockHeight);

  // The labels are set on one shared column so the names line up under each
  // other, however long "REQUESTED BY" is against "NOTED BY".
  doc.font('Helvetica-Bold').fontSize(9);
  const labelWidth = Math.max(...people.map((p) => doc.widthOfString(`${p.role.toUpperCase()} :`))) + 10;

  for (const person of people) {
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK);
    doc.text(`${person.role.toUpperCase()} :`, MARGIN, y, { lineBreak: false });

    const x = MARGIN + labelWidth;
    if (person.name) {
      doc.font('Helvetica').fontSize(9).fillColor(INK);
      const name = person.position ? `${person.name} (${person.position}),` : `${person.name},`;
      doc.text(name, x, y, { lineBreak: false, continued: true });
      doc.font('Helvetica-Oblique').fillColor(MUTED);
      doc.text(person.at ? ` ${formatDateTime(person.at)}` : ' Pending', { lineBreak: false });
    } else {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED);
      doc.text('Pending', x, y, { lineBreak: false });
    }
    doc.y = y + lineHeight;
  }
}

/**
 * Footer and "Page n of m" on every page. Done at the end because the total
 * page count is only known once the content is laid out.
 *
 * This is the company block for EVERY document (rule 6): no module prints its
 * own letterhead, so Tel, Fax, TIN, REG. NO. and the strapline appear on a
 * purchase order exactly as they do on a quotation.
 */
function paginate(doc: PDFKit.PDFDocument, spec: PdfDocumentSpec, company: Company) {
  const range = doc.bufferedPageRange();

  // Three columns, as on the reference: who we are, how to reach us, and the
  // registration numbers (the TIN is the one a Philippine counterparty
  // actually looks for, the SEC number the one a tender asks for). A line
  // whose value is not set is dropped, never printed as a bare label.
  // The strapline row carries the tagline with the website on it, or the
  // website alone when no tagline is set; printing it twice in a strip this
  // small is clutter.
  const strapline = footerTagline(company) || websiteForPrint(company?.website);
  const who = [
    company?.name ?? '',
    company?.address ?? '',
    [company?.city, company?.country].filter(Boolean).join(', '),
  ].filter((t) => t.trim());
  const reach = [
    company?.phone ? `Tel: ${company.phone}` : '',
    company?.fax ? `Fax: ${company.fax}` : '',
    company?.email ?? '',
  ].filter((t) => t.trim());
  const ids: [string, string][] = [];
  if (company?.tin) ids.push(['TIN:', company.tin]);
  if (company?.regNo) ids.push(['REG. NO.:', company.regNo]);

  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);

    // The footer deliberately sits BELOW the bottom margin. PDFKit treats any
    // text past that margin as overflow and helpfully starts a new page, which
    // would then need its own footer, and so on. Dropping the margin for the
    // duration of the write is the documented way to stop that; without it a
    // two-page document silently becomes six.
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    const right = doc.page.width - MARGIN;
    const top = doc.page.height - FOOTER_TOP + 8;

    doc.moveTo(MARGIN, top - 8).lineTo(right, top - 8).strokeColor(RULE).lineWidth(0.7).stroke();

    const colTwo = MARGIN + 226;
    const colThree = MARGIN + 390;
    // Three rows of 7.5pt on 9.5pt leading, then the strapline row. The
    // strapline's baseline sits about 16pt off the paper's edge: clear of the
    // 14pt margin, and of the ~12pt below which consumer printers clip.
    const line = 9.5;
    const baseRow = top + line * 3 + 1.5;
    // PDFKit wraps at `width` even with lineBreak off, so every line is given
    // a width it fits, and a long one is cut with an ellipsis rather than
    // spilling onto the row below.
    const oneLine = (width: number) => ({ width, height: line, ellipsis: true, lineGap: 0 });

    who.forEach((text, n) => {
      doc.font(n === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5).fillColor(n === 0 ? INK : MUTED);
      doc.text(text, MARGIN, top + n * line, oneLine(colTwo - MARGIN - 8));
    });

    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
    reach.forEach((text, n) => {
      doc.text(text, colTwo, top + n * line, oneLine(colThree - colTwo - 8));
    });

    ids.forEach(([label, value], n) => {
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(INK);
      doc.text(label, colThree, top + n * line, { lineBreak: false, continued: true });
      doc.font('Helvetica').fillColor(MUTED).text(` ${value}`, { lineBreak: false });
    });

    // Only when there is more than one page: "Page 1 of 1" is noise. Top
    // right of the block, on the TIN's row, so the rows below stay free for a
    // module's note to wrap into.
    if (range.count > 1) {
      doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
      doc.text(`Page ${i + 1} of ${range.count}`, right - 60, top, {
        width: 60,
        align: 'right',
        lineBreak: false,
      });
    }

    if (spec.footerNote) {
      // Wraps down the third column as far as the strapline row, then stops.
      const noteTop = top + ids.length * line;
      doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
      doc.text(spec.footerNote, colThree, noteTop, {
        width: right - colThree,
        // A point of slack, or float rounding cuts the last line it has room for.
        height: baseRow + line - noteTop + 1,
        ellipsis: true,
        lineGap: line - doc.currentLineHeight(),
      });
    }

    if (strapline) {
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(HEAD_BG);
      doc.text(strapline, MARGIN, baseRow, {
        ...oneLine(colThree - MARGIN - 8),
        characterSpacing: 0.8,
      });
    }

    doc.page.margins.bottom = bottomMargin;
  }
  // Leave the cursor on the last page so nothing is appended to page 1.
  doc.switchToPage(range.start + range.count - 1);
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number) {
  if (doc.y + needed > doc.page.height - FOOTER_TOP - 24) doc.addPage();
}

export function formatDate(d: Date): string {
  return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * A timestamp beside a name, in the form the reference documents use:
 * "Sep 17, 2026, 9:13 AM". Manila, because a timestamp on an approval is
 * evidence and it belongs in the timezone the business works in rather than
 * whatever the server happens to be set to.
 *
 * Assembled from parts rather than left to toLocaleString, which inserts "at"
 * before the time in some ICU versions and would quietly change the wording of
 * every document when Node is upgraded.
 */
export function formatDateTime(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(d);
  const get = (type: string) => parts.find((x) => x.type === type)?.value ?? '';
  return `${get('month')} ${get('day')}, ${get('year')}, ${get('hour')}:${get('minute')} ${get('dayPeriod').toUpperCase()}`;
}


/**
 * Money, as the reference documents print it: "PHP 1,562.20".
 *
 * The currency CODE, not the peso sign — and not only because that is the
 * house style. U+20B1 is outside WinAnsiEncoding, which is all a standard PDF
 * font can draw, so every amount on every document this engine has produced
 * came out as "±1,562.20". A plus-or-minus sign in front of a price on a
 * customer's quotation. Embedding a Unicode font would fix the glyph; using
 * the code fixes it and matches the paperwork at the same time.
 */
export function formatMoney(value: number | string, currency = 'PHP'): string {
  const n = typeof value === 'string' ? Number(value) : value;
  return new Intl.NumberFormat('en-PH', {
    style: 'currency',
    currency,
    currencyDisplay: 'code',
    minimumFractionDigits: 2,
  })
    .format(Number.isFinite(n) ? n : 0)
    // Intl separates the code with a non-breaking space; a plain one sits
    // better in a right-aligned column.
    .replace(/ /g, ' ')
    .trim();
}
