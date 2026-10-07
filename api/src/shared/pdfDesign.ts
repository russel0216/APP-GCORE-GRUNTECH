import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import { z } from 'zod';
import { prisma } from '../prisma';
import { formatDateTime, pdfSafe, websiteForPrint, type PdfCell, type PdfTotal, type Signatory } from './pdf';

/**
 * Designed documents — a PDF laid out by an administrator.
 *
 * The house style (`renderDocument`) is code: every internal document prints
 * the same way and nobody needs to move anything on it. The quotation is the
 * one document a customer receives, and its look is the business's to decide,
 * so its layout is DATA: boxes on an A4 page, edited in Admin › PDF Templates,
 * each printing fixed text and `{{fields}}`. The engine still draws every box;
 * a module supplies only the values, the lines, the totals and the sign-offs
 * (`DesignData`), never a coordinate.
 *
 * A page is 595.28 × 841.89pt, measured from the top-left corner. Every box
 * has an ANCHOR, which is what makes a fixed layout work for a document whose
 * length is not known until it is printed:
 *
 *   first  page 1, where it was put. A box that grows (a long address) pushes
 *          down whatever sits under it, the line table included — the way the
 *          letterhead used to push the customer block.
 *   every  every page, where it was put: the footer, the strapline.
 *   later  pages 2 onward: the running header.
 *   after  follows the line table. Its distance below the table is kept,
 *          wherever the table ends; boxes under it keep their distance from
 *          it; a box with nothing to print closes up; a box that does not fit
 *          goes over to the next page, and a text box longer than a page runs on.
 *   last   the last page, where it was put — the sign-offs. It keeps its
 *          bottom edge, growing upward when it prints more than its box
 *          holds, so it never runs into the footer; if the content reaches
 *          it, it takes a page of its own.
 *
 * The line table (`items`) starts on page 1 where it was put and carries on
 * from `flowTop` on every later page, its head repeated, down to `flowBottom`.
 *
 * Every string reaches the page through `pdfSafe`, as in the house style.
 */

export const PAGE_WIDTH = 595.28;
export const PAGE_HEIGHT = 841.89;

export const ORIENTATIONS = ['portrait', 'landscape'] as const;
export type DesignOrientation = (typeof ORIENTATIONS)[number];

/** The page a layout draws on: A4 upright, or on its side (the sales order). */
export function pageSizeOf(design: { orientation?: DesignOrientation }): { w: number; h: number } {
  return design.orientation === 'landscape' ? { w: PAGE_HEIGHT, h: PAGE_WIDTH } : { w: PAGE_WIDTH, h: PAGE_HEIGHT };
}

export const ANCHORS = ['first', 'every', 'later', 'after', 'last'] as const;
export type DesignAnchor = (typeof ANCHORS)[number];
export const ALIGNS = ['left', 'center', 'right'] as const;
export type DesignAlign = (typeof ALIGNS)[number];

/** What a column of the line table can print. */
export const ITEM_COLUMNS = ['no', 'product', 'qtyUnit', 'qty', 'unit', 'unitPrice', 'amount', 'group', 'cost', 'margin'] as const;
export type ItemColumnKey = (typeof ITEM_COLUMNS)[number];

/**
 * The cost columns exist for internal paper (the sales order). A document a
 * customer receives never offers them — its template registry entry leaves
 * them off its column list, and a save naming one is refused there.
 */
export const COST_COLUMNS: readonly ItemColumnKey[] = ['cost', 'margin'];

export const ITEM_COLUMN_LABELS: Record<ItemColumnKey, string> = {
  no: 'Line number',
  product: 'Product, with its description under it',
  qtyUnit: 'Quantity and unit',
  qty: 'Quantity',
  unit: 'Unit',
  unitPrice: 'Unit price',
  amount: 'Amount',
  group: 'Group',
  cost: 'Cost, with its provider under it',
  margin: 'Margin',
};

// ── The layout, as stored ─────────────────────────────────────────────────────

const HEX = /^#[0-9a-fA-F]{6}$/;
const color = (fallback: string) => z.string().regex(HEX, 'A colour is written #RRGGBB').default(fallback);
const num = (min: number, max: number) => z.number().finite().min(min).max(max);

// Bounds here take the page's long side either way round; which way the page
// actually stands is the layout's `orientation`, checked edge by edge below.
const base = {
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'A box id is letters, digits, - and _'),
  name: z.string().trim().max(60).optional(),
  x: num(0, PAGE_HEIGHT),
  y: num(0, PAGE_HEIGHT),
  w: num(1, PAGE_HEIGHT),
  h: num(0.25, PAGE_HEIGHT),
  /** Printed only when this field has a value — "Notes:" only when there are notes. */
  showIf: z.string().max(60).nullable().optional(),
};

const textBlock = z.object({
  ...base,
  type: z.literal('text'),
  anchor: z.enum(ANCHORS),
  /** Fixed text and {{field}} placeholders; **bold** marks a bold span. */
  text: z.string().max(4000),
  size: num(4, 72),
  bold: z.boolean().default(false),
  italic: z.boolean().default(false),
  color: color('#222222'),
  align: z.enum(ALIGNS).default('left'),
  uppercase: z.boolean().default(false),
  /** Character spacing, in points. */
  spacing: num(0, 10).default(0),
  /** Extra space between lines, in points. */
  lineGap: num(0, 40).default(0),
  /** Shrink the type (to 60% at most) rather than wrap a line. */
  fit: z.boolean().default(false),
  /** Printed only when the document runs to more than one page. */
  multiPageOnly: z.boolean().default(false),
});

/** A rule across the box's width; the box's height is its thickness. */
const lineBlock = z.object({ ...base, type: z.literal('line'), anchor: z.enum(ANCHORS), color: color('#D9D9D9') });

/** A filled rectangle — a band behind a heading, a panel behind the totals. */
const boxBlock = z.object({ ...base, type: z.literal('box'), anchor: z.enum(ANCHORS), color: color('#F2F2F2') });

/** The company logo from Company Settings, fitted inside the box. */
const logoBlock = z.object({ ...base, type: z.literal('logo'), anchor: z.enum(ANCHORS), align: z.enum(ALIGNS).default('left') });

