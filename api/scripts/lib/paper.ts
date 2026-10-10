/**
 * Reading what the API printed — the ONE copy every verify script imports.
 *
 * Until 2026-10-10 each module group carried its own reader, fetcher and
 * sign-off counters, and the copies had drifted: some counted every
 * "Pending" on the page (a status's "Pending approval" included), some every
 * dated run (a revision's or a comment's date included), and two different
 * functions were both called `flat`. These are the strictest of each.
 *
 * PDFKit Flate-compresses its content streams, so the words are not in the
 * raw bytes. It writes text as `[<hex> kern <hex>] TJ` rather than
 * `(literal) Tj`, and it splits a run at every kerning pair — so "Marikina"
 * arrives as `<4d6172> -15 <696b696e61>`. Both halves of one TJ array belong
 * to the same word, so they are joined with nothing between them and only
 * whole operators are separated.
 */

import zlib from 'node:zlib';
import PDFDocument from 'pdfkit';
import { env } from '../../src/env';
import { prisma } from '../../src/prisma';

const BASE = `http://localhost:${env.port}/api`;

/** A script's own `check`: a label, whether it held, and what to say when it did not. */
export type Check = (label: string, condition: boolean, detail?: string) => void;

// ── Reading a PDF ────────────────────────────────────────────────────────────

/**
 * Each content stream, inflated, in file order — PDFKit writes one a page, in
 * page order. Not every stream is text, and a font program that will not
 * inflate is not a failure.
 */
