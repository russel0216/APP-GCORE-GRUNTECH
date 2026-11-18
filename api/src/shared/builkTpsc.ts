import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { audit } from './audit';
import { nextNumber } from './numbering';
import { postJobCost } from './inventory';

/**
 * What Builk already bought for project j-2688 "RA '26 TPSC - TOSHIBA LTI"
 * (2026-11-19, the owner's call: "input the data, no approval needed as this
 * was already approved in Builk"). Brought into G-CORE ONCE, by the seed
 * (`BUILK_TPSC_MARK`), onto the project built from quotation 1052607084.1.
 *
 * Six of Builk's purchase orders — 2610-015, -095, -096, -097, -137, -138 —
 * whose sum is Builk's actual cost, PHP 303,103.57. Builk's 2611-010 re-lists
 * the lines of -095, -096, -137 and -138 and Builk leaves it out of the
 * actual; so does this. 2610-097 is Gruntech's own ORDER SLIP: goods taken
 * from the warehouse before the Odoo stock count of 2026-10-25, so today's
 * stock is not touched — it is recorded against the GRUNTECHNOLOGY
 * CORPORATION supplier row at Builk's prices.
 *
 * Each order is written as Builk left it — issued and fully received
 * (delivered to and used at site, no stock held) — and the project is charged
 * INCURRED per budget line, as Builk's Project Cost Drilldown allocated each
 * line: Equipment (Builk 305) PHP 138,578.38 — the VFD, PHP 28,870.89 of the
 * four contactors and PHP 4,969.92 of the PLC — and Materials (Builk 103)
 * PHP 164,525.19, everything else. A line Builk split between the two is two
 * lines here. A line whose Builk amount is not quantity x a two-decimal price
 * (the RS485 cable, two of the end caps) is one lot at Builk's amount, its
 * quantity in the description.
 */
export const BUILK_TPSC_MARK = 'seed.builkTpsc20261119';
export const BUILK_TPSC_QUOTATION = '1052607084.1';

type Cat = 'MAT' | 'EQP';
interface Line { name: string; description?: string; qty: number; unit: string; price: number; cat: Cat }
interface Order { builk: string; supplier: string; date: string; delivery: string; total: number; createdBy: string; notes?: string; lines: Line[] }

const m = (name: string, qty: number, unit: string, price: number, description?: string): Line => ({ name, qty, unit, price, cat: 'MAT', description });
const e = (name: string, qty: number, unit: string, price: number, description?: string): Line => ({ name, qty, unit, price, cat: 'EQP', description });