const itemsBlock = z.object({
  ...base,
  type: z.literal('items'),
  anchor: z.literal('first').default('first'),
  columns: z
    .array(
      z.object({
        key: z.enum(ITEM_COLUMNS),
        /** May carry fields: "Unit price ({{quotation.currency}})". */
        label: z.string().max(80),
        width: num(1, PAGE_HEIGHT),
        align: z.enum(ALIGNS).default('left'),
      }),
    )
    .min(1, 'The line table needs at least one column')
    .max(8, 'The line table takes eight columns at most'),
  size: num(6, 14).default(9),
  headColor: color('#5B2A8C'),
  /** A subheading between the lines. */
  headingColor: color('#2E9A4B'),
  textColor: color('#222222'),
  /** A line's description, under its product name. */
  bodyColor: color('#555555'),
  ruleColor: color('#D9D9D9'),
});

const totalsBlock = z.object({
  ...base,
  type: z.literal('totals'),
  anchor: z.enum(['after', 'last']).default('after'),
  size: num(6, 14).default(9),
  labelWidth: num(20, PAGE_HEIGHT).default(129.6),
  textColor: color('#222222'),
  /** The total itself, and the heavier rule under it. */
  accentColor: color('#5B2A8C'),
  ruleColor: color('#D9D9D9'),
});

const signoffsBlock = z.object({
  ...base,
  type: z.literal('signoffs'),
  anchor: z.enum(['after', 'last']).default('last'),
  size: num(6, 14).default(8),
  /** Each person's column; the first starts at the left edge, the last ends at the right. */
  colWidth: num(40, PAGE_HEIGHT).default(133),
  headColor: color('#5B2A8C'),
  textColor: color('#222222'),
  /** The name, in bold, at this size — larger than the lines under it. */
  nameSize: num(6, 18).default(10),
  /** Their position, on a line of its own under the name. */
  showPosition: z.boolean().default(false),
  /** How to reach them, under the name: the contact number, then the email. */
  showPhone: z.boolean().default(true),
  showEmail: z.boolean().default(true),
});

export const designBlockSchema = z.discriminatedUnion('type', [
  textBlock,
  lineBlock,
  boxBlock,
  logoBlock,
  itemsBlock,
  totalsBlock,
  signoffsBlock,
]);

export const designSchema = z
  .object({
    version: z.literal(1).default(1),
    /** A4 upright, or on its side. A layout keeps the way it was drawn. */
    orientation: z.enum(ORIENTATIONS).default('portrait'),
    /** Where the content resumes on every page after the first. */
    flowTop: num(0, 400),
    /** Where the content stops on every page, above the footer. */
    flowBottom: num(200, PAGE_HEIGHT),
    blocks: z.array(designBlockSchema).min(1).max(150, 'A template takes 150 boxes at most'),
  })
  .superRefine((design, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    const page = pageSizeOf(design);
    if (design.flowBottom > page.h) issue(['flowBottom'], 'The content cannot stop below the page');
    if (design.flowBottom - design.flowTop < 200) {
      issue(['flowBottom'], 'Leave at least 200pt between where the content starts and where it stops');
    }
    const ids = new Set<string>();
    design.blocks.forEach((b, i) => {
      if (ids.has(b.id)) issue(['blocks', i, 'id'], `Two boxes share the id "${b.id}"`);
      ids.add(b.id);
      if (b.x + b.w > page.w + 1) issue(['blocks', i, 'w'], `${label(b)} runs off the right edge of the page`);
      if (b.y + b.h > page.h + 1) issue(['blocks', i, 'h'], `${label(b)} runs off the bottom of the page`);
    });
    const count = (type: DesignBlock['type']) => design.blocks.filter((b) => b.type === type).length;
    if (count('items') !== 1) issue(['blocks'], 'A template has exactly one line table');
    if (count('totals') > 1) issue(['blocks'], 'A template has one totals block at most');
    if (count('signoffs') > 1) issue(['blocks'], 'A template has one sign-off block at most');
    const items = design.blocks.find((b) => b.type === 'items');
    if (items && items.y > design.flowBottom - 60) {
      issue(['blocks', design.blocks.indexOf(items), 'y'], 'The line table starts too low to fit a row on the first page');
    }
  });

export type PdfDesign = z.infer<typeof designSchema>;
export type DesignBlock = z.infer<typeof designBlockSchema>;
export type TextBlock = Extract<DesignBlock, { type: 'text' }>;
export type ItemsBlock = Extract<DesignBlock, { type: 'items' }>;
export type TotalsBlock = Extract<DesignBlock, { type: 'totals' }>;
export type SignoffsBlock = Extract<DesignBlock, { type: 'signoffs' }>;
export type LogoBlock = Extract<DesignBlock, { type: 'logo' }>;

/** A box as a person reads it in an error: its name, else what it is. */
function label(b: { name?: string; type: string; id: string }): string {
  return b.name?.trim() ? `"${b.name.trim()}"` : `The ${b.type} box ${b.id}`;
}

