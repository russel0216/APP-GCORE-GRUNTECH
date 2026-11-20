import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { audit } from './audit';
import { nextNumber } from './numbering';
import { postJobCost } from './inventory';

/**
 * Bringing a Builk project's purchases into G-CORE (2026-11-19, the owner's
 * call: "input the data, no approval needed as this was already approved in
 * Builk"). Each project is DATA — `BuilkProject`, its orders and lines read off
 * Builk's Project Cost Drilldown — and this is the one engine that writes it,
 * ONCE per project (its own seed mark), onto the project built from its
 * quotation.
 *
 * Each order is written as Builk left it — issued and fully received
 * (delivered to and used at site, no stock held), its Incoming report beside
 * it — and the project is charged INCURRED per budget line as Builk allocated
 * each line. Builk's order slips, reimbursements and budget requests are
 * recorded against the GRUNTECHNOLOGY CORPORATION supplier row, what they were
 * said on the order's notes; company stock is never touched. Before anything is
 * written the data is checked against Builk's own totals — every order, and
 * every budget line's actual.
 */

export type BuilkCat = 'MAT' | 'EQP' | 'LAB' | 'SUB' | 'IND';
export const BUILK_CATS: BuilkCat[] = ['MAT', 'EQP', 'LAB', 'SUB', 'IND'];
export interface BuilkLine { name: string; description?: string; qty: number; unit: string; price: number; cat: BuilkCat; service?: boolean }
export interface BuilkOrder { builk: string; supplier: string; date: string; delivery: string; total: number; createdBy: string; notes?: string; lines: BuilkLine[] }
export interface BuilkProject {
  /** The seed mark: set once the orders are written. */
  mark: string;
  markDescription: string;
  /** Builk's project, e.g. "j-2688 RA '26 TPSC - TOSHIBA LTI". */
  builkName: string;
  /** The quotation the G-CORE project is built from. */
  quotation: string;
  deliverTo: string;
  /** Builk's actual cost per budget line — what the lines must come to. */
  actual: Partial<Record<BuilkCat, number>>;
  orders: BuilkOrder[];
}

const toCents = (v: number) => Math.round(v * 100);
export const lineCents = (l: BuilkLine) => Math.round(l.qty * 1000) * toCents(l.price) / 1000;
const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9&]+/g, ' ').trim();
const plain = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

/**
 * A line as Builk's drilldown gives it — its quantity and its AMOUNT. The unit
 * price is amount ÷ quantity where that is a whole centavo; otherwise the line
 * is one lot at Builk's amount, its quantity said in the description.
 */
export function lineByAmount(cat: BuilkCat, name: string, qty: number, unit: string, amount: number, description?: string, service?: boolean): BuilkLine {
  const price = Math.round((amount / qty) * 100) / 100;
  const u = unit || 'lot';
  if (toCents(price * qty) === toCents(amount)) return { cat, name, qty, unit: u, price, description, service };
  return { cat, name, qty: 1, unit: 'lot', price: amount, service, description: [`${qty} ${unit || 'pcs'}`, description].filter(Boolean).join(' — ') };
}

/** The data checked against Builk's own totals — every order and every budget line — before anything is written. */
export function checkBuilkData(p: BuilkProject): string[] {
  const problems: string[] = [];
  const byCat: Record<BuilkCat, number> = { MAT: 0, EQP: 0, LAB: 0, SUB: 0, IND: 0 };
  const seen = new Set<string>();
  for (const o of p.orders) {
    if (seen.has(o.builk)) problems.push(`${o.builk} is listed twice`);
    seen.add(o.builk);
    let sum = 0;
    for (const l of o.lines) {
      const c = lineCents(l);
      if (!Number.isInteger(c)) problems.push(`${o.builk} ${l.name}: ${l.qty} x ${l.price} is not a whole centavo`);
      sum += c;
      byCat[l.cat] += c;
    }
    if (sum !== toCents(o.total)) problems.push(`${o.builk} adds up to ${(sum / 100).toFixed(2)}, Builk says ${o.total.toFixed(2)}`);
  }
  for (const k of BUILK_CATS) {
    const want = toCents(p.actual[k] ?? 0);
    if (byCat[k] !== want) problems.push(`${k} adds up to ${(byCat[k] / 100).toFixed(2)}, Builk says ${(want / 100).toFixed(2)}`);
  }
  return problems;
}