export const BUILK_TPSC_ORDERS: Order[] = [
  {
    builk: '2610-015', supplier: 'SPEC-MASTER INCORPORATED', date: '2026-10-05', delivery: '2026-10-05', total: 50000, createdBy: 'Ayessa Yaya',
    lines: [m('PANEL ENCLOSURE 1700MM X 800MM X 400MM', 1, 'pcs', 50000, 'PO 3047')],
  },
  {
    builk: '2610-095', supplier: 'GLOBAL STANDARD ELECTRICAL DEPOT', date: '2026-10-14', delivery: '2026-10-14', total: 12728.7, createdBy: 'Ayessa Yaya',
    lines: [
      m('PHELPS DODGE, THHN WIRE 22MM2 (RED)', 9, 'm', 313.1, 'PO 3066'),
      m('PHELPS DODGE, THHN WIRE 22MM2 (YELLOW)', 9, 'm', 313.1),
      m('PHELPS DODGE, THHN WIRE 22MM2 (BLUE)', 9, 'm', 313.1),
      m('PHELPS DODGE, THHN WIRE 14MM2 (GREEN)', 6, 'm', 200),
      m('PHELPS DODGE, TF WIRE 1.25MM2', 1, 'roll', 3075),
    ],
  },
  {
    builk: '2610-096', supplier: 'HEXAGON MECHANELIC SYSTEMS', date: '2026-10-14', delivery: '2026-10-14', total: 35576, createdBy: 'Ayessa Yaya',
    lines: [
      e('SCHNEIDER ELECTRIC, CONTACTOR, LC1D80M7', 1, 'lot', 28870.89, '4 pcs x 8,038.00 (PO 3067) — the share Builk allocated to Equipment (305)'),
      m('SCHNEIDER ELECTRIC, CONTACTOR, LC1D80M7', 1, 'lot', 3281.11, '4 pcs x 8,038.00 (PO 3067) — the share Builk allocated to Electrical Materials (103)'),
      m('SCHNEIDER ELECTRIC AUXILLARY CONTACT LADN22', 4, 'pcs', 856),
    ],
  },
  {
    builk: '2610-097', supplier: 'GRUNTECHNOLOGY CORPORATION', date: '2026-10-14', delivery: '2026-10-13', total: 183182.98, createdBy: 'Ayessa Yaya',
    notes: "Gruntech ORDER SLIP — goods from Gruntech's own warehouse stock, taken off the shelf before the Odoo stock count of 2026-10-25 (company stock not touched). For TPSC Controller.",
    lines: [
      m('SEP - EZC100H3100 - MAIN CIRCUIT BREAKER', 2, 'pcs', 4417.56),
      m('SEP - A9F74204 - SCHNEIDER ELECTRIC, MINIATURE CIRCUIT BREAKER - 2P - 4A - C CURVE', 4, 'pcs', 771.34),
      e('SVD - ATV630D30N4 - SCHNEIDER ELECTRIC, VFD, ATV630D30N4', 1, 'pcs', 104737.57),
      m('SHM - HMIET6500 - SCHNEIDER ELECTRIC, HMI 10"', 1, 'pcs', 23917.06),
      e('SRC - TM200CE40R - SCHNEIDER ELECTRIC, RELAY, PROGRAMMABLE LOGIC CONTROLLER', 1, 'lot', 4969.92, '1 pc x 13,504.92 — the share Builk allocated to Equipment (305)'),
      m('SRC - TM200CE40R - SCHNEIDER ELECTRIC, RELAY, PROGRAMMABLE LOGIC CONTROLLER', 1, 'lot', 8535, '1 pc x 13,504.92 — the share Builk allocated to Electrical Materials (103)'),
      m('SEP - TMCR2AI2 - ANALOG INPUT MODULE, SCHNEIDER ELECTRIC, CARTRIDGE', 1, 'pcs', 4969.55),
      m('SPS - PRESSURE SENSOR 4-20MA, 2 WIRE (DISCHARGE HEADER), SUTO-ITEC, M12 CONNECTOR S694 3557', 1, 'unit', 7182),
      m('SPP - POWER SUPPLY 24VDC 3.1A, ABLS1A24031, SCHNEIDER ELECTRIC', 1, 'unit', 3380.24),
      m('SEP - MINIATURE CIRCUIT BREAKER 2P 5A (T1 PRIMARY), A9F74206, SCHNEIDER ELECTRIC, ACTI9 IC60N 2P C 6A', 1, 'unit', 722.89),
      m('SRC - INTERPOSING RELAY 230VAC, 1 C/O, SCHNEIDER ELECTRIC, RELAY RSL1PVPU', 4, 'pcs', 581.37),
      m('SEP - NSYCVF300M230PF SCHNEIDER ELECTRIC, EXHAUST FAN 300/350 M3/HR @50/60HZ, 230V, IP54 - LEFT SIDE', 1, 'unit', 9459.69),
      m('SEP - NSYCCOTHOF SCHNEIDER ELECTRIC, THERMOSTAT 0-60 DEG C NO (FAN CONTROL)', 1, 'unit', 678.63),
      m('OOP - CABLE TIE BLACK #6', 1, 'pack', 45),
      m('OOP - 3801501K, COMMUNICATION CABLE BELDEN COMPUTER CABLE (RS485)', 1, 'lot', 339.47, '10 meters x 33.95'),
    ],
  },
  {
    builk: '2610-137', supplier: 'A. WIN ELECTRICAL GOODS TRADING', date: '2026-10-21', delivery: '2026-10-06', total: 9363.8, createdBy: 'Ayessa Yaya',
    lines: [
      m('CONTROL TRANSFORMER 200VA, 1PH, 400V/230V (ALT. ABL6TS25U)', 1, 'pcs', 3200, 'PO 3048'),
      m('POWER TERMINAL BLOCK 35MM2, 125A (22MM2 CONDUCTORS), FJ711S', 15, 'pcs', 140),
      m('EARTH TERMINAL BLOCK 35MM (GREEN/YELLOW) JUT1-35PE', 5, 'pcs', 220),
      m('END PLATE/END STOP FOR JUT1-35', 4, 'pcs', 20),
      m('DIN RAIL 34MM', 3, 'length', 100),
      m('POWER TERMINAL LUGS 22-8 RING', 60, 'pcs', 30),
      m('POWER TERMINAL LUGS 14-6 RING', 8, 'pcs', 24),
      m('SPIRAL WRAP', 1, 'pack', 211.8),
      m('TIE MOUNT, HC-102', 1, 'pack', 100),
      m('DIN RAIL TYPE OUTLET 16AMP', 1, 'pack', 280, 'PO 3068'),
    ],
  },
  {
    builk: '2610-138', supplier: 'ELECTRICAL & EQUIPMENT SALES CO', date: '2026-10-21', delivery: '2026-10-06', total: 12252.09, createdBy: 'Ayessa Yaya',
    lines: [
      m('AIR INLET GRILLE WITH FILTER 223X223 CUT-OUT (RIGHT-SIDE)', 1, 'pcs', 788),
      m('EXHAUST FAN 300/350 M3/HR @50/60HZ 37W, IP54, LEFT SIDE, NSYCVF300M230PF', 1, 'pcs', 5421.4),
      m('CONTROL TERMINAL BLOCK, JUT1-2.5', 24, 'pcs', 27.2),
      m('CONTROL TERMINAL BLOCK END PLATE, JUT1-2.5', 6, 'pcs', 10.2),
      m('CONTROL TERMINAL BLOCK STOPPER FOR JUT1-2.5', 6, 'pcs', 16.15),
      m('CONTROL TERMINAL BLOCK CENTER JUMPER FOR JUT1-2.5', 1, 'pcs', 113.05),
      m('WIRE DUCT / CABLE TRAY 60X60', 4, 'length', 1123),
      m('VINYL END CAP 14MM2 (GREEN)', 8, 'pcs', 3.95),
      m('CONTROL INSULATED TERMINAL LUGS Y FOR 1.25MM SQ WIRE', 1, 'pack', 190),
      m('VINYL END CAP 22MM2 (RED)', 20, 'pcs', 6.75),
      m('VINYL END CAP 22MM2 (BLUE)', 1, 'lot', 135.07, '20 pcs x 6.75'),
      m('VINYL END CAP 22MM2 (YELLOW)', 1, 'lot', 135.07, '20 pcs x 6.75'),
    ],
  },
];