export function contentStreams(pdf: Buffer): string[] {
  const raw = pdf.toString('latin1');
  const out: string[] = [];
  const stream = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = stream.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    try {
      out.push(zlib.inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1'));
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * WinAnsi's typographic marks in 0x80–0x9F. A standard PDF font draws text in
 * WinAnsi, where "—" is byte 0x97 and "…" 0x85; read as latin1 those bytes
 * would be C1 control characters, so a check for "APPROVED BY —" could never
 * match and a check for its absence could never fail.
 */
const WINANSI_MARKS: Record<number, string> = {
  0x80: '€', 0x85: '…', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x99: '™',
};
const winAnsi = (bytes: string) => bytes.replace(/[\u0080-\u009f]/g, (c) => WINANSI_MARKS[c.charCodeAt(0)] ?? c);

/**
 * One TJ array's string — the inside of `[…] TJ` — its kerned halves joined
 * back into one piece, and its WinAnsi marks read as the characters they draw.
 * Every reader here (`pdfPieces`, `pdfText`, `pdfRuns`) goes through it, so
 * all of them read the same characters.
 */
export function shown(array: string): string {
  let piece = '';
  for (const part of array.matchAll(/<([0-9A-Fa-f]*)>|\(((?:\\.|[^\\()])*)\)/g)) {
    piece += part[1] ? Buffer.from(part[1], 'hex').toString('latin1') : part[2].replace(/\\([()\\])/g, '$1');
  }
  return winAnsi(piece);
}

/** The text runs a PDF shows, in drawing order — a run is what one TJ drew, so a wrapped line is two. */
export function pdfPieces(pdf: Buffer): string[] {
  const out: string[] = [];
  for (const body of contentStreams(pdf)) {
    for (const show of body.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      const piece = shown(show[1]);
      if (piece) out.push(piece);
    }
  }
  return out;
}

/** Readable text out of a rendered PDF: its runs, one to a line. */
export const pdfText = (pdf: Buffer): string => pdfPieces(pdf).join('\n');

export interface PdfRun {
  text: string;
  /** From the left edge, and from the top of its page, at the baseline. */
  x: number;
  y: number;
  /** From 1. */
  page: number;
  /** The standard font's name (Helvetica-Bold …) and the size it was set at. */
  font: string;
  size: number;
}

/**
 * Every text run on every page, with where it was set and in what font and
 * size — enough to say which row of a money block is bold, and to MEASURE a
 * run (`runWidth`). PDFKit sets each run as `Tm`, `Tf`, then the `TJ` that
 * shows it, one content stream a page, and names its fonts /F1… in the page
 * resources.
 */
export function pdfRuns(pdf: Buffer): PdfRun[] {
  const raw = pdf.toString('latin1');
  const height = Number((raw.match(/\/MediaBox \[0 0 [\d.]+ ([\d.]+)\]/) ?? [])[1] ?? 841.89);
  const objects = new Map<string, string>();
  for (const m of raw.matchAll(/(\d+) 0 obj\s*<<\s*\/Type \/Font\s*\/BaseFont \/([\w-]+)/g)) objects.set(m[1], m[2]);
  const fonts = new Map<string, string>();
  for (const dict of raw.matchAll(/\/Font <<([^>]*)>>/g)) {
    for (const m of dict[1].matchAll(/\/(F\d+) (\d+) 0 R/g)) fonts.set(m[1], objects.get(m[2]) ?? 'Helvetica');
  }
  const out: PdfRun[] = [];
  let page = 0;
  for (const body of contentStreams(pdf)) {
    if (!/\]\s*TJ/.test(body)) continue;
    page++;
    let at = { x: 0, y: 0 };
    let font = 'Helvetica';
    let size = 0;
    for (const t of body.matchAll(/1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm|\/(F\d+) ([\d.]+) Tf|\[([^\]]*)\]\s*TJ/g)) {
      if (t[1] !== undefined) at = { x: Number(t[1]), y: Math.round((height - Number(t[2])) * 100) / 100 };
      else if (t[3] !== undefined) {
        font = fonts.get(t[3]) ?? 'Helvetica';
        size = Number(t[4]);
      } else {
        const text = shown(t[5]);
        if (text) out.push({ text, ...at, page, font, size });
      }
    }
  }
  return out;
}

/** Whether a run was set in a bold face. */
export const isBold = (run: Pick<PdfRun, 'font'>) => /-Bold/.test(run.font);

/**
 * The runs that read exactly one of `labels`, in drawing order, each with
 * whether it was set bold — a money block's rows, whose last and only last
 * is the bold one ("Total", "Net collectible", "Released").
 */
export const labelRuns = (pdf: Buffer | null, labels: readonly string[]) =>
  (pdf ? pdfRuns(pdf) : []).filter((r) => labels.includes(r.text)).map((r) => ({ text: r.text, bold: isBold(r) }));
/** "Amount requested, Released*" — label runs as a detail line, a bold one starred. */
export const labelsSaid = (runs: { text: string; bold: boolean }[]) => runs.map((r) => `${r.text}${r.bold ? '*' : ''}`).join(', ') || 'none';

/** How wide a run's ink is, measured the way PDFKit set it (the font's own widths and kerning). */
const measurer = new PDFDocument({ autoFirstPage: false });
export function runWidth(run: PdfRun): number {
  return measurer.font(run.font).fontSize(run.size).widthOfString(run.text);
}

/** Each page's size as "841.89x595.28" — landscape A4 — or "595.28x841.89", portrait. */
export const pageSizes = (pdf: Buffer | null): string[] =>
  [...(pdf?.toString('latin1').matchAll(/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g) ?? [])].map((m) => `${m[1]}x${m[2]}`);
export const LANDSCAPE = '841.89x595.28';
export const PORTRAIT = '595.28x841.89';

// ── Asking the API for paper ─────────────────────────────────────────────────

export interface Printed {
  status: number;
  type: string;
  /** The file, when the route answered one; null on a refusal. */
  bytes: Buffer | null;
  /** Its text runs, one to a line — '' unless the answer was a PDF. */
  text: string;
  /** Each page's size (`pageSizes`). */
  pages: string[];
}

/**
 * A GET as `token`, riding out a dev-server reload: `tsx watch` restarts the
 * API on any saved file, and a refused connection mid-run is that, not a
 * verdict. Only refused connections are retried — they never reached the server.
 */
async function get(token: string, path: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
      if (attempt >= 40 || !String((err as Error)?.cause ?? err).includes('ECONNREFUSED')) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** What a PDF route printed, for whoever holds `token`. */
export async function printed(token: string, path: string): Promise<Printed> {
  const res = await get(token, path);
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok) return { status: res.status, type, bytes: null, text: '', pages: [] };
  const bytes = Buffer.from(await res.arrayBuffer());
  const isPdf = type.includes('application/pdf');
  return { status: res.status, type, bytes, text: isPdf ? pdfText(bytes) : '', pages: isPdf ? pageSizes(bytes) : [] };
}

/** What a list's screen holds for the same query: its rows and its total. */
export async function readScreen(token: string, path: string) {
  const res = await get(token, path);
  const body = (await res.json().catch(() => ({}))) as { rows?: Record<string, unknown>[]; total?: number };
  return { status: res.status, rows: body.rows ?? [], total: body.total ?? -1 };
}

// ── Words on paper ───────────────────────────────────────────────────────────

/** A head, a role or a reference may wrap: read the words, not the line breaks. */
export const flat = (t: string) => t.replace(/\s+/g, ' ');
/** A number or a name may wrap inside a narrow cell: compare with every space gone. */
export const squash = (t: string) => t.replace(/\s+/g, '');
/**
 * The words of a text, line breaks AND punctuation gone — for a sign-off
 * slot, whose role may be cut short with "…" and whose dash prints as the
 * font's own character. `flat` keeps punctuation; this is the looser read,
 * for where punctuation is not what is being checked.
 */
export const words = (t: string) => t.replace(/[^A-Za-z0-9:]+/g, ' ').trim();
/** A run of its own, exactly — "Claimed", never the "Claimed by:" a field prints. */
export const hasLine = (t: string, line: string) => t.split('\n').some((l) => l === line);
/**
 * The runs strictly between the first run reading `from` and the next one
 * reading `to` — a part of the page (a table's body, from its last head to
 * the money block under it), so a check on it never reads the letterhead
 * or the strapline. Empty when either end is missing.
 */
export function between(t: string, from: string, to: string): string[] {
  const lines = t.split('\n');
  const start = lines.indexOf(from);
  const end = start < 0 ? -1 : lines.indexOf(to, start + 1);
  return end < 0 ? [] : lines.slice(start + 1, end);
}

const DATED = /^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M$/;
/** A sign-off's "Pending" is a run of its own — never the "Pending approval" a status prints. */
export const pendingCount = (t: string) => (t.match(/^Pending$/gm) ?? []).length;
/**
 * A dated run: "Oct 10, 2026, 6:07 AM" on a line of its own, as a sign-off
 * prints it under the name. A table that prints such a date in a cell counts
 * too — on such a document count the slots (`signoffSlots`), not the page.
 */
export const signedCount = (t: string) => t.split('\n').filter((l) => DATED.test(l)).length;

// ── Sign-off slots ───────────────────────────────────────────────────────────

export interface Slot {
  /** The slot's role, person and contact lines, as `words`. */
  text: string;
  signed: boolean;
}

/**
 * The sign-off block, slot by slot. Each slot draws its role, the name, the
 * contact lines and last its date or "Pending", so the block — from the last
 * `firstRole` on — splits after those last lines. A slot's text is that one
 * slot's role and person and nothing else: the details or a table name the
 * same people, so a check on WHO signs reads here, never the whole page; and
 * a date in a revision table or a comment thread is not a signature.
 */
export function signoffSlots(text: string, firstRole: string): Slot[] {
  const slots: Slot[] = [];
  const start = text.lastIndexOf(firstRole);
  if (start < 0) return slots;
  let lines: string[] = [];
  for (const line of text.slice(start).split('\n')) {
    lines.push(line);
    const signed = DATED.test(line);
    if (signed || line === 'Pending') {
      slots.push({ text: words(lines.join(' ')), signed });
      lines = [];
    }
  }
  return slots;
}
/** A step's name prints in CAPITALS as its sign-off role, compared by its first three words: a long one is cut short with "…". */
export const roleWords = (step: string) => words(step).toUpperCase().split(' ').slice(0, 3).join(' ');
export const printsRole = (text: string, step: string) => words(text).includes(roleWords(step));
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * The slot is the step's, and names this person straight after its role: the
 * role's first three words in capitals, the rest of the role (or what of it
 * fits before "…"), then the name.
 */