export type BuilkResult =
  | { done: false; reason: string }
  | { done: true; job: string; orders: { builk: string; po: string; receiving: string; total: number }[]; byCat: Partial<Record<BuilkCat, number>> };

/**
 * Runs once per project. Waits, unmarked, while the project does not exist
 * yet; refuses (unmarked, said) if a supplier, a budget line or the data does
 * not add up, and leaves alone a project that already carries a Builk order.
 */
export async function importBuilkProject(
  p: BuilkProject,
  opts: { dryRun?: boolean; force?: boolean; /** A test's own project in place of the quotation's. */ jobId?: string } = {},
): Promise<BuilkResult | null> {
  if (!opts.dryRun && !opts.force && (await prisma.setting.findUnique({ where: { key: p.mark } }))) return null;

  const problems = checkBuilkData(p);
  if (problems.length) return { done: false, reason: `the Builk data does not add up: ${problems.join('; ')}` };

  const job = await prisma.job.findFirst({
    where: opts.jobId ? { id: opts.jobId } : { status: { not: 'CANCELLED' }, quotationRevision: { quotation: { number: p.quotation } } },
    select: { id: true, number: true, projectManagerId: true, createdById: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!job) return { done: false, reason: `no project is built from quotation ${p.quotation} yet` };

  const already = await prisma.purchaseOrder.count({ where: { jobId: job.id, notes: { contains: 'Builk PO' } } });
  if (already) return { done: false, reason: `${job.number} already carries ${already} order(s) from Builk` };

  const used = BUILK_CATS.filter((k) => p.orders.some((o) => o.lines.some((l) => l.cat === k)));
  const CODE: Record<BuilkCat, string> = { MAT: 'MAT', EQP: 'EQP', LAB: 'LAB', SUB: 'SUB', IND: 'IND' };
  const cats = await prisma.costCategory.findMany({ where: { code: { in: used.map((k) => CODE[k]) } }, select: { id: true, code: true } });
  const catId = Object.fromEntries(cats.map((c) => [c.code, c.id])) as Record<BuilkCat, string>;
  const missingCat = used.find((k) => !catId[k]);
  if (missingCat) return { done: false, reason: `the ${missingCat} budget line is not on file` };

  const suppliers = await prisma.supplier.findMany({ select: { id: true, name: true } });
  const supplierOf = new Map<string, { id: string; name: string }>();
  for (const o of p.orders) {
    // The name exactly as written (capitals and spaces aside) first — a
    // supplier filed twice under two spellings ("K.CMT II" and "K. CMT II")
    // is told apart by it; else the one supplier whose name starts so.
    const exact = suppliers.filter((s) => plain(s.name) === plain(o.supplier));
    const hits = exact.length === 1 ? exact : suppliers.filter((s) => fold(s.name).startsWith(fold(o.supplier)));
    if (hits.length !== 1) return { done: false, reason: `supplier "${o.supplier}" matches ${hits.length} on file` };
    supplierOf.set(o.builk, hits[0]);
  }

  const users = await prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true } });
  const admin = await prisma.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true }, orderBy: { createdAt: 'asc' } });
  // "Ayessa Yaya" finds "Ayessa Jane Yaya": every word of the name, in any login's name; one login only.
  const userNamed = (name: string) => {
    const words = fold(name).split(' ');
    const hits = users.filter((u) => { const n = fold(u.name).split(' '); return words.every((w) => n.includes(w)); });
    return (hits.length === 1 ? hits[0].id : null) ?? job.createdById ?? admin?.id;
  };
  const receiverId = job.projectManagerId ?? job.createdById ?? admin?.id;
  if (!receiverId) return { done: false, reason: 'nobody to record as the receiver' };

  if (opts.dryRun) {
    return { done: true, job: job.number, orders: p.orders.map((o) => ({ builk: o.builk, po: '(dry run)', receiving: '(dry run)', total: o.total })), byCat: p.actual };
  }

  return prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const done: { builk: string; po: string; receiving: string; total: number }[] = [];
      for (const o of p.orders) {
        const supplier = supplierOf.get(o.builk)!;
        const createdById = userNamed(o.createdBy)!;
        const ponumber = await nextNumber('purchase_order', tx);
        const total = new Prisma.Decimal(o.total.toFixed(2));
        const po = await tx.purchaseOrder.create({
          data: {
            number: ponumber,
            status: 'RECEIVED',
            kind: 'DIRECT_TO_JOB',
            supplierId: supplier.id,
            jobId: job.id,
            createdById,
            orderDate: day(o.date),
            deliveryDate: day(o.delivery),
            deliverTo: p.deliverTo,
            quoteRef: `Builk PO ${o.builk}`,
            terms: 'Cash',
            notes: `Builk PO ${o.builk} — imported from Builk (approved there by ${o.createdBy} on ${o.date}); no approval in G-CORE.${o.notes ? ` ${o.notes}` : ''}`,
            vatRate: new Prisma.Decimal(0),
            subtotal: total,
            total,
            issuedAt: day(o.date),
            approvedAt: day(o.date),
            items: {
              create: o.lines.map((l, i) => ({
                costCategoryId: catId[l.cat],
                name: l.name,
                description: l.description ? `${l.name} — ${l.description}` : l.name,
                nature: l.service ? ('SERVICE' as const) : ('GOODS' as const),
                quantity: new Prisma.Decimal(l.qty),
                unit: l.unit,
                unitPrice: new Prisma.Decimal(l.price.toFixed(2)),
                amount: new Prisma.Decimal((lineCents(l) / 100).toFixed(2)),
                receivedQty: new Prisma.Decimal(l.qty),
                sortOrder: i,
              })),
            },
          },
          include: { items: { orderBy: { sortOrder: 'asc' } } },
        });

        const rrnumber = await nextNumber('receiving', tx);
        const receiving = await tx.receiving.create({
          data: {
            number: rrnumber,
            orderId: po.id,
            warehouseId: null,
            receivedById: receiverId,
            receivedDate: day(o.delivery),
            status: 'RECEIVED',
            notes: `Builk PO ${o.builk} — delivered to and used at site (imported from Builk); no stock held.`,
            items: {
              create: po.items.map((it) => ({
                orderItemId: it.id,
                description: it.description,
                unit: it.unit,
                quantity: it.quantity,
                unitCost: it.unitPrice,
                costTyped: true,
              })),
            },
          },
        });

        for (const cat of BUILK_CATS) {
          const amount = o.lines.filter((l) => l.cat === cat).reduce((s, l) => s + lineCents(l), 0) / 100;
          if (!amount) continue;
          await postJobCost(tx, {
            jobId: job.id,
            costCategoryId: catId[cat],
            state: 'INCURRED',
            amount,
            sourceType: 'receiving',
            sourceId: receiving.id,
            sourceNumber: receiving.number,
            description: `Goods received from ${supplier.name} — Builk PO ${o.builk}`,
            createdById: receiverId,
          });
        }

        await audit({ entityType: 'purchase_order', entityId: po.id, action: 'CREATED', summary: `${po.number} imported from Builk PO ${o.builk} for ${job.number} — ${supplier.name}, ${o.total.toFixed(2)}, issued and received there (no approval in G-CORE)`, after: { builk: o.builk, total: o.total } }, undefined, tx);
        await audit({ entityType: 'receiving', entityId: receiving.id, action: 'CREATED', summary: `${receiving.number} imported from Builk PO ${o.builk} — received at site, charged to ${job.number}`, after: { builk: o.builk } }, undefined, tx);
        done.push({ builk: o.builk, po: po.number, receiving: receiving.number, total: o.total });
      }

      const said = BUILK_CATS.filter((k) => p.actual[k]).map((k) => `${k} ${(p.actual[k] as number).toFixed(2)}`).join(', ');
      await audit({ entityType: 'job', entityId: job.id, action: 'UPDATED', summary: `Builk's purchases brought over: ${done.length} orders, ${said} incurred (Builk ${p.builkName})` }, undefined, tx);
      await tx.setting.upsert({
        where: { key: p.mark },
        create: { key: p.mark, value: { at: new Date().toISOString(), job: job.number, orders: done }, description: p.markDescription },
        update: { value: { at: new Date().toISOString(), job: job.number, orders: done } },
      });
      return { done: true as const, job: job.number, orders: done, byCat: p.actual };
    },
    { maxWait: 15_000, timeout: 180_000 },
  );
}
