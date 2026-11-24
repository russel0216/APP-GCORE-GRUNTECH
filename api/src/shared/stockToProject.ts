import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { audit } from './audit';
import { issueStock, postJobCost } from './inventory';
import { receiveProjectStock } from './projectStock';
import { nextNumber } from './numbering';

/**
 * A stock-replenishment purchase that was really bought for a project, moved
 * onto that project ONCE (2026-11-24, the owner's call on GT-PR-2026-0037:
 * "link it to the Amherst project so the pull-out is easy").
 *
 * The request and its orders become DIRECT_TO_JOB on the project, every line
 * on Materials (unless it names a budget line); what their RECEIVED reports
 * put on the company shelf is taken off it and put on the same shelf as the
 * PROJECT's own stock, at the cost it was received at; and the project is
 * charged INCURRED at the request's declared value — what a direct-to-job
 * receipt would have charged. The goods then leave by the project's own
 * pull-out slip or an Outgoing line marked project stock (CONSUMED only). A
 * DRAFT Outgoing slip on the project already taking those items from the
 * company shelf is switched to take them from the project's stock.
 *
 * Refused, and nothing written, when the goods have already left the company
 * shelf; it then waits, unmarked, for somebody to look.
 */
export interface StockToProject {
  mark: string;
  requestNumber: string;
  projectNumber: string;
  /** Draft pull-out slips to put on the project: the moved goods stay on the slip as the project's own stock, anything else goes on a new slip that charges the project. */
  pullouts?: string[];
}

export const AMHERST_ENCLOSURE: StockToProject = {
  mark: 'seed.amherstEnclosureToProject20261124',
  requestNumber: 'GT-PR-2026-0037',
  projectNumber: 'GT-PRJ-2026-0034',
  pullouts: ['GT-PS-2026-0011'],
};

const cents = (v: number) => Math.round(v * 100) / 100;
const num = (v: unknown) => Number(v ?? 0);