/** A stored layout, or null when it no longer parses — the caller falls back to the standard one. */
export function readDesign(value: unknown): PdfDesign | null {
  const parsed = designSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ── Fields ────────────────────────────────────────────────────────────────────

export interface DesignField {
  key: string;
  label: string;
  group: string;
  /** What the editor shows in the box before anything is printed. */
  sample?: string;
}

/** What every designed document can print about the company (Company Settings). */
export const COMPANY_FIELDS: DesignField[] = [
  { key: 'company.name', label: 'Registered name (else the trading name)', group: 'Company' },
  { key: 'company.tradeName', label: 'Trading name', group: 'Company' },
  { key: 'company.address', label: 'Address, city', group: 'Company' },
  { key: 'company.country', label: 'Country', group: 'Company' },
  { key: 'company.phone', label: 'Tel', group: 'Company' },
  { key: 'company.fax', label: 'Fax', group: 'Company' },
  { key: 'company.email', label: 'Email', group: 'Company' },
  { key: 'company.website', label: 'Website', group: 'Company' },
  { key: 'company.tin', label: 'TIN', group: 'Company' },
  { key: 'company.regNo', label: 'Reg. No.', group: 'Company' },
  { key: 'company.tagline', label: 'Document tagline', group: 'Company' },
  { key: 'company.strapline', label: 'Strapline (the tagline, else the website)', group: 'Company' },
  { key: 'company.bankName', label: 'Bank', group: 'Company' },
  { key: 'company.bankBranch', label: 'Bank branch', group: 'Company' },
  { key: 'company.bankAccount', label: 'Bank account', group: 'Company' },
];

/** Known once the document is laid out. */
export const PAGE_FIELDS: DesignField[] = [
  { key: 'page', label: 'This page’s number', group: 'Page', sample: '1' },
  { key: 'pages', label: 'Number of pages', group: 'Page', sample: '2' },
];

type CompanyRow = Awaited<ReturnType<typeof prisma.company.findUnique>>;

/** "https://www.gruntechnology.com/" → "www.gruntechnology.com", as the letterhead prints it. */
function siteForPrint(website?: string | null): string {
  return (website ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

export function companyValues(c: CompanyRow): Record<string, string> {
  const site = siteForPrint(c?.website);
  return {
    'company.name': c?.legalName?.trim() || c?.name || '',
    'company.tradeName': c?.name ?? '',
    'company.address': [c?.address, c?.city].filter((t) => t?.trim()).join(', '),
    'company.country': c?.country ?? '',
    'company.phone': c?.phone ?? '',
    'company.fax': c?.fax ?? '',
    'company.email': c?.email ?? '',
    'company.website': site,
    'company.tin': c?.tin ?? '',
    'company.regNo': c?.regNo ?? '',
    'company.tagline': c?.documentTagline ?? '',
    'company.strapline': c?.documentTagline?.trim() || websiteForPrint(c?.website),
    'company.bankName': c?.bankName ?? '',
    'company.bankBranch': c?.bankBranch ?? '',
    'company.bankAccount': c?.bankAccount ?? '',
  };
}

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9.]*)\s*(?:\|([^{}]*))?\}\}/g;

/** Every field a piece of template text names. */
export function fieldsIn(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1]);
}

/**
 * Field keys a layout uses that the document does not have, as zod-style
 * issues — a typo in a placeholder would otherwise print nothing, silently.
 */
export function unknownFields(design: PdfDesign, known: Set<string>): { field: string; message: string }[] {
  const out: { field: string; message: string }[] = [];
  design.blocks.forEach((b, i) => {
    const texts: [string, string][] =
      b.type === 'text'
        ? [[`blocks.${i}.text`, b.text]]
        : b.type === 'items'
          ? b.columns.map((c, n) => [`blocks.${i}.columns.${n}.label`, c.label] as [string, string])
          : [];
    for (const [path, text] of texts) {
      for (const key of fieldsIn(text)) {
        if (!known.has(key)) out.push({ field: path, message: `${label(b)} names {{${key}}}, which this document does not have` });
      }
    }
    if (b.showIf && !known.has(b.showIf)) {
      out.push({ field: `blocks.${i}.showIf`, message: `${label(b)} depends on ${b.showIf}, which this document does not have` });
    }
  });
  return out;
}

// ── Template text ─────────────────────────────────────────────────────────────

export interface Run {
  text: string;
  bold: boolean;
}

/**
 * Template text as lines of runs, with the values put in.
 *
 * Lines are separated by newlines and parts of a line by " | ". A part that
 * names fields, every one of them empty, is left out — "Tel No.: {{phone}} |
 * Email: {{email}}" prints "Email: …" when there is no phone — and a line all
 * of whose parts were left out is left out with them, so an unset TIN never
 * prints as a bare "TIN:". `{{field|—}}` prints "—" when the field is empty,
 * which keeps the line. Text with no fields always prints, blank lines too.
 *
 * `**` marks bold in the TEMPLATE only: values are put in after the markup is
 * read, so a description that happens to contain "**" prints as typed. A
 * value with newlines in it (terms, notes) runs over as many lines as it has.
 */
export function resolveTemplate(text: string, values: Record<string, string | undefined>, bold = false): Run[][] {
  const out: Run[][] = [];
  const TOKEN = new RegExp(`${PLACEHOLDER.source}|\\*\\*| \\| `, 'g');
  for (const source of text.split(/\r?\n/)) {
    type Part = { runs: Run[]; fields: number; filled: number; sepBold: boolean };
    const parts: Part[] = [{ runs: [], fields: 0, filled: 0, sepBold: false }];
    let on = false;
    let last = 0;
    const push = (t: string) => {
      if (t) parts[parts.length - 1].runs.push({ text: t, bold: bold || on });
    };
    let m: RegExpExecArray | null;
    while ((m = TOKEN.exec(source))) {
      push(source.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[0] === '**') on = !on;
      else if (m[0] === ' | ') parts.push({ runs: [], fields: 0, filled: 0, sepBold: bold || on });
      else {
        const part = parts[parts.length - 1];
        part.fields++;
        const raw = values[m[1]] ?? '';
        const value = raw.trim() ? raw : (m[2] ?? '').trim();
        if (value) part.filled++;
        push(value);
      }
    }
    push(source.slice(last));

    const kept = parts.filter((p) => p.fields === 0 || p.filled > 0);
    if (!kept.length) continue;
    const runs: Run[] = [];
    kept.forEach((p, i) => {
      if (i > 0) runs.push({ text: ' | ', bold: p.sepBold });
      runs.push(...p.runs);
    });

    // A value with newlines in it becomes as many lines.
    let line: Run[] = [];
    for (const run of runs) {
      const pieces = run.text.split(/\r?\n/);
      pieces.forEach((piece, i) => {
        if (i > 0) {
          out.push(merge(line));
          line = [];
        }
        if (piece) line.push({ text: piece, bold: run.bold });
      });
    }
    out.push(merge(line));
  }
  return out;
}

function merge(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const prev = out[out.length - 1];
    if (prev && prev.bold === r.bold) prev.text += r.text;
    else if (r.text) out.push({ ...r });
  }
  return out;
}

