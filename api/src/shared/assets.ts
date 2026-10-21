import { prisma } from '../prisma';
import { audit } from './audit';

/**
 * G-HR › Records › Asset Management (2026-10-21, the owner's Asset Management
 * tab): the company's tagged property — vehicles, laptops, tools, kits —
 * and who holds each. Asset types are Admin › Categories › Asset types; the
 * seeded ones are the owner's sample's, plus a phone.
 */
export const ASSET_TYPES = [
  'Company Vehicle',
  'Office Laptop',
  'Mobile Phone',
  'Power Tools / Testing',
  'Safety Gear & Tool Kit',
  'Other',
] as const;

/** Seeds the list; a row already on file keeps its name and order. */
export async function seedAssetTypes(): Promise<number> {
  let created = 0;
  for (const [i, name] of ASSET_TYPES.entries()) {
    const existing = await prisma.assetType.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
    if (existing) {
      if (!existing.isSystem) await prisma.assetType.update({ where: { id: existing.id }, data: { isSystem: true } });
      continue;
    }
    await prisma.assetType.create({ data: { name, sortOrder: i, isSystem: true } });
    created++;
  }
  return created;
}

export type AssetState = 'AVAILABLE' | 'ISSUED' | 'RETURN_PENDING' | 'UNDER_REPAIR' | 'RETIRED';

/**
 * The status a screen shows, derived on read: an ISSUED asset whose holder
 * is leaving — a clearance raised and not cancelled, or a separation date on
 * file — is RETURN_PENDING. Stored only as ISSUED, so the day the clearance
 * is cancelled it reads Issued again with nothing to undo.
 */
export function assetState(status: string, holder: { leaving: boolean } | null): AssetState {
  if (status === 'ISSUED' && holder?.leaving) return 'RETURN_PENDING';
  return status as AssetState;
}

/** Of these employees, who is leaving — a live clearance or a separation date. */
export async function leavingEmployees(employeeIds: string[]): Promise<Map<string, { since: Date | null; dateSeparated: Date | null }>> {
  const ids = [...new Set(employeeIds)];
  if (!ids.length) return new Map();
  const [clearances, separated] = await Promise.all([
    prisma.employeeClearance.findMany({
      where: { employeeId: { in: ids }, status: { not: 'CANCELLED' } },
      select: { employeeId: true, lastWorkingDay: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.employee.findMany({ where: { id: { in: ids }, dateSeparated: { not: null } }, select: { id: true, dateSeparated: true } }),
  ]);
  const out = new Map<string, { since: Date | null; dateSeparated: Date | null }>();
  for (const c of clearances) if (!out.has(c.employeeId)) out.set(c.employeeId, { since: c.lastWorkingDay, dateSeparated: null });
  for (const e of separated) out.set(e.id, { since: out.get(e.id)?.since ?? e.dateSeparated, dateSeparated: e.dateSeparated });
  return out;
}

/** The once-only mark of the tag code's move. */
export const ASSET_TAG_MOVED = 'seed.assetTagCodeMoved20261021';

/**
 * The company asset's tag code moves from AST to TAG once (2026-10-21): AST
 * is the installed base's code, and both counted from 0001 under it, so a
 * laptop's tag and a customer's compressor printed the same number. The
 * template and every period counter of `company_asset` still on AST move
 * (each counter prints its own copy of the code); a tag already issued keeps
 * its print. Only while the template carries AST — a code an administrator
 * chose stays. Audited.
 */
export async function moveAssetTagCode(): Promise<{ moved: number }> {
  if (await prisma.setting.findUnique({ where: { key: ASSET_TAG_MOVED } })) return { moved: 0 };
  const moved = await prisma.$transaction(async (tx) => {
    const template = await tx.numberSequence.findFirst({ where: { documentType: 'company_asset', periodKey: '' }, select: { typeCode: true } });
    const n = template?.typeCode === 'AST' ? await tx.numberSequence.updateMany({ where: { documentType: 'company_asset', typeCode: 'AST' }, data: { typeCode: 'TAG' } }) : { count: 0 };
    await tx.setting.upsert({
      where: { key: ASSET_TAG_MOVED },
      create: { key: ASSET_TAG_MOVED, value: { at: new Date().toISOString(), rows: n.count }, description: "The company asset tag's numbering code moved from AST (the installed base's) to TAG once." },
      update: {},
    });
    return n.count;
  });
  if (moved) await audit({ entityType: 'number_sequence', entityId: 'company_asset', action: 'UPDATED', summary: 'Company asset tag code moved from AST to TAG — AST numbers the installed base', actorName: 'system' });
  return { moved };
}
