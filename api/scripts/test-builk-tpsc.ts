/**
 * Runs the Builk TPSC import against a local project and takes everything it
 * wrote back off: the orders, their Incoming reports, the ledger rows, the
 * audit rows and the mark. Local databases only.
 *
 *   npx tsx scripts/test-builk-tpsc.ts [jobId]
 */
import { prisma } from '../src/prisma';
import { BUILK_TPSC_MARK, importBuilkTpsc } from '../src/shared/builkTpsc';

let failed = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '✓' : '✗'} ${what}`);
  if (!ok) failed += 1;
};

async function main() {
  const jobId = process.argv[2] ?? (await prisma.job.findFirstOrThrow({ where: { status: { not: 'CANCELLED' } }, select: { id: true } })).id;
  const hadMark = await prisma.setting.findUnique({ where: { key: BUILK_TPSC_MARK } });
  const startedAt = new Date();
  const result = await importBuilkTpsc({ force: true, jobId });
  try {
    check(!!result?.done, `import ran (${result && !result.done ? result.reason : 'done'})`);
    if (!result?.done) return;
    const pos = await prisma.purchaseOrder.findMany({ where: { jobId, notes: { contains: 'Builk PO' } }, include: { items: true, receivings: { include: { items: true } }, supplier: true } });
    check(pos.length === 6, `6 orders on the project (${pos.length})`);
    check(pos.every((p) => p.status === 'RECEIVED' && p.receivings.length === 1 && p.receivings[0].status === 'RECEIVED'), 'each order received on one Incoming report');
    check(pos.every((p) => p.items.every((i) => Number(i.receivedQty) === Number(i.quantity))), 'every line fully received');
    const total = pos.reduce((s, p) => s + Number(p.total), 0);
    check(Math.abs(total - 303103.57) < 0.005, `orders total 303,103.57 (${total.toFixed(2)})`);
    const lines = pos.flatMap((p) => p.items).reduce((s, i) => s + Number(i.amount), 0);
    check(Math.abs(lines - 303103.57) < 0.005, `lines total 303,103.57 (${lines.toFixed(2)})`);
    const ids = pos.flatMap((p) => p.receivings.map((r) => r.id));
    const ledger = await prisma.jobCostEntry.findMany({ where: { jobId, sourceType: 'receiving', sourceId: { in: ids } }, include: { costCategory: true } });
    const by = (code: string) => ledger.filter((l) => l.costCategory.code === code && l.state === 'INCURRED').reduce((s, l) => s + Number(l.amount), 0);
    check(Math.abs(by('MAT') - 164525.19) < 0.005, `Materials incurred 164,525.19 (${by('MAT').toFixed(2)})`);
    check(Math.abs(by('EQP') - 138578.38) < 0.005, `Equipment incurred 138,578.38 (${by('EQP').toFixed(2)})`);
    check(ledger.every((l) => l.state === 'INCURRED'), 'nothing committed or consumed');
    const again = await importBuilkTpsc({ force: true, jobId });
    check(!!again && !again.done, `a second run writes nothing (${again && !again.done ? again.reason : ''})`);
    const slip = pos.find((p) => p.notes?.includes('2610-097'));
    check(slip?.supplier.name === 'GRUNTECHNOLOGY CORPORATION', 'the order slip is on GRUNTECHNOLOGY CORPORATION');
  } finally {
    const pos = await prisma.purchaseOrder.findMany({ where: { jobId, notes: { contains: 'Builk PO' }, createdAt: { gte: startedAt } }, select: { id: true, receivings: { select: { id: true } } } });
    const recIds = pos.flatMap((p) => p.receivings.map((r) => r.id));
    await prisma.jobCostEntry.deleteMany({ where: { sourceType: 'receiving', sourceId: { in: recIds } } });
    await prisma.receiving.deleteMany({ where: { id: { in: recIds } } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: pos.map((p) => p.id) } } });
    await prisma.auditLog.deleteMany({ where: { at: { gte: startedAt }, OR: [{ entityId: { in: [...pos.map((p) => p.id), ...recIds] } }, { entityId: jobId, summary: { startsWith: "Builk's purchases" } }] } });
    if (!hadMark) await prisma.setting.deleteMany({ where: { key: BUILK_TPSC_MARK } });
    console.log(`Cleaned up ${pos.length} orders and ${recIds.length} Incoming reports.`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    failed += 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    if (failed) process.exitCode = 1;
  });
