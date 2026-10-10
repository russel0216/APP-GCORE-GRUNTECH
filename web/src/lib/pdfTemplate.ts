/**
 * The quotation PDF's layout, as Admin › PDF Templates edits it — the shapes
 * of `api/src/shared/pdfDesign.ts`, and its rule for filling text with field
 * values, so a box on the editor's page reads the way it will print.
 *
 * DOM-free: `verify-foundation.ts` imports `resolveTemplate` from here and
 * holds it equal to the server's on the same cases. It is a copy of that rule
 * for the page's preview, never a second rule — change both together.
 */

/** A4, in points. */
export const PAGE_WIDTH = 595.28;
export const PAGE_HEIGHT = 841.89;

export type Orientation = 'portrait' | 'landscape';

/** The page a layout draws on: A4 upright, or on its side (the sales order). */
export function pageSizeOf(layout: { orientation?: Orientation }): { w: number; h: number } {
  return layout.orientation === 'landscape' ? { w: PAGE_HEIGHT, h: PAGE_WIDTH } : { w: PAGE_WIDTH, h: PAGE_HEIGHT };
}

export type Anchor = 'first' | 'every' | 'later' | 'after' | 'last';
export type Align = 'left' | 'center' | 'right';
export type ColumnKey = 'no' | 'product' | 'qtyUnit' | 'qty' | 'unit' | 'unitPrice' | 'amount' | 'group' | 'cost' | 'margin';

interface Base {
  id: string;
  name?: string;
  anchor: Anchor;
  x: number;
  y: number;
  w: number;
  h: number;
  showIf?: string | null;
}

export interface TextBlock extends Base {
  type: 'text';
  text: string;
  size: number;
  bold: boolean;
  italic: boolean;
  color: string;
  align: Align;
  uppercase: boolean;
  spacing: number;
  lineGap: number;
  fit: boolean;
  multiPageOnly: boolean;
}

export interface LineBlock extends Base {
  type: 'line';
  color: string;
}

export interface BoxBlock extends Base {
  type: 'box';
  color: string;
}

export interface LogoBlock extends Base {
  type: 'logo';
  align: Align;
}

export interface ItemColumn {
  key: ColumnKey;
  label: string;
  width: number;
  align: Align;
}

export interface ItemsBlock extends Base {
  type: 'items';
  columns: ItemColumn[];
  size: number;
  headColor: string;
  headingColor: string;
  textColor: string;
  bodyColor: string;
  ruleColor: string;
}

export interface TotalsBlock extends Base {
  type: 'totals';
  size: number;
  labelWidth: number;
  textColor: string;
  accentColor: string;
  ruleColor: string;
}

export interface SignoffsBlock extends Base {
  type: 'signoffs';
  size: number;
  colWidth: number;
  headColor: string;
  textColor: string;
  /** The name, in bold, at this size. */
  nameSize: number;
  showPosition: boolean;
  showPhone: boolean;
  showEmail: boolean;
}

export type Block = TextBlock | LineBlock | BoxBlock | LogoBlock | ItemsBlock | TotalsBlock | SignoffsBlock;
export type BlockType = Block['type'];

export interface Layout {
  version: 1;
  orientation?: Orientation;
  flowTop: number;
  flowBottom: number;
  blocks: Block[];
}

export interface FieldDef {
  key: string;
  label: string;
  group: string;
  sample?: string;
}

export type PdfCell = string | { title: string; body?: string };

export interface Sample {
  rows: ({ heading: string } | { cells: Partial<Record<ColumnKey, PdfCell>> })[];
  totals: { label: string; value: string; bold?: boolean }[] | null;
  signatories: { role: string; name?: string; position?: string; phone?: string; email?: string; at?: string | null }[];
}

export const ANCHOR_LABELS: Record<Anchor, string> = {
  first: 'Page 1',
  every: 'Every page',
  later: 'Pages 2 onward',
  after: 'Follows the lines',
  last: 'Last page',
};

/** What each anchor means, for the one line of help under the choice. */
export const ANCHOR_HINTS: Record<Anchor, string> = {
  first: 'Stays where you put it on the first page. If a box above it grows, it moves down with it.',
  every: 'Printed on every page, where you put it — a footer, a strapline, a page number.',
  later: 'Printed on every page after the first — a running header.',
  after: 'Follows the lines: it keeps its distance below the table, or below the box above it, wherever the table ends. With nothing to print it closes up.',
  last: 'Stays where you put it on the last page, keeping its bottom edge: when it prints more than the box holds it grows upward, never into the footer. If the content reaches it, it starts a page of its own.',
};

/** The anchors a kind of box may take. */
export const ANCHORS_FOR: Record<BlockType, Anchor[]> = {
  text: ['first', 'every', 'later', 'after', 'last'],
  line: ['first', 'every', 'later', 'after', 'last'],
  box: ['first', 'every', 'later', 'after', 'last'],
  logo: ['first', 'every', 'later', 'after', 'last'],
  items: ['first'],
  totals: ['after', 'last'],
  signoffs: ['after', 'last'],
};

