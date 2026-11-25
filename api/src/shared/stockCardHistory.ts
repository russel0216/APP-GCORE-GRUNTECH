import { prisma } from '../prisma';
import { MOVE_KIND_LABELS, type OdooMoveKind } from './odooMoves';

/**
 * What the stock card says beside its movements (2026-11-25, the owner's
 * call: "view the product movement once I click the product … for the future
 * pull-out slip in G-CORE, it should reflect the pull-out slip and incoming"):
 *
 * - `withDocuments()` — each of G-CORE's own movements with the slip or
 *   report behind it as a link, and where the goods came from and went to;
 * - `odooHistory()` — where the product moved in Odoo before G-CORE, read
 *   only (`OdooStockMove`; nothing here touches stock).
 */

const num = (v: unknown) => Number(v ?? 0);
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const join = (...parts: (string | null | undefined)[]) => parts.map((p) => (p ?? '').trim()).filter(Boolean).join(' · ');

export interface MovementDocument {
  /** The page of the slip or report that moved the stock, when it has one. */
  link: string | null;
  from: string | null;
  to: string | null;
}

interface MoveLike {
  id: string;
  quantity: unknown;
  sourceType: string;
  sourceId: string | null;
  warehouse: { name: string };
}

/** The other end of each movement, by the document that made it. */
async function counterparties(moves: MoveLike[]): Promise<Map<string, { link: string; party: string | null }>> {
  const ids = (type: string) => [...new Set(moves.filter((m) => m.sourceType === type && m.sourceId).map((m) => m.sourceId!))];
  const [receivings, issues, pullouts, borrows] = await Promise.all([
    ids('receiving').length
      ? prisma.receiving.findMany({
          where: { id: { in: ids('receiving') } },
          select: { id: true, sourceName: true, supplier: { select: { name: true } }, order: { select: { number: true, supplier: { select: { name: true } } } } },
        })
      : [],
    ids('stock_issue').length
      ? prisma.stockIssue.findMany({
          where: { id: { in: ids('stock_issue') } },
          select: {
            id: true,
            issuedToName: true,
            deliverTo: true,
            issuedTo: { select: { name: true } },
            job: { select: { number: true } },
            salesOrder: { select: { number: true } },
          },
        })
      : [],
    ids('pullout_slip').length
      ? prisma.pulloutSlip.findMany({
          where: { id: { in: ids('pullout_slip') } },
          select: {
            id: true,
            destination: true,
            receivedByName: true,
            requestedBy: { select: { name: true } },
            job: { select: { number: true } },
            salesOrder: { select: { number: true } },
          },
        })
      : [],
    ids('borrow_slip').length
      ? prisma.borrowSlip.findMany({ where: { id: { in: ids('borrow_slip') } }, select: { id: true, borrowerName: true, siteLocation: true, borrower: { select: { name: true } } } })
      : [],
  ]);
  const out = new Map<string, { link: string; party: string | null }>();
  for (const r of receivings) {
    out.set(`receiving:${r.id}`, { link: `/g-chain/incoming/${r.id}`, party: join(r.supplier?.name ?? r.order?.supplier?.name ?? r.sourceName, r.order?.number) || null });
  }
  for (const s of issues) {
    out.set(`stock_issue:${s.id}`, {
      link: `/g-chain/outgoing/${s.id}`,
      party: join(s.deliverTo, s.issuedTo?.name ?? s.issuedToName, s.job?.number, s.salesOrder?.number) || null,
    });
  }
  for (const p of pullouts) {
    out.set(`pullout_slip:${p.id}`, {
      link: `/g-chain/pullout-slips/${p.id}`,
      party: join(p.destination, p.receivedByName ?? p.requestedBy?.name, p.job?.number, p.salesOrder?.number) || null,
    });
  }
  for (const b of borrows) {
    out.set(`borrow_slip:${b.id}`, { link: `/g-chain/borrow-slips/${b.id}`, party: join(b.borrower?.name ?? b.borrowerName, b.siteLocation) || null });
  }
  return out;
}

/** Each movement with its document's link and its two ends: stock coming in is party → warehouse, going out warehouse → party. */
export async function withDocuments<T extends MoveLike>(moves: T[]): Promise<(T & MovementDocument)[]> {
  const docs = await counterparties(moves);
  return moves.map((m) => {
    const doc = m.sourceId ? docs.get(`${m.sourceType}:${m.sourceId}`) : undefined;
    const party = doc?.party ?? (m.sourceType === 'odoo_opening' ? 'Odoo — opening balance' : null);
    const incoming = num(m.quantity) > 0;
    return { ...m, link: doc?.link ?? null, from: incoming ? party : m.warehouse.name, to: incoming ? m.warehouse.name : party };
  });
}

/** The newest rows the card shows at once; the totals always cover every row. */
export const ODOO_HISTORY_SHOWN = 1_000;

export async function odooHistory(itemId: string) {
  const [total, sums, edge, rows] = await Promise.all([
    prisma.odooStockMove.count({ where: { itemId } }),
    prisma.odooStockMove.groupBy({ by: ['direction'], where: { itemId }, _sum: { quantity: true } }),
    prisma.odooStockMove.aggregate({ where: { itemId }, _min: { occurredAt: true }, _max: { occurredAt: true } }),
    prisma.odooStockMove.findMany({ where: { itemId }, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: ODOO_HISTORY_SHOWN }),
  ]);
  if (!total) return null;
  const sumOf = (d: number) => round3(sums.filter((s) => (d > 0 ? s.direction > 0 : s.direction < 0)).reduce((n, s) => n + num(s._sum.quantity), 0));
  return {
    total,
    received: sumOf(1),
    delivered: sumOf(-1),
    first: edge._min.occurredAt,
    last: edge._max.occurredAt,
    rows: rows.map((r) => ({
      id: r.id,
      occurredAt: r.occurredAt,
      reference: r.reference,
      kind: r.kind,
      kindLabel: MOVE_KIND_LABELS[r.kind as OdooMoveKind] ?? r.kind,
      direction: r.direction,
      from: r.fromLocation,
      to: r.toLocation,
      contact: r.contact,
      quantity: num(r.quantity),
      unit: r.unit,
      by: r.createdByName,
    })),
  };
}