/** Template text resolved flat, for one-line labels such as a column's. */
export function resolveInline(text: string, values: Record<string, string | undefined>): string {
  return resolveTemplate(text, values)
    .map((line) => line.map((r) => r.text).join(''))
    .join(' ');
}

// ── Measuring and drawing text ────────────────────────────────────────────────

/** Helvetica's line height: (ascender + line gap − descender) / 1000, as PDFKit sets a line. */
const LINE = 1.156;

interface Style {
  size: number;
  italic: boolean;
  spacing: number;
  upper: boolean;
}

interface Placed {
  text: string;
  bold: boolean;
  width: number;
}

interface Laid {
  runs: Placed[];
  width: number;
}

function fontName(bold: boolean, italic: boolean): string {
  if (bold) return italic ? 'Helvetica-BoldOblique' : 'Helvetica-Bold';
  return italic ? 'Helvetica-Oblique' : 'Helvetica';
}

function measure(doc: PDFKit.PDFDocument, text: string, bold: boolean, s: Style): number {
  if (!text) return 0;
  doc.font(fontName(bold, s.italic)).fontSize(s.size);
  return doc.widthOfString(text, { characterSpacing: s.spacing });
}

function lineWidth(doc: PDFKit.PDFDocument, runs: Run[], s: Style): number {
  const visible = runs.filter((r) => r.text);
  return (
    visible.reduce((sum, r) => sum + measure(doc, s.upper ? r.text.toUpperCase() : r.text, r.bold, s), 0) +
    s.spacing * Math.max(0, visible.length - 1)
  );
}

/**
 * Lines of runs wrapped to a width: words are kept whole unless one is wider
 * than the box on its own, and a wrapped line drops the spaces it broke at.
 */
function wrap(doc: PDFKit.PDFDocument, lines: Run[][], width: number, s: Style): Laid[] {
  const out: Laid[] = [];
  for (const line of lines) {
    type Tok = { text: string; bold: boolean; space: boolean; w: number };
    const toks: Tok[] = [];
    for (const run of line) {
      const text = s.upper ? run.text.toUpperCase() : run.text;
      for (const part of text.split(/(\s+)/)) {
        if (!part) continue;
        const space = /^\s+$/.test(part);
        const t = space ? part.replace(/\s/g, ' ') : part;
        toks.push({ text: t, bold: run.bold, space, w: measure(doc, t, run.bold, s) + s.spacing });
      }
    }
    let cur: Tok[] = [];
    let curW = 0;
    const flush = () => {
      while (cur.length && cur[cur.length - 1].space) cur.pop();
      out.push(laid(doc, cur, s));
      cur = [];
      curW = 0;
    };
    for (const tok of toks) {
      if (tok.space) {
        if (cur.length) {
          cur.push(tok);
          curW += tok.w;
        }
        continue;
      }
      if (curW + tok.w - s.spacing <= width + 0.01) {
        cur.push(tok);
        curW += tok.w;
        continue;
      }
      if (cur.some((t) => !t.space)) flush();
      // A word wider than the box on its own is broken where it has to be.
      let rest = tok.text;
      while (measure(doc, rest, tok.bold, s) > width && rest.length > 1) {
        let n = rest.length - 1;
        while (n > 1 && measure(doc, rest.slice(0, n), tok.bold, s) > width) n--;
        cur.push({ ...tok, text: rest.slice(0, n), w: measure(doc, rest.slice(0, n), tok.bold, s) + s.spacing });
        flush();
        rest = rest.slice(n);
      }
      const w = measure(doc, rest, tok.bold, s) + s.spacing;
      cur.push({ ...tok, text: rest, w });
      curW = w;
    }
    flush();
  }
  return out;
}

function laid(doc: PDFKit.PDFDocument, toks: { text: string; bold: boolean }[], s: Style): Laid {
  const runs: Placed[] = [];
  for (const t of toks) {
    const prev = runs[runs.length - 1];
    if (prev && prev.bold === t.bold) prev.text += t.text;
    else runs.push({ text: t.text, bold: t.bold, width: 0 });
  }
  for (const r of runs) r.width = measure(doc, r.text, r.bold, s);
  return { runs, width: runs.reduce((n, r) => n + r.width, 0) + s.spacing * Math.max(0, runs.length - 1) };
}

/**
 * One laid line at (x, y), aligned inside `width`. Each run is one text call
 * with no wrapping, so PDFKit never breaks a line or a page behind our back
 * and a reader that copies the text gets whole phrases.
 */
function drawLaid(doc: PDFKit.PDFDocument, line: Laid, x: number, y: number, width: number, align: DesignAlign, s: Style, color: string) {
  let cx = align === 'right' ? x + width - line.width : align === 'center' ? x + (width - line.width) / 2 : x;
  for (const run of line.runs) {
    if (run.text.trim()) {
      doc.font(fontName(run.bold, s.italic)).fontSize(s.size).fillColor(color);
      doc.text(run.text, cx, y, { lineBreak: false, characterSpacing: s.spacing });
    }
    cx += run.width + s.spacing;
  }
}

// ── What a module supplies ────────────────────────────────────────────────────

/** A row of the line table: a subheading, or a line's cells by column key. */
export type DesignRow =
  | { heading: string; /** A SCORO group, not a subheading: left out when the table has a Group column. */ group?: boolean }
  | { cells: Partial<Record<ItemColumnKey, PdfCell>> };

export interface DesignData {
  /** The document's own fields; the company's are added by the engine. */
  fields: Record<string, string>;
  rows: DesignRow[];
  /** Null prints no totals block at all — a quotation with "Hide total". */
  totals: PdfTotal[] | null;
  signatories: Signatory[];
  /** The PDF's own title, for the reader's window. */
  title: string;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

const overlapsX = (a: DesignBlock, b: DesignBlock) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5;
const isAbove = (a: DesignBlock, b: DesignBlock) => a.y + a.h <= b.y + 0.5;
const byPosition = (a: DesignBlock, b: DesignBlock) => a.y - b.y || a.x - b.x;
/** Whether `c` spans the whole width that `a` and `b` share. */
const covers = (c: DesignBlock, a: DesignBlock, b: DesignBlock) =>
  c.x <= Math.max(a.x, b.x) + 0.5 && c.x + c.w >= Math.min(a.x + a.w, b.x + b.w) - 0.5;

/** A text box, worked out: its lines at the size it prints, or nothing to print. */
interface TextPlan {
  lines: Laid[];
  style: Style;
  lh: number;
  height: number;
}

class Renderer {
  readonly doc: PDFKit.PDFDocument;
  private pages = 1;
  private readonly chunks: Buffer[] = [];
  readonly done: Promise<Buffer>;

