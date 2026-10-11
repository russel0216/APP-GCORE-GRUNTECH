import { badRequest } from '../http/kit';

/**
 * CSV import, shared by every master (model §13 decision 4).
 *
 * Gruntech starts clean, so this is not a migration tool — it is the escape
 * hatch for the day someone finds a clean supplier list in a spreadsheet and
 * does not want to retype 200 rows.
 *
 * The contract every importer follows:
 *   1. Download a template with the exact headers.
 *   2. Upload. The server validates EVERY row and reports what it would do.
 *   3. Nothing is written until the same file is posted again with commit=true.
 *
 * A dry run first is the whole point: a half-applied import of master data is
 * far worse than a rejected one, because the bad rows are now indistinguishable
 * from the good ones.
 */

// ── Parsing ──────────────────────────────────────────────────────────────────

/**
 * The text of an uploaded file, whatever Excel or SCORO wrote it in
 * (2026-10-11, the owner's SCORO quotes export: UTF-16 LE with a BOM, which
 * read as UTF-8 is a header of NUL-spaced letters and matches no column). A
 * UTF-16 BOM (FF FE little-endian, FE FF big-endian) decodes the rest as
 * UTF-16 — the big-endian bytes swapped pairwise first, since Node decodes
 * only the little-endian order; a trailing odd byte is left out. Anything
 * else is UTF-8, its own BOM stripped.
 */
export function decodeCsv(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2, 2 + Math.floor((buffer.length - 2) / 2) * 2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const body = Buffer.from(buffer.subarray(2, 2 + Math.floor((buffer.length - 2) / 2) * 2));
    body.swap16();
    return body.toString('utf16le');
  }
  const text = buffer.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * The delimiter a file uses, read off its header line: a TAB when the line
 * holds tabs and no commas, or more tabs than commas (SCORO's exports are
 * tab-separated, 2026-10-11); otherwise the comma. Column names rarely hold
 * a comma and never a tab, so the header is the one line that says.
 */
export function sniffDelimiter(text: string): ',' | '\t' {
  const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const end = text.indexOf('\n', start);
  const header = text.slice(start, end === -1 ? undefined : end);
  const tabs = (header.match(/\t/g) ?? []).length;
  const commas = (header.match(/,/g) ?? []).length;
  return (tabs > 0 && commas === 0) || tabs > commas ? '\t' : ',';
}

/**
 * RFC 4180 parser. Handles quoted fields, embedded commas, doubled quotes and
 * newlines inside quotes — all of which appear the moment someone exports an
 * address column from Excel. The delimiter is sniffed from the header line
 * (`sniffDelimiter`): a tab-separated export parses by the same rules.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const delimiter = sniffDelimiter(text);

  // Strip a UTF-8 BOM; Excel writes one and it silently corrupts the first header.
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  for (; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\r') {
      // handled by the \n branch
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const v = cell === null || cell === undefined ? '' : String(cell);
          return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
        })
        .join(','),
    )
    .join('\r\n');
}

// ── Column definitions ───────────────────────────────────────────────────────

export interface ColumnDef {
  /** Header as it appears in the CSV. */
  header: string;
  required?: boolean;
  /** Example value for the downloadable template. */
  example?: string;
  hint?: string;
}

export interface ImportSpec<T> {
  entity: string;
  label: string;
  columns: ColumnDef[];
  /**
   * Turns one raw row into the record to write, or throws with a readable
   * message. Async so it can look up related records by name or code.
   */
  build: (row: Record<string, string>, rowNumber: number) => Promise<T>;
  /** Natural key used to report a row as an update rather than a create. */
  existing: (row: Record<string, string>) => Promise<string | null>;
  /**
   * For a record that spans rows (SCORO's quotes export with its lines,
   * 2026-10-11: one row per line, the header repeated on each): the key the
   * rows are grouped by, in first-seen order. Set, `runImport` calls
   * `existing` on a group's first row and `buildGroup` (else `build` on the
   * first row) once per group, and reports ONE result per group — `row` the
   * group's first row number, `key` the group key.
   */
  groupBy?: (row: Record<string, string>) => string;
  /** The record of one group of rows; `firstRowNumber` is the first row's, for messages. */
  buildGroup?: (rows: Record<string, string>[], firstRowNumber: number) => Promise<T>;
  /**
   * What the person importing must decide before the file is applied, read
   * off the records the dry run built — returned on the report as `extra`
   * (the SCORO quotes' groups not on the list, 2026-10-11). Their answer
   * comes back with the commit as the route's `options`.
   */
  summarize?(records: T[]): Promise<Record<string, unknown> | undefined>;
}

/** Who is running the import — for the audit rows a writer files inside its transactions. */
export interface ImportActor {
  id: string;
  name: string;
}

export interface RowResult {
  row: number;
  action: 'create' | 'update' | 'error';
  key: string;
  message?: string;
}

export interface ImportReport {
  entity: string;
  committed: boolean;
  total: number;
  created: number;
  updated: number;
  errors: number;
  rows: RowResult[];
  /** The spec's `summarize`: what is asked of the person importing. */
  extra?: Record<string, unknown>;
}

export function templateFor(spec: ImportSpec<unknown>): string {
  return toCsv([spec.columns.map((c) => c.header), spec.columns.map((c) => c.example ?? '')]);
}

