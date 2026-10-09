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
 * This is the house style, the internal paperwork (P00340, REQ-00073): the
 * document names itself top-left and the company block sits in the footer.
 * The quotation — the one document a customer receives — is laid out by an
 * administrator instead (Admin › PDF Templates) and prints through
 * `renderDesigned` in `pdfDesign.ts`, with the helpers below (`pdfSafe`, the
 * formatters) shared between the two.
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

/** One bar of a `gantt` section: a task on working days `start` … `start + days − 1`. */
export interface PdfGanttTask {
  name: string;
  start: number;
  days: number;
}

/** A phase of a `gantt` section: a shaded row whose bar spans its tasks. */
export interface PdfGanttGroup {
  name: string;
  tasks: PdfGanttTask[];
  /** The phase's own span (working days from 1), drawn as its bar when it has no tasks to span. */
  start?: number;
  days?: number;
}

export type PdfSection =
  | { kind: 'fields'; title?: string; columns?: 1 | 2 | 3; fields: PdfField[] }
  | { kind: 'table'; title?: string; head: string[]; rows: PdfRow[]; widths?: number[]; align?: ('left' | 'right' | 'center')[] }
  | { kind: 'text'; title?: string; body: string }
  | { kind: 'lines'; lines: PdfLine[] }
  | { kind: 'parties'; left: PdfParty; right?: PdfParty }
  | { kind: 'totals'; rows: PdfTotal[] }
  /**
   * A schedule drawn as bars against numbered working days: Task, Start, End,
   * Days, then the day grid. `landscape` starts it on a landscape page (and
   * keeps its overflow pages landscape), for the width a long plan needs.
   */
  | { kind: 'gantt'; title?: string; groups: PdfGanttGroup[]; landscape?: boolean; legend?: string }
  /** A light hairline across the page, with room above and below. */
  | { kind: 'rule' }
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
  /**
   * How to reach them. The quotation's sign-offs print these under the name,
   * because a customer who reads it calls the person who prepared it; the
   * house style's one-line sign-offs leave them out.
   */
  phone?: string;
  email?: string;
}