  constructor(
    private readonly design: PdfDesign,
    private readonly data: DesignData,
    private readonly values: Record<string, string>,
    private readonly logo: string | null,
    /** The page count used for {{pages}} before the document is laid out. */
    private readonly pagesHint: number,
  ) {
    this.doc = new PDFDocument({
      size: 'A4',
      layout: design.orientation === 'landscape' ? 'landscape' : 'portrait',
      // Nothing here relies on PDFKit's own wrapping, so no margin can make it
      // start a page of its own accord: every page break is the layout's.
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      bufferPages: true,
      info: { Title: pdfSafe(data.title), Author: values['company.tradeName'] || 'G-CORE' },
    });
    this.doc.on('data', (c: Buffer) => this.chunks.push(c));
    this.done = new Promise((resolve) => this.doc.on('end', () => resolve(Buffer.concat(this.chunks))));
  }

  get pageCount() {
    return this.pages;
  }

  private visible(b: DesignBlock, pages: number): boolean {
    if (b.showIf && !(this.values[b.showIf] ?? '').trim()) return false;
    if (b.type === 'text' && b.multiPageOnly && pages < 2) return false;
    if (b.type === 'totals' && !this.data.totals?.length) return false;
    if (b.type === 'signoffs' && !this.data.signatories.length) return false;
    if (b.type === 'logo' && !this.logo) return false;
    return true;
  }

  /** Moves to a page, making it (and the furniture on it) if it does not exist yet. */
  private goTo(page: number) {
    while (this.pages <= page) {
      this.doc.addPage();
      this.pages++;
      this.furniture(this.pages - 1);
    }
    this.doc.switchToPage(page);
  }

  /**
   * The every-page and later-page graphics, drawn the moment a page exists so
   * they sit BEHIND its content — a band under the strapline, a logo. Their
   * text waits until the end, when the page count is known.
   */
  furniture(page: number) {
    for (const b of this.design.blocks) {
      if (b.type === 'text' || !(b.anchor === 'every' || (b.anchor === 'later' && page > 0))) continue;
      if (this.visible(b, this.pagesHint)) this.drawFixed(b, b.y);
    }
  }

  textPlan(b: TextBlock, page: number, pages: number): TextPlan | null {
    const values = { ...this.values, page: String(page + 1), pages: String(pages) };
    const resolved = resolveTemplate(b.text, values, b.bold).map((line) => line.map((r) => ({ ...r, text: pdfSafe(r.text) })));
    if (!resolved.some((line) => line.some((r) => r.text.trim()))) return null;
    const style: Style = { size: b.size, italic: b.italic, spacing: b.spacing, upper: b.uppercase };
    if (b.fit) {
      const floor = Math.max(4, b.size * 0.6);
      while (style.size > floor && resolved.some((line) => lineWidth(this.doc, line, style) > b.w)) {
        style.size = Math.max(floor, style.size - 0.25);
      }
    }
    const lines = wrap(this.doc, resolved, b.w, style);
    const lh = style.size * LINE;
    return { lines, style, lh, height: lines.length * lh + Math.max(0, lines.length - 1) * b.lineGap };
  }

  private drawPlan(b: TextBlock, plan: TextPlan, top: number) {
    plan.lines.forEach((line, i) => {
      drawLaid(this.doc, line, b.x, top + i * (plan.lh + b.lineGap), b.w, b.align, plan.style, b.color);
    });
  }

  /** How tall a box prints: at least as tall as it was drawn; longer text makes it taller. */
  private heightOf(b: DesignBlock, page: number): number | null {
    switch (b.type) {
      case 'text': {
        const plan = this.textPlan(b, page, this.pagesHint);
        return plan ? Math.max(b.h, plan.height) : null;
      }
      case 'totals':
        return Math.max(b.h, this.totalsHeight(b));
      case 'signoffs':
        return Math.max(b.h, this.signoffsHeight(b));
      default:
        return b.h;
    }
  }

  /** A box that does not flow, drawn with its top at `top` on the current page. */
  private drawFixed(b: DesignBlock, top: number, page = 0) {
    const doc = this.doc;
    switch (b.type) {
      case 'text': {
        const plan = this.textPlan(b, page, this.pagesHint);
        if (plan) this.drawPlan(b, plan, top);
        return;
      }
      case 'line':
        doc.save();
        doc.moveTo(b.x, top + b.h / 2).lineTo(b.x + b.w, top + b.h / 2).strokeColor(b.color).lineWidth(b.h).stroke();
        doc.restore();
        return;
      case 'box':
        doc.save();
        doc.rect(b.x, top, b.w, b.h).fill(b.color);
        doc.restore();
        return;
      case 'logo':
        if (!this.logo) return;
        try {
          doc.image(this.logo, b.x, top, { fit: [b.w, b.h], ...(b.align === 'left' ? {} : { align: b.align }) });
        } catch {
          /* a broken logo must never stop a document printing */
        }
        return;
      case 'totals':
        this.drawTotals(b, top);
        return;
      case 'signoffs':
        this.drawSignoffs(b, top);
        return;
      case 'items':
        return; // the table flows; see table()
    }
  }

  // ── Page 1, the table, what follows it, the last page ──────────────────────

