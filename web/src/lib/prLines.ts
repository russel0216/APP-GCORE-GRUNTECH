/**
 * The purchase requisition page's line rules (pages/chain/PurchaseRequisition
 * Editor.tsx) — DOM-free, so verify-foundation can pin them.
 *
 * - `prLineAmount` is the server's own `cents(quantity × estimatedCost)` in
 *   routes/procurement.ts, so the page's live figures and the stored ones
 *   agree to the centavo.
 * - `parseDelimited` reads what "Import CSV" opens and what is pasted from a
 *   spreadsheet: tab-separated when the first line has more tabs than commas
 *   (the import's own sniff), quoted fields with doubled quotes, CRLF.
 * - `rowsToPrLines` turns those rows into lines. A first row that names its
 *   columns (Budget line, Part No., Item, Description, Unit, Qty, Est. unit
 *   cost — and the usual spellings of each) is read by name; anything else is
 *   read in the page's own column order from Part No.: Part No., Item,
 *   Description, Unit, Qty, Est. unit cost. A budget line is matched to a cost
 *   category by code, name or its place ("1", "Materials", "MAT"), case-blind.
 */

export interface PrLineDraft {
  partNumber: string;
  name: string;
  description: string;
  unit: string;
  quantity: string;
  estimatedCost: string;
  costCategoryId: string;
}

export interface CategoryRef {
  id: string;
  code: string;
  name: string;
}

/** quantity × cost to the centavo — the server's `cents()`, exactly. */
export function prLineAmount(quantity: number, estimatedCost: number): number {
  return Math.round(quantity * estimatedCost * 100) / 100;
}

/** A number as typed in a sheet: "1,240.00", " 3 ", "PHP 1,240" → 1240; anything else → NaN. */
export function sheetNumber(text: string): number {
  const cleaned = text.replace(/[^\d.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return Number.NaN;
  return Number(cleaned);
}

export function parseDelimited(text: string): string[][] {
  const body = text.replace(/^﻿/, '');
  const firstLine = body.split(/\r?\n/, 1)[0] ?? '';
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  const delimiter = tabs > commas ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

type Column = keyof PrLineDraft;

const HEADERS: Record<string, Column> = {
  'budget line': 'costCategoryId',
  'cost category': 'costCategoryId',
  category: 'costCategoryId',
  'part no': 'partNumber',
  'part no.': 'partNumber',
  'part number': 'partNumber',
  pn: 'partNumber',
  item: 'name',
  'item name': 'name',
  name: 'name',
  description: 'description',
  unit: 'unit',
  uom: 'unit',
  qty: 'quantity',
  quantity: 'quantity',
  'est. unit cost': 'estimatedCost',
  'est unit cost': 'estimatedCost',
  'estimated cost': 'estimatedCost',
  'unit cost': 'estimatedCost',
  cost: 'estimatedCost',
  'unit price': 'estimatedCost',
};

/** The page's own column order, read when the first row names no columns. */
const ORDER: Column[] = ['partNumber', 'name', 'description', 'unit', 'quantity', 'estimatedCost'];

const headerOf = (cell: string) => HEADERS[cell.trim().toLowerCase().replace(/\s+/g, ' ')];

/** A budget line by code, name or place ("1" is the first category). */
export function matchCategory(text: string, categories: CategoryRef[]): string {
  const t = text.trim().toLowerCase();
  if (!t) return '';
  const byPlace = /^\d+$/.test(t) ? categories[Number(t) - 1] : undefined;
  const hit =
    categories.find((c) => c.code.toLowerCase() === t || c.name.toLowerCase() === t) ??
    byPlace ??
    // "1 Materials", "1 · Materials" — the page's own spelling.
    categories.find((c) => t.replace(/^\d+\s*[·.\-]?\s*/, '') === c.name.toLowerCase());
  return hit?.id ?? '';
}

export interface ParsedLines {
  lines: PrLineDraft[];
  /** Rows that could not be read, with why — said on the page, never dropped silently. */
  skipped: string[];
}

export function rowsToPrLines(rows: string[][], categories: CategoryRef[]): ParsedLines {
  if (!rows.length) return { lines: [], skipped: [] };
  const named = rows[0].map(headerOf);
  const hasHeader = named.filter(Boolean).length >= 2;
  const columns: (Column | undefined)[] = hasHeader ? named : ORDER;
  const data = hasHeader ? rows.slice(1) : rows;
  const lines: PrLineDraft[] = [];
  const skipped: string[] = [];
  data.forEach((row, index) => {
    const rowNo = index + (hasHeader ? 2 : 1);
    const line: PrLineDraft = {
      partNumber: '',
      name: '',
      description: '',
      unit: '',
      quantity: '',
      estimatedCost: '',
      costCategoryId: '',
    };
    columns.forEach((column, i) => {
      if (!column) return;
      const cell = (row[i] ?? '').trim();
      if (column === 'costCategoryId') line.costCategoryId = matchCategory(cell, categories);
      else line[column] = cell;
    });
    if (!line.name && !line.description) {
      skipped.push(`Row ${rowNo}: no item or description`);
      return;
    }
    const quantity = line.quantity ? sheetNumber(line.quantity) : 1;
    if (!(quantity > 0)) {
      skipped.push(`Row ${rowNo}: the quantity "${line.quantity}" is not a number above zero`);
      return;
    }
    const cost = line.estimatedCost ? sheetNumber(line.estimatedCost) : 0;
    if (!(cost >= 0)) {
      skipped.push(`Row ${rowNo}: the cost "${line.estimatedCost}" is not a number`);
      return;
    }
    lines.push({ ...line, quantity: String(quantity), estimatedCost: String(cost), unit: line.unit || 'pcs' });
  });
  return { lines, skipped };
}

/**
 * A purchase order's money — `recalcPo()` in routes/procurement.ts, exactly:
 * the subtotal is the lines' amounts; VAT is added to it, or, when the
 * supplier's prices include VAT, taken out of it and the total is the
 * subtotal itself.
 */
export function orderTotals(amounts: number[], vatRate: number, vatInclusive: boolean) {
  const cents = (n: number) => Math.round(n * 100) / 100;
  const subtotal = cents(amounts.reduce((s, a) => s + a, 0));
  const vatAmount = vatInclusive ? cents(subtotal - subtotal / (1 + vatRate)) : cents(subtotal * vatRate);
  const total = vatInclusive ? subtotal : cents(subtotal + vatAmount);
  return { subtotal, vatAmount, total };
}