/**
 * Validates the file and, when `commit` is set and NOTHING failed, applies it.
 *
 * All-or-nothing on purpose. A partially applied master import leaves the
 * operator unable to tell which rows landed, and re-running it then duplicates
 * the successful half.
 */
export async function runImport<T>(
  text: string,
  spec: ImportSpec<T>,
  commit: boolean,
  write: (records: { record: T; existingId: string | null }[]) => Promise<void>,
): Promise<ImportReport> {
  const grid = parseCsv(text);
  if (grid.length < 2) {
    throw badRequest('The file needs a header row and at least one row of data');
  }

  const headers = grid[0].map((h) => h.trim());
  const missing = spec.columns
    .filter((c) => c.required && !headers.includes(c.header))
    .map((c) => c.header);
  if (missing.length) {
    throw badRequest(
      `The file is missing required column(s): ${missing.join(', ')}. Download the template to see the expected headers.`,
    );
  }

  const results: RowResult[] = [];
  const staged: { record: T; existingId: string | null }[] = [];
  const seenKeys = new Set<string>();

  // The rows, then the groups: one row each, or — for a spec whose record
  // spans rows (`groupBy`) — the rows sharing a key, in the order the key
  // was first seen, the first row's number naming the group in the report.
  const rows: { rowNumber: number; raw: Record<string, string> }[] = [];
  for (let r = 1; r < grid.length; r++) {
    const rowNumber = r + 1; // 1-based, and the header is row 1 — matches Excel
    const raw: Record<string, string> = {};
    headers.forEach((h, c) => {
      raw[h] = (grid[r][c] ?? '').trim();
    });
    rows.push({ rowNumber, raw });
  }
  const groups: { key: string; rowNumber: number; rows: Record<string, string>[] }[] = [];
  if (spec.groupBy) {
    const byKey = new Map<string, (typeof groups)[number]>();
    for (const { rowNumber, raw } of rows) {
      const key = spec.groupBy(raw) || `row ${rowNumber}`;
      const found = byKey.get(key.toLowerCase());
      if (found) found.rows.push(raw);
      else {
        const group = { key, rowNumber, rows: [raw] };
        byKey.set(key.toLowerCase(), group);
        groups.push(group);
      }
    }
  } else {
    for (const { rowNumber, raw } of rows) {
      groups.push({ key: raw[spec.columns[0].header] || `row ${rowNumber}`, rowNumber, rows: [raw] });
    }
  }

  for (const { key, rowNumber, rows: groupRows } of groups) {
    // A file that repeats a key would otherwise apply twice, last one winning,
    // with no indication that it happened. (A grouped spec gathers repeats
    // into one group, so this never fires for it.)
    if (seenKeys.has(key.toLowerCase())) {
      results.push({
        row: rowNumber,
        action: 'error',
        key,
        message: `"${key}" appears more than once in this file`,
      });
      continue;
    }
    seenKeys.add(key.toLowerCase());

    try {
      const existingId = await spec.existing(groupRows[0]);
      const record =
        spec.groupBy && spec.buildGroup ? await spec.buildGroup(groupRows, rowNumber) : await spec.build(groupRows[0], rowNumber);
      staged.push({ record, existingId });
      results.push({ row: rowNumber, action: existingId ? 'update' : 'create', key });
    } catch (err) {
      results.push({
        row: rowNumber,
        action: 'error',
        key,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const errors = results.filter((r) => r.action === 'error').length;
  const shouldWrite = commit && errors === 0;
  const extra = spec.summarize ? await spec.summarize(staged.map((s) => s.record)) : undefined;
  if (shouldWrite) await write(staged);

  return {
    entity: spec.entity,
    committed: shouldWrite,
    total: results.length,
    created: results.filter((r) => r.action === 'create').length,
    updated: results.filter((r) => r.action === 'update').length,
    errors,
    rows: results,
    ...(extra ? { extra } : {}),
  };
}

// ── Field helpers ────────────────────────────────────────────────────────────

export function required(row: Record<string, string>, header: string): string {
  const v = row[header];
  if (!v) throw new Error(`${header} is required`);
  return v;
}

export function optional(row: Record<string, string>, header: string): string | null {
  return row[header] || null;
}

export function decimal(row: Record<string, string>, header: string): number | null {
  const v = row[header];
  if (!v) return null;
  const n = Number(v.replace(/,/g, ''));
  if (!Number.isFinite(n)) throw new Error(`${header} "${v}" is not a number`);
  return n;
}

export function bool(row: Record<string, string>, header: string, fallback = true): boolean {
  const v = (row[header] ?? '').toLowerCase();
  if (!v) return fallback;
  if (['yes', 'y', 'true', '1', 'active'].includes(v)) return true;
  if (['no', 'n', 'false', '0', 'inactive'].includes(v)) return false;
  throw new Error(`${header} "${row[header]}" should be Yes or No`);
}

export function date(row: Record<string, string>, header: string): Date | null {
  const v = row[header];
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`${header} "${v}" is not a date — use YYYY-MM-DD`);
  }
  return d;
}

export function oneOf<T extends string>(
  row: Record<string, string>,
  header: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const v = row[header];
  if (!v) return fallback;
  const match = allowed.find((a) => a.toLowerCase() === v.toLowerCase().replace(/[\s-]/g, '_'));
  if (!match) throw new Error(`${header} "${v}" must be one of: ${allowed.join(', ')}`);
  return match;
}
