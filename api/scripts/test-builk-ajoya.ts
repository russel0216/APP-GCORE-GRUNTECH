/**
 * Runs the Builk Ajoya (j-2658) import against a local project and takes
 * everything it wrote back off — the orders, their Incoming reports, the ledger
 * rows, the audit rows, the mark, and any supplier it had to add for the run.
 * Local databases only.
 *
 *   npx tsx scripts/test-builk-ajoya.ts [jobId]
 */
import { prisma } from '../src/prisma';
import { BUILK_AJOYA, BUILK_AJOYA_ACTUAL, BUILK_AJOYA_MARK, checkBuilkAjoyaData, importBuilkAjoya } from '../src/shared/builkAjoya';

let failed = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? '✓' : '✗'} ${what}`); if (!ok) failed += 1; };
const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9&]+/g, ' ').trim();

async function main() {
  const problems = checkBuilkAjoyaData();
  check(!problems.length, `the data adds up to Builk's drilldown${problems.length ? ': ' + problems.join('; ') : ''}`);
  const jobId = process.argv[2] ?? (await prisma.job.findFirstOrThrow({ where: { status: { not: 'CANCELLED' } }, select: { id: true } })).id;
  const hadMark = await prisma.setting.findUnique({ where: { key: BUILK_AJOYA_MARK } });
  const startedAt = new Date();
  // A local database may lack a supplier the live one has: add it for the run.
  const suppliers = await prisma.supplier.findMany({ select: { name: true } });
  const added: string[] = [];
  for (const name of [...new Set(BUILK_AJOYA.orders.map((o) => o.supplier))]) {
    if (suppliers.some((s) => fold(s.name).startsWith(fold(name)))) continue;
    const s = await prisma.supplier.create({ data: { code: `ZZBUILK-${added.length + 1}-${Date.now()}`, name } });
    added.push(s.id);
  }
  const result = await importBuilkAjoya({ force: true, jobId });
  try {
    check(!!result?.done, `import ran (${result && !result.done ? result.reason : 'done'})`);
    if (!result?.done) return;
    const pos = await prisma.purchaseOrder.findMany({ where: { jobId, notes: { contains: 'Builk PO' }, createdAt: { gte: startedAt } }, include: { items: true, receivings: true } });
    check(pos.length === 34, `34 orders on the project (${pos.length})`);
    check(pos.every((p) => p.status === 'RECEIVED' && p.receivings.length === 1), 'each order received on one Incoming report');
    const total = pos.reduce((s, p) => s + Number(p.total), 0);
    check(Math.abs(total - 556991.3) < 0.005, `orders total 556,991.30 (${total.toFixed(2)})`);
    const lines = pos.flatMap((p) => p.items).reduce((s, i) => s + Number(i.amount), 0);
    check(Math.abs(lines - 556991.3) < 0.005, `lines total 556,991.30 (${lines.toFixed(2)})`);
    check(pos.flatMap((p) => p.items).length === 139, `139 lines (${pos.flatMap((p) => p.items).length})`);
    const ids = pos.flatMap((p) => p.receivings.map((r) => r.id));
    const ledger = await prisma.jobCostEntry.findMany({ where: { jobId, sourceType: 'receiving', sourceId: { in: ids } }, include: { costCategory: true } });
    const by = (code: string) => ledger.filter((l) => l.costCategory.code === code).reduce((s, l) => s + Number(l.amount), 0);
    check(Math.abs(by('MAT') - BUILK_AJOYA_ACTUAL.MAT) < 0.005, `Materials incurred 301,890.50 (${by('MAT').toFixed(2)})`);
    check(Math.abs(by('LAB') - BUILK_AJOYA_ACTUAL.LAB) < 0.005, `Labor incurred 200,000.00 (${by('LAB').toFixed(2)})`);
    check(Math.abs(by('IND') - BUILK_AJOYA_ACTUAL.IND) < 0.005, `Indirect incurred 55,100.80 (${by('IND').toFixed(2)})`);
    check(ledger.every((l) => l.state === 'INCURRED'), 'nothing committed or consumed');
    const labor = pos.find((p) => p.notes?.includes('2606-055'));
    check(!!labor && labor.items.every((i) => i.nature === 'SERVICE'), "Gas Ion's job order is a service");
    const again = await importBuilkAjoya({ force: true, jobId });
    check(!!again && !again.done, `a second run writes nothing (${again && !again.done ? again.reason : ''})`);
  } finally {
    const pos = await prisma.purchaseOrder.findMany({ where: { jobId, notes: { contains: 'Builk PO' }, createdAt: { gte: startedAt } }, select: { id: true, receivings: { select: { id: true } } } });
    const recIds = pos.flatMap((p) => p.receivings.map((r) => r.id));
    await prisma.jobCostEntry.deleteMany({ where: { sourceType: 'receiving', sourceId: { in: recIds } } });
    await prisma.receiving.deleteMany({ where: { id: { in: recIds } } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: pos.map((p) => p.id) } } });
    await prisma.auditLog.deleteMany({ where: { at: { gte: startedAt }, OR: [{ entityId: { in: [...pos.map((p) => p.id), ...recIds] } }, { entityId: jobId, summary: { startsWith: "Builk's purchases" } }] } });
    if (added.length) await prisma.supplier.deleteMany({ where: { id: { in: added } } });
    if (!hadMark) await prisma.setting.deleteMany({ where: { key: BUILK_AJOYA_MARK } });
    console.log(`Cleaned up ${pos.length} orders, ${recIds.length} Incoming reports and ${added.length} supplier(s) added for the run.`);
  }
}

main().catch((e) => { console.error(e); failed += 1; }).finally(async () => { await prisma.$disconnect(); if (failed) process.exitCode = 1; });