export async function moveStockPurchaseToProject(p: StockToProject, opts: { force?: boolean; tx?: Prisma.TransactionClient } = {}): Promise<{ done: true; moved: string[] } | { done: false; reason: string } | null> {
  const db = opts.tx ?? prisma;
  if (!opts.force && (await db.setting.findUnique({ where: { key: p.mark } }))) return null;
  const job = await db.job.findFirst({ where: { number: p.projectNumber }, select: { id: true, number: true, status: true } });
  if (!job || job.status === 'CANCELLED') return { done: false, reason: `project ${p.projectNumber} is not on file` };
  const request = await db.purchaseRequest.findFirst({ where: { number: p.requestNumber }, include: { items: true } });
  if (!request) return { done: false, reason: `${p.requestNumber} is not on file` };
  if (request.kind !== 'STOCK_REPLENISHMENT') return { done: false, reason: `${p.requestNumber} is ${request.kind}, not a stock request` };
  const materials = await db.costCategory.findFirst({ where: { code: 'MAT' }, select: { id: true } });
  if (!materials) return { done: false, reason: 'no Materials cost category' };

  try {
    const run = async (tx: Prisma.TransactionClient) => {
        const why = `moved onto project ${job.number} (it was bought for it)`;
        const done: string[] = [];
        await tx.purchaseRequest.update({ where: { id: request.id }, data: { kind: 'DIRECT_TO_JOB', jobId: job.id } });
        for (const i of request.items) {
          if (!i.costCategoryId) await tx.purchaseRequestItem.update({ where: { id: i.id }, data: { costCategoryId: materials.id } });
        }
        await audit({ entityType: 'purchase_request', entityId: request.id, action: 'UPDATED', summary: `${request.number} ${why}` }, undefined, tx);
        done.push(request.number);

        const declared = new Map(request.items.map((i) => [i.id, { cost: num(i.estimatedCost), cat: i.costCategoryId ?? materials.id }]));
        const orders = await tx.purchaseOrder.findMany({
          where: { requestId: request.id, status: { not: 'CANCELLED' } },
          include: { items: true, supplier: { select: { name: true } } },
        });
        const moves: { itemId: string; warehouseId: string }[] = [];
        for (const o of orders) {
          await tx.purchaseOrder.update({ where: { id: o.id }, data: { kind: 'DIRECT_TO_JOB', jobId: job.id } });
          for (const i of o.items) {
            const cat = (i.requestItemId && declared.get(i.requestItemId)?.cat) || i.costCategoryId || materials.id;
            if (cat !== i.costCategoryId) await tx.purchaseOrderItem.update({ where: { id: i.id }, data: { costCategoryId: cat } });
          }
          const receivings = await tx.receiving.findMany({
            where: { orderId: o.id, status: 'RECEIVED' },
            include: { items: { include: { orderItem: true } } },
          });
          for (const rec of receivings) {
            if (!rec.warehouseId) continue;
            const byCat = new Map<string, number>();
            for (const line of rec.items) {
              const oi = line.orderItem;
              const itemId = line.itemId ?? oi?.itemId;
              const quantity = num(line.quantity);
              if (!itemId || quantity <= 0 || oi?.nature === 'SERVICE') continue;
              const common = { itemId, warehouseId: rec.warehouseId, quantity, sourceType: 'receiving', sourceId: rec.id, sourceNumber: rec.number };
              await issueStock(tx, { ...common, notes: `Taken off the company shelf — ${rec.number} ${why}` });
              await receiveProjectStock(tx, { ...common, jobId: job.id, unitCost: num(line.unitCost), locationId: line.locationId, notes: `${rec.number} ${why}` });
              moves.push({ itemId, warehouseId: rec.warehouseId });
              const d = oi?.requestItemId ? declared.get(oi.requestItemId) : undefined;
              const cat = d?.cat ?? oi?.costCategoryId ?? materials.id;
              byCat.set(cat, (byCat.get(cat) ?? 0) + quantity * (d ? d.cost : num(line.unitCost)));
            }
            for (const [costCategoryId, amount] of byCat) {
              await postJobCost(tx, {
                jobId: job.id,
                costCategoryId,
                state: 'INCURRED',
                amount: cents(amount),
                sourceType: 'receiving',
                sourceId: rec.id,
                sourceNumber: rec.number,
                description: `Goods received from ${o.supplier.name} — ${why}`,
              });
            }
            await audit({ entityType: 'receiving', entityId: rec.id, action: 'UPDATED', summary: `${rec.number} ${why} — its goods are the project's own stock` }, undefined, tx);
            done.push(rec.number);
          }
          await audit({ entityType: 'purchase_order', entityId: o.id, action: 'UPDATED', summary: `${o.number} ${why}` }, undefined, tx);
          done.push(o.number);
        }

        // A draft Outgoing slip on the project taking these goods from the company shelf takes them from the project's now.
        for (const m of moves) {
          const lines = await tx.stockIssueItem.findMany({
            where: { itemId: m.itemId, projectStock: false, issue: { jobId: job.id, warehouseId: m.warehouseId, status: 'DRAFT' } },
            include: { issue: { select: { id: true, number: true } } },
          });
          for (const l of lines) {
            await tx.stockIssueItem.update({ where: { id: l.id }, data: { projectStock: true } });
            await audit({ entityType: 'stock_issue', entityId: l.issue.id, action: 'UPDATED', summary: `${l.issue.number}: a line now takes the goods from project ${job.number}'s own stock` }, undefined, tx);
            done.push(l.issue.number);
          }
        }
        // The draft pull-out slips named: the moved goods go out as the project's own stock;
        // anything else on the slip moves to a new slip that charges the project from company stock.
        const movedAt = new Set(moves.map((m) => `${m.itemId}@${m.warehouseId}`));
        for (const number of p.pullouts ?? []) {
          const slip = await tx.pulloutSlip.findFirst({ where: { number }, include: { items: { include: { item: { select: { id: true, costCategoryId: true } } } } } });
          if (!slip || slip.status !== 'DRAFT') continue;
          const own = slip.items.filter((i) => movedAt.has(`${i.itemId}@${slip.warehouseId}`));
          const rest = slip.items.filter((i) => !own.includes(i));
          if (!own.length) continue;
          await tx.pulloutSlip.update({ where: { id: slip.id }, data: { kind: 'PROJECT_STOCK', jobId: job.id, requestId: null, salesOrderId: null, purpose: 'PROJECT_USE' } });
          if (rest.length) {
            await tx.pulloutItem.deleteMany({ where: { id: { in: rest.map((i) => i.id) } } });
            for (const i of rest) {
              if (!i.item.costCategoryId) await tx.item.update({ where: { id: i.itemId }, data: { costCategoryId: materials.id } });
            }
            const twin = await tx.pulloutSlip.create({
              data: {
                number: await nextNumber('pullout_slip', tx),
                kind: 'OTHER',
                jobId: job.id,
                purpose: 'PROJECT_USE',
                warehouseId: slip.warehouseId,
                preparedById: slip.preparedById,
                requestedById: slip.requestedById,
                pulloutDate: slip.pulloutDate,
                receivedByName: slip.receivedByName,
                notes: slip.notes,
                poReference: slip.poReference,
                drReference: slip.drReference,
                courierCompany: slip.courierCompany,
                courierContact: slip.courierContact,
                vehicle: slip.vehicle,
                destination: slip.destination,
                returnBy: slip.returnBy,
                reason: `Company stock for project ${job.number} — split from ${slip.number}, whose other goods are the project's own stock`,
                items: { create: rest.map((i, n) => ({ itemId: i.itemId, quantity: i.quantity, unitCost: i.unitCost, amount: i.amount, sortOrder: n, serialNo: i.serialNo, condition: i.condition })) },
              },
            });
            await audit({ entityType: 'pullout_slip', entityId: twin.id, action: 'CREATED', summary: `${twin.number} split from ${slip.number} for project ${job.number} — company stock` }, undefined, tx);
            done.push(twin.number);
          }
          await audit({ entityType: 'pullout_slip', entityId: slip.id, action: 'UPDATED', summary: `${slip.number} now pulls out project ${job.number}'s own stock${rest.length ? ` (its other goods moved to a slip of their own)` : ''}` }, undefined, tx);
          done.push(slip.number);
        }
        await tx.setting.upsert({
          where: { key: p.mark },
          create: { key: p.mark, value: { at: new Date().toISOString(), moved: done }, description: `seed: ${p.requestNumber} moved onto ${p.projectNumber} once` },
          update: { value: { at: new Date().toISOString(), moved: done } },
        });
        return done;
    };
    const moved = opts.tx ? await run(opts.tx) : await prisma.$transaction(run, { timeout: 60_000 });
    return { done: true, moved };
  } catch (e) {
    if (opts.tx) throw e;
    return { done: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
