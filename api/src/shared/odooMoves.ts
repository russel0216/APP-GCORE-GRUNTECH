import { createHash } from 'node:crypto';
import { odooKey, odooNumber, tidy } from './odooMigration';

/**
 * Odoo's "Product Moves" export (stock.move.line), read for HISTORY
 * (2026-11-25, the owner's call: "we just want to know where the product
 * moved — don't create a pull-out slip"). Pure rules; the import and the
 * stock card read them. Nothing here touches stock.
 *
 * The export, as Odoo writes it: Date ("2026-11-19 14:21:20", the user's own
 * clock — Manila), Reference (WH/OUT/04895, WH/IN/02323, "Product Quantity
 * Confirmed"), Product ("[Internal Reference] Name" — and G-CORE keeps Odoo's
 * Name WHOLE as the part number), From, To, Contact, Quantity, Unit, Status,
 * Created by.
 */

export const MOVE_HEADERS = {
  date: 'Date',
  reference: 'Reference',
  product: 'Product',
  from: 'From',
  to: 'To',
  contact: 'Contact',
  quantity: 'Quantity',
  unit: 'Unit',
  status: 'Status',
  by: 'Created by',
} as const;

export const ODOO_MOVE_KINDS = ['RECEIPT', 'DELIVERY', 'RETURN_IN', 'RETURN_OUT', 'ADJUSTMENT', 'TRANSFER', 'OTHER'] as const;
export type OdooMoveKind = (typeof ODOO_MOVE_KINDS)[number];

/**
 * The part numbers a Product cell may stand for, likeliest first. Odoo shows
 * a product as "[Internal Reference] Name"; either part may itself hold a
 * "]", so the cut after the FIRST "] " is tried, then after the last, then
 * the whole text (a product with no internal reference has no bracket).
 */
export function moveProductNames(product: string): string[] {
  const text = tidy(product);
  const out: string[] = [];
  const add = (v: string) => {
    const t = tidy(v);
    if (t && !out.includes(t)) out.push(t);
  };
  if (text.startsWith('[')) {
    const first = text.indexOf('] ');
    const last = text.lastIndexOf('] ');
    if (first > 0) add(text.slice(first + 2));
    if (last > 0) add(text.slice(last + 2));
  }
  add(text);
  return out;
}

/** The description Odoo printed in the brackets, for a message. */
export function moveProductLabel(product: string): string {
  return moveProductNames(product)[0] ?? tidy(product);
}

type Place = 'vendor' | 'customer' | 'virtual' | 'internal';
function placeOf(location: string): Place {
  const l = tidy(location).toLowerCase();
  if (l.startsWith('partner locations/vendor') || l.startsWith('partner locations/supplier')) return 'vendor';
  if (l.startsWith('partner locations/customer')) return 'customer';
  if (l.startsWith('partner location')) return 'customer';
  if (l.startsWith('virtual location')) return 'virtual';
  return 'internal';
}

/**
 * What a move was, read off its two locations: a supplier to the warehouse is
 * a receipt, the warehouse to a customer a delivery, either the other way a
 * return, a virtual location (inventory adjustment, scrap, production) an
 * adjustment, warehouse to warehouse a transfer. `direction` is the sign on
 * the warehouse: +1 in, -1 out, 0 inside it.
 */
export function moveKind(from: string, to: string): { kind: OdooMoveKind; direction: -1 | 0 | 1 } {
  const a = placeOf(from);
  const b = placeOf(to);
  const direction = a !== 'internal' && b === 'internal' ? 1 : a === 'internal' && b !== 'internal' ? -1 : 0;
  if (a === 'internal' && b === 'internal') return { kind: 'TRANSFER', direction: 0 };
  if (a === 'virtual' || b === 'virtual') return { kind: 'ADJUSTMENT', direction };
  if (a === 'vendor' && b === 'internal') return { kind: 'RECEIPT', direction };
  if (a === 'internal' && b === 'customer') return { kind: 'DELIVERY', direction };
  if (a === 'customer' && b === 'internal') return { kind: 'RETURN_IN', direction };
  if (a === 'internal' && b === 'vendor') return { kind: 'RETURN_OUT', direction };
  return { kind: 'OTHER', direction };
}

export const MOVE_KIND_LABELS: Record<OdooMoveKind, string> = {
  RECEIPT: 'Receipt',
  DELIVERY: 'Delivery',
  RETURN_IN: 'Customer return',
  RETURN_OUT: 'Return to supplier',
  ADJUSTMENT: 'Adjustment',
  TRANSFER: 'Transfer',
  OTHER: 'Other',
};

