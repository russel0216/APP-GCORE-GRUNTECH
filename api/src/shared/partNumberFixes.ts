import { prisma } from '../prisma';

const MARK = 'seed.partNumberFix20261123';

/**
 * A part number typed wrong on an approved request and its issued order
 * (2026-11-23, the owner's call): GT-PR-2026-0037's enclosure, 1000 × 800 × 400
 * mm, read "OOP - ENC-N3R- 1500x500x250". The text alone is corrected — no
 * quantity, price or approval moves — on the request line and the order line
 * it became (the RFQ and canvass read the request's), once, audited on each.
 */
const FIXES = [
  { request: 'GT-PR-2026-0037', from: 'OOP - ENC-N3R- 1500x500x250', to: 'OOP-ENC-N3R-1000x800x400' },
];

export async function fixPartNumbers(): Promise<number | null> {
  if (await prisma.setting.findUnique({ where: { key: MARK } })) return null;
  let fixed = 0;
  for (const f of FIXES) {
    const pr = await prisma.purchaseRequest.findUnique({ where: { number: f.request }, select: { id: true, number: true } });
    if (!pr) continue;
    const lines = await prisma.purchaseRequestItem.findMany({ where: { requestId: pr.id, partNumber: f.from }, select: { id: true } });
    for (const l of lines) {
      await prisma.$transaction(async (tx) => {
        await tx.purchaseRequestItem.update({ where: { id: l.id }, data: { partNumber: f.to } });
        await tx.auditLog.create({
          data: { entityType: 'purchase_request', entityId: pr.id, action: 'UPDATED', summary: `${pr.number}: part number corrected — ${f.from} → ${f.to}`, actorId: null },
        });
        const poLines = await tx.purchaseOrderItem.findMany({ where: { requestItemId: l.id, partNumber: f.from }, select: { id: true, order: { select: { id: true, number: true } } } });
        for (const p of poLines) {
          await tx.purchaseOrderItem.update({ where: { id: p.id }, data: { partNumber: f.to } });
          await tx.auditLog.create({
            data: { entityType: 'purchase_order', entityId: p.order.id, action: 'UPDATED', summary: `${p.order.number}: part number corrected — ${f.from} → ${f.to} (as on ${pr.number})`, actorId: null },
          });
        }
      });
      fixed += 1;
    }
  }
  await prisma.setting.upsert({
    where: { key: MARK },
    create: { key: MARK, value: { at: new Date().toISOString(), fixed }, description: 'Part numbers typed wrong, corrected once, 2026-11-23' },
    update: {},
  });
  return fixed;
}
