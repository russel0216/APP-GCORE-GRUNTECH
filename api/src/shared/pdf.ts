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
 *
 * Two styles, one engine. `house` is the internal paperwork (P00340,
 * REQ-00073): the document names itself top-left and the company block sits in
 * the footer. `letter` is what goes to a customer, patterned on the quote SCORO
 * printed for years: logo and company block across the top, the date and the
 * number on one line under them, the brand band along the foot of every page,
 * and a running header on every page after the first. Either way the engine
 * draws the header, the footer, the sign-offs and the page numbers; a module
 * supplies sections and picks the style.
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

/**
 * A table row: its cells, or a heading that runs the full width of the table.
 * SCORO's quote prints a line's product name that way, above the row that
 * carries its description and figures. `shade` tints the heading, for a group
 * that has to read apart from the product names under it.
 */
export type PdfRow = PdfCell[] | { heading: string; shade?: boolean };

/**
 * One line of a `lines` section. `label` prints in bold in front of the text,
 * as in "Delivery: 4 to 6 weeks". A line with neither is a blank line.
 */
export interface PdfLine {
  text: string;
  label?: string;
  bold?: boolean;
  italic?: boolean;
  /** Two points under the body size, for small print. */
  small?: boolean;
}

/**
 * One side of a `parties` section: the name in large bold, the lines under it,
 * and a labelled line ("Payment Terms : 30 days") that sits level with the
 * other side's.
 */
export interface PdfParty {
  name: string;
  lines?: string[];
  label?: string;
  value?: string;
}

export interface PdfTotal {
  label: string;
  value: string;
  bold?: boolean;
}

export type PdfSection =
  | { kind: 'fields'; title?: string; columns?: 1 | 2 | 3; fields: PdfField[] }
  | { kind: 'table'; title?: string; head: string[]; rows: PdfRow[]; widths?: number[]; align?: ('left' | 'right' | 'center')[] }
  | { kind: 'text'; title?: string; body: string }
  | { kind: 'lines'; lines: PdfLine[] }
  | { kind: 'parties'; left: PdfParty; right?: PdfParty }
  | { kind: 'totals'; rows: PdfTotal[] }
  | { kind: 'spacer'; height?: number };

export type PdfStyle = 'house' | 'letter';

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
  /**
   * Customer / project reference. Under the title in the house style; in the
   * letter style it leads the running header on every page after the first.
   */
  reference?: string;
  /** `house` (the default) or `letter` — see the top of this file. */
  style?: PdfStyle;
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
/** The letter's brand colours, off SCORO's quote: the purple band, the green on it, the green number. */
const BAND_BG = '#cb00ff';
const BAND_INK = '#00ff5f';
const NUMBER_INK = '#44aa00';
/** A shaded heading row, so a group reads apart from the product names under it. */
const SHADE = '#e9ebef';

/** What differs between the two styles, so the drawing code is written once. */
interface Layout {
  style: PdfStyle;
  left: number;
  right: number;
  /** Where the footer starts, measured up from the bottom edge; content stops 24pt above it. */
  footerTop: number;
  /** Body text size. */
  size: number;
  /** Table cells: padding to the side, above the text, and what a row adds to its tallest cell. */
  padX: number;
  padTop: number;
  padRow: number;
}

const HOUSE: Layout = { style: 'house', left: MARGIN, right: MARGIN, footerTop: FOOTER_TOP, size: 9, padX: 8, padTop: 7, padRow: 14 };

/**
 * Measured off SCORO's quote: content from 43.5pt in to 30pt short of the
 * right edge, 10pt text, a tight 18pt table head, the band 30pt off the
 * bottom. The 40pt footer leaves the sign-offs and the page number clear of
 * the band.
 */
const LETTER: Layout = { style: 'letter', left: 43.5, right: 30, footerTop: 40, size: 10, padX: 3, padTop: 3.5, padRow: 8 };

const layouts = new WeakMap<PDFKit.PDFDocument, Layout>();
const lay = (doc: PDFKit.PDFDocument): Layout => layouts.get(doc) ?? HOUSE;
const usableWidth = (doc: PDFKit.PDFDocument) => doc.page.width - lay(doc).left - lay(doc).right;
const contentBottom = (doc: PDFKit.PDFDocument) => doc.page.height - lay(doc).footerTop - 24;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const isHeading = (row: PdfRow): row is { heading: string; shade?: boolean } => !Array.isArray(row);