export const signs = (slot: Slot | undefined, step: string, name: string) =>
  !!slot && new RegExp(`^${escapeRe(roleWords(step))}(?: [A-Z0-9:]+)* ${escapeRe(words(name))}(?: |$)`).test(slot.text);
/** The slot names this person anywhere in it — among "A or B", say, on a step several may sign. */
export const names = (slot: Slot | undefined, name: string) => !!slot && ` ${slot.text} `.includes(` ${words(name)} `);
export const slotsSaid = (slots: Slot[]) => slots.map((sl) => `${sl.text.slice(0, 48)}${sl.signed ? ' [dated]' : ' [pending]'}`).join(' | ');

// ── Printed lists (rule 6, A5) ───────────────────────────────────────────────
//
// `GET <list>/pdf` reads the list's own where-builder, so the paper is the
// screen: the same set for the same query (the reference's count is the
// screen's total, every row is on it, the search named), `?ids=` prints only
// the row ticked and says so, a filter is named and prints the screen's rows
// for it and none of the rows it drops, and each print is on the trail as
// EXPORTED with entityId "list". The caller's query must find two rows or
// more, and its filter must split them — `splittingValue` finds a value that
// does — or there is nothing to leave out and the checks prove nothing.

/** "Reference: 3 leave requests" — the count a printed list opens with. */
export const countedAs = (n: number, noun: readonly [string, string]) =>
  `Reference: ${n.toLocaleString('en-PH')} ${n === 1 ? noun[0] : noun[1]}`;