  async render(): Promise<Buffer> {
    const { design } = this;
    const items = design.blocks.find((b): b is ItemsBlock => b.type === 'items')!;
    this.furniture(0);

    // Page 1: each box where it was put, lower only when a box above it grew.
    const firsts = design.blocks.filter((b) => b.anchor === 'first' && b.type !== 'items' && this.visible(b, this.pagesHint));
    const placed = new Map<DesignBlock, { top: number; bottom: number }>();
    for (const b of [...firsts, items].sort(byPosition)) {
      let top = b.y;
      for (const [a, at] of placed) {
        if (isAbove(a, b) && overlapsX(a, b)) top = Math.max(top, at.bottom + (b.y - (a.y + a.h)));
      }
      const height = b === items ? b.h : this.heightOf(b, 0);
      if (height === null) continue;
      placed.set(b, { top, bottom: top + height });
    }
    for (const b of firsts) {
      const at = placed.get(b);
      if (at) this.drawFixed(b, at.top, 0);
    }

    const end = this.table(items, placed.get(items)?.top ?? items.y);
    const flowEnd = this.afterTable(end, items.y + items.h);
    this.lastPage(flowEnd);
    this.furnitureText();

    this.doc.end();
    return this.done;
  }

  /**
   * The boxes that follow the table, in the order they sit on the page. Each
   * keeps its distance below the box above it (or below the table), so the
   * layout drawn in the editor holds wherever the table happens to end.
   */
  private afterTable(end: { page: number; y: number }, tableBottom: number): { page: number; y: number } {
    const { flowTop, flowBottom } = this.design;
    const blocks = this.design.blocks.filter((b) => b.anchor === 'after').sort(byPosition);
    const done: { b: DesignBlock; page: number; bottom: number }[] = [];
    let last = { ...end };
    for (const b of blocks) {
      // What it hangs from: the lowest box above it that it overlaps, else the table.
      let page = end.page;
      let top = end.y + Math.max(0, b.y - tableBottom);
      let ref = end.y;
      // Only the boxes directly above it: one with another box between them,
      // across the width they share, is that box's business — otherwise a box
      // that closed up in between could not pull this one up after it.
      const over = done.filter((d) => isAbove(d.b, b) && overlapsX(d.b, b));
      const above = over.filter((a) => !over.some((c) => c !== a && isAbove(a.b, c.b) && covers(c.b, a.b, b)));
      if (above.length) {
        page = Math.max(...above.map((d) => d.page));
        top = -Infinity;
        for (const d of above.filter((d) => d.page === page)) {
          const t = d.bottom + Math.max(0, b.y - (d.b.y + d.b.h));
          if (t > top) {
            top = t;
            ref = d.bottom;
          }
        }
      }

      const height = this.visible(b, this.pagesHint) ? this.heightOf(b, page) : null;
      if (height === null) {
        // Nothing to print: it closes up, and whatever hangs from it moves up
        // into the space it would have taken.
        done.push({ b, page, bottom: ref });
        continue;
      }

      const room = flowBottom - top;
      if (height > room) {
        const plan = b.type === 'text' ? this.textPlan(b, page, this.pagesHint) : null;
        // Text of four lines or more runs on, as a paragraph does, once two of
        // its lines fit here; anything shorter, and any other box, goes over whole.
        if (plan && b.type === 'text' && plan.lines.length >= 4 && room >= plan.lh * 2) {
          const out = this.runOn(b, plan, page, top);
          done.push({ b, ...out });
          last = later(last, out.page, out.bottom);
          continue;
        }
        page += 1;
        top = flowTop;
        if (plan && b.type === 'text' && height > flowBottom - flowTop) {
          const out = this.runOn(b, plan, page, top);
          done.push({ b, ...out });
          last = later(last, out.page, out.bottom);
          continue;
        }
      }
      this.goTo(page);
      this.drawFixed(b, top, page);
      done.push({ b, page, bottom: top + height });
      last = later(last, page, top + height);
    }
    return last;
  }

  /** A text box drawn line by line, carrying on at the top of the next page. */
  private runOn(b: TextBlock, plan: TextPlan, page: number, top: number): { page: number; bottom: number } {
    const { flowTop, flowBottom } = this.design;
    this.goTo(page);
    let y = top;
    plan.lines.forEach((line, i) => {
      if (i > 0) y += b.lineGap;
      if (y + plan.lh > flowBottom) {
        page += 1;
        this.goTo(page);
        y = flowTop;
      }
      drawLaid(this.doc, line, b.x, y, b.w, b.align, plan.style, b.color);
      y += plan.lh;
    });
    return { page, bottom: y };
  }

  /**
   * The last-page boxes, where they were put — on a page of their own if the
   * content reaches them. Each keeps its BOTTOM edge: printing more than its
   * box holds (a third approver, a contact line) it grows upward, so it can
   * never run down into the footer under it.
   */
  private lastPage(flowEnd: { page: number; y: number }) {
    const lasts = this.design.blocks
      .filter((b) => b.anchor === 'last' && this.visible(b, this.pagesHint))
      .map((b) => {
        const height = this.heightOf(b, flowEnd.page);
        return height === null ? null : { b, top: b.y + b.h - height };
      })
      .filter((x): x is { b: DesignBlock; top: number } => x !== null);
    if (!lasts.length) return;
    const highest = Math.min(...lasts.map((l) => l.top));
    const page = flowEnd.y + 12 > highest ? flowEnd.page + 1 : flowEnd.page;
    this.goTo(page);
    for (const { b, top } of lasts) this.drawFixed(b, top, page);
  }

  /** Every-page and later-page text, once the page count is known. */
  private furnitureText() {
    const total = this.pages;
    for (let page = 0; page < total; page++) {
      this.doc.switchToPage(page);
      for (const b of this.design.blocks) {
        if (b.type !== 'text' || !(b.anchor === 'every' || (b.anchor === 'later' && page > 0))) continue;
        if (!this.visible(b, total)) continue;
        const plan = this.textPlan(b, page, total);
        if (plan) this.drawPlan(b, plan, b.y);
      }
    }
    this.doc.switchToPage(total - 1);
  }

  // ── The line table ──────────────────────────────────────────────────────────

