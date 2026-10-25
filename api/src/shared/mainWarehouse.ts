import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

/**
 * Gruntech keeps ONE warehouse, at the main office (2026-10-25, the owner's
 * answer during the Odoo migration: "Warehouse is only one, it is in the main
 * office"). The seeded `MAIN` row is that warehouse.
 */

export const MAIN_WAREHOUSE_CODE = 'MAIN';
const SEEDED_NAME = 'Main Warehouse';
export const MAIN_OFFICE_NAME = 'Main Office Warehouse';
const MARK = 'seed.mainOfficeWarehouse20261025';

/**
 * The warehouse goods land in when a document names none: `MAIN` while it is
 * active, else the one active warehouse; null when there is none, or several
 * and none of them `MAIN` — the caller then asks.
 */
export async function mainWarehouse(
  tx: Prisma.TransactionClient = prisma,
): Promise<{ id: string; code: string; name: string } | null> {
  const main = await tx.warehouse.findFirst({ where: { code: MAIN_WAREHOUSE_CODE, isActive: true }, select: { id: true, code: true, name: true } });
  if (main) return main;
  const active = await tx.warehouse.findMany({ where: { isActive: true }, select: { id: true, code: true, name: true }, take: 2 });
  return active.length === 1 ? active[0] : null;
}

/**
 * Once: the seeded "Main Warehouse" is named for where it is — the main
 * office — and takes the company's address while it has none, so the RFQ's
 * "Deliver to", the Incoming and every paper naming it say the office.
 * A name or address an administrator typed is kept.
 */
export async function placeMainWarehouseAtOffice(): Promise<string | null> {
  if (await prisma.setting.findUnique({ where: { key: MARK } })) return null;
  const [main, company] = await Promise.all([
    prisma.warehouse.findUnique({ where: { code: MAIN_WAREHOUSE_CODE } }),
    prisma.company.findUnique({ where: { id: 'company' }, select: { address: true, city: true } }),
  ]);
  let said: string | null = null;
  if (main) {
    const data: Prisma.WarehouseUpdateInput = {};
    if (main.name === SEEDED_NAME) data.name = MAIN_OFFICE_NAME;
    if (!main.address?.trim() && company?.address?.trim()) {
      data.address = company.address;
      if (!main.city?.trim() && company.city?.trim()) data.city = company.city;
    }
    if (Object.keys(data).length) {
      await prisma.warehouse.update({ where: { id: main.id }, data });
      await prisma.auditLog.create({
        data: {
          entityType: 'warehouse',
          entityId: main.id,
          action: 'UPDATED',
          summary: `${main.code} is the warehouse at the main office${data.name ? ` — named ${MAIN_OFFICE_NAME}` : ''}${data.address ? ', at the company address' : ''}`,
        },
      });
      said = `${main.code} placed at the main office`;
    }
  }
  await prisma.setting.create({ data: { key: MARK, value: { at: new Date().toISOString() } } });
  return said;
}
