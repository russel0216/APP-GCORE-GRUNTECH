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
 * ONE dress (2026-10-10, the owner's call: every document in the quotation
 * template's dress, matched to the designed quotation). The quotation and
 * the sales order are laid out by an administrator (Admin › PDF Templates)
 * and print through `renderDesigned` in `pdfDesign.ts`, the engine's other
 * door; everything else prints through `renderDocument` below, which draws
 * the SAME letterhead, table, totals, sign-offs, strapline, running header
 * and page number that `STANDARD_QUOTATION_DESIGN` (quotationTemplate.ts)
 * draws through that engine — the metrics here are copied from there, so a
 * job order reads like the quotation it follows. The helpers (`pdfSafe`, the
 * formatters) are shared between the two.
 */

interface PdfField {
  label: string;
  value: string;
}

/**
 * A table cell: plain text, or a bold title with regular text under it — the
 * way a quotation line prints its product title above its description.
 */
export type PdfCell = string | { title: string; body?: string };

/**
 * A table row: its cells, or a subheading between the lines — 9.5pt green on
 * white, wrapped inside the table's leading column(s) (`headingSpan`) and
 * ruled only as far as they reach, exactly as the designed quotation sets a
 * group apart from the products under it. Nothing is shaded: the one dress
 * has no tinted rows.
 */
export type PdfRow = PdfCell[] | { heading: string };

export interface PdfTotal {
  label: string;
  value: string;
  bold?: boolean;
}

/** One bar of a `gantt` section: a task on working days `start` … `start + days − 1`. */
interface PdfGanttTask {
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
  | { kind: 'fields'; title?: string; columns?: 2 | 3; fields: PdfField[] }
  | {
      kind: 'table';
      title?: string;
      head: string[];
      rows: PdfRow[];
      widths?: number[];
      align?: ('left' | 'right' | 'center')[];
      /**
       * How many leading columns a `{ heading }` row occupies: it wraps inside
       * them and its rule reaches their right edge (the designed table's
       * product column). 1 unless the first column is narrow — the costing's
       * "No." — in which case the heading takes the item column too.
       */
      headingSpan?: number;
    }
  | { kind: 'text'; title?: string; body: string }
  /**
   * The money block: label and figure on ruled rows in a box at the right,
   * the bold row the total — larger, in the accent colour, over a heavier
   * rule. The ONE way a document prints its money; never a two-column table.
   */
  | { kind: 'totals'; rows: PdfTotal[] }
  /**
   * A schedule drawn as bars against numbered working days: Task, Start, End,
   * Days, then the day grid. `landscape` starts it on a landscape page (and
   * keeps its overflow pages landscape), for the width a long plan needs.
   */
  | { kind: 'gantt'; title?: string; groups: PdfGanttGroup[]; landscape?: boolean; legend?: string };

export interface Signatory {
  role: string;
  name?: string;
  /** Kept on the record; the dress does not print it (the designed quotation's `showPosition: false`). */
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
  /** How to reach them, printed under the name: a reader calls the person who prepared it. */
  phone?: string;
  email?: string;
}

export interface PdfDocumentSpec {
  title: string;
  documentNumber?: string;
  revision?: string;
  date?: Date;
  /** Customer / project reference, printed in the details under the letterhead and in the running header. */
  reference?: string;
  sections: PdfSection[];
  signatories?: Signatory[];
  /** Small print above the footer rule. */
  footerNote?: string;
}

// ── The dress ─────────────────────────────────────────────────────────────────
//
// Mirrored from STANDARD_QUOTATION_DESIGN (shared/quotationTemplate.ts) and
// the way renderDesigned draws it (shared/pdfDesign.ts). Not imported from
// there: quotationTemplate imports pdfDesign, which imports this file, and a
// constant read through that cycle at module load would be undefined.

/** The template's colours. */
const PURPLE = '#5B2A8C';
const GREEN = '#2E9A4B';
const INK = '#222222';
const GREY = '#666666';
const RULE = '#D9D9D9';
/** A line's description under its title. */
const BODY = '#555555';
/** A phase's row on a schedule (the Gantt appendix only — no table row is ever shaded). */
const PHASE_BAND = '#F3EFF7';
/** A task's bar on a schedule: the purple, lightened. */
const BAR = '#D9CCE6';

/** Helvetica's line height: (ascender + line gap − descender) / 1000, as PDFKit sets a line. */
const LINE = 1.156;
/**
 * Helvetica-Bold's own is 1.19 (its bounding box is taller). The designed
 * engine sets every line at LINE whatever the weight; PDFKit's wrapping does
 * not, so a bold run it wraps is given this (negative) line gap to land on
 * the same metric — a two-line product title is then exactly as tall here.
 */
const BOLD_LINE = 1.19;
const boldGap = (size: number) => size * (LINE - BOLD_LINE);

/**
 * The page's measurements, named once (the template's: 36pt margins, body
 * 9pt, the content stopping 81pt above the foot, continuation pages from
 * 50pt — under the running header).
 */
const T = {
  left: 36,
  right: 36,
  /** Body text size. */
  size: 9,
  /** Where continuation pages start. */
  flowTop: 50,
  /** Where the content stops on every page, measured up from the bottom edge. */
  flowBottomUp: 81,
  /** Table cells: padding to the side, above the text, and what a row adds to its tallest cell. */
  padX: 7,
  padTop: 10,
  padRow: 20,
  /** The sign-off block keeps its BOTTOM edge this far above the foot (the template's 714 + 60 on A4). */
  signoffBottomUp: 67.89,
} as const;

const usableWidth = (doc: PDFKit.PDFDocument) => doc.page.width - T.left - T.right;
const contentBottom = (doc: PDFKit.PDFDocument) => doc.page.height - T.flowBottomUp;

/** A section that stands on landscape pages of its own after the signed body: the Gantt chart. */
const isAppendix = (s: PdfSection) => s.kind === 'gantt' && !!s.landscape;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const isHeading = (row: PdfRow): row is { heading: string } => !Array.isArray(row);

export async function renderDocument(input: PdfDocumentSpec): Promise<Buffer> {
  // Everything that reaches the page goes through pdfSafe first: the module's
  // content AND the company's own details, which an administrator types freely
  // into Settings and which print on every page of every document.
  const spec = safeSpec(input);
  const row = await prisma.company.findUnique({ where: { id: 'company' } });
  const company = row && safeCompany(row);
  const doc = new PDFDocument({
    size: 'A4',
    // PDFKit's own page limit is the content's: a paragraph it wraps breaks
    // where the table would. Only the sign-offs and the page furniture sit
    // lower, and they drop the bottom margin while they draw.
    margins: { top: T.flowTop, bottom: T.flowBottomUp, left: T.left, right: T.right },
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

  drawLetterhead(doc, spec, company);
  // A landscape section at the end is an APPENDIX (the costing's Scope of
  // Work, 2026-10-09): the sign-offs print before it, on the last portrait
  // page of the body, and the chart gets pages of its own after them. Drawn
  // after everything, the sign-offs spilled onto a near-empty portrait page
  // behind the chart whenever its legend ran low.
  const sections = spec.sections;
  let appendixFrom = sections.length;
  while (appendixFrom > 0 && isAppendix(sections[appendixFrom - 1])) appendixFrom--;
  for (const section of sections.slice(0, appendixFrom)) drawSection(doc, section);
  drawSignoffs(doc, spec);
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
  ' ': ' ', // no-break space
  ' ': ' ', // figure space
  ' ': ' ', // thin space
  ' ': ' ', // narrow no-break space (Intl puts these in dates and money)
  '​': '', // zero-width space
  '﻿': '', // byte-order mark, pasted in from exported CSV
  '‐': '-', // hyphen
  '‑': '-', // non-breaking hyphen
  '−': '-', // minus sign
  'μ': 'µ', // Greek mu as the micro sign, which Latin-1 has: "0.1 µm" (SCORO's line texts carry it)
  '≤': '<=',
  '≥': '>=',
  '→': '->',
  '←': '<-',
  '✓': 'x',
  '✔': 'x',
  '✕': 'x',
  '✖': 'x',
};

/**
 * Text as a standard PDF font can print it. Every string renderDocument puts
 * on a page passes through here, so a module never has to remember to.
 */
/**
 * Capitals for the page. Upper-casing after `pdfSafe` can leave WinAnsi:
 * 'µ' (a micron on a filter spec) becomes U+039C, GREEK CAPITAL MU. So every
 * run the dress sets in capitals goes through here — capitals first, the
 * micron kept, then `pdfSafe` once more.
 */
function caps(text: string): string {
  return pdfSafe(text.toUpperCase().replace(/\u039c/g, 'µ'));
}

export function pdfSafe(text: string): string {
  if (!text) return text;
  let out = text.replace(/₱\s*/g, 'PHP ');
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
    case 'text':
      return { ...section, title: t(section.title), body: pdfSafe(section.body) };
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
            ? { heading: pdfSafe(r.heading ?? '') }
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

/**
 * "https://www.gruntechnology.com/" -> "www.gruntechnology.com", as the
 * letterhead prints it ("Website: www.…") and as the strapline falls back to
 * it (uppercased on the page, with the rest of the strapline) when no tagline
 * is set.
 */
export function websiteForPrint(website?: string | null): string {
  if (!website) return '';
  return website
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}

/**
 * The strapline along the foot of every page: the company's tagline, OR its
 * website when there is no tagline — never both (the designed quotation's
 * `company.strapline`). Empty when the company has neither.
 */
function strapline(company: Company): string {
  return company?.documentTagline?.trim() || websiteForPrint(company?.website);
}

/**
 * The letterhead's lines under the company name, by the designed rule for
 * template text: a line is parts separated by " | ", a part whose fields are
 * all empty drops out, and a line with nothing left drops out with them — so
 * an unset TIN never prints as a bare "TIN:".
 */
function letterheadLines(company: Company): string[] {
  const part = (label: string, value?: string | null) => (value?.trim() ? `${label}${value.trim()}` : '');
  const line = (parts: string[]) => parts.filter(Boolean).join(' | ');
  return [
    [company?.address, company?.city].filter((v) => v?.trim()).join(', '),
    line([part('Tel No.: ', company?.phone), part('Fax No.: ', company?.fax), part('Email: ', company?.email)]),
    part('Website: ', websiteForPrint(company?.website)),
    line([part('TIN: ', company?.tin), part('REG NO: ', company?.regNo)]),
  ].filter((l) => l.trim());
}

/** The DETAILS block's line: bold 9.5 on 4pt of lead (the template's `lineGap: 4`). */
const DETAIL_SIZE = 9.5;
const DETAIL_LINE = DETAIL_SIZE * LINE + 4;
/**
 * PDFKit sets a bold line at BOLD_LINE; this gap lands it on DETAIL_LINE, so
 * a wrapped detail or field is set at the template's 14.98pt pitch.
 */
const DETAIL_GAP = 4 + boldGap(DETAIL_SIZE);

/**
 * The letterhead, as the quotation template places it — every box at the
 * template's own coordinates, pushed down by the same rule the designed
 * engine applies when a box above it grows:
 *
 *   the logo top-left (72×72 at the margin); the registered name in purple
 *   capitals beside it (15pt, shrunk to fit) with its details under that in
 *   7.5pt on 2.5pt of lead; the document's name in 24pt purple top-right,
 *   wrapping inside its 185pt box as the template's title box would (never
 *   shrunk, unless a single word is wider than the box), and "# number R1"
 *   in green 8pt under it; the green rule at 114.25, lower by exactly what
 *   the details or the title grew; then DETAILS — the heading 22.75 under
 *   the rule, the date and the reference in bold 9.5 lines 22 under it.
 */
function drawLetterhead(doc: PDFKit.PDFDocument, spec: PdfDocumentSpec, company: Company) {
  const left = T.left;
  const right = doc.page.width - T.right;
  const top = 30;
  const logoW = 72;
  const textX = left + logoW + 9; // 117
  const textW = 255;
  const titleW = 185;
  const titleX = right - titleW;
  /** The template's title box (y 26, h 28) and number box (y 62, h 12): the number hangs 8 under the title, the rule 40.25 under the number. */
  const titleTop = top - 4;
  const titleBoxH = 28;

  if (company?.logoPath && fs.existsSync(company.logoPath)) {
    try {
      doc.image(company.logoPath, left, top, { fit: [logoW, logoW] });
    } catch {
      /* a broken logo must never stop a document printing */
    }
  }

  // The registered name, else the trading name; shrunk to fit its box
  // rather than wrapped, to 60% at most, as the designed box does.
  const name = caps(company?.legalName?.trim() || company?.name || '');
  if (name) {
    let size = 15;
    doc.font('Helvetica-Bold');
    while (size > 9 && doc.fontSize(size).widthOfString(name) > textW) size -= 0.25;
    doc.fontSize(size).fillColor(PURPLE).text(name, textX, top + 7, { width: textW, lineBreak: false });
  }
  doc.font('Helvetica').fontSize(7.5).fillColor(INK);
  const linesTop = top + 27.5;
  let y = linesTop;
  const lines = letterheadLines(company);
  for (const line of lines) {
    doc.text(line, textX, y, { width: textW, lineGap: 2.5 });
    y = doc.y;
  }
  // PDFKit adds the lead after the last line too; the template's box ends at
  // the last line's bottom, and is never shorter than it was drawn (42pt).
  const linesBottom = linesTop + Math.max(42, lines.length ? y - 2.5 - linesTop : 0);

  // The document's name: 24pt regular, wrapped inside its box as the
  // template's title box would wrap it — "MATERIAL COST" over "ESTIMATE" —
  // and shrunk (to 13pt at the least) only when even that will not do: a
  // single word wider than the box, or a name that would run to a third line.
  const title = caps(spec.title);
  let size = 24;
  let titleLines = wrapText(doc, title, titleW, false, size);
  while (size > 13 && (titleLines.length > 2 || titleLines.some((l) => doc.widthOfString(l) > titleW))) {
    size -= 1;
    titleLines = wrapText(doc, title, titleW, false, size);
  }
  titleLines.forEach((line, n) => drawLine(doc, line, titleX, titleTop + (24 - size) / 2 + n * size * LINE, titleW, 'right', false, size, PURPLE));
  // What the title grew by pushes the number and the rule down with it, the
  // designed engine's rule for a box under a box that grew.
  const titleExtra = Math.max(0, titleLines.length * size * LINE - titleBoxH);
  if (spec.documentNumber) {
    const rev = spec.revision ? ` ${/^\d+$/.test(spec.revision) ? `R${spec.revision}` : spec.revision}` : '';
    doc.font('Helvetica-Bold').fontSize(10).fillColor(GREEN);
    doc.text(`# ${spec.documentNumber}${rev}`, titleX, top + 32 + titleExtra, { width: titleW, align: 'right', lineBreak: false });
  }

  // The rule under the letterhead: 14.75 under the company's details and
  // 40.25 under the number — whichever of the two pushed it lower.
  const ruleY = Math.max(114.25 + titleExtra, linesBottom + 14.75);
  doc.moveTo(left, ruleY + 0.75).lineTo(right, ruleY + 0.75).strokeColor(GREEN).lineWidth(1.5).stroke();

  // DETAILS: the heading 22.75 under the rule (137 on the template), its
  // lines 22 under that (159) — the date, then the reference.
  doc.y = ruleY + 22.75 - 10;
  sectionTitle(doc, 'Details', DETAIL_LINE);
  const detailsTop = doc.y;
  const meta: [string, string][] = [['Date', formatShortDate(spec.date ?? new Date())]];
  if (spec.reference) meta.push(['Reference', spec.reference]);
  doc.font('Helvetica-Bold').fontSize(DETAIL_SIZE).fillColor(INK);
  for (const [label, value] of meta) {
    doc.text(`${label}: ${value}`, left, doc.y, { width: right - left, lineGap: DETAIL_GAP });
  }
  // The template's details box is 41pt, taller when its lines are, and the
  // line table hangs 23 under it: an untitled table starts exactly there.
  doc.x = left;
  // The template's DETAILS box is 41pt whatever it holds, so every document's
  // first table starts where the quotation's does.
  doc.y = detailsTop + Math.max(41, doc.y - detailsTop) + 23;
}

/**
 * A section's title: 8.5pt bold purple capitals, as CUSTOMER / DETAILS head
 * the quotation's blocks — 10pt under what came before, its content 22pt
 * under its top (the template's 137 → 159). `needed` is the height of what
 * follows it (a table's head and first row, a line of text), so the title
 * goes over to the next page WITH its content rather than ending a page alone.
 */
function sectionTitle(doc: PDFKit.PDFDocument, title?: string, needed = 0) {
  if (!title) return;
  ensureSpace(doc, 10 + 22 + needed);
  doc.y += 10;
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(PURPLE).text(caps(title), T.left, doc.y, { lineBreak: false });
  doc.y += 22;
}

/** A light hairline across the table's width at `y`. */
function hairline(doc: PDFKit.PDFDocument, y: number, width: number, weight = 0.75, color = RULE) {
  doc.moveTo(T.left, y).lineTo(T.left + width, y).strokeColor(color).lineWidth(weight).stroke();
}

function drawSection(doc: PDFKit.PDFDocument, section: PdfSection) {
  switch (section.kind) {
    case 'text': {
      // The title goes over with the first line of its text; PDFKit carries
      // the rest over itself, page by page, as the designed terms box runs on.
      const line = T.size * LINE + 1;
      sectionTitle(doc, section.title, line);
      ensureSpace(doc, line);
      doc.font('Helvetica').fontSize(T.size).fillColor(INK);
      doc.text(section.body, T.left, doc.y, { width: usableWidth(doc), lineGap: 1 });
      doc.x = T.left;
      doc.y += 4;
      return;
    }

    case 'totals': {
      // The designed totals box: 231.8 wide against the right margin, the
      // labels on the left of it (129.6), the figures right-aligned, a light
      // rule under each row; the bold row — the total — 11pt purple over a
      // 2pt purple rule. 18pt below whatever came before, as it hangs 18pt
      // under the line table on the template.
      //
      // Each row is MEASURED first: a figure never wraps (PDFKit wraps a box
      // given a width whatever `lineBreak` says, and "PHP" over a second line
      // "123,456,789.00" is not a total), and a label longer than its box —
      // "Margin (33.333333% of the price)" — takes the room the figure leaves
      // and, failing that, wraps inside it and makes the row taller.
      const width = usableWidth(doc);
      const boxW = Math.min(231.8, width);
      const labelW = 129.6;
      const x = T.left + width - boxW;
      const rows = section.rows.map((r) => {
        const size = r.bold ? T.size + 2 : T.size;
        const base = r.bold ? 30 : 24.5;
        doc.font(r.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
        const valueW = doc.widthOfString(r.value);
        const room = boxW - T.padX * 2 - valueW - 6;
        const labelLines =
          doc.widthOfString(r.label) <= Math.max(labelW - T.padX, room) ? [r.label] : wrapText(doc, r.label, Math.max(room, 40), !!r.bold, size);
        return { ...r, size, valueW, labelLines, height: base + (labelLines.length - 1) * size * LINE, textY: (base - size) / 2 };
      });
      // 13 under the 5 the table leaves: the template hangs its totals 18pt
      // under the line table.
      const lead = 13;
      // The block goes over whole: a total on a page of its own, away from
      // the subtotal and the tax it adds up, reads as a different figure.
      const height = sum(rows.map((r) => r.height));
      if (doc.y + lead + height > contentBottom(doc)) doc.addPage();
      let y = doc.y + lead;
      for (const r of rows) {
        const ink = r.bold ? PURPLE : INK;
        doc.font(r.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(r.size).fillColor(ink);
        r.labelLines.forEach((line, n) => {
          doc.text(line, x + T.padX, y + r.textY + n * r.size * LINE, { lineBreak: false });
        });
        doc.text(r.value, x + boxW - T.padX - r.valueW, y + r.textY, { lineBreak: false });
        y += r.height;
        doc.moveTo(x, y).lineTo(x + boxW, y).strokeColor(r.bold ? PURPLE : RULE).lineWidth(r.bold ? 2 : 0.75).stroke();
      }
      doc.x = T.left;
      doc.y = y + 6;
      return;
    }

    case 'gantt':
      drawGantt(doc, section);
      return;

    case 'fields': {
      // Each field is a DETAILS line — "Label: value" in bold 9.5 on 4pt of
      // lead, the template's own style for Date / Payment Terms / PR Number —
      // in a grid of two or three columns.
      sectionTitle(doc, section.title, DETAIL_LINE);
      const cols = section.columns ?? 2;
      const colWidth = usableWidth(doc) / cols;
      let col = 0;
      let rowTop = doc.y;
      let rowHeight = 0;

      for (const field of section.fields) {
        if (col === 0) {
          ensureSpace(doc, DETAIL_LINE);
          rowTop = doc.y;
          rowHeight = 0;
        }
        const x = T.left + col * colWidth;
        doc.font('Helvetica-Bold').fontSize(DETAIL_SIZE).fillColor(INK);
        doc.text(`${field.label}: ${field.value || '—'}`, x, rowTop, { width: colWidth - 10, lineGap: DETAIL_GAP });
        rowHeight = Math.max(rowHeight, doc.y - rowTop);
        col = (col + 1) % cols;
        doc.y = col === 0 ? rowTop + rowHeight : rowTop;
      }
      if (col !== 0) doc.y = rowTop + rowHeight;
      doc.x = T.left;
      return;
    }

    case 'table': {
      const usable = usableWidth(doc);
      const widths =
        section.widths && section.widths.length === section.head.length
          ? normalise(section.widths, usable)
          : section.head.map(() => usable / section.head.length);
      const align = section.align ?? section.head.map(() => 'left' as const);
      const head = tableHead(doc, section.head, widths);
      // The title goes over with the head and a one-line row, never alone.
      sectionTitle(doc, section.title, head.height + T.size * LINE + T.padRow);
      drawTable(doc, section, head, widths, align);
      doc.x = T.left;
      doc.y += 5;
      return;
    }
  }
}

/** The last working day a plan reaches. */
function ganttEnd(groups: PdfGanttGroup[]): number {
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
 * row with a purple bar over the span of its tasks, each task a row with a
 * light bar labelled with its length. Days are numbered working days, not
 * dates — a costing is priced before anybody knows the start date.
 */
function drawGantt(
  doc: PDFKit.PDFDocument,
  section: { title?: string; groups: PdfGanttGroup[]; landscape?: boolean; legend?: string },
) {
  const newPage = () => {
    if (section.landscape) doc.addPage({ size: 'A4', layout: 'landscape', margins: doc.page.margins });
    else doc.addPage();
  };
  if (section.landscape) newPage();
  // The title goes over with the day head and a phase row, never alone.
  sectionTitle(doc, section.title, 20 + 17 + 18);

  const usable = usableWidth(doc);
  const colTask = Math.max(150, usable * 0.24);
  const colStart = 40;
  const colEnd = 40;
  const colDays = 30;
  const fixed = colTask + colStart + colEnd + colDays;
  const gridX = T.left + fixed;
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
    // Purple capitals on white over one rule, as the table head.
    doc.fillColor(PURPLE).font('Helvetica-Bold').fontSize(7.5);
    const cells: [string, number, number, 'left' | 'right'][] = [
      ['TASK', T.left, colTask, 'left'],
      ['START', T.left + colTask, colStart, 'left'],
      ['END', T.left + colTask + colStart, colEnd, 'left'],
      ['DAYS', T.left + colTask + colStart + colEnd, colDays, 'right'],
    ];
    for (const [text, x, w, align] of cells) {
      doc.text(text, x + 5, top + 7, { width: w - 10, align, lineBreak: false });
    }
    doc.font('Helvetica').fontSize(6.5);
    for (let day = 1; day <= total; day += step) {
      doc.text(`Day ${day}`, dayX(day) + 1.5, top + 7.5, { width: Math.max(step * dayW - 2, 10), lineBreak: false });
    }
    hairline(doc, top + height, usable);
    doc.y = top + height;
  };

  const gridLines = (top: number, height: number) => {
    for (let day = 1; day <= total; day += step) {
      doc.moveTo(dayX(day), top).lineTo(dayX(day), top + height).strokeColor(RULE).lineWidth(0.4).stroke();
    }
    hairline(doc, top + height, usable, 0.5);
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
    doc.rect(T.left, gTop, usable, groupH).fill(PHASE_BAND);
    doc.font('Helvetica-Bold').fontSize(size).fillColor(INK);
    doc.text(group.name, T.left + 5, gTop + 5, { width: colTask - 10, height: size + 2, ellipsis: true, lineGap: 0 });
    // The phase's own span — over its tasks, or its planned days when it has
    // none (a costing phased without tasks still has a schedule to show).
    const span = groupSpan(group);
    if (span) {
      doc.font('Helvetica-Bold').fontSize(size).fillColor(INK);
      doc.text(`Day ${span.from}`, T.left + colTask + 5, gTop + 5, { width: colStart - 10, lineBreak: false });
      doc.text(`Day ${span.to}`, T.left + colTask + colStart + 5, gTop + 5, { width: colEnd - 10, lineBreak: false });
      doc.text(String(span.to - span.from + 1), T.left + colTask + colStart + colEnd + 5, gTop + 5, {
        width: colDays - 10,
        align: 'right',
        lineBreak: false,
      });
      doc.roundedRect(dayX(span.from), gTop + 6, (span.to - span.from + 1) * dayW, 5, 2).fill(PURPLE);
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
      doc.font('Helvetica').fontSize(size).fillColor(INK);
      doc.text(task.name, T.left + 14, top + 4, { width: colTask - 20 });
      const mid = top + rowH / 2 - size / 2 + 0.5;
      doc.text(`Day ${task.start}`, T.left + colTask + 5, mid, { width: colStart - 10, lineBreak: false });
      doc.text(`Day ${end}`, T.left + colTask + colStart + 5, mid, { width: colEnd - 10, lineBreak: false });
      doc.text(String(task.days), T.left + colTask + colStart + colEnd + 5, mid, {
        width: colDays - 10,
        align: 'right',
        lineBreak: false,
      });
      const barW = Math.max(task.days, 1) * dayW;
      doc.roundedRect(dayX(task.start) + 0.5, top + rowH / 2 - 5, Math.max(barW - 1, 2), 10, 2).fill(BAR);
      const label = `${task.days}d`;
      doc.font('Helvetica').fontSize(6.5).fillColor(INK);
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
    doc.rect(T.left, y + 1, 9, 6).fill(BAR);
    doc.font('Helvetica').fontSize(7.5).fillColor(GREY).text(section.legend, T.left + 14, y, { width: usable - 14 });
  }
  doc.x = T.left;
  doc.y += 6;
}

function normalise(widths: number[], usable: number): number[] {
  const total = widths.reduce((a, b) => a + b, 0);
  return widths.map((w) => (w / total) * usable);
}

// ── Lines of text, laid out the way the designed engine lays them ─────────────
//
// The table never lets PDFKit wrap: it would break a page of its own accord
// in the middle of a cell, set a bold line taller than a regular one, and
// break words by different rules from the layout the quotation prints with.
// Every line is measured and drawn here, one `text` call with no width and no
// line break, so a row is exactly as tall here as on the designed quotation.

type Align = 'left' | 'right' | 'center';

/**
 * Text wrapped to a width — the designed engine's rule (`wrap` in
 * pdfDesign.ts): words are kept whole unless one is wider than the box on its
 * own, a wrapped line drops the spaces it broke at, and a newline in the text
 * is a line of its own.
 */
function wrapText(doc: PDFKit.PDFDocument, text: string, width: number, bold: boolean, size: number): string[] {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
  const w = (t: string) => doc.widthOfString(t);
  const out: string[] = [];
  for (const source of (text ?? '').split(/\r?\n/)) {
    let cur = '';
    let curW = 0;
    const flush = () => {
      out.push(cur.replace(/\s+$/, ''));
      cur = '';
      curW = 0;
    };
    for (const tok of source.split(/(\s+)/)) {
      if (!tok) continue;
      if (/^\s+$/.test(tok)) {
        if (cur) {
          const space = tok.replace(/\s/g, ' ');
          cur += space;
          curW += w(space);
        }
        continue;
      }
      const tw = w(tok);
      if (curW + tw <= width + 0.01) {
        cur += tok;
        curW += tw;
        continue;
      }
      if (cur.trim()) flush();
      // A word wider than the box on its own is broken where it has to be.
      let rest = tok;
      while (w(rest) > width && rest.length > 1) {
        let n = rest.length - 1;
        while (n > 1 && w(rest.slice(0, n)) > width) n--;
        cur = rest.slice(0, n);
        flush();
        rest = rest.slice(n);
      }
      cur = rest;
      curW = w(rest);
    }
    flush();
  }
  return out;
}

/** One line at (x, y), aligned inside `width`, never wrapped and never breaking a page. */
function drawLine(doc: PDFKit.PDFDocument, text: string, x: number, y: number, width: number, align: Align, bold: boolean, size: number, color: string) {
  if (!text.trim()) return;
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color);
  const tw = doc.widthOfString(text);
  const cx = align === 'right' ? x + width - tw : align === 'center' ? x + (width - tw) / 2 : x;
  doc.text(text, cx, y, { lineBreak: false });
}

interface CellLine {
  text: string;
  bold: boolean;
  color: string;
  /** Lead over this line: 2pt between a title and the description under it. */
  gap: number;
}

/** A cell as lines: the title in bold over the description, or plain text. */
function cellLines(doc: PDFKit.PDFDocument, cell: PdfCell | undefined, width: number): CellLine[] {
  if (cell === undefined || cell === null) return [];
  if (typeof cell === 'object') {
    const title = cell.title ? wrapText(doc, cell.title, width, true, T.size).map((text) => ({ text, bold: true, color: INK, gap: 0 })) : [];
    const body = cell.body
      ? wrapText(doc, cell.body, width, false, T.size).map((text, i) => ({ text, bold: false, color: BODY, gap: i === 0 && cell.title ? 2 : 0 }))
      : [];
    return [...title, ...body];
  }
  return wrapText(doc, String(cell), width, false, T.size).map((text) => ({ text, bold: false, color: INK, gap: 0 }));
}

interface TableHead {
  lines: string[][];
  height: number;
}

/**
 * The table head as the designed line table sets it: 8.5pt bold purple
 * capitals on white, text 11pt down, the band at least 30pt (taller when a
 * label wraps), and ONE rule — under it.
 */
function tableHead(doc: PDFKit.PDFDocument, head: string[], widths: number[]): TableHead {
  const size = T.size - 0.5;
  const lines = head.map((cell, i) => wrapText(doc, caps(cell), widths[i] - T.padX * 2, true, size));
  const height = Math.max(30, Math.max(...lines.map((l) => l.length)) * size * LINE + 20);
  return { lines, height };
}

function drawTableHead(doc: PDFKit.PDFDocument, head: TableHead, widths: number[], align: Align[]) {
  const size = T.size - 0.5;
  const top = doc.y;
  let x = T.left;
  head.lines.forEach((lines, i) => {
    lines.forEach((line, n) => drawLine(doc, line, x + T.padX, top + 11 + n * size * LINE, widths[i] - T.padX * 2, align[i], true, size, PURPLE));
    x += widths[i];
  });
  hairline(doc, top + head.height, sum(widths));
  doc.y = top + head.height;
}

/**
 * The rows under the head, the head repeated on every page they reach — the
 * designed engine's `table()`, line for line. A subheading goes over with the
 * line it heads (stranded at the foot of a page, with its figures on the
 * next, it reads as a line with no price); a row that fits on a page goes
 * over whole; only a row taller than a whole page is split, its lines
 * carried on under a fresh head rather than cut off or drawn off the page.
 */
function drawTable(
  doc: PDFKit.PDFDocument,
  section: { rows: PdfRow[]; headingSpan?: number },
  head: TableHead,
  widths: number[],
  align: Align[],
) {
  const total = sum(widths);
  const span = Math.min(widths.length, Math.max(1, Math.round(section.headingSpan ?? 1)));
  const headingWidth = sum(widths.slice(0, span));
  const lh = T.size * LINE;
  const subSize = T.size + 0.5;
  const cellHeight = (lines: CellLine[]) => lines.reduce((n, l) => n + l.gap + lh, 0);
  const rowCells = (row: PdfCell[]) => row.map((cell, i) => cellLines(doc, cell, widths[i] - T.padX * 2));
  const nextPage = () => {
    doc.addPage();
    drawTableHead(doc, head, widths, align);
  };

  if (doc.y + head.height + lh + T.padRow > contentBottom(doc)) doc.addPage();
  drawTableHead(doc, head, widths, align);
  // The room a row has on a page of its own, under the head.
  const fresh = contentBottom(doc) - T.flowTop - head.height;

  section.rows.forEach((row, i) => {
    const bottom = contentBottom(doc);
    if (isHeading(row)) {
      const lines = wrapText(doc, row.heading, headingWidth - T.padX * 2, false, subSize);
      const rowH = lines.length * subSize * LINE + T.padRow;
      const next = section.rows[i + 1];
      const keep = next && !isHeading(next) ? Math.min(Math.max(...rowCells(next).map(cellHeight), lh) + T.padRow, fresh - rowH) : 0;
      if (doc.y + rowH + keep > bottom) nextPage();
      const top = doc.y;
      lines.forEach((line, n) => drawLine(doc, line, T.left + T.padX, top + T.padTop + n * subSize * LINE, headingWidth - T.padX * 2, 'left', false, subSize, GREEN));
      hairline(doc, top + rowH, headingWidth);
      doc.y = top + rowH;
      return;
    }

    const cells = rowCells(row);
    const rowH = Math.max(lh, ...cells.map(cellHeight)) + T.padRow;
    if (doc.y + rowH > bottom && rowH <= fresh) nextPage();
    const queues = cells.map((lines) => [...lines]);
    for (let part = 0; ; part++) {
      const top = doc.y;
      const room = contentBottom(doc) - top - T.padRow;
      let used = 0;
      let x = T.left;
      widths.forEach((w, n) => {
        let at = top + T.padTop;
        let h = 0;
        // Past the first part the row is at the top of a fresh page, where a
        // line always goes down — so a cell can never stall the table.
        while (queues[n]?.length && (h + queues[n][0].gap + lh <= room || (part > 0 && h === 0))) {
          const l = queues[n].shift()!;
          at += l.gap;
          drawLine(doc, l.text, x + T.padX, at, w - T.padX * 2, align[n], l.bold, T.size, l.color);
          at += lh;
          h += l.gap + lh;
        }
        used = Math.max(used, h);
        x += w;
      });
      if (queues.every((q) => !q.length)) {
        const h = Math.max(used, lh) + T.padRow;
        hairline(doc, top + h, total);
        doc.y = top + h;
        break;
      }
      nextPage();
    }
  });
}

/**
 * Who did what, and when — the designed quotation's sign-off block: side by
 * side, one column a person, the role in purple capitals, the NAME in bold
 * 10pt, then 8pt lines of the contact number, the email and when they did
 * it — or "Pending" where nothing has happened, which is the truth rather
 * than a borrowed date. No position, no signature rules: these are approved
 * in the system and the record of that is the name and the timestamp.
 *
 * The block keeps its BOTTOM edge where the template puts it, above the
 * footer, and goes to a page of its own when the content reaches it. Four to
 * a row, the first column at the left margin and the last ending at the
 * right; more wrap to another row.
 */
function drawSignoffs(doc: PDFKit.PDFDocument, spec: PdfDocumentSpec) {
  const people = spec.signatories ?? [];
  if (!people.length) return;
  const usable = usableWidth(doc);
  const perRow = 4;
  const colWidth = 133;
  // The template's sign-off box is 60pt tall; the block is never shorter, so
  // a document with one-line roles starts its sign-offs where the quotation does.
  const minHeight = 60;
  const roleSize = 8.5;
  const nameSize = 10;
  const textSize = 8;
  /** The role, bold: a line is LINE tall, as the designed engine sets it. */
  const roleLine = roleSize * LINE;
  /** The name, bold, and the lines under it, regular: a point of lead each. */
  const nameLine = nameSize * LINE + 1;
  const textLine = textSize * LINE + 1;
  /** A role runs to two lines at most ("APPROVED BY — PROJECT MANAGER" in a quarter of the page), never a third. */
  const ROLE_MAX = 2;

  const rows: Signatory[][] = [];
  for (let i = 0; i < people.length; i += perRow) rows.push(people.slice(i, i + perRow));

  // The template's columns: the first at the left margin, the last ending
  // at the right, each at least colWidth wide.
  const columnsOf = (row: Signatory[]) => {
    const n = row.length;
    if (n <= 1) return [{ x: T.left, width: usable }];
    const colW = Math.min(colWidth, usable);
    const step = (usable - colW) / (n - 1);
    // Each column keeps a gutter before the next (four signatories put the
    // step under colWidth): the last takes colWidth, the others step less 8.
    return row.map((_, i) => ({ x: T.left + step * i, width: i === n - 1 ? colW : Math.min(colW, step - 8) }));
  };
  const lines = (text: string, width: number, line: number, gap: number) =>
    Math.max(1, Math.round(doc.heightOfString(text || ' ', { width, lineGap: gap }) / line));
  const linesOf = (person: Signatory, width: number) => {
    doc.font('Helvetica-Bold').fontSize(roleSize);
    const role = Math.min(ROLE_MAX, lines(caps(person.role), width, roleLine, boldGap(roleSize)));
    doc.font('Helvetica-Bold').fontSize(nameSize);
    const name = person.name ? lines(person.name, width, nameLine, boldGap(nameSize) + 1) : 0;
    const details = person.name
      ? [person.phone, person.email].filter((v): v is string => !!v?.trim()).concat(person.at ? formatDateTime(person.at) : 'Pending')
      : ['Pending'];
    doc.font('Helvetica').fontSize(textSize);
    const rest = details.map((t) => lines(t, width, textLine, 1));
    return { role, name, details, rest };
  };
  const heightOf = (person: Signatory, width: number) => {
    const { role, name, rest } = linesOf(person, width);
    return role * roleLine + 5 + name * nameLine + sum(rest) * textLine;
  };
  const rowHeights = rows.map((row) => {
    const cols = columnsOf(row);
    return Math.max(...row.map((p, i) => heightOf(p, cols[i].width)));
  });
  const gap = 10;
  const blockHeight = Math.max(minHeight, sum(rowHeights) + gap * (rows.length - 1));

  // A module's footer note prints just above the footer rule; the block
  // makes room for it rather than sit on it.
  const bottom = doc.page.height - T.signoffBottomUp - (spec.footerNote ? 11 : 0);
  const top = bottom - blockHeight;
  if (doc.y + 12 > top) doc.addPage();
  // A light rule over the block, as the template rules off its text before
  // the sign-offs — only where the content left room for it.
  if (doc.y + 14 <= top) hairline(doc, top - 10, usable);

  // The block sits below the content's bottom margin; PDFKit would start a
  // page for a line past it, so the margin is dropped while it draws.
  const bottomMargin = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  let rowTop = top;
  rows.forEach((row, r) => {
    const cols = columnsOf(row);
    row.forEach((person, i) => {
      const { x, width } = cols[i];
      const { role, name, details, rest } = linesOf(person, width);
      let y = rowTop;
      doc.font('Helvetica-Bold').fontSize(roleSize).fillColor(PURPLE);
      // The box is measured in PDFKit's own bold line height: that is what
      // its ellipsis rule reads, and a role of ROLE_MAX lines must pass it.
      doc.text(caps(person.role), x, y, { width, lineGap: boldGap(roleSize), height: ROLE_MAX * roleSize * BOLD_LINE + 1, ellipsis: true });
      y += role * roleLine + 5;
      if (person.name) {
        doc.font('Helvetica-Bold').fontSize(nameSize).fillColor(INK);
        doc.text(person.name, x, y, { width, lineGap: boldGap(nameSize) + 1 });
        y += name * nameLine;
      }
      doc.font('Helvetica').fontSize(textSize).fillColor(INK);
      details.forEach((line, n) => {
        doc.text(line, x, y, { width, lineGap: 1 });
        y += rest[n] * textLine;
      });
    });
    rowTop += rowHeights[r] + gap;
  });
  doc.page.margins.bottom = bottomMargin;
  doc.x = T.left;
  doc.y = bottom;
}

/**
 * The page furniture, on every page once the content is laid out and the
 * page count is known: the footer rule, the strapline centred in green
 * capitals, "Page n of m" bottom right (only when there is more than one
 * page), a module's footer note small above the rule; and on page two
 * onward the running header — the reference, the document and its number,
 * the date — exactly where the quotation template puts each.
 */
function paginate(doc: PDFKit.PDFDocument, spec: PdfDocumentSpec, company: Company) {
  const range = doc.bufferedPageRange();
  const foot = caps(strapline(company));
  const running = [
    spec.reference,
    spec.documentNumber ? `${spec.title} # ${spec.documentNumber}` : spec.title,
    formatShortDate(spec.date ?? new Date()),
  ]
    .filter((p): p is string => !!p)
    .join('   ·   ');

  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    // The furniture sits BELOW the bottom margin. PDFKit treats any text past
    // that margin as overflow and helpfully starts a new page, which would
    // then need its own footer, and so on. Dropping the margin for the
    // duration of the write is the documented way to stop that; without it a
    // two-page document silently becomes six.
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const left = T.left;
    const right = doc.page.width - T.right;
    const width = right - left;
    const ruleY = doc.page.height - 57.38;

    doc.moveTo(left, ruleY).lineTo(right, ruleY).strokeColor(RULE).lineWidth(0.75).stroke();
    if (foot) {
      // Shrunk to fit the width rather than wrapped, to 60% at most, as the
      // template's strapline box does.
      let size = 14;
      doc.font('Helvetica-Bold');
      while (size > 8.4 && doc.fontSize(size).widthOfString(foot, { characterSpacing: 1.5 }) > width) size -= 0.25;
      doc.fontSize(size).fillColor(GREEN);
      doc.text(foot, left, doc.page.height - 45, { width, align: 'center', characterSpacing: 1.5, lineBreak: false });
    }
    if (range.count > 1) {
      doc.font('Helvetica').fontSize(7.5).fillColor(GREY);
      doc.text(`Page ${i + 1} of ${range.count}`, right - 60, doc.page.height - 25, { width: 60, align: 'right', lineBreak: false });
    }
    if (spec.footerNote) {
      doc.font('Helvetica').fontSize(7).fillColor(GREY);
      doc.text(spec.footerNote, left, ruleY - 10, { width: width - 70, height: 9, ellipsis: true, lineBreak: false });
    }
    if (i > 0) {
      doc.font('Helvetica').fontSize(8).fillColor(GREY);
      doc.text(running, left, 22, { width, align: 'center', height: 10, ellipsis: true, lineBreak: false });
    }
    doc.page.margins.bottom = bottomMargin;
  }
  // Leave the cursor on the last page so nothing is appended to page 1.
  doc.switchToPage(range.start + range.count - 1);
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number) {
  if (doc.y + needed > contentBottom(doc)) doc.addPage();
}

// ── Words and figures, as every document prints them ─────────────────────────

/**
 * A status as a document prints it: "PENDING_APPROVAL" → "Pending approval".
 * The one function for every status an enum prints; a module never spells a
 * status for the paper itself.
 */
export function statusLabel(value: string | null | undefined): string {
  const words = (value ?? '').trim().toLowerCase().replace(/[_\s]+/g, ' ');
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

/**
 * The company's currency code (Company Settings), 'PHP' when unset, so a
 * route never hard-codes it. Read every time, as the engine reads the whole
 * company row for every print: a cache here was the one place a changed
 * setting kept printing the old value.
 */
export async function companyCurrency(): Promise<string> {
  const row = await prisma.company.findUnique({ where: { id: 'company' }, select: { currency: true } });
  return row?.currency?.trim() || 'PHP';
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
    .replace(/ /g, ' ')
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
