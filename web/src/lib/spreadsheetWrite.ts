/**
 * Writes an .xlsx in the browser (2026-11-23, the HR attendance report).
 * Loaded with a dynamic import only when a report is asked for, so the main
 * bundle never carries the spreadsheet library — the reader's rule
 * (`spreadsheetRead.ts`). The workbook is plain values: text, numbers and
 * links; nothing leaves the browser but the download.
 */
import * as XLSX from 'xlsx';

export type SheetCell = string | number | null | { text: string; link: string };

export function downloadWorkbook(fileName: string, sheetName: string, head: string[], rows: SheetCell[][], widths?: number[]) {
  const aoa = [head, ...rows.map((r) => r.map((c) => (c && typeof c === 'object' ? c.text : (c ?? ''))))];
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  // Links (a map position) keep their words and open on a click.
  rows.forEach((r, i) =>
    r.forEach((c, j) => {
      if (c && typeof c === 'object') {
        const ref = XLSX.utils.encode_cell({ r: i + 1, c: j });
        if (sheet[ref]) sheet[ref].l = { Target: c.link };
      }
    }),
  );
  if (widths) sheet['!cols'] = widths.map((wch) => ({ wch }));
  sheet['!autofilter'] = { ref: XLSX.utils.encode_range({ r: 0, c: 0 }, { r: rows.length, c: head.length - 1 }) };
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, sheetName.slice(0, 31));
  XLSX.writeFile(book, fileName);
}
