import { prisma } from '../src/prisma';
(async () => {
  const q = await prisma.quotation.findUniqueOrThrow({ where: { id: process.argv[2] }, include: { revisions: { include: { items: { orderBy: { sortOrder: 'asc' } } } } } });
  const r = q.revisions[0];
  console.log(q.number, q.ownerId, q.contactId, 'sub', String(r.subtotal), 'disc', String(r.discountPct), String(r.discountAmount), 'vat', String(r.vatAmount), 'total', String(r.total), 'incl', r.vatInclusive, 'validity', r.validityDays, 'status', r.status);
  for (const i of r.items) console.log(' ', i.sortOrder, i.group, '|', i.title, '|', i.description, '|', String(i.quantity), i.unit, String(i.unitPrice), String(i.amount), 'cost', String(i.unitCost), String(i.costAmount), i.providerSupplierId ? 'SUP' : '', i.providerUserId ? 'USER' : '', i.costNote);
  console.log(JSON.stringify(await prisma.auditLog.findMany({ where: { entityId: q.id }, select: { action: true, summary: true }, orderBy: { at: 'asc' } })));
  await prisma.$disconnect();
})();