/** Builk's actual cost of the project, by budget line — what the import must come to. */
export const BUILK_TPSC_ACTUAL = { MAT: 164525.19, EQP: 138578.38 } as const;

const toCents = (v: number) => Math.round(v * 100);
const lineCents = (l: Line) => Math.round(l.qty * 1000) * toCents(l.price) / 1000;
const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9&]+/g, ' ').trim();
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

/** The data checked against Builk's own totals — every order and both budget lines — before anything is written. */
export function checkBuilkTpscData(): string[] {
  const problems: string[] = [];
  const byCat = { MAT: 0, EQP: 0 };
  for (const o of BUILK_TPSC_ORDERS) {
    let sum = 0;
    for (const l of o.lines) {
      const c = lineCents(l);
      if (!Number.isInteger(c)) problems.push(`${o.builk} ${l.name}: ${l.qty} x ${l.price} is not a whole centavo`);
      sum += c;
      byCat[l.cat] += c;
    }
    if (sum !== toCents(o.total)) problems.push(`${o.builk} adds up to ${(sum / 100).toFixed(2)}, Builk says ${o.total.toFixed(2)}`);
  }
  for (const k of ['MAT', 'EQP'] as const) {
    if (byCat[k] !== toCents(BUILK_TPSC_ACTUAL[k])) problems.push(`${k} adds up to ${(byCat[k] / 100).toFixed(2)}, Builk says ${BUILK_TPSC_ACTUAL[k].toFixed(2)}`);
  }
  return problems;
}