/** The paper says it holds exactly `n` — "Reference: 1 machine", never "1 machines" or "1 machine(s)". */
export const saysCount = (text: string, n: number, noun: readonly [string, string]) =>
  new RegExp(`${escapeRe(countedAs(n, noun))}(?![a-z(])`).test(flat(text));
export const referenceOf = (text: string) => flat(text).match(/Reference:.{0,140}/)?.[0] ?? '';

/** A value of `key` that splits the rows — some have it, some do not — so a filter on it keeps some and drops others. */
export const splittingValue = (rows: Record<string, unknown>[], key: string) =>
  [...new Set(rows.map((r) => String(r[key] ?? '')))].find((v) => {
    const n = rows.filter((r) => String(r[key] ?? '') === v).length;
    return v && n > 0 && n < rows.length;
  }) ?? String(rows[0]?.[key] ?? '');

export async function checkListPaper(
  check: Check,
  o: {
    label: string;
    token: string;
    actorId: string;
    /** The list's path, '/leave'. */
    list: string;
    /** A query that finds this script's own rows, and how the reference names it. */
    query: string;
    named: string;
    noun: readonly [string, string];
    /** What on the paper names a row: its number, code or email. */
    mark: (row: Record<string, unknown>) => string;
    filter: { query: string; named: string };
    entityType: string;
  },
) {
  const exported = () =>
    prisma.auditLog.count({ where: { entityType: o.entityType, entityId: 'list', action: 'EXPORTED', actorId: o.actorId } });
  const before = await exported();
  const has = (text: string, mark: string) => squash(text).includes(squash(mark));

  const screen = await readScreen(o.token, `${o.list}?${o.query}&pageSize=200`);
  const paper = await printed(o.token, `${o.list}/pdf?${o.query}`);
  const missing = screen.rows.map(o.mark).filter((m) => !has(paper.text, m));
  check(
    `${o.label}: ${o.list}/pdf prints the list as the screen shows it — the same count, every row, the search named`,
    paper.status === 200 &&
      paper.type.includes('application/pdf') &&
      screen.total > 0 &&
      saysCount(paper.text, screen.total, o.noun) &&
      !missing.length &&
      flat(paper.text).includes(o.named),
    `${paper.status} ${paper.type} · screen ${screen.total} · missing ${missing.join(', ')} · ${referenceOf(paper.text)}`,
  );

  // With one row there is nothing for `?ids=` to leave out, and the check
  // would pass whatever the route printed: the query must find two or more.
  const [first, ...rest] = screen.rows;
  const others = first ? rest.map(o.mark).filter((m) => m !== o.mark(first)) : [];
  const ticked = await printed(o.token, `${o.list}/pdf?ids=${String(first?.id ?? 'none')}`);
  check(
    `${o.label}: ?ids= prints only the row ticked, and says so`,
    ticked.status === 200 &&
      !!first &&
      others.length > 0 &&
      saysCount(ticked.text, 1, o.noun) &&
      flat(ticked.text).includes('the rows selected') &&
      has(ticked.text, o.mark(first)) &&
      others.every((m) => !has(ticked.text, m)),
    `${ticked.status} · ${referenceOf(ticked.text)} · ${others.length} other row(s) on the screen, ` +
      `${others.filter((m) => has(ticked.text, m)).length} printed`,
  );

  // The filter must NARROW — keep some rows and drop others — or a route that
  // ignored it would print the same count and the same rows, and pass.
  const narrowed = await readScreen(o.token, `${o.list}?${o.filter.query}&pageSize=200`);
  const filtered = await printed(o.token, `${o.list}/pdf?${o.filter.query}`);
  const kept = narrowed.rows.map(o.mark);
  const lost = kept.filter((m) => !has(filtered.text, m));
  const dropped = screen.rows.map(o.mark).filter((m) => !kept.includes(m));
  const leaked = dropped.filter((m) => has(filtered.text, m));
  check(
    `${o.label}: a filter is named (${o.filter.named}), keeps some rows and drops others, and prints exactly the screen's rows for it`,
    filtered.status === 200 &&
      narrowed.status === 200 &&
      narrowed.total > 0 &&
      narrowed.total < screen.total &&
      dropped.length > 0 &&
      flat(filtered.text).includes(o.filter.named) &&
      saysCount(filtered.text, narrowed.total, o.noun) &&
      !lost.length &&
      !leaked.length,
    `${filtered.status} · screen ${screen.total} → ${narrowed.total} · missing ${lost.join(', ')} · ` +
      `printed though dropped ${leaked.join(', ')} · ${referenceOf(filtered.text)}`,
  );
  const after = await exported();
  check(`${o.label}: each print is on the trail as EXPORTED, entityId "list"`, after === before + 3, `${after - before} new row(s)`);
}