  /**
   * The lines, from `top` on page 1, their head repeated on every page they
   * reach. A subheading goes over with the line it heads; a line taller than a
   * whole page runs on rather than off the bottom.
   */
  private table(b: ItemsBlock, top: number): { page: number; y: number } {
    const doc = this.doc;
    const { flowTop, flowBottom } = this.design;
    const k = b.size / 9;
    const padX = 7;
    const padTop = 10 * k;
    const padRow = 20 * k;
    const total = b.columns.reduce((n, c) => n + c.width, 0);
    let x = b.x;
    const cols = b.columns.map((c) => {
      const width = (c.width / total) * b.w;
      const col = { ...c, x, width };
      x += width;
      return col;
    });
    const hasGroup = cols.some((c) => c.key === 'group');
    const product = cols.find((c) => c.key === 'product');
    const headingWidth = product ? product.x + product.width - b.x : b.w;
    const body: Style = { size: b.size, italic: false, spacing: 0, upper: false };
    const headStyle: Style = { size: b.size - 0.5, italic: false, spacing: 0, upper: true };
    const subStyle: Style = { size: b.size + 0.5, italic: false, spacing: 0, upper: false };
    const lh = b.size * LINE;

    const heads = cols.map((c) =>
      wrap(doc, [[{ text: pdfSafe(resolveInline(c.label, this.values)), bold: true }]], c.width - padX * 2, headStyle),
    );
    const headH = Math.max(30 * k, Math.max(...heads.map((h) => h.length)) * headStyle.size * LINE + 20 * k);

    let page = 0;
    let y = top;
    const rule = (at: number, width = b.w, weight = 0.75) => {
      doc.save();
      doc.moveTo(b.x, at).lineTo(b.x + width, at).strokeColor(b.ruleColor).lineWidth(weight).stroke();
      doc.restore();
    };
    const head = () => {
      cols.forEach((c, i) => {
        heads[i].forEach((line, n) => {
          drawLaid(doc, line, c.x + padX, y + 11 * k + n * headStyle.size * LINE, c.width - padX * 2, c.align, headStyle, b.headColor);
        });
      });
      rule(y + headH);
      y += headH;
    };
    const nextPage = () => {
      page += 1;
      this.goTo(page);
      y = flowTop;
      head();
    };

    type CellLine = { line: Laid; color: string; gap: number };
    const cellLines = (cell: PdfCell | undefined, width: number): CellLine[] => {
      if (cell === undefined || cell === null) return [];
      if (typeof cell === 'object') {
        const title = wrap(doc, [[{ text: pdfSafe(cell.title ?? ''), bold: true }]], width, body).map((line) => ({ line, color: b.textColor, gap: 0 }));
        const text = cell.body ? pdfSafe(cell.body) : '';
        const desc = text
          ? wrap(doc, text.split(/\r?\n/).map((t) => [{ text: t, bold: false }]), width, body).map((line, i) => ({
              line,
              color: b.bodyColor,
              gap: i === 0 && cell.title ? 2 : 0,
            }))
          : [];
        return [...(cell.title ? title : []), ...desc];
      }
      return wrap(doc, pdfSafe(String(cell)).split(/\r?\n/).map((t) => [{ text: t, bold: false }]), width, body).map((line) => ({
        line,
        color: b.textColor,
        gap: 0,
      }));
    };
    const cellHeight = (lines: CellLine[]) => lines.reduce((n, l) => n + l.gap + lh, 0);

    // The head and a first row must fit on page 1, or the table starts on page 2.
    this.goTo(0);
    if (y + headH + lh + padRow > flowBottom) {
      page = 1;
      this.goTo(1);
      y = flowTop;
    }
    head();

    const rows = this.data.rows.filter((r) => !('heading' in r && r.group && hasGroup));
    const rowCells = (r: DesignRow) => ('cells' in r ? cols.map((c) => cellLines(r.cells[c.key], c.width - padX * 2)) : []);
    const fresh = flowBottom - flowTop - headH;

    rows.forEach((row, i) => {
      if ('heading' in row) {
        const lines = wrap(doc, [[{ text: pdfSafe(row.heading), bold: false }]], headingWidth - padX * 2, subStyle);
        const height = lines.length * subStyle.size * LINE + padRow;
        const next = rows[i + 1];
        const keep = next && 'cells' in next ? Math.min(Math.max(...rowCells(next).map(cellHeight), lh) + padRow, fresh - height) : 0;
        if (y + height + keep > flowBottom) nextPage();
        lines.forEach((line, n) => {
          drawLaid(doc, line, b.x + padX, y + padTop + n * subStyle.size * LINE, headingWidth - padX * 2, 'left', subStyle, b.headingColor);
        });
        rule(y + height, headingWidth);
        y += height;
        return;
      }

      const cells = rowCells(row);
      const height = Math.max(lh, ...cells.map(cellHeight)) + padRow;
      // A row that fits on a page goes over whole; only one taller than a page is split.
      if (y + height > flowBottom && height <= fresh) nextPage();
      const queues = cells.map((lines) => [...lines]);
      for (let part = 0; ; part++) {
        const room = flowBottom - y - padRow;
        let used = 0;
        cols.forEach((c, n) => {
          let at = y + padTop;
          let h = 0;
          // Past the first part the row is at the top of a fresh page, where a
          // line always goes down — so a cell can never stall the table.
          while (queues[n].length && (h + queues[n][0].gap + lh <= room || (part > 0 && h === 0))) {
            const l = queues[n].shift()!;
            at += l.gap;
            drawLaid(doc, l.line, c.x + padX, at, c.width - padX * 2, c.align, body, l.color);
            at += lh;
            h += l.gap + lh;
          }
          used = Math.max(used, h);
        });
        if (queues.every((q) => !q.length)) {
          rule(y + Math.max(used, lh) + padRow);
          y += Math.max(used, lh) + padRow;
          break;
        }
        nextPage();
      }
    });

    return { page, y };
  }

  // ── Totals and sign-offs ────────────────────────────────────────────────────

  private totalsHeight(b: TotalsBlock): number {
    const k = b.size / 9;
    return (this.data.totals ?? []).reduce((n, r) => n + (r.bold ? 30 : 24.5) * k, 0);
  }

