/**
 * Parsing a spreadsheet attachment into plain rows of text — the only module
 * that imports the spreadsheet library, so it reaches the browser only inside
 * the viewer's worker (spreadsheet.worker.ts). The shapes and the rules about
 * them are in spreadsheet.ts.
 *
 * The library is SheetJS Community Edition from the vendor's own CDN, pinned in
 * package.json by URL and integrity hash. The copy on the npm registry (0.18.5)
 * is years stale and has known flaws when reading a crafted file — never
 * `npm install xlsx` by name.
 */
import * as XLSX from 'xlsx';
import {
  MAX_COLS,
  MAX_ROWS,
  detectHeaderRow,
  extensionOf,
  looksNumeric,
  type ViewSheet,
  type ViewWorkbook,
} from './spreadsheet';

/** A CSV's bytes as text: UTF-8 (the BOM Excel writes is dropped), else the
 *  Windows code page an older Excel saves in. */
function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** The text Excel shows in a cell. `w` is the value through the cell's own
 *  number format — 12,500.00, 01-Jun-26, 15% — which is what a reader expects. */
function cellText(cell: XLSX.CellObject | undefined): string {
  if (!cell || cell.t === 'z') return '';
  if (typeof cell.w === 'string') return cell.w;
  if (cell.v === undefined || cell.v === null) return '';
  if (cell.t === 'b') return cell.v ? 'TRUE' : 'FALSE';
  if (cell.v instanceof Date) return cell.v.toISOString().slice(0, 10);
  return String(cell.v);
}

function readSheet(name: string, ws: XLSX.WorkSheet, typed: boolean): ViewSheet {
  const data = (ws['!data'] ?? []) as (XLSX.CellObject[] | undefined)[];
  const rows: string[][] = [];
  const kinds: string[] = [];
  let colCount = 0;
  let truncatedCols = false;
  let lastRow = -1;

  const rowLimit = Math.min(data.length, MAX_ROWS);
  for (let r = 0; r < rowLimit; r++) {
    const src = data[r] ?? [];
    const row: string[] = [];
    let kind = '';
    let last = -1;
    for (let c = 0; c < src.length; c++) {
      const text = cellText(src[c]);
      if (c >= MAX_COLS) {
        if (text.trim() !== '') truncatedCols = true;
        continue;
      }
      row.push(text);
      const t = src[c]?.t;
      const numeric = typed ? t === 'n' || t === 'd' : looksNumeric(text);
      kind += numeric && text !== '' ? 'n' : 's';
      if (text.trim() !== '') last = c;
    }
    row.length = last + 1;
    rows.push(row);
    kinds.push(kind.slice(0, last + 1).replace(/s+$/, ''));
    if (last >= 0) {
      lastRow = r;
      colCount = Math.max(colCount, last + 1);
    }
  }
  rows.length = lastRow + 1;
  kinds.length = lastRow + 1;

  // sheetRows keeps the sheet's real extent in !fullref when it cuts it short.
  const full = (ws as Record<string, unknown>)['!fullref'];
  const truncatedRows =
    data.length > MAX_ROWS ||
    (typeof full === 'string' && XLSX.utils.decode_range(full).e.r + 1 > MAX_ROWS);

  const spans: ViewSheet['spans'] = [];
  for (const m of ws['!merges'] ?? []) {
    if (m.s.r > lastRow || m.s.c >= colCount) continue;
    const cols = Math.min(m.e.c, colCount - 1) - m.s.c + 1;
    if (cols > 1) spans.push({ r: m.s.r, c: m.s.c, cols });
  }

  const sheet: ViewSheet = { name, rows, kinds, colCount, spans, headerRow: null, truncatedRows, truncatedCols };
  sheet.headerRow = detectHeaderRow(sheet);
  return sheet;
}

/**
 * Every sheet Excel would show, as text. Throws when the bytes are not a
 * workbook the library can read; the viewer says so and offers the download.
 */
export function readWorkbook(data: ArrayBuffer | Uint8Array, fileName: string): ViewWorkbook {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const csv = extensionOf(fileName) === 'csv';
  const options: XLSX.ParsingOptions = {
    dense: true,
    sheetRows: MAX_ROWS + 1,
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    bookVBA: false,
  };
  // A CSV is read as text, untouched: `raw` stops 00123 becoming 123 and a
  // date being re-written in another order.
  const wb = csv
    ? XLSX.read(decodeText(bytes), { ...options, type: 'string', raw: true })
    : XLSX.read(bytes, { ...options, type: 'array' });

  const sheets: ViewSheet[] = [];
  const hiddenSheets: string[] = [];
  let otherSheets = 0;
  wb.SheetNames.forEach((name, i) => {
    const hidden = wb.Workbook?.Sheets?.[i]?.Hidden ?? 0;
    if (hidden === 2) return;
    const ws = wb.Sheets[name];
    if (!ws || (ws['!type'] && ws['!type'] !== 'sheet')) {
      otherSheets++;
      return;
    }
    if (hidden === 1) {
      hiddenSheets.push(name);
      return;
    }
    sheets.push(readSheet(name, ws, !csv));
  });
  return { sheets, hiddenSheets, otherSheets };
}