export type BuilkTpscResult =
  | { done: false; reason: string }
  | { done: true; job: string; orders: { builk: string; po: string; receiving: string; total: number }[]; materials: number; equipment: number };

/**
 * Runs once. Waits, unmarked, while the project does not exist yet; refuses
 * (unmarked, said) if a supplier, a budget line or the data does not add up,
 * and leaves alone a project that already carries a Builk order.
 */
export async function importBuilkTpsc(opts: { dryRun?: boolean; force?: boolean; /** A test's own project in place of the quotation's (scripts/test-builk-tpsc.ts). */ jobId?: string } = {}): Promise<BuilkTpscResult | null> {
  if (!opts.dryRun && !opts.force && (await prisma.setting.findUnique({ where: { key: BUILK_TPSC_MARK } }))) return null;

  const problems = checkBuilkTpscData();
  if (problems.length) return { done: false, reason: `the Builk data does not add up: ${problems.join('; ')}` };

  const job = await prisma.job.findFirst({
    where: opts.jobId ? { id: opts.jobId } : { status: { not: 'CANCELLED' }, quotationRevision: { quotation: { number: BUILK_TPSC_QUOTATION } } },
    select: { id: true, number: true, projectManagerId: true, createdById: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!job) return { done: false, reason: `no project is built from quotation ${BUILK_TPSC_QUOTATION} yet` };

  const already = await prisma.purchaseOrder.count({ where: { jobId: job.id, notes: { contains: 'Builk PO' } } });
  if (already) return { done: false, reason: `${job.number} already carries ${already} order(s) from Builk` };

  const cats = await prisma.costCategory.findMany({ where: { code: { in: ['MAT', 'EQP'] } }, select: { id: true, code: true } });
  const catId = Object.fromEntries(cats.map((c) => [c.code, c.id])) as Record<Cat, string>;
  if (!catId.MAT || !catId.EQP) return { done: false, reason: 'the Materials or Equipment budget line is not on file' };

  const suppliers = await prisma.supplier.findMany({ select: { id: true, name: true } });
  const supplierOf = new Map<string, { id: string; name: string }>();
  for (const o of BUILK_TPSC_ORDERS) {
    const hits = suppliers.filter((s) => fold(s.name).startsWith(fold(o.supplier)));
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
    return { done: true, job: job.number, orders: BUILK_TPSC_ORDERS.map((o) => ({ builk: o.builk, po: '(dry run)', receiving: '(dry run)', total: o.total })), materials: BUILK_TPSC_ACTUAL.MAT, equipment: BUILK_TPSC_ACTUAL.EQP };
  }

  return prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const done: { builk: string; po: string; receiving: string; total: number }[] = [];
      for (const o of BUILK_TPSC_ORDERS) {
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
            deliverTo: "RA '26 TPSC - TOSHIBA LTI, Laguna — person in charge Salvador Ugaban",
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

        for (const cat of ['MAT', 'EQP'] as const) {
          const amount = o.lines.filter((l) => l.cat === cat).reduce((s, l) => s + lineCents(l), 0) / 100;
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

      await audit({ entityType: 'job', entityId: job.id, action: 'UPDATED', summary: `Builk's purchases brought over: ${done.length} orders, Materials ${BUILK_TPSC_ACTUAL.MAT.toFixed(2)} and Equipment ${BUILK_TPSC_ACTUAL.EQP.toFixed(2)} incurred (Builk j-2688)` }, undefined, tx);
      await tx.setting.upsert({
        where: { key: BUILK_TPSC_MARK },
        create: { key: BUILK_TPSC_MARK, value: { at: new Date().toISOString(), job: job.number, orders: done }, description: "seed: Builk's purchases for RA '26 TPSC - TOSHIBA LTI were brought over once (2026-11-19)" },
        update: { value: { at: new Date().toISOString(), job: job.number, orders: done } },
      });
      return { done: true as const, job: job.number, orders: done, materials: BUILK_TPSC_ACTUAL.MAT, equipment: BUILK_TPSC_ACTUAL.EQP };
    },
    { maxWait: 15_000, timeout: 120_000 },
  );
}