/**
 * Odoo's date as an instant. The export carries the user's own wall clock
 * (Manila: the deliveries read 09:00–18:00), so it is read as Manila time.
 * Takes "2026-11-19 14:21:20" (Odoo), the same with a T, a date alone, and
 * Excel's "11/19/2026 14:21" / "11/19/26 2:21 PM" for a sheet re-saved there.
 */
export function moveDate(text: string): Date {
  const v = tidy(text);
  if (!v) throw new Error('Date is required');
  let y: number, mo: number, d: number, h = 0, mi = 0, s = 0;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/.exec(v);
  if (m) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    [h, mi, s] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
  } else {
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/.exec(v);
    if (!m) throw new Error(`Date "${text}" is not a date — Odoo writes 2026-11-19 14:21:20`);
    [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (y < 100) y += 2000;
    [h, mi, s] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
    const half = m[7]?.toLowerCase();
    if (half === 'pm' && h < 12) h += 12;
    if (half === 'am' && h === 12) h = 0;
  }
  const at = new Date(Date.UTC(y, mo - 1, d, h - 8, mi, s));
  const back = new Date(at.getTime() + 8 * 3_600_000);
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59 || back.getUTCDate() !== d || back.getUTCMonth() !== mo - 1 || y < 1990 || y > 2100) {
    throw new Error(`Date "${text}" is not a date — Odoo writes 2026-11-19 14:21:20`);
  }
  return at;
}

export interface OdooMove {
  occurredAt: Date;
  reference: string;
  kind: OdooMoveKind;
  direction: -1 | 0 | 1;
  fromLocation: string;
  toLocation: string;
  contact: string | null;
  quantity: number;
  unit: string | null;
  createdByName: string | null;
  importKey: string;
}

export interface OdooMoveSet {
  /** Odoo's Product cell, as written. */
  product: string;
  /** The part numbers it may stand for, likeliest first (upper-cased keys). */
  keys: string[];
  moves: OdooMove[];
  /** Rows with quantity 0 — stock counts that changed nothing; left out. */
  zeroRows: number;
  /** Rows whose Status is not Done — never happened; left out. */
  notDone: number;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The rows of ONE product as its moves. A row that moved nothing (quantity 0)
 * or was never done is counted, not kept. The once-only key is the line's own
 * facts, and — for two lines alike in every fact — its place among them, so
 * the same export read twice adds nothing and two real identical lines both
 * stay.
 */
export function readMoves(rows: Record<string, string>[]): OdooMoveSet {
  const product = tidy(rows[0]?.[MOVE_HEADERS.product]);
  if (!product) throw new Error('Product is required');
  const set: OdooMoveSet = { product, keys: moveProductNames(product).map(odooKey), moves: [], zeroRows: 0, notDone: 0 };
  const seen = new Map<string, number>();
  for (const row of rows) {
    const status = tidy(row[MOVE_HEADERS.status]);
    if (status && status.toLowerCase() !== 'done') {
      set.notDone += 1;
      continue;
    }
    const quantity = round3(Math.abs(odooNumber(row[MOVE_HEADERS.quantity])));
    if (quantity === 0) {
      set.zeroRows += 1;
      continue;
    }
    const occurredAt = moveDate(row[MOVE_HEADERS.date] ?? '');
    const reference = tidy(row[MOVE_HEADERS.reference]) || '—';
    const fromLocation = tidy(row[MOVE_HEADERS.from]);
    const toLocation = tidy(row[MOVE_HEADERS.to]);
    if (!fromLocation || !toLocation) throw new Error(`${reference}: From and To are required`);
    const contact = tidy(row[MOVE_HEADERS.contact]) || null;
    const facts = [occurredAt.toISOString(), reference, fromLocation, toLocation, contact ?? '', quantity.toFixed(3)].join('|').toLowerCase();
    const nth = seen.get(facts) ?? 0;
    seen.set(facts, nth + 1);
    set.moves.push({
      occurredAt,
      reference,
      ...moveKind(fromLocation, toLocation),
      fromLocation,
      toLocation,
      contact,
      quantity,
      unit: tidy(row[MOVE_HEADERS.unit]) || null,
      createdByName: tidy(row[MOVE_HEADERS.by]) || null,
      importKey: createHash('sha1').update(`${facts}#${nth}`).digest('hex'),
    });
  }
  return set;
}

/** Received and delivered, in the item's unit — what the card's head says. */
export function moveTotals(moves: { direction: number; quantity: number }[]): { in: number; out: number } {
  let i = 0;
  let o = 0;
  for (const m of moves) {
    if (m.direction > 0) i += m.quantity;
    else if (m.direction < 0) o += m.quantity;
  }
  return { in: round3(i), out: round3(o) };
}