  /**
   * Label and figure on rows with a light rule under each; the total — the
   * bold row — larger, in the accent colour, over a heavier rule.
   */
  private drawTotals(b: TotalsBlock, top: number) {
    const doc = this.doc;
    const k = b.size / 9;
    const padX = 7;
    let y = top;
    for (const r of this.data.totals ?? []) {
      const h = (r.bold ? 30 : 24.5) * k;
      const s: Style = { size: r.bold ? b.size + 2 : b.size, italic: false, spacing: 0, upper: false };
      const ink = r.bold ? b.accentColor : b.textColor;
      const textY = y + (h - s.size) / 2;
      const labelLine = laid(doc, [{ text: pdfSafe(r.label), bold: !!r.bold }], s);
      const valueLine = laid(doc, [{ text: pdfSafe(r.value), bold: !!r.bold }], s);
      drawLaid(doc, labelLine, b.x + padX, textY, b.labelWidth - padX, 'left', s, ink);
      drawLaid(doc, valueLine, b.x + b.labelWidth, textY, b.w - b.labelWidth - padX, 'right', s, ink);
      y += h;
      doc.save();
      doc
        .moveTo(b.x, y)
        .lineTo(b.x + b.w, y)
        .strokeColor(r.bold ? b.accentColor : b.ruleColor)
        .lineWidth(r.bold ? 2 : 0.75)
        .stroke();
      doc.restore();
    }
  }

  private signoffColumns(b: SignoffsBlock): { x: number; width: number }[] {
    const n = this.data.signatories.length;
    if (n <= 1) return [{ x: b.x, width: b.w }];
    const colW = Math.min(b.colWidth, b.w);
    const step = (b.w - colW) / (n - 1);
    return this.data.signatories.map((_, i) => ({
      x: b.x + step * i,
      width: i === n - 1 ? colW : Math.max(colW, step - 10),
    }));
  }

  /**
   * One person's column, laid out: the role, the name in bold at its own
   * size, then — smaller — the position if the layout asks for it, how to
   * reach them, and when they did their part. A step nobody has taken yet is
   * "Pending" and nothing else.
   */
  private signoffLines(b: SignoffsBlock, person: Signatory, width: number) {
    const head: Style = { size: b.size + 0.5, italic: false, spacing: 0, upper: true };
    const nameStyle: Style = { size: b.nameSize, italic: false, spacing: 0, upper: false };
    const text: Style = { size: b.size, italic: false, spacing: 0, upper: false };
    const role = wrap(this.doc, [[{ text: pdfSafe(person.role), bold: true }]], width, head);
    const name = person.name ? wrap(this.doc, [[{ text: pdfSafe(person.name), bold: true }]], width, nameStyle) : [];
    const details: string[] = [];
    if (person.name) {
      if (b.showPosition && person.position?.trim()) details.push(pdfSafe(person.position));
      if (b.showPhone && person.phone?.trim()) details.push(pdfSafe(person.phone));
      if (b.showEmail && person.email?.trim()) details.push(pdfSafe(person.email));
      details.push(person.at ? formatDateTime(person.at) : 'Pending');
    } else {
      details.push('Pending');
    }
    const rest = wrap(this.doc, details.map((t) => [{ text: t, bold: false }]), width, text);
    return { role, name, rest, head, nameStyle, text };
  }

  private signoffsHeight(b: SignoffsBlock): number {
    const cols = this.signoffColumns(b);
    let tallest = 0;
    this.data.signatories.forEach((person, i) => {
      const { role, name, rest, head, nameStyle, text } = this.signoffLines(b, person, cols[i].width);
      tallest = Math.max(
        tallest,
        role.length * head.size * LINE + 5 + name.length * (nameStyle.size * LINE + 1) + rest.length * (text.size * LINE + 1),
      );
    });
    return tallest;
  }

  /**
   * Side by side, one column a person: the role as a heading, the name in
   * bold, how to reach them, then when they did it — or "Pending" where
   * nothing has happened, which is the truth rather than a borrowed date. No
   * signature rules.
   */
  private drawSignoffs(b: SignoffsBlock, top: number) {
    const cols = this.signoffColumns(b);
    this.data.signatories.forEach((person, i) => {
      const { x, width } = cols[i];
      const { role, name, rest, head, nameStyle, text } = this.signoffLines(b, person, width);
      let y = top;
      for (const line of role) {
        drawLaid(this.doc, line, x, y, width, 'left', head, b.headColor);
        y += head.size * LINE;
      }
      y += 5;
      for (const line of name) {
        drawLaid(this.doc, line, x, y, width, 'left', nameStyle, b.textColor);
        y += nameStyle.size * LINE + 1;
      }
      for (const line of rest) {
        drawLaid(this.doc, line, x, y, width, 'left', text, b.textColor);
        y += text.size * LINE + 1;
      }
    });
  }
}

function later(a: { page: number; y: number }, page: number, y: number) {
  return page > a.page || (page === a.page && y > a.y) ? { page, y } : a;
}

/** Whether any box outside the page furniture prints the page count — that needs a second pass. */
function countsPages(design: PdfDesign): boolean {
  return design.blocks.some(
    (b) => b.type === 'text' && b.anchor !== 'every' && b.anchor !== 'later' && (fieldsIn(b.text).includes('pages') || b.multiPageOnly),
  );
}

/**
 * Prints a designed document. The company's fields are read here, as the
 * house style reads its letterhead, so no module has to supply them.
 */
export async function renderDesigned(design: PdfDesign, data: DesignData): Promise<Buffer> {
  const company = await prisma.company.findUnique({ where: { id: 'company' } });
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...companyValues(company), ...data.fields })) values[k] = pdfSafe(v ?? '');
  const logo = company?.logoPath && fs.existsSync(company.logoPath) ? company.logoPath : null;

  const first = new Renderer(design, data, values, logo, 1);
  const pdf = await first.render();
  if (!countsPages(design) || first.pageCount === 1) return pdf;
  // A box on page 1 or after the table printed "{{pages}}" before the count
  // was known; lay it out again with the count the first pass found.
  return new Renderer(design, data, values, logo, first.pageCount).render();
}