export interface PdfDocumentSpec {
  title: string;
  documentNumber?: string;
  revision?: string;
  date?: Date;
  /** Customer / project reference, printed under the title. */
  reference?: string;
  sections: PdfSection[];
  /** Defaults to Prepared / Checked / Approved. */
  signatories?: Signatory[];
  /** Small print above the page number. */
  footerNote?: string;
  /**
   * The dress (2026-10-09, the owner's call: "pattern other PDF output to
   * the quote template — focus only on G-OPS"). `house` is the internal
   * paperwork (P00340, REQ-00073): 14pt margins, the document naming itself
   * top-left, the company block in the footer, slate table heads, one-line
   * sign-offs. `quote` is the Quotation_Template's dress for G-OPS: 36pt
   * margins, the letterhead top-left with the document and its number in
   * purple and green top-right, purple heads and green subheadings on light
   * rules, side-by-side sign-offs, the strapline along the foot. The
   * sections a module supplies are the same either way.
   */
  style?: 'house' | 'quote';
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
/** A shaded heading row, so a group reads apart from the product names under it. */
const SHADE = '#e9ebef';
/** A task's bar on a schedule: the slate of the table head, lightened. */
const BAR = '#c7ccd6';

/** The page's measurements, named once. */
interface Layout {
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

const HOUSE: Layout = { left: MARGIN, right: MARGIN, footerTop: FOOTER_TOP, size: 9, padX: 8, padTop: 7, padRow: 14 };

/** A dress: the page's measurements and its colours, named once. */
interface Theme extends Layout {
  name: 'house' | 'quote';
  ink: string;
  muted: string;
  rule: string;
  /** The band behind a table head, or null for head text on white over a rule. */
  headBg: string | null;
  headInk: string;
  shade: string;
  bar: string;
  barStrong: string;
  /** Section titles and the document's name. */
  accent: string;
  /** Subheadings, the number, the strapline. */
  accent2: string;
}

const HOUSE_THEME: Theme = {
  name: 'house',
  ...HOUSE,
  ink: INK,
  muted: MUTED,
  rule: RULE,
  headBg: HEAD_BG,
  headInk: HEAD_INK,
  shade: SHADE,
  bar: BAR,
  barStrong: HEAD_BG,
  accent: INK,
  accent2: INK,
};

/**
 * The Quotation_Template's dress (shared/quotationTemplate.ts): 36pt margins,
 * purple #5B2A8C heads, green #2E9A4B subheadings and number, light #D9D9D9
 * rules — for the G-OPS paper, so a job order reads like the quotation it
 * follows.
 */
const QUOTE_THEME: Theme = {
  name: 'quote',
  left: 36,
  right: 36,
  footerTop: FOOTER_TOP,
  size: 9,
  padX: 6,
  padTop: 6,
  padRow: 12,
  ink: '#222222',
  muted: '#666666',
  rule: '#D9D9D9',
  headBg: null,
  headInk: '#5B2A8C',
  shade: '#F3EFF7',
  bar: '#D9CCE6',
  barStrong: '#5B2A8C',
  accent: '#5B2A8C',
  accent2: '#2E9A4B',
};

/**
 * The dress of the document being drawn. Set at the top of renderDocument,
 * before any drawing; everything from there to doc.end() is synchronous, so
 * two documents rendering at once never read each other's dress.
 */
let T: Theme = HOUSE_THEME;

const usableWidth = (doc: PDFKit.PDFDocument) => doc.page.width - T.left - T.right;
const contentBottom = (doc: PDFKit.PDFDocument) => doc.page.height - T.footerTop - 24;

/** A section that stands on landscape pages of its own after the signed body: the Gantt chart. */
const isAppendix = (s: PdfSection) => s.kind === 'gantt' && !!s.landscape;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const isHeading = (row: PdfRow): row is { heading: string; shade?: boolean } => !Array.isArray(row);

export async function renderDocument(input: PdfDocumentSpec): Promise<Buffer> {
  // Everything that reaches the page goes through pdfSafe first: the module's
  // content AND the company's own details, which an administrator types freely
  // into Settings and which print on every page of every document.
  const spec = safeSpec(input);
  const row = await prisma.company.findUnique({ where: { id: 'company' } });
  const company = row && safeCompany(row);
  T = spec.style === 'quote' ? QUOTE_THEME : HOUSE_THEME;
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: T.left, bottom: 64, left: T.left, right: T.right },
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
  // A landscape section at the end is an APPENDIX (the costing's Scope of
  // Work, 2026-10-09): the sign-offs print before it, on the last portrait
  // page of the body, and the chart gets pages of its own after them. Drawn
  // after everything, the sign-offs spilled onto a near-empty portrait page
  // behind the chart whenever its legend ran low.
  const sections = spec.sections;
  let appendixFrom = sections.length;
  while (appendixFrom > 0 && isAppendix(sections[appendixFrom - 1])) appendixFrom--;
  for (const section of sections.slice(0, appendixFrom)) drawSection(doc, section);
  drawSignoffs(doc, spec.signatories);
  for (const section of sections.slice(appendixFrom)) drawSection(doc, section);
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
    case 'rule':
      return section;
    case 'text':
      return { ...section, title: t(section.title), body: pdfSafe(section.body) };
    case 'lines':
      return { ...section, lines: section.lines.map((l) => ({ ...l, text: pdfSafe(l.text ?? ''), label: t(l.label) })) };
    case 'parties':
      return { ...section, left: party(section.left), right: section.right && party(section.right) };
    case 'totals':
      return { ...section, rows: section.rows.map((r) => ({ ...r, label: pdfSafe(r.label), value: pdfSafe(r.value) })) };
    case 'gantt':
      return {
        ...section,
        title: t(section.title),
        legend: t(section.legend),
        groups: section.groups.map((g) => ({
          ...g,
          name: pdfSafe(g.name ?? ''),
          tasks: g.tasks.map((task) => ({ ...task, name: pdfSafe(task.name ?? '') })),
        })),
      };
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
      phone: t(p.phone),
      email: t(p.email),
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
export function websiteForPrint(website?: string | null): string {
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
 * `gap` is what separates the two.
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

/**
 * The document identifies itself top-left; the logo sits top-right.
 *
 * The company's name and address are NOT up here — they are in the footer,
 * which is where the documents this is patterned on put them. It is the right
 * way round: the first thing a reader needs is which document this is, and the
 * letterhead is what you check afterwards.
 */
function drawHeader(doc: PDFKit.PDFDocument, spec: PdfDocumentSpec, company: Company) {
  if (T.name === 'quote') {
    drawLetterhead(doc, spec, company);
    return;
  }
  const right = doc.page.width - T.left;
  const top = T.left + 6;

  if (company?.logoPath && fs.existsSync(company.logoPath)) {
    try {
      doc.image(company.logoPath, right - 150, top - 6, { fit: [150, 56], align: 'right' });
    } catch {
      /* a broken logo must never stop a document printing */
    }
  }

  // "Purchase Request No. GT-PR-2026-0042" — one line, the way it is spoken.
  doc.fillColor(T.ink).font('Helvetica-Bold').fontSize(13);
  doc.text(
    spec.documentNumber ? `${spec.title} No. ${spec.documentNumber}` : spec.title,
    T.left,
    top,
    { width: right - T.left - 170 },
  );

  doc.font('Helvetica').fontSize(10).fillColor(T.ink);
  doc.text(formatDate(spec.date ?? new Date()), T.left, doc.y + 3, { width: 300 });

  // Bold label, regular value, on one line each — as on the reference.
  const meta: [string, string][] = [];
  if (spec.revision) meta.push(['Revision:', spec.revision]);
  if (spec.reference) meta.push(['Reference:', spec.reference]);
  for (const [label, value] of meta) {
    const y = doc.y + 3;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(T.ink);
    // Wraps inside the space left of the logo, and the next line starts below
    // however many lines it took — a long reference used to overprint what
    // followed it.
    doc.text(label, T.left, y, { width: right - T.left - 170, continued: true });
    doc.font('Helvetica').text(` ${value}`);
    doc.y = Math.max(doc.y, y + 13);
  }

  // Clear of the logo whatever the header ran to.
  doc.y = Math.max(doc.y, top + 58) + 12;
}

/**
 * The Quotation_Template's letterhead, for the G-OPS paper: the logo top-left
 * with the company name in purple capitals beside it and its details under
 * that; the document's name top-right in purple with the number in green under
 * it; a green rule; then the date, the reference and the revision in bold.
 */
function drawLetterhead(doc: PDFKit.PDFDocument, spec: PdfDocumentSpec, company: Company) {
  const left = T.left;
  const right = doc.page.width - T.right;
  const top = 30;
  const logoW = 72;
  const titleW = 240;
  const titleX = right - titleW;
  const textX = left + logoW + 9;
  const textW = titleX - textX - 10;

  let drewLogo = false;
  if (company?.logoPath && fs.existsSync(company.logoPath)) {
    try {
      doc.image(company.logoPath, left, top, { fit: [logoW, logoW] });
      drewLogo = true;
    } catch {
      /* a broken logo must never stop a document printing */
    }
  }
  const nameX = drewLogo ? textX : left;
  const nameW = drewLogo ? textW : titleX - left - 10;

  doc.font('Helvetica-Bold').fontSize(15).fillColor(T.accent);
  doc.text((company?.name ?? '').toUpperCase(), nameX, top + 7, { width: nameW, height: 18, ellipsis: true, lineBreak: false });
  const join = (parts: string[], sep = ' | ') => parts.filter((p) => p.trim()).join(sep);
  const lines = [
    join([company?.address ?? '', [company?.city, company?.country].filter(Boolean).join(', ')], ', '),
    join([company?.phone ? `Tel No.: ${company.phone}` : '', company?.fax ? `Fax No.: ${company.fax}` : '', company?.email ? `Email: ${company.email}` : '']),
    company?.website ? `Website: ${company.website}` : '',
    join([company?.tin ? `TIN: ${company.tin}` : '', company?.regNo ? `REG NO: ${company.regNo}` : '']),
  ].filter((l) => l.trim());
  doc.font('Helvetica').fontSize(7.5).fillColor(T.ink);
  let y = top + 27.5;
  for (const line of lines) {
    // A line wraps onto a second when it must (Tel | Fax | Email), never a third.
    const h = Math.min(20, Math.max(10, doc.heightOfString(line, { width: nameW, lineGap: 1 })));
    doc.text(line, nameX, y, { width: nameW, height: h, ellipsis: true, lineGap: 1 });
    y += h;
  }

  // The document's name, as large as fits the right-hand block.
  const title = spec.title.toUpperCase();
  let size = 24;
  doc.font('Helvetica-Bold');
  while (size > 13 && doc.fontSize(size).widthOfString(title) > titleW) size -= 1;
  doc.fontSize(size).fillColor(T.accent).text(title, titleX, top - 4 + (24 - size) / 2, { width: titleW, align: 'right', lineBreak: false });
  if (spec.documentNumber) {
    doc.font('Helvetica-Bold').fontSize(10).fillColor(T.accent2);
    doc.text(`# ${spec.documentNumber}`, titleX, top + 32, { width: titleW, align: 'right', lineBreak: false });
  }

  const ruleY = Math.max(top + logoW + 12, y + 8, 114);
  doc.moveTo(left, ruleY).lineTo(right, ruleY).strokeColor(T.accent2).lineWidth(1.5).stroke();

  // Date, reference, revision — bold, as the quotation's DETAILS block.
  doc.y = ruleY + 12;
  const meta: [string, string][] = [['Date:', formatDate(spec.date ?? new Date())]];
  if (spec.reference) meta.push(['Reference:', spec.reference]);
  if (spec.revision) meta.push(['Revision:', spec.revision]);
  for (const [label, value] of meta) {
    const lineY = doc.y;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(T.ink);
    doc.text(label, left, lineY, { width: right - left, continued: true });
    doc.font('Helvetica').text(` ${value}`);
    doc.y = Math.max(doc.y, lineY + 13);
  }
  doc.x = left;
  doc.y += 6;
}

function sectionTitle(doc: PDFKit.PDFDocument, title?: string) {
  if (!title) return;
  ensureSpace(doc, 40);
  // Explicit gaps rather than moveDown fractions: moveDown scales with whatever
  // font happens to be current, which left headings sitting ~3pt above their
  // own content — cramped on the page, and close enough to merge with it when
  // the PDF is parsed by anything that groups text into lines.
  doc.y += 10;
  doc.font('Helvetica-Bold').fontSize(T.name === 'quote' ? 8.5 : 9.5).fillColor(T.accent).text(title.toUpperCase(), T.left, doc.y);
  doc.y += 7;
}

function drawSection(doc: PDFKit.PDFDocument, section: PdfSection) {
  const L = T;
  switch (section.kind) {
    case 'spacer':
      doc.y += section.height ?? 12;
      return;

    case 'rule': {
      ensureSpace(doc, 30);
      const y = doc.y + 12;
      doc
        .moveTo(L.left, y)
        .lineTo(doc.page.width - L.right, y)
        .strokeColor(T.rule)
        .lineWidth(0.75)
        .stroke();
      doc.x = L.left;
      doc.y = y + 12;
      return;
    }

    case 'text':
      sectionTitle(doc, section.title);
      ensureSpace(doc, 40);
      doc.font('Helvetica').fontSize(L.size).fillColor(T.ink);
      doc.text(section.body, L.left, doc.y, {
        width: usableWidth(doc),
        align: 'justify',
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
          doc.font('Helvetica-Bold').fontSize(size).fillColor(T.ink).text(`${line.label} `, L.left, doc.y, { ...opts, continued: true });
          // A space, never an empty string: PDFKit leaves a continued line open on ''.
          doc.font(font).text(line.text || ' ');
        } else {
          doc.font(font).fontSize(size).fillColor(T.ink).text(line.text, L.left, doc.y, opts);
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
          doc.font('Helvetica-Bold').fontSize(12).fillColor(T.ink).text(p.name, x, y, { width: w });
          y = doc.y + 1;
        }
        doc.font('Helvetica').fontSize(L.size).fillColor(T.ink);
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
        doc.font('Helvetica-Bold').fontSize(L.size).fillColor(T.ink).text(`${p.label} `, x, below, { width: w, continued: true });
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
      const lead = 6;
      // The block goes over whole: a total on a page of its own, away from
      // the subtotal and the tax it adds up, reads as a different figure.
      if (doc.y + lead + section.rows.length * step > contentBottom(doc)) doc.addPage();
      let y = doc.y + lead;
      for (const row of section.rows) {
        if (y + step > contentBottom(doc)) {
          doc.addPage();
          y = doc.y;
        }
        doc.font(row.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(L.size).fillColor(row.bold ? T.accent : T.ink);
        doc.text(row.label, L.left, y, { width: labelRight - L.left - L.padX, align: 'right', lineBreak: false });
        doc.text(row.value, labelRight, y, { width: valueWidth - L.padX, align: 'right', lineBreak: false });
        if (T.name === 'quote') {
          doc.moveTo(labelRight - 120, y + step - 4).lineTo(right, y + step - 4).strokeColor(row.bold ? T.accent : T.rule).lineWidth(row.bold ? 1.5 : 0.5).stroke();
        }
        y += step;
      }
      doc.x = L.left;
      doc.y = y - step + L.size * 1.2 + 5;
      return;
    }

    case 'gantt':
      drawGantt(doc, section);
      return;

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
        doc.font('Helvetica-Bold').fontSize(8).fillColor(T.muted);
        doc.text(field.label.toUpperCase(), x, rowTop, { width: colWidth - 10 });
        doc.font('Helvetica-Bold').fontSize(10).fillColor(T.ink);
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
      doc.moveDown(0.5);
      return;
    }
  }
}

/** The last working day a plan reaches. */
export function ganttEnd(groups: PdfGanttGroup[]): number {
  let end = 0;
  for (const g of groups) {
    const span = groupSpan(g);
    if (span) end = Math.max(end, span.to);
    for (const t of g.tasks) end = Math.max(end, t.start + Math.max(t.days, 1) - 1);
  }
  return end;
}

/** A phase's bar: over its tasks when it has any, else its own start and days; none when it has neither. */
function groupSpan(g: PdfGanttGroup): { from: number; to: number } | null {
  if (g.tasks.length) {
    const from = Math.min(...g.tasks.map((t) => t.start));
    const to = Math.max(...g.tasks.map((t) => t.start + Math.max(t.days, 1) - 1));
    return { from, to };
  }
  if (g.start && g.days) return { from: g.start, to: g.start + Math.max(g.days, 1) - 1 };
  return null;
}

/** A day-label step that keeps the labels about 22pt apart. */
function dayStep(dayWidth: number): number {
  for (const step of [1, 2, 5, 10, 20, 30, 50, 100]) if (step * dayWidth >= 22) return step;
  return 200;
}

/**
 * The schedule as bars (the costing's Scope of Work page): each phase a shaded
 * row with a slate bar over the span of its tasks, each task a row with a light
 * bar labelled with its length. Days are numbered working days, not dates — a
 * costing is priced before anybody knows the start date.
 */
function drawGantt(
  doc: PDFKit.PDFDocument,
  section: { title?: string; groups: PdfGanttGroup[]; landscape?: boolean; legend?: string },
) {
  const L = T;
  const newPage = () => {
    if (section.landscape) doc.addPage({ size: 'A4', layout: 'landscape', margins: doc.page.margins });
    else doc.addPage();
  };
  if (section.landscape) newPage();
  sectionTitle(doc, section.title);

  const usable = usableWidth(doc);
  const colTask = Math.max(150, usable * 0.24);
  const colStart = 40;
  const colEnd = 40;
  const colDays = 30;
  const fixed = colTask + colStart + colEnd + colDays;
  const gridX = L.left + fixed;
  const gridW = usable - fixed;
  const total = Math.max(1, ganttEnd(section.groups));
  const dayW = gridW / total;
  const step = dayStep(dayW);
  const size = 8;
  const dayX = (day: number) => gridX + (day - 1) * dayW;

  const head = () => {
    ensureSpace(doc, 60);
    const top = doc.y;
    const height = 20;
    if (T.headBg) doc.rect(L.left, top, usable, height).fill(T.headBg);
    else {
      doc.moveTo(L.left, top).lineTo(L.left + usable, top).strokeColor(T.rule).lineWidth(0.75).stroke();
      doc.moveTo(L.left, top + height).lineTo(L.left + usable, top + height).strokeColor(T.rule).lineWidth(0.75).stroke();
    }
    doc.fillColor(T.headInk).font('Helvetica-Bold').fontSize(7.5);
    const cells: [string, number, number, 'left' | 'right'][] = [
      ['TASK', L.left, colTask, 'left'],
      ['START', L.left + colTask, colStart, 'left'],
      ['END', L.left + colTask + colStart, colEnd, 'left'],
      ['DAYS', L.left + colTask + colStart + colEnd, colDays, 'right'],
    ];
    for (const [text, x, w, align] of cells) {
      doc.text(text, x + 5, top + 7, { width: w - 10, align, lineBreak: false });
    }
    doc.font('Helvetica').fontSize(6.5);
    for (let day = 1; day <= total; day += step) {
      doc.text(`Day ${day}`, dayX(day) + 1.5, top + 7.5, { width: Math.max(step * dayW - 2, 10), lineBreak: false });
    }
    doc.y = top + height;
  };

  const gridLines = (top: number, height: number) => {
    for (let day = 1; day <= total; day += step) {
      doc.moveTo(dayX(day), top).lineTo(dayX(day), top + height).strokeColor(T.rule).lineWidth(0.4).stroke();
    }
    doc.moveTo(L.left, top + height).lineTo(L.left + usable, top + height).strokeColor(T.rule).lineWidth(0.5).stroke();
  };

  const fits = (height: number) => {
    if (doc.y + height > contentBottom(doc)) {
      newPage();
      head();
    }
  };

  head();
  for (const group of section.groups) {
    const groupH = 17;
    // A phase goes over with its first task, never alone at the foot of a page.
    fits(groupH + (group.tasks.length ? 18 : 0));
    const gTop = doc.y;
    doc.rect(L.left, gTop, usable, groupH).fill(T.shade);
    doc.font('Helvetica-Bold').fontSize(size).fillColor(T.ink);
    doc.text(group.name, L.left + 5, gTop + 5, { width: colTask - 10, height: size + 2, ellipsis: true, lineGap: 0 });
    // The phase's own span — over its tasks, or its planned days when it has
    // none (a costing phased without tasks still has a schedule to show).
    const span = groupSpan(group);
    if (span) {
      doc.font('Helvetica-Bold').fontSize(size).fillColor(T.ink);
      doc.text(`Day ${span.from}`, L.left + colTask + 5, gTop + 5, { width: colStart - 10, lineBreak: false });
      doc.text(`Day ${span.to}`, L.left + colTask + colStart + 5, gTop + 5, { width: colEnd - 10, lineBreak: false });
      doc.text(String(span.to - span.from + 1), L.left + colTask + colStart + colEnd + 5, gTop + 5, {
        width: colDays - 10,
        align: 'right',
        lineBreak: false,
      });
      doc.roundedRect(dayX(span.from), gTop + 6, (span.to - span.from + 1) * dayW, 5, 2).fill(T.barStrong);
    }
    gridLines(gTop, groupH);
    doc.y = gTop + groupH;

    for (const task of group.tasks) {
      doc.font('Helvetica').fontSize(size);
      const textH = doc.heightOfString(task.name || ' ', { width: colTask - 20 });
      const rowH = Math.max(textH + 8, 16);
      fits(rowH);
      const top = doc.y;
      const end = task.start + Math.max(task.days, 1) - 1;
      doc.font('Helvetica').fontSize(size).fillColor(T.ink);
      doc.text(task.name, L.left + 14, top + 4, { width: colTask - 20 });
      const mid = top + rowH / 2 - size / 2 + 0.5;
      doc.text(`Day ${task.start}`, L.left + colTask + 5, mid, { width: colStart - 10, lineBreak: false });
      doc.text(`Day ${end}`, L.left + colTask + colStart + 5, mid, { width: colEnd - 10, lineBreak: false });
      doc.text(String(task.days), L.left + colTask + colStart + colEnd + 5, mid, {
        width: colDays - 10,
        align: 'right',
        lineBreak: false,
      });
      const barW = Math.max(task.days, 1) * dayW;
      doc.roundedRect(dayX(task.start) + 0.5, top + rowH / 2 - 5, Math.max(barW - 1, 2), 10, 2).fill(T.bar);
      const label = `${task.days}d`;
      doc.font('Helvetica').fontSize(6.5).fillColor(T.ink);
      if (doc.widthOfString(label) + 4 <= barW) {
        doc.text(label, dayX(task.start) + 2.5, top + rowH / 2 - 3, { lineBreak: false });
      }
      gridLines(top, rowH);
      doc.y = top + rowH;
    }
  }

  if (section.legend) {
    ensureSpace(doc, 20);
    doc.y += 6;
    const y = doc.y;
    doc.rect(L.left, y + 1, 9, 6).fill(T.bar);
    doc.font('Helvetica').fontSize(7.5).fillColor(T.muted).text(section.legend, L.left + 14, y, { width: usable - 14 });
  }
  doc.x = L.left;
  doc.y += 6;
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
  const L = T;
  ensureSpace(doc, 44);
  const top = doc.y;

  // 24pt and white on slate, as measured off the reference documents. A taller
  // band reads as a header rather than as a slightly shaded first row.
  const height = 24;
  if (T.headBg) doc.rect(L.left, top, sum(widths), height).fill(T.headBg);
  else {
    // The quotation's head: purple text on white, a rule above and a rule under.
    doc.moveTo(L.left, top).lineTo(L.left + sum(widths), top).strokeColor(T.rule).lineWidth(0.75).stroke();
    doc.moveTo(L.left, top + height).lineTo(L.left + sum(widths), top + height).strokeColor(T.rule).lineWidth(0.75).stroke();
  }
  doc.fillColor(T.headInk).font('Helvetica-Bold').fontSize(8.5);
  let x = L.left;
  head.forEach((cell, i) => {
    doc.text(T.headBg ? cell.toUpperCase() : cell, x + L.padX, top + 8, { width: widths[i] - L.padX * 2, align: align[i] });
    x += widths[i];
  });
  doc.y = top + height;
}

function cellHeight(doc: PDFKit.PDFDocument, cell: PdfCell, width: number): number {
  const size = T.size;
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
  const L = T;
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

/** The light hairline under a row. */
function rowRule(doc: PDFKit.PDFDocument, y: number, widths: number[]) {
  doc.moveTo(T.left, y).lineTo(T.left + sum(widths), y).strokeColor(T.rule).lineWidth(0.5).stroke();
}

function drawHeadingRow(
  doc: PDFKit.PDFDocument,
  row: { heading: string; shade?: boolean },
  widths: number[],
  height: number,
) {
  const L = T;
  const top = doc.y;
  const total = sum(widths);
  if (row.shade) doc.rect(L.left, top, total, height).fill(T.shade);
  doc
    .font('Helvetica-Bold')
    .fontSize(L.size)
    .fillColor(T.accent2)
    .text(row.heading, L.left + L.padX, top + L.padTop, { width: total - L.padX * 2 });
  rowRule(doc, top + height, widths);
  doc.y = top + height;
}

function drawTableRow(
  doc: PDFKit.PDFDocument,
  row: PdfCell[],
  widths: number[],
  align: ('left' | 'right' | 'center')[],
  height: number,
) {
  const L = T;
  const top = doc.y;
  const ink = T.ink;
  doc.font('Helvetica').fontSize(L.size).fillColor(ink);
  let x = L.left;
  row.forEach((cell, i) => {
    const opts = { width: widths[i] - L.padX * 2, align: align[i] };
    if (typeof cell === 'object' && cell !== null) {
      doc.font('Helvetica-Bold').fontSize(L.size).fillColor(ink).text(cell.title, x + L.padX, top + L.padTop, opts);
      if (cell.body) {
        doc
          .font('Helvetica')
          .fontSize(L.size)
          .fillColor(ink)
          .text(cell.body, x + L.padX, doc.y + 2, opts);
      }
      doc.font('Helvetica').fontSize(L.size).fillColor(ink);
    } else {
      doc.text(cell ?? '', x + L.padX, top + L.padTop, opts);
    }
    x += widths[i];
  });
  rowRule(doc, top + height, widths);
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
  if (T.name === 'quote') {
    drawSignoffColumns(doc, people);
    return;
  }
  const L = T;

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
    doc.font('Helvetica-Bold').fontSize(9).fillColor(T.ink);
    doc.text(`${person.role.toUpperCase()} :`, L.left, y, { lineBreak: false });

    const x = L.left + labelWidth;
    if (person.name) {
      doc.font('Helvetica').fontSize(9).fillColor(T.ink);
      const name = person.position ? `${person.name} (${person.position}),` : `${person.name},`;
      doc.text(name, x, y, { lineBreak: false, continued: true });
      doc.font('Helvetica-Oblique').fillColor(T.muted);
      doc.text(person.at ? ` ${formatDateTime(person.at)}` : ' Pending', { lineBreak: false });
    } else {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(T.muted);
      doc.text('Pending', x, y, { lineBreak: false });
    }
    doc.y = y + lineHeight;
  }
}

/**
 * The quotation's sign-offs: side by side, each column the role in purple
 * capitals, the name in bold, then the position, the contact number, the
 * email and when — or "Pending". Four to a row; more wrap to another row.
 * The block sits above the footer wherever the content ended, and goes over
 * whole when it does not fit.
 */
function drawSignoffColumns(doc: PDFKit.PDFDocument, people: Signatory[]) {
  const L = T;
  const usable = usableWidth(doc);
  const perRow = Math.min(4, Math.max(1, people.length));
  const colW = usable / perRow;
  const rows: Signatory[][] = [];
  for (let i = 0; i < people.length; i += perRow) rows.push(people.slice(i, i + perRow));

  const lineH = 11;
  // A role may run to two lines ("APPROVED BY — PROJECT MANAGER" in a quarter
  // of the page); it never loses a word to an ellipsis. Every column in a row
  // starts its name on the same line, under the tallest role.
  const ROLE_MAX = 20;
  const roleHeight = (p: Signatory) => {
    doc.font('Helvetica-Bold').fontSize(8);
    return Math.min(ROLE_MAX, doc.heightOfString(p.role.toUpperCase(), { width: colW - 8 }));
  };
  const roleRowHeight = (row: Signatory[]) => Math.max(10, ...row.map(roleHeight)) + 4;
  const rowHeightOf = (row: Signatory[]) =>
    roleRowHeight(row) + 14 + Math.max(...row.map((p) => (p.name ? [p.position, p.phone, p.email].filter(Boolean).length + 1 : 1))) * lineH + 10;
  const blockHeight = rows.reduce((t, row) => t + rowHeightOf(row), 0) + 12;
  ensureSpace(doc, blockHeight + 10);
  doc.y = Math.max(doc.y + 18, doc.page.height - L.footerTop - 10 - blockHeight);
  // A light rule over the block, as the quotation rules off its text.
  doc.moveTo(L.left, doc.y).lineTo(L.left + usable, doc.y).strokeColor(T.rule).lineWidth(0.75).stroke();
  doc.y += 12;

  for (const row of rows) {
    const top = doc.y;
    const roleH = roleRowHeight(row);
    row.forEach((person, i) => {
      const x = L.left + i * colW;
      const w = colW - 8;
      let y = top;
      doc.font('Helvetica-Bold').fontSize(8).fillColor(T.accent);
      doc.text(person.role.toUpperCase(), x, y, { width: w, height: ROLE_MAX, ellipsis: true });
      y += roleH;
      if (person.name) {
        doc.font('Helvetica-Bold').fontSize(10).fillColor(T.ink);
        doc.text(person.name, x, y, { width: w, height: 12, ellipsis: true, lineBreak: false });
        y += 14;
        doc.font('Helvetica').fontSize(8).fillColor(T.ink);
        for (const line of [person.position, person.phone, person.email].filter((v): v is string => !!v)) {
          doc.text(line, x, y, { width: w, height: lineH, ellipsis: true, lineBreak: false });
          y += lineH;
        }
        doc.font(person.at ? 'Helvetica' : 'Helvetica-Oblique').fillColor(person.at ? T.ink : T.muted);
        doc.text(person.at ? formatDateTime(person.at) : 'Pending', x, y, { width: w, height: lineH, ellipsis: true, lineBreak: false });
      } else {
        doc.font('Helvetica-Oblique').fontSize(9).fillColor(T.muted);
        doc.text('Pending', x, y, { width: w, lineBreak: false });
      }
    });
    doc.y = top + rowHeightOf(row);
  }
  doc.x = L.left;
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

  if (T.name === 'quote') {
    paginateQuote(doc, spec, company, range, strapline);
    return;
  }

  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);

    // The footer deliberately sits BELOW the bottom margin. PDFKit treats any
    // text past that margin as overflow and helpfully starts a new page, which
    // would then need its own footer, and so on. Dropping the margin for the
    // duration of the write is the documented way to stop that; without it a
    // two-page document silently becomes six.
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    const right = doc.page.width - T.left;
    const top = doc.page.height - FOOTER_TOP + 8;

    doc.moveTo(T.left, top - 8).lineTo(right, top - 8).strokeColor(T.rule).lineWidth(0.7).stroke();

    const colTwo = T.left + 226;
    const colThree = T.left + 390;
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
      doc.font(n === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5).fillColor(n === 0 ? T.ink : T.muted);
      doc.text(text, T.left, top + n * line, oneLine(colTwo - T.left - 8));
    });