export const TYPE_LABELS: Record<BlockType, string> = {
  text: 'Text',
  line: 'Line',
  box: 'Box',
  logo: 'Logo',
  items: 'Line table',
  totals: 'Totals',
  signoffs: 'Sign-offs',
};

/** The house colours, offered as swatches beside every colour choice. */
export const SWATCHES: { name: string; value: string }[] = [
  { name: 'Purple', value: '#5B2A8C' },
  { name: 'Green', value: '#2E9A4B' },
  { name: 'Ink', value: '#222222' },
  { name: 'Description grey', value: '#555555' },
  { name: 'Grey', value: '#666666' },
  { name: 'Rule', value: '#D9D9D9' },
  { name: 'Light panel', value: '#F2F2F2' },
  { name: 'White', value: '#FFFFFF' },
];

// ── Template text: the server's rule, copied ─────────────────────────────────

const PLACEHOLDER = /\{\{\s*([A-Za-z][A-Za-z0-9.]*)\s*(?:\|([^{}]*))?\}\}/g;

export interface Run {
  text: string;
  bold: boolean;
}

/** Every field a piece of template text names. */
export function fieldsIn(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1]);
}

/**
 * Template text as lines of runs, with the values put in. Lines split at
 * newlines and parts of a line at " | "; a part whose fields are all empty is
 * left out, and a line whose parts all went goes with them. `{{field|—}}`
 * prints "—" when the field is empty. `**` marks bold in the template only.
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

/** Template text resolved flat, for a one-line label such as a column's. */
export function resolveInline(text: string, values: Record<string, string | undefined>): string {
  return resolveTemplate(text, values)
    .map((line) => line.map((r) => r.text).join(''))
    .join(' ');
}

// ── Editing helpers ──────────────────────────────────────────────────────────

/** A point value as the editor keeps it: to a hundredth, so a nudge never accumulates float dust. */
export const pt = (v: number) => Math.round(v * 100) / 100;

export function clampToPage<B extends Block>(b: B, page: { w: number; h: number } = { w: PAGE_WIDTH, h: PAGE_HEIGHT }): B {
  const w = Math.min(Math.max(b.w, 1), page.w);
  const h = Math.min(Math.max(b.h, 0.25), page.h);
  return {
    ...b,
    w: pt(w),
    h: pt(h),
    x: pt(Math.min(Math.max(b.x, 0), page.w - w)),
    y: pt(Math.min(Math.max(b.y, 0), page.h - h)),
  };
}

/** Where the boxes that follow the lines may start: under the table as drawn. */
export function tableBottom(layout: Layout): number {
  const items = layout.blocks.find((b) => b.type === 'items');
  return items ? items.y + items.h : 0;
}

/**
 * What a company field is called in Admin › Company Settings — where an
 * empty one is filled in. The strapline is the tagline, else the website.
 */
export const COMPANY_SETTING_NAMES: Record<string, string> = {
  'company.name': 'Registered / legal name',
  'company.tradeName': 'Trading name',
  'company.address': 'Address',
  'company.country': 'Country',
  'company.phone': 'Tel',
  'company.fax': 'Fax',
  'company.email': 'Email',
  'company.website': 'Website',
  'company.tin': 'TIN',
  'company.regNo': 'Reg. No.',
  'company.tagline': 'Document tagline',
  'company.strapline': 'Document tagline',
  'company.bankName': 'Bank name',
  'company.bankBranch': 'Bank branch',
  'company.bankAccount': 'Bank account',
};

/**
 * The fields these boxes name that have nothing in them right now, so the
 * parts and lines that print them are left out. A field with a fallback
 * (`{{x|—}}`) is not one of them — it prints the fallback — and neither is
 * the page count, which is always known.
 */
export function emptyFieldsIn(blocks: Block[], values: Record<string, string | undefined>): string[] {
  const out = new Set<string>();
  for (const b of blocks) {
    const texts = b.type === 'text' ? [b.text] : b.type === 'items' ? b.columns.map((c) => c.label) : [];
    for (const t of texts) {
      for (const m of t.matchAll(PLACEHOLDER)) {
        const [, key, fallback] = m;
        if (key === 'page' || key === 'pages' || (fallback ?? '').trim()) continue;
        if (!(values[key] ?? '').trim()) out.add(key);
      }
    }
  }
  return [...out];
}

/** "Tel, Fax and Email". */
export function listOf(items: string[]): string {
  const unique = [...new Set(items)];
  return unique.length < 2 ? (unique[0] ?? '') : `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
}

/**
 * The field keys a layout names that the document does not have — the same
 * check the server makes on save, shown beside the box before then.
 */
export function unknownFieldsIn(block: Block, known: Set<string>): string[] {
  const texts = block.type === 'text' ? [block.text] : block.type === 'items' ? block.columns.map((c) => c.label) : [];
  const out = new Set<string>();
  for (const t of texts) for (const key of fieldsIn(t)) if (!known.has(key)) out.add(key);
  if (block.showIf && !known.has(block.showIf)) out.add(block.showIf);
  return [...out];
}
