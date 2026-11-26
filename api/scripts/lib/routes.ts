/**
 * The SEEDED approval routes, for a verify run (2026-11-26). An install's
 * administrator may rename every step ("Approved By"), send a document to
 * another role or add steps of their own — the laptop's routes are all three
 * — and a check about what the seed routes to then fails on the install,
 * not on the code. `seededRoutes()` switches the install's own routes off and
 * puts a copy of each seeded route (src/shared/workflowSeeds.ts) in its place;
 * `ownRoutesBack()` switches them on again and deletes the copies. What was
 * changed is parked in a Setting, so a run that dies is put right by the next
 * run's cleanup, whichever script it is. A request filed on a copy only loses
 * its link when the copy goes (ApprovalRequest.workflow is SetNull).
 *
 * Call `ownRoutesBack()` at the START of a script's cleanup and
 * `seededRoutes()` after it; the cleanup at the end puts the routes back.
 */
import { prisma } from '../../src/prisma';
import { WORKFLOWS } from '../../src/shared/workflowSeeds';

const STASH = 'approvalWorkflows.__verify__';
/** Marks the copies (`ApprovalWorkflow.createdById`, a plain string), so they can always be found and deleted. */
const MARK = '__verify_seeded_route__';

/** Only these document types, else every type the seed routes. */
export async function seededRoutes(documentTypes?: string[]): Promise<void> {
  await ownRoutesBack();
  const seeds = documentTypes ? WORKFLOWS.filter((w) => documentTypes.includes(w.documentType)) : WORKFLOWS;
  const types = [...new Set(seeds.map((w) => w.documentType))];
  const roles = await prisma.role.findMany({ select: { id: true, key: true } });
  const roleId = (key?: string) => (key ? (roles.find((r) => r.key === key)?.id ?? null) : null);
  const off = (await prisma.approvalWorkflow.findMany({ where: { documentType: { in: types }, isActive: true }, select: { id: true } })).map((w) => w.id);
  // Parked BEFORE anything changes, so a crash halfway is still put right.
  await prisma.setting.upsert({ where: { key: STASH }, create: { key: STASH, value: { off } }, update: { value: { off } } });
  await prisma.approvalWorkflow.updateMany({ where: { id: { in: off } }, data: { isActive: false } });
  for (const seed of seeds) {
    await prisma.approvalWorkflow.create({
      data: {
        documentType: seed.documentType,
        name: seed.name,
        minAmount: seed.minAmount ?? null,
        maxAmount: seed.maxAmount ?? null,
        optionLabel: seed.optionLabel ?? null,
        requesterRoleId: roleId(seed.requesterRoleKey),
        preparerSigns: seed.preparerSigns ?? false,
        standIns: seed.standIns ?? false,
        createdById: MARK,
        steps: {
          create: seed.steps.map((s) => ({
            sequence: s.sequence,
            name: s.name,
            approverType: s.approverType,
            roleId: roleId(s.roleKey),
            alsoRoleIds: (s.alsoRoleKeys ?? []).map((k) => roleId(k)).filter((id): id is string => !!id),
          })),
        },
      },
    });
  }
}

/** The install's own routes back, and every copy gone — safe to call when nothing was set aside. */
export async function ownRoutesBack(): Promise<void> {
  const stash = await prisma.setting.findUnique({ where: { key: STASH } });
  await prisma.approvalWorkflow.deleteMany({ where: { createdById: MARK } });
  if (stash) {
    const ids = ((stash.value as { off?: unknown[] }).off ?? []).filter((x): x is string => typeof x === 'string');
    await prisma.approvalWorkflow.updateMany({ where: { id: { in: ids } }, data: { isActive: true } });
    await prisma.setting.delete({ where: { key: STASH } });
  }
}
