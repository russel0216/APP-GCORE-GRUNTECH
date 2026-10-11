import { prisma } from '../prisma';

/**
 * The address a document prints for its customer (2026-10-11, the owner's
 * call: "add an address for the customer — this is the default on the
 * quotation; a site can be selected if needed"): the chosen site's address
 * and city, else the customer's own address. One rule for the quotation's
 * page, its PDF and the sales order's PDF.
 */
export function documentAddress(
  customer: { address?: string | null },
  site?: { address?: string | null; city?: string | null } | null,
): string {
  const siteLine = site ? [site.address, site.city].map((p) => (p ?? '').trim()).filter(Boolean).join(', ') : '';
  return siteLine || (customer.address ?? '').trim();
}

const BACKFILL_MARK = 'seed.customerAddressBackfilled';

/**
 * Once, on the deploy that brings the customer's own address: every customer
 * without one takes its first site's address and city, so quotations keep
 * printing the address they printed before. Marked in a Setting, so an
 * address cleared by hand afterwards stays cleared. Returns the count.
 */
export async function backfillCustomerAddresses(): Promise<number> {
  if (await prisma.setting.findUnique({ where: { key: BACKFILL_MARK } })) return 0;
  const customers = await prisma.customer.findMany({
    where: { OR: [{ address: null }, { address: '' }] },
    select: {
      id: true,
      sites: { where: { isActive: true }, orderBy: { createdAt: 'asc' }, take: 1, select: { address: true, city: true } },
    },
  });
  let filled = 0;
  for (const c of customers) {
    const address = documentAddress({}, c.sites[0]);
    if (!address) continue;
    await prisma.customer.update({ where: { id: c.id }, data: { address } });
    filled++;
  }
  await prisma.setting.create({ data: { key: BACKFILL_MARK, value: { at: new Date().toISOString(), filled } } });
  return filled;
}