    doc.font('Helvetica').fontSize(7.5).fillColor(T.muted);
    reach.forEach((text, n) => {
      doc.text(text, colTwo, top + n * line, oneLine(colThree - colTwo - 8));
    });

    ids.forEach(([label, value], n) => {
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(T.ink);
      doc.text(label, colThree, top + n * line, { lineBreak: false, continued: true });
      doc.font('Helvetica').fillColor(T.muted).text(` ${value}`, { lineBreak: false });
    });

    // Only when there is more than one page: "Page 1 of 1" is noise. Top
    // right of the block, on the TIN's row, so the rows below stay free for a
    // module's note to wrap into.
    if (range.count > 1) {
      doc.font('Helvetica').fontSize(7.5).fillColor(T.muted);
      doc.text(`Page ${i + 1} of ${range.count}`, right - 60, top, {
        width: 60,
        align: 'right',
        lineBreak: false,
      });
    }

    if (spec.footerNote) {
      // Wraps down the third column as far as the strapline row, then stops.
      const noteTop = top + ids.length * line;
      doc.font('Helvetica').fontSize(7.5).fillColor(T.muted);
      doc.text(spec.footerNote, colThree, noteTop, {
        width: right - colThree,
        // A point of slack, or float rounding cuts the last line it has room for.
        height: baseRow + line - noteTop + 1,
        ellipsis: true,
        lineGap: line - doc.currentLineHeight(),
      });
    }