export async function renderDocument(input: PdfDocumentSpec): Promise<Buffer> {
  // Everything that reaches the page goes through pdfSafe first: the module's
  // content AND the company's own details, which an administrator types freely
  // into Settings and which print on every page of every document.
  const spec = safeSpec(input);
  const row = await prisma.company.findUnique({ where: { id: 'company' } });
  const company = row && safeCompany(row);
  const layout = spec.style === 'letter' ? LETTER : HOUSE;

  const doc = new PDFDocument({
    size: 'A4',
    // A letter's later pages open under the running header, so their top
    // margin is where the content picks up again.
    margins:
      layout.style === 'letter'
        ? { top: 50, bottom: 64, left: layout.left, right: layout.right }
        : { top: MARGIN, bottom: 64, left: MARGIN, right: MARGIN },
    bufferPages: true,
    info: {
      Title: spec.documentNumber ? `${spec.documentNumber} — ${spec.title}` : spec.title,
      Author: company?.name ?? 'G-CORE',
    },
  });
  layouts.set(doc, layout);

  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });

  if (layout.style === 'letter') drawLetterhead(doc, spec, company);
  else drawHeader(doc, spec, company);
  for (const section of spec.sections) drawSection(doc, section);
  drawSignoffs(doc, spec.signatories);
  if (layout.style === 'letter') paginateLetter(doc, spec, company);
  else paginate(doc, spec, company);

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
  '\u03bc': '\u00b5', // Greek mu as the micro sign, which Latin-1 has: "0.1 \u00b5m" (SCORO's line texts carry it)
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
  const party = (p: PdfParty): PdfParty => ({
    ...p,
    name: pdfSafe(p.name ?? ''),
    lines: p.lines?.map((line) => pdfSafe(line ?? '')),
    label: t(p.label),
    value: t(p.value),
  });
  switch (section.kind) {
    case 'spacer':
      return section;
    case 'text':
      return { ...section, title: t(section.title), body: pdfSafe(section.body) };
    case 'lines':
      return { ...section, lines: section.lines.map((l) => ({ ...l, text: pdfSafe(l.text ?? ''), label: t(l.label) })) };
    case 'parties':
      return { ...section, left: party(section.left), right: section.right && party(section.right) };
    case 'totals':
      return { ...section, rows: section.rows.map((r) => ({ ...r, label: pdfSafe(r.label), value: pdfSafe(r.value) })) };
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
          isHeading(r)
            ? { ...r, heading: pdfSafe(r.heading ?? '') }
            : r.map((c) =>
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
 * `gap` is what separates the two; the letter's band spaces them wide.
 */
export function footerTagline(
  company: { documentTagline?: string | null; website?: string | null } | null,
  gap = '  ',
): string {
  const tagline = company?.documentTagline?.trim() ?? '';
  if (!tagline) return '';
  const site = websiteForPrint(company?.website);
  if (!site || tagline.toUpperCase().includes(site)) return tagline;
  return `${tagline}${gap}${site}`;
}

/** The number as the letter prints it: a revision after the first carries " R1", " R2"… */
function numberForPrint(spec: PdfDocumentSpec): string {
  if (!spec.documentNumber) return '';
  const rev = spec.revision && spec.revision !== '0' ? ` R${spec.revision}` : '';
  return `${spec.documentNumber}${rev}`;
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

/**
 * The letter's first page, as SCORO's quote set it: the logo top-left, the
 * company block top-right (name, address, Tel/Fax, email, website, TIN,
 * REG. NO.), then "Date: 08/17/2026" on the left and the document's number,
 * in the brand green, on the right.
 */
function drawLetterhead(doc: PDFKit.PDFDocument, spec: PdfDocumentSpec, company: Company) {
  const L = lay(doc);
  const right = doc.page.width - L.right;
  const top = 23;
  let bottom = top;

  if (company?.logoPath && fs.existsSync(company.logoPath)) {
    try {
      doc.image(company.logoPath, 54, top, { fit: [88, 75] });
      bottom = top + 75;
    } catch {
      /* a broken logo must never stop a document printing */
    }
  }

  const x = 336;
  const width = right - x;
  let y = top;
  const name = (company?.legalName || company?.name || '').toUpperCase();
  if (name) {
    doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text(name, x, y, { width });
    y = doc.y + 6;
  }
  const reach = [company?.phone ? `Tel No.: ${company.phone}` : '', company?.fax ? `Fax No.: ${company.fax}` : '']
    .filter(Boolean)
    .join(' ');
  const lines = [
    [company?.address, company?.city].filter(Boolean).join(', '),
    reach,
    company?.email ? `Email: ${company.email}` : '',
    company?.website ?? '',
  ].filter((t) => t.trim());
  doc.font('Helvetica').fontSize(8).fillColor(INK);
  for (const line of lines) {
    doc.text(line, x, y, { width });
    y = doc.y + 7.3;
  }
  const ids: [string, string][] = [];
  if (company?.tin) ids.push(['TIN :', ` ${company.tin}`]);
  if (company?.regNo) ids.push(['REG. NO.:', company.regNo]);
  for (const [label, value] of ids) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(label, x, y, { width, continued: true });
    doc.font('Helvetica').text(value);
    y = doc.y + 7.3;
  }
  bottom = Math.max(bottom, y - 7.3);

  const line = bottom + 18;
  doc.font('Helvetica').fontSize(10).fillColor(INK);
  doc.text(`Date:  ${formatShortDate(spec.date ?? new Date())}`, L.left, line + 1.5, { lineBreak: false });
  const number = numberForPrint(spec);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(NUMBER_INK);
  doc.text(number ? `${spec.title} No. ${number}` : spec.title, L.left, line, {
    width: right - L.left,
    align: 'right',
    lineBreak: false,
  });

  doc.fillColor(INK);
  doc.x = L.left;
  doc.y = line + 30;
}

function sectionTitle(doc: PDFKit.PDFDocument, title?: string) {
  if (!title) return;
  ensureSpace(doc, 40);
  // Explicit gaps rather than moveDown fractions: moveDown scales with whatever
  // font happens to be current, which left headings sitting ~3pt above their
  // own content — cramped on the page, and close enough to merge with it when
  // the PDF is parsed by anything that groups text into lines.
  doc.y += 10;
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(title.toUpperCase(), lay(doc).left, doc.y);
  doc.y += 7;
}

function drawSection(doc: PDFKit.PDFDocument, section: PdfSection) {
  const L = lay(doc);
  switch (section.kind) {
    case 'spacer':
      doc.y += section.height ?? 12;
      return;

    case 'text':
      sectionTitle(doc, section.title);
      ensureSpace(doc, 40);
      doc.font('Helvetica').fontSize(L.size).fillColor(INK);
      doc.text(section.body, L.left, doc.y, {
        width: usableWidth(doc),
        align: L.style === 'letter' ? 'left' : 'justify',
      });
      doc.moveDown(0.5);
      return;

    case 'lines':
      for (const line of section.lines) {
        const size = line.small ? L.size - 2 : L.size;
        if (!line.text && !line.label) {
          doc.y += size * 1.25;
          continue;
        }
        ensureSpace(doc, size * 2);
        const font = line.bold
          ? line.italic
            ? 'Helvetica-BoldOblique'
            : 'Helvetica-Bold'
          : line.italic
            ? 'Helvetica-Oblique'
            : 'Helvetica';
        const opts = { width: usableWidth(doc), lineGap: 1 };
        if (line.label) {
          doc.font('Helvetica-Bold').fontSize(size).fillColor(INK).text(`${line.label} `, L.left, doc.y, { ...opts, continued: true });
          // A space, never an empty string: PDFKit leaves a continued line open on ''.
          doc.font(font).text(line.text || ' ');
        } else {
          doc.font(font).fontSize(size).fillColor(INK).text(line.text, L.left, doc.y, opts);
        }
      }
      doc.x = L.left;
      return;

    case 'parties': {
      ensureSpace(doc, 80);
      const width = usableWidth(doc);
      const rightX = L.left + width * 0.5785;
      const top = doc.y;
      const drawParty = (p: PdfParty, x: number, w: number): number => {
        let y = top;
        if (p.name) {
          doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text(p.name, x, y, { width: w });
          y = doc.y + 1;
        }
        doc.font('Helvetica').fontSize(L.size).fillColor(INK);
        for (const line of p.lines ?? []) {
          if (!line.trim()) continue;
          doc.text(line, x, y, { width: w });
          y = doc.y + 1;
        }
        return y;
      };
      const leftWidth = rightX - L.left - 14;
      const rightWidth = L.left + width - rightX;
      const below = Math.max(
        drawParty(section.left, L.left, leftWidth),
        section.right ? drawParty(section.right, rightX, rightWidth) : top,
      );
      // The labelled lines sit level with each other, below whichever side ran longer.
      const labelled = (p: PdfParty | undefined, x: number, w: number): number => {
        if (!p?.label) return below;
        doc.font('Helvetica-Bold').fontSize(L.size).fillColor(INK).text(`${p.label} `, x, below, { width: w, continued: true });
        doc.font('Helvetica').text(p.value || ' ');
        return doc.y;
      };
      const end = Math.max(labelled(section.left, L.left, leftWidth), labelled(section.right, rightX, rightWidth));
      doc.x = L.left;
      doc.y = end + 8;
      return;
    }

    case 'totals': {
      // Labels end where the second-last column does and the figures sit in
      // the last, under Unit price and Total, as SCORO sets them.
      const width = usableWidth(doc);
      const right = L.left + width;
      const valueWidth = Math.max(80, width * 0.154);
      const labelRight = right - valueWidth;
      const step = L.size * 1.9;
      const lead = L.style === 'letter' ? 3.7 : 6;
      // The block goes over whole: a total on a page of its own, away from
      // the subtotal and the tax it adds up, reads as a different figure.
      if (doc.y + lead + section.rows.length * step > contentBottom(doc)) doc.addPage();
      let y = doc.y + lead;
      for (const row of section.rows) {
        if (y + step > contentBottom(doc)) {
          doc.addPage();
          y = doc.y;
        }
        doc.font(row.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(L.size).fillColor(INK);
        doc.text(row.label, L.left, y, { width: labelRight - L.left - L.padX, align: 'right', lineBreak: false });
        doc.text(row.value, labelRight, y, { width: valueWidth - L.padX, align: 'right', lineBreak: false });
        y += step;
      }
      doc.x = L.left;
      doc.y = y - step + L.size * 1.2 + 5;
      return;
    }

    case 'fields': {
      sectionTitle(doc, section.title);
      const cols = section.columns ?? 2;
      const colWidth = usableWidth(doc) / cols;
      let col = 0;
      let rowTop = doc.y;
      let rowHeight = 0;

      for (const field of section.fields) {
        if (col === 0) {
          ensureSpace(doc, 30);
          rowTop = doc.y;
          rowHeight = 0;
        }
        const x = L.left + col * colWidth;
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
      const usable = usableWidth(doc);
      const widths =
        section.widths && section.widths.length === section.head.length
          ? normalise(section.widths, usable)
          : section.head.map(() => usable / section.head.length);
      const align = section.align ?? section.head.map(() => 'left' as const);

      drawTableHead(doc, section.head, widths, align);
      section.rows.forEach((row, i) => {
        const height = rowHeight(doc, row, widths);
        // A heading goes over with the row it heads: stranded at the foot of a
        // page, with its figures on the next, it reads as a line with no price.
        const next = section.rows[i + 1];
        const keep = isHeading(row) && next && !isHeading(next) ? rowHeight(doc, next, widths) : 0;
        if (doc.y + height + keep > contentBottom(doc)) {
          doc.addPage();
          drawTableHead(doc, section.head, widths, align);
        }
        if (isHeading(row)) drawHeadingRow(doc, row, widths, height);
        else drawTableRow(doc, row, widths, align, height);
      });
      // The letter's totals sit straight under the last rule.
      if (L.style === 'house') doc.moveDown(0.5);
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
  const L = lay(doc);
  ensureSpace(doc, 44);
  const top = doc.y;

  if (L.style === 'letter') {
    // SCORO's head: 18pt, one slate cell per column with a hairline of white
    // between them, bold 10pt white text.
    const height = 18;
    let x = L.left;
    widths.forEach((w, i) => {
      doc.rect(x, top, w - (i < widths.length - 1 ? 0.75 : 0), height).fill(HEAD_BG);
      x += w;
    });
    doc.fillColor(HEAD_INK).font('Helvetica-Bold').fontSize(10);
    x = L.left;
    head.forEach((cell, i) => {
      doc.text(cell.toUpperCase(), x + L.padX, top + 3, {
        width: widths[i] - 0.75 - L.padX * 2,
        align: align[i],
        lineBreak: false,
      });
      x += widths[i];
    });
    doc.y = top + height;
    return;
  }

  // 24pt and white on slate, as measured off the reference documents. A taller
  // band reads as a header rather than as a slightly shaded first row.
  const height = 24;
  doc.rect(L.left, top, sum(widths), height).fill(HEAD_BG);
  doc.fillColor(HEAD_INK).font('Helvetica-Bold').fontSize(8.5);
  let x = L.left;
  head.forEach((cell, i) => {
    doc.text(cell.toUpperCase(), x + 8, top + 8, { width: widths[i] - 16, align: align[i] });
    x += widths[i];
  });
  doc.y = top + height;
}

function cellHeight(doc: PDFKit.PDFDocument, cell: PdfCell, width: number): number {
  const size = lay(doc).size;
  if (typeof cell === 'object' && cell !== null) {
    doc.font('Helvetica-Bold').fontSize(size);
    const title = doc.heightOfString(cell.title || ' ', { width });
    doc.font('Helvetica').fontSize(size);
    return title + (cell.body ? 2 + doc.heightOfString(cell.body, { width }) : 0);
  }
  doc.font('Helvetica').fontSize(size);
  return doc.heightOfString(cell ?? '', { width });
}

function rowHeight(doc: PDFKit.PDFDocument, row: PdfRow, widths: number[]): number {
  const L = lay(doc);
  if (isHeading(row)) {
    doc.font('Helvetica-Bold').fontSize(L.size);
    return doc.heightOfString(row.heading || ' ', { width: sum(widths) - L.padX * 2 }) + L.padRow;
  }
  let tallest = 0;
  row.forEach((cell, i) => {
    tallest = Math.max(tallest, cellHeight(doc, cell, widths[i] - L.padX * 2));
  });
  return tallest + L.padRow;
}

/**
 * The rule under a row. The house style strokes a light hairline; the letter
 * lays SCORO's 0.7pt slate bar, broken at the column gaps under a heading.
 */
function rowRule(doc: PDFKit.PDFDocument, y: number, widths: number[], underHeading: boolean) {
  const L = lay(doc);
  const total = sum(widths);
  if (L.style === 'house') {
    doc.moveTo(L.left, y).lineTo(L.left + total, y).strokeColor(RULE).lineWidth(0.5).stroke();
    return;
  }
  if (!underHeading) {
    doc.rect(L.left, y, total, 0.7).fill(HEAD_BG);
    return;
  }
  let x = L.left;
  widths.forEach((w, i) => {
    doc.rect(x, y, w - (i < widths.length - 1 ? 0.75 : 0), 0.7).fill(HEAD_BG);
    x += w;
  });
}

function drawHeadingRow(
  doc: PDFKit.PDFDocument,
  row: { heading: string; shade?: boolean },
  widths: number[],
  height: number,
) {
  const L = lay(doc);
  const top = doc.y;
  const total = sum(widths);
  if (row.shade) doc.rect(L.left, top, total, height).fill(SHADE);
  doc
    .font('Helvetica-Bold')
    .fontSize(L.size)
    .fillColor(INK)
    .text(row.heading, L.left + L.padX, top + L.padTop, { width: total - L.padX * 2 });
  rowRule(doc, top + height, widths, true);
  doc.y = top + height;
}

function drawTableRow(
  doc: PDFKit.PDFDocument,
  row: PdfCell[],
  widths: number[],
  align: ('left' | 'right' | 'center')[],
  height: number,
) {
  const L = lay(doc);
  const top = doc.y;
  doc.font('Helvetica').fontSize(L.size).fillColor(INK);
  let x = L.left;
  row.forEach((cell, i) => {
    const opts = { width: widths[i] - L.padX * 2, align: align[i] };
    if (typeof cell === 'object' && cell !== null) {
      doc.font('Helvetica-Bold').fontSize(L.size).fillColor(INK).text(cell.title, x + L.padX, top + L.padTop, opts);
      if (cell.body) doc.font('Helvetica').fontSize(L.size).text(cell.body, x + L.padX, doc.y + 2, opts);
      doc.font('Helvetica').fontSize(L.size);
    } else {
      doc.text(cell ?? '', x + L.padX, top + L.padTop, opts);
    }
    x += widths[i];
  });
  rowRule(doc, top + height, widths, false);
  doc.y = top + height;
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
  const L = lay(doc);

  const lineHeight = 15;
  const blockHeight = people.length * lineHeight + 6;
  ensureSpace(doc, blockHeight + 10);
  // Sits directly above the footer, wherever the content ended.
  doc.y = Math.max(doc.y + 20, doc.page.height - L.footerTop - 10 - blockHeight);

  // The labels are set on one shared column so the names line up under each
  // other, however long "REQUESTED BY" is against "NOTED BY".
  doc.font('Helvetica-Bold').fontSize(9);
  const labelWidth = Math.max(...people.map((p) => doc.widthOfString(`${p.role.toUpperCase()} :`))) + 10;

  for (const person of people) {
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK);
    doc.text(`${person.role.toUpperCase()} :`, L.left, y, { lineBreak: false });

    const x = L.left + labelWidth;
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

/**
 * The letter's furniture on every page, drawn once the content is laid out:
 * the brand band along the foot, "Page n of m" just above it when there is
 * more than one, and on every page after the first SCORO's running header —
 * who it is for, the number and the date, centred in bold — so a loose second
 * page still says which quote it belongs to. The company block is on page
 * one's letterhead, so the band carries only the strapline.
 */
function paginateLetter(doc: PDFKit.PDFDocument, spec: PdfDocumentSpec, company: Company) {
  const L = lay(doc);
  const range = doc.bufferedPageRange();
  const band = footerTagline(company, ' '.repeat(10)) || websiteForPrint(company?.website);
  const running = [spec.reference ?? '', numberForPrint(spec), formatShortDate(spec.date ?? new Date())]
    .filter((t) => t.trim())
    .join(' '.repeat(16));

  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    // Below the bottom margin, like the house footer: see paginate().
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const right = doc.page.width - L.right;
    const bandTop = doc.page.height - 30;

    if (i > 0 && running) {
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK);
      doc.text(running, L.left, 24, { width: right - L.left, align: 'center', height: 12, ellipsis: true, lineGap: 0 });
    }

    doc.rect(14, bandTop, right + 0.7 - 14, 18).fill(BAND_BG);
    if (band) {
      doc.font('Helvetica-Bold').fontSize(12).fillColor(BAND_INK);
      doc.text(band, 14, bandTop + 2, { width: right + 0.7 - 14, align: 'center', height: 14, ellipsis: true, lineGap: 0 });
    }

    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
    if (spec.footerNote) {
      doc.text(spec.footerNote, L.left, bandTop - 11, { width: right - L.left - 70, height: 9, ellipsis: true, lineGap: 0 });
    }
    if (range.count > 1) {
      doc.text(`Page ${i + 1} of ${range.count}`, right - 60, bandTop - 11, { width: 60, align: 'right', lineBreak: false });
    }

    doc.page.margins.bottom = bottomMargin;
  }
  doc.switchToPage(range.start + range.count - 1);
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number) {
  if (doc.y + needed > contentBottom(doc)) doc.addPage();
}

export function formatDate(d: Date): string {
  return d.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
}

/** "08/17/2026", in Manila — the date as SCORO's quote printed it. */
export function formatShortDate(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (type: string) => parts.find((x) => x.type === type)?.value ?? '';
  return `${get('month')}/${get('day')}/${get('year')}`;
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
    .replace(/\u00a0/g, ' ')
    .trim();
}

/**
 * An amount with no currency: "13,100,000.00". Only for a table whose
 * currency is named once, in its total's label — "Total Price (PHP):" — as
 * SCORO's quote prints it. A figure that stands on its own is formatMoney.
 */
export function formatAmount(value: number | string): string {
  const n = typeof value === 'string' ? Number(value) : value;
  return new Intl.NumberFormat('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    Number.isFinite(n) ? n : 0,
  );
}
