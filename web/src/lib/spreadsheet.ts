/**
 * Reading a spreadsheet attachment in the browser — the shapes and the rules.
 *
 * A browser cannot show a workbook, so an attached price list used to download
 * every time somebody only wanted to look up one figure. `/files/:id`
 * (pages/FileViewer.tsx) shows it instead: values as Excel displays them,
 * read-only, one tab per sheet.
 *
 * This module is DOM-free and does NOT import the spreadsheet library, so the
 * screens that only ask "is this a spreadsheet?" do not pull half a megabyte
 * into the main bundle. The parsing itself is `spreadsheetRead.ts`, run in a
 * worker (`spreadsheet.worker.ts`) — a file somebody uploaded is untrusted
 * input, and parsing it away from the page means a malformed one can fail, or
 * hang, without taking the screen or the signed-in session with it.
 * verify-foundation imports both modules and pins these rules.
 */

/** What opens in the viewer, by extension. The MIME type is no guide: Windows
 *  with Excel installed uploads a .csv as application/vnd.ms-excel. */
export const SPREADSHEET_EXTENSIONS = ['xlsx', 'xlsm', 'xlsb', 'xls', 'ods', 'csv'] as const;

/** Above this a file downloads instead — the parse runs in the viewer's own
 *  browser, often a site laptop. */
export const MAX_VIEW_BYTES = 25 * 1024 * 1024;
/** Rows read per sheet, and columns kept. Past either, the sheet says so. */
export const MAX_ROWS = 50_000;
export const MAX_COLS = 256;

/** One sheet as the viewer shows it. Row and column indices are Excel's, from
 *  A1, zero-based: rows[4][1] is B5. */
export interface ViewSheet {
  name: string;
  /** The text Excel shows in each cell (`''` when empty). Trailing empty rows
   *  and columns are trimmed, and a row may stop at its own last value. */
  rows: string[][];
  /** Per row, one character per cell: `n` for a number or date (aligned right,
   *  as Excel aligns it), anything else is text. May be shorter than the row. */
  kinds: string[];
  /** Columns in use, the widest row's. */
  colCount: number;
  /** Merged cells, horizontally: the cell at (r, c) spans `cols` columns. A
   *  vertical merge keeps its value in its top cell, which is where it sits. */
  spans: { r: number; c: number; cols: number }[];
  /** The row that names the columns, guessed; null when nothing looks like one. */
  headerRow: number | null;
  truncatedRows: boolean;
  truncatedCols: boolean;
}

export interface ViewWorkbook {
  sheets: ViewSheet[];
  /** Sheets Excel would not show either. Very hidden ones are not even named,
   *  as Excel's own Unhide does not name them. */
  hiddenSheets: string[];
  /** Chart and macro sheets: nothing to show as a grid. */
  otherSheets: number;
}

export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase();
}

export function isSpreadsheet(file: { fileName: string }): boolean {
  return (SPREADSHEET_EXTENSIONS as readonly string[]).includes(extensionOf(file.fileName));
}

/** Excel's column name: 0 → A, 25 → Z, 26 → AA, 701 → ZZ, 702 → AAA. */
export function columnName(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/*
  Does a cell's TEXT read as a number? Only for plain text, where the file
  carries no type — a CSV. A workbook says what each cell is, and that wins:
  a part number typed as text in Excel stays text here.

  Accepted: 12500, 12,500.00, -3.5, (1,234.00), 12%, 1.2E+10, ₱12,500.00,
  PHP 1,562.20. Not: 00123 (a code — the leading zero is the point of it),
  ACS580 (a model), 6/1/26 (a date in a CSV is just text).
*/
const NUMBER_TEXT =
  /^\s*\(?\s*(?:(?:PHP|USD|EUR|SGD|JPY|GBP|AUD|CNY|HKD)\s|[₱$€£¥]\s?)?[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:E[+-]\d+)?\s*%?\s*\)?\s*$/;

export function looksNumeric(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^[-+]?0\d/.test(t)) return false;
  return NUMBER_TEXT.test(t);
}

/**
 * The row that names the columns, so it can stay in view while the rows under
 * it scroll — Excel's Freeze Panes — and head the results of a search.
 *
 * A price list rarely starts with it: a title, a validity line and a blank row
 * usually come first. The heading row is the first of the opening thirty that
 * fills most of the sheet's width (60% of the widest of the first two hundred
 * rows, and at least two cells) with mostly text. Nothing qualifying → null;
 * the screen lets the reader pick another row, or none.
 */
export function detectHeaderRow(sheet: Pick<ViewSheet, 'rows' | 'kinds'>): number | null {
  const filled = (r: number) => (sheet.rows[r] ?? []).filter((v) => v.trim() !== '').length;
  let widest = 0;
  for (let r = 0; r < Math.min(sheet.rows.length, 200); r++) widest = Math.max(widest, filled(r));
  if (widest < 2) return null;
  const need = Math.max(2, Math.ceil(widest * 0.6));
  for (let r = 0; r < Math.min(sheet.rows.length, 30); r++) {
    const row = sheet.rows[r] ?? [];
    const kinds = sheet.kinds[r] ?? '';
    let count = 0;
    let text = 0;
    row.forEach((v, c) => {
      if (v.trim() === '') return;
      count++;
      if (kinds[c] !== 'n') text++;
    });
    if (count >= need && text >= count * 0.7) return r < sheet.rows.length - 1 ? r : null;
  }
  return null;
}

/** Case- and comma-blind, so "12500" finds 12,500.00. */
export function searchKey(text: string): string {
  return text.toLowerCase().replace(/,/g, '');
}

/** Each row's cells as one search key, joined on a character nobody types so a
 *  match never runs across two cells. Built once per sheet. */
export function rowKeys(sheet: Pick<ViewSheet, 'rows'>): string[] {
  return sheet.rows.map((row) => searchKey(row.join('\u0001')));
}

/**
 * Where `query` sits in one cell's text, as [start, end) ranges of the text
 * as shown — found the way `matchingRows` finds a row (case- and comma-blind),
 * so "9137.25" marks the whole of "9,137.25", commas included.
 */
export function matchRanges(text: string, query: string): [number, number][] {
  const needle = searchKey(query.trim());
  if (!needle || !text) return [];
  // The text as searched, and the index in `text` each character came from.
  let flat = '';
  const from: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ',') continue;
    const lower = text[i].toLowerCase();
    flat += lower;
    for (let k = 0; k < lower.length; k++) from.push(i);
  }
  const out: [number, number][] = [];
  let at = flat.indexOf(needle);
  while (at >= 0) {
    out.push([from[at], from[at + needle.length - 1] + 1]);
    at = flat.indexOf(needle, at + needle.length);
  }
  return out;
}

/** The rows of a sheet holding `query`, in order. An empty query matches none. */
export function matchingRows(keys: string[], query: string): number[] {
  const needle = searchKey(query.trim());
  if (!needle) return [];
  const out: number[] = [];
  keys.forEach((k, r) => {
    if (k.includes(needle)) out.push(r);
  });
  return out;
}
