import { prisma } from '../src/prisma';
import { signToken } from '../src/auth/middleware';
(async () => {
  const u = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@gruntech.com' } });
  console.log('TOKEN', signToken(u.id, u.email));
  console.log('ADMIN', u.id, u.employeeNo, u.isSuperAdmin);
  const lead = await prisma.lead.findFirst({ where: { customerId: { not: null }, costings: { some: {} } }, include: { costings: { select: { id: true, number: true } }, customer: { select: { name: true } } } });
  console.log('LEAD', lead?.id, lead?.companyName, lead?.status, lead?.customer?.name, JSON.stringify(lead?.costings));
  const costing = await prisma.costing.findFirst({ where: { scopeSections: { some: {} } }, select: { id: true, number: true, title: true, customerId: true, leadId: true, _count: { select: { scopeSections: true } } } });
  console.log('COSTING', JSON.stringify(costing));
  const cust = await prisma.customer.findFirst({ where: { contacts: { some: {} } }, select: { id: true, name: true, paymentTerms: true, _count: { select: { contacts: true, sites: true } } } });
  console.log('CUSTOMER', JSON.stringify(cust));
  console.log('SEQS', JSON.stringify(await prisma.numberSequence.findMany({ where: { documentType: 'quotation' }, orderBy: { updatedAt: 'desc' }, take: 5 })));
  console.log('QCOUNT', await prisma.quotation.count());
  await prisma.$disconnect();
})();