/**
 * A view_own holder's paper: only their own rows, whatever they search or
 * tick — somebody else's row named in `?ids=` prints nothing of it.
 */
export async function checkOwnPaper(
  check: Check,
  o: {
    label: string;
    ownToken: string;
    allToken: string;
    list: string;
    query: string;
    noun: readonly [string, string];
    mark: (row: Record<string, unknown>) => string;
  },
) {
  const has = (text: string, mark: string) => squash(text).includes(squash(mark));
  const own = (await readScreen(o.ownToken, `${o.list}?${o.query}&pageSize=200`)).rows;
  const all = (await readScreen(o.allToken, `${o.list}?${o.query}&pageSize=200`)).rows;
  const ownMarks = own.map(o.mark);
  const theirs = all.filter((r) => !ownMarks.includes(o.mark(r)));
  const paper = await printed(o.ownToken, `${o.list}/pdf?${o.query}`);
  check(
    `${o.label}: someone who sees only their own prints only their own`,
    paper.status === 200 &&
      saysCount(paper.text, own.length, o.noun) &&
      ownMarks.every((m) => has(paper.text, m)) &&
      theirs.every((r) => !has(paper.text, o.mark(r))),
    `${paper.status} · own ${own.length}, others ${theirs.length} · ${referenceOf(paper.text)}`,
  );
  // Without somebody else's row in the set the rule has nothing to keep out,
  // and the check would pass whatever the route printed: the caller builds one.
  const [other] = theirs;
  const sneaky = await printed(o.ownToken, `${o.list}/pdf?ids=${String(other?.id ?? 'none')}`);
  check(
    `${o.label}: and ticking somebody else's row prints nothing of it`,
    !!other && sneaky.status === 200 && !has(sneaky.text, o.mark(other)) && saysCount(sneaky.text, 0, o.noun),
    other ? `${sneaky.status} · ${referenceOf(sneaky.text)}` : 'no row of anybody else’s under the query — nothing to keep out',
  );
}