    if (strapline) {
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(T.barStrong);
      doc.text(strapline, T.left, baseRow, {
        ...oneLine(colThree - T.left - 8),
        characterSpacing: 0.8,
      });
    }

    doc.page.margins.bottom = bottomMargin;
  }
  // Leave the cursor on the last page so nothing is appended to page 1.
  doc.switchToPage(range.start + range.count - 1);
}

/**
 * The quotation's foot on every page: a light rule, the strapline centred in
 * green capitals, "Page n of m" bottom right (only when there is more than one
 * page), a module's footer note small above the rule; and on page two onward
 * a running header — the reference, the document and its number, the date.
 */
function paginateQuote(
  doc: PDFKit.PDFDocument,
  spec: PdfDocumentSpec,
  company: Company,
  range: { start: number; count: number },
  strapline: string,
) {
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const left = T.left;
    const right = doc.page.width - T.right;
    const width = right - left;
    const ruleY = doc.page.height - 57.4;

    doc.moveTo(left, ruleY).lineTo(right, ruleY).strokeColor(T.rule).lineWidth(0.75).stroke();
    if (strapline) {
      let size = 14;
      doc.font('Helvetica-Bold');
      while (size > 8 && doc.fontSize(size).widthOfString(strapline.toUpperCase(), { characterSpacing: 1.5 }) > width) size -= 0.5;
      doc.fontSize(size).fillColor(T.accent2);
      doc.text(strapline.toUpperCase(), left, ruleY + 12.4, { width, align: 'center', characterSpacing: 1.5, lineBreak: false });
    }
    doc.font('Helvetica').fontSize(7.5).fillColor(T.muted);
    if (range.count > 1) {
      doc.text(`Page ${i + 1} of ${range.count}`, right - 60, ruleY + 32.4, { width: 60, align: 'right', lineBreak: false });
    }
    if (spec.footerNote) {
      doc.font('Helvetica').fontSize(7).fillColor(T.muted);
      doc.text(spec.footerNote, left, ruleY - 10, { width: width - 70, height: 9, ellipsis: true, lineBreak: false });
    }
    if (i > 0) {
      const parts = [spec.reference, spec.documentNumber ? `${spec.title} # ${spec.documentNumber}` : spec.title, formatDate(spec.date ?? new Date())].filter(Boolean);
      doc.font('Helvetica').fontSize(8).fillColor(T.muted);
      doc.text(parts.join('   ·   '), left, 22, { width, align: 'center', height: 10, ellipsis: true, lineBreak: false });
    }
    doc.page.margins.bottom = bottomMargin;
  }
  void company;
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
