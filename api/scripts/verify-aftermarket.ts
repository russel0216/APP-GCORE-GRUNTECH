/**
 * Phase 8 verification — Aftermarket.
 *
 *   npx tsx scripts/verify-aftermarket.ts      (the API must be running)
 *
 * The phase's acceptance criterion is one sentence: *a turned-over project
 * generates a PM schedule and a signed PM report*. Getting there honestly
 * means four things have to hold.
 *
 *   · **The schedule has to land on sensible dates.** A quarterly contract
 *     signed in January is visited in April, not on the day it starts; a visit
 *     that would fall after the contract ends is dropped rather than clamped
 *     onto the last day; and three months after 31 January is 30 April.
 *   · **Regenerating a schedule must not erase a visit that was made.**
 *   · **A template that has been used is immutable.** Editing publishes a new
 *     version, and the old report still renders the way it was signed.
 *   · **Warranty is a fact, not a tick box** — decided from the asset's dates
 *     at the time the work was done.
 */

import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { signToken } from '../src/auth/middleware';
import { nextNumber } from '../src/shared/numbering';
import { submitForApproval, act, approversForStep } from '../src/shared/approvals';
import {
  addMonths,
  dayKey,
  daysBetween,
  expiryState,
  planSchedule,
  regenerateSchedule,
  validateSections,
  missingRequired,
  renewalPipeline,
  sweepOverdue,
  type TemplateSection,
} from '../src/shared/aftermarket';
// Side-effect import: registers the three service-report approval subscribers.
import '../src/routes/aftermarket';

if (env.isProduction) {
  console.error('Refusing to run against a production database.');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function expectRejection(label: string, fn: () => Promise<unknown>, expect: string) {
  try {
    await fn();
    check(label, false, 'it was allowed when it should have been refused');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    check(label, message.toLowerCase().includes(expect.toLowerCase()), `got: ${message}`);
  }
}

const D = (v: number) => new Prisma.Decimal(v);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

const TAG = 'ZZAM';
const BASE = `http://localhost:${env.port}/api`;

async function cleanup() {
  await prisma.serviceReport.deleteMany({ where: { customer: { name: { startsWith: TAG } } } });
  await prisma.serviceVisit.deleteMany({ where: { customer: { name: { startsWith: TAG } } } });
  await prisma.serviceContract.deleteMany({ where: { job: { name: { startsWith: TAG } } } });
  await prisma.installedAsset.deleteMany({ where: { customer: { name: { startsWith: TAG } } } });
  await prisma.reportTemplate.deleteMany({ where: { key: { startsWith: 'zzam-' } } });
  await prisma.job.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.costing.deleteMany({ where: { title: { startsWith: TAG } } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: TAG } } });

  const users = await prisma.user.findMany({
    where: { email: { endsWith: '@verifya.local' } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.approvalAction.deleteMany({ where: { approverId: { in: ids } } });
    await prisma.approvalRequest.deleteMany({ where: { requesterId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.user.updateMany({ where: { supervisorId: { in: ids } }, data: { supervisorId: null } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
}

async function makeUser(name: string, email: string, roleKeys: string[]) {
  const roles = await prisma.role.findMany({ where: { key: { in: roleKeys } } });
  return prisma.user.create({
    data: {
      name,
      email,
      passwordHash: await bcrypt.hash('x', 10),
      roles: { create: roles.map((r) => ({ roleId: r.id })) },
    },
  });
}

/** Walks an approval to settlement, asking the engine who may act at each step. */
async function settle(approvalId: string, outcome: 'APPROVED' | 'REJECTED' = 'APPROVED') {
  for (let guard = 0; guard < 10; guard++) {
    const request = await prisma.approvalRequest.findUnique({
      where: { id: approvalId },
      include: { workflow: { include: { steps: { orderBy: { sequence: 'asc' } } } } },
    });
    if (!request || request.status !== 'PENDING') return request;
    const step = request.workflow?.steps.find((s) => s.sequence === request.currentSequence);
    if (!step) throw new Error(`No step ${request.currentSequence}`);
    const eligible = (await approversForStep(step, request.requesterId)).filter(
      (id) => id !== request.requesterId,
    );
    if (!eligible.length) {
      throw new Error(
        `Step "${step.name}" of "${request.workflow?.name}" has nobody who may approve it — the fixture is missing a role holder.`,
      );
    }
    await act({ requestId: approvalId, userId: eligible[0], action: outcome });
    if (outcome === 'REJECTED') break;
  }
  return prisma.approvalRequest.findUnique({ where: { id: approvalId } });
}

async function main() {
  console.log('\nG-CORE aftermarket verification\n');
  await cleanup();

  // ══ The PM schedule ══════════════════════════════════════════════════════
  console.log('The PM schedule');

  const quarterly = planSchedule(day('2026-01-15'), day('2027-01-14'), 3);
  check(
    'a one-year quarterly contract plans three visits inside its term',
    quarterly.length === 3,
    `got ${quarterly.length}: ${quarterly.map((v) => iso(v.dueDate)).join(', ')}`,
  );
  check(
    'the first visit is one interval in, not on the day cover starts',
    iso(quarterly[0].dueDate) === '2026-04-15',
    `got ${iso(quarterly[0].dueDate)}`,
  );
  check(
    'a visit that would fall after the contract ends is dropped, not clamped',
    quarterly.every((v) => v.dueDate <= day('2027-01-14')),
    quarterly.map((v) => iso(v.dueDate)).join(', '),
  );
  check(
    'visits are numbered in sequence',
    quarterly.map((v) => v.sequence).join(',') === '1,2,3',
  );

  // The month-end trap: naive month arithmetic turns 31 January into 3 March.
  check(
    'three months after 31 January is 30 April, not 1 May',
    iso(addMonths(day('2026-01-31'), 3)) === '2026-04-30',
    `got ${iso(addMonths(day('2026-01-31'), 3))}`,
  );
  check(
    'one month after 31 January is 28 February in a common year',
    iso(addMonths(day('2026-01-31'), 1)) === '2026-02-28',
    `got ${iso(addMonths(day('2026-01-31'), 1))}`,
  );
  check(
    'and 29 February in a leap year',
    iso(addMonths(day('2028-01-31'), 1)) === '2028-02-29',
    `got ${iso(addMonths(day('2028-01-31'), 1))}`,
  );

  const monthly = planSchedule(day('2026-01-01'), day('2026-12-31'), 1);
  check('a monthly contract plans eleven visits in a year', monthly.length === 11, `got ${monthly.length}`);

  const annual = planSchedule(day('2026-01-01'), day('2026-06-30'), 12);
  check('an annual visit on a six-month contract plans none', annual.length === 0, `got ${annual.length}`);

  await expectRejection(
    'a contract that ends before it starts is refused',
    async () => planSchedule(day('2027-01-01'), day('2026-01-01'), 3),
    'ends before it starts',
  );
  await expectRejection(
    'visits closer than a month apart are refused',
    async () => planSchedule(day('2026-01-01'), day('2026-12-31'), 0),
    'less than a month apart',
  );

  // ══ Expiry ═══════════════════════════════════════════════════════════════
  console.log('\nWarranty and contract expiry');

  const today = dayKey(new Date());
  const inDays = (n: number) => {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() + n);
    return d;
  };

  check('nothing recorded is NONE, not expired', expiryState(null, 90).state === 'NONE');
  check('a year out is ACTIVE', expiryState(inDays(365), 90).state === 'ACTIVE');
  check('inside the warning window is EXPIRING', expiryState(inDays(30), 90).state === 'EXPIRING');
  check('the day it ends is still EXPIRING, not expired', expiryState(today, 90).state === 'EXPIRING');
  check('the day after is EXPIRED', expiryState(inDays(-1), 90).state === 'EXPIRED');
  check(
    'and it reports how long is left',
    expiryState(inDays(45), 90).daysRemaining === 45,
    `got ${expiryState(inDays(45), 90).daysRemaining}`,
  );

  // ══ Templates ════════════════════════════════════════════════════════════
  console.log('\nReport templates');

  const goodSections = [
    {
      key: 'readings',
      title: 'Readings',
      allowPhotos: true,
      fields: [
        { key: 'purity', label: 'Oxygen purity', type: 'number', unit: '%', required: true },
        { key: 'pressure', label: 'Pressure', type: 'number', unit: 'bar' },
      ],
    },
    {
      key: 'checks',
      title: 'Checks',
      fields: [{ key: 'alarms', label: 'Alarms tested', type: 'boolean', required: true }],
    },
  ];

  const sections = validateSections(goodSections);
  check('a well-formed template validates', sections.length === 2);
  check('and photos default to off where nobody said otherwise', sections[1].allowPhotos === false);

  await expectRejection(
    'a template with no sections is refused',
    async () => validateSections([]),
    'at least one section',
  );
  await expectRejection(
    'two sections sharing a key are refused',
    async () => validateSections([goodSections[0], { ...goodSections[0], title: 'Again' }]),
    'share the key',
  );
  await expectRejection(
    'a section with no fields is refused',
    async () => validateSections([{ key: 'a', title: 'Empty', fields: [] }]),
    'no fields',
  );
  await expectRejection(
    'an unknown field type is refused',
    async () =>
      validateSections([
        { key: 'a', title: 'A', fields: [{ key: 'x', label: 'X', type: 'signature' }] },
      ]),
    'unknown field type',
  );
  await expectRejection(
    'a select with no options is refused',
    async () =>
      validateSections([{ key: 'a', title: 'A', fields: [{ key: 'x', label: 'X', type: 'select' }] }]),
    'select with no options',
  );

  const emptyForm = missingRequired(sections, {});
  check(
    'an empty form reports every required field, by name',
    emptyForm.length === 2 && emptyForm[0].includes('Oxygen purity'),
    emptyForm.join(' | '),
  );
  const partial = missingRequired(sections, { readings: { purity: 93 } });
  check('a partly filled form reports only what is still missing', partial.length === 1, partial.join(' | '));
  const complete = missingRequired(sections, { readings: { purity: 93 }, checks: { alarms: true } });
  check('a complete form reports nothing missing', complete.length === 0);
  check(
    'a required field answered "false" counts as answered',
    missingRequired(sections, { readings: { purity: 93 }, checks: { alarms: false } }).length === 0,
    'false is an answer; empty is not',
  );
  check(
    'but an optional field left blank is never chased',
    !missingRequired(sections, { readings: { purity: 93 }, checks: { alarms: true } }).some((m) =>
      m.includes('Pressure'),
    ),
  );

  // ══ Fixtures ═════════════════════════════════════════════════════════════

  const engineer = await makeUser('ZZ Service Engineer', 'eng@verifya.local', ['service_engineer']);
  const manager = await makeUser('ZZ Service Manager', 'svc@verifya.local', ['service_manager']);
  await makeUser('ZZ Director', 'exec@verifya.local', ['executive']);

  const customer = await prisma.customer.create({
    data: { code: `${TAG}-C1`, name: `${TAG} Hospital` },
  });
  const site = await prisma.customerSite.create({
    data: { customerId: customer.id, name: `${TAG} Main Campus`, city: 'Cagayan de Oro' },
  });

  // The delivery project that installed the plant.
  const projectCosting = await prisma.costing.create({
    data: {
      number: await nextNumber('costing'),
      title: `${TAG} Plant build`,
      ownerId: manager.id,
      totalCost: D(800_000),
      contractValue: D(1_000_000),
    },
  });
  const project = await prisma.job.create({
    data: {
      number: await nextNumber('project'),
      type: 'PROJECT',
      status: 'TURNED_OVER',
      name: `${TAG} Plant build`,
      customerId: customer.id,
      siteId: site.id,
      costingId: projectCosting.id,
      createdById: manager.id,
      projectManagerId: manager.id,
      contractValue: D(1_000_000),
    },
  });

  // ══ The installed base ═══════════════════════════════════════════════════
  console.log('\nThe installed base');

  const installedAt = day('2026-03-01');
  const asset = await prisma.installedAsset.create({
    data: {
      code: await nextNumber('installed_asset'),
      customerId: customer.id,
      siteId: site.id,
      jobId: project.id,
      name: `${TAG} PSA Oxygen Generator`,
      manufacturer: 'Gruntech',
      model: 'GT-PSA-40',
      serialNo: `${TAG}-SN-0001`,
      installedAt,
      warrantyEndsAt: addMonths(installedAt, 12),
    },
  });
  const secondAsset = await prisma.installedAsset.create({
    data: {
      code: await nextNumber('installed_asset'),
      customerId: customer.id,
      siteId: site.id,
      jobId: project.id,
      name: `${TAG} Air Compressor`,
      serialNo: `${TAG}-SN-0002`,
      installedAt,
      warrantyEndsAt: addMonths(installedAt, 12),
    },
  });

  check(
    'an asset keeps its link to the project that installed it',
    asset.jobId === project.id,
    'that link is how a turned-over project becomes a renewal lead',
  );
  check(
    'a twelve-month warranty from 1 March ends on 1 March the next year',
    iso(asset.warrantyEndsAt!) === '2027-03-01',
    `got ${iso(asset.warrantyEndsAt!)}`,
  );

  // ══ The contract and its schedule ════════════════════════════════════════
  console.log('\nService contracts');

  const serviceCosting = await prisma.costing.create({
    data: {
      number: await nextNumber('costing'),
      title: `${TAG} Annual PMS`,
      ownerId: manager.id,
      totalCost: D(120_000),
      contractValue: D(180_000),
    },
  });
  const serviceJob = await prisma.job.create({
    data: {
      number: await nextNumber('project'),
      type: 'SERVICE_CONTRACT',
      name: `${TAG} Annual PMS`,
      customerId: customer.id,
      siteId: site.id,
      costingId: serviceCosting.id,
      createdById: manager.id,
      projectManagerId: manager.id,
      contractValue: D(180_000),
    },
  });

  const contract = await prisma.serviceContract.create({
    data: {
      number: await nextNumber('service_contract'),
      jobId: serviceJob.id,
      startsAt: day('2026-04-01'),
      endsAt: day('2027-03-31'),
      frequencyMonths: 3,
      createdById: manager.id,
      assets: { create: [{ assetId: asset.id }, { assetId: secondAsset.id }] },
    },
  });

  check(
    'a service contract is a job of that type, so it carries its own budget',
    serviceJob.type === 'SERVICE_CONTRACT' && Number(serviceJob.contractValue) === 180_000,
  );

  const generated = await prisma.$transaction((tx) =>
    regenerateSchedule(tx, contract.id, (t) => nextNumber('service_visit', t)),
  );
  check('activating the contract writes its schedule', generated.created === 3, `${generated.created} created`);

  const visits = await prisma.serviceVisit.findMany({
    where: { contractId: contract.id },
    orderBy: { dueDate: 'asc' },
  });
  check(
    'the visits fall a quarter apart, inside the term',
    visits.map((v) => iso(v.dueDate)).join(',') === '2026-07-01,2026-10-01,2027-01-01',
    visits.map((v) => iso(v.dueDate)).join(','),
  );
  check(
    'each visit inherits the customer and site from the contract',
    visits.every((v) => v.customerId === customer.id && v.siteId === site.id),
  );

  // Attend the first visit, then regenerate. The attended one must survive.
  await prisma.serviceVisit.update({
    where: { id: visits[0].id },
    data: { status: 'COMPLETED', performedAt: day('2026-07-02') },
  });
  const again = await prisma.$transaction((tx) =>
    regenerateSchedule(tx, contract.id, (t) => nextNumber('service_visit', t)),
  );
  const afterRegen = await prisma.serviceVisit.findMany({
    where: { contractId: contract.id },
    orderBy: { dueDate: 'asc' },
  });
  check(
    'regenerating the schedule keeps a visit that was actually made',
    again.kept === 1 && afterRegen.filter((v) => v.status === 'COMPLETED').length === 1,
    `kept ${again.kept}, completed ${afterRegen.filter((v) => v.status === 'COMPLETED').length}`,
  );
  check(
    'and does not duplicate it',
    afterRegen.length === 3,
    `${afterRegen.length} visits: ${afterRegen.map((v) => `${v.sequence}:${v.status}`).join(', ')}`,
  );
  check(
    'the completed visit keeps the date it was made',
    iso(afterRegen.find((v) => v.status === 'COMPLETED')!.performedAt!) === '2026-07-02',
  );

  // ══ A PM report ══════════════════════════════════════════════════════════
  console.log('\nService reports');

  const template = await prisma.reportTemplate.create({
    data: {
      key: 'zzam-pm',
      version: 1,
      kind: 'PREVENTIVE_MAINTENANCE',
      name: `${TAG} PM form`,
      sections: goodSections as unknown as Prisma.InputJsonValue,
      createdById: manager.id,
    },
  });

  const openVisit = afterRegen.find((v) => v.status === 'SCHEDULED')!;
  const performedAt = day('2026-10-02');
  const report = await prisma.serviceReport.create({
    data: {
      number: await nextNumber('pm_report'),
      kind: 'PREVENTIVE_MAINTENANCE',
      visitId: openVisit.id,
      contractId: contract.id,
      customerId: customer.id,
      siteId: site.id,
      assetId: asset.id,
      templateId: template.id,
      performedAt,
      performedById: engineer.id,
      data: { readings: { purity: 93.4, pressure: 4.2 }, checks: { alarms: true } },
      findings: `${TAG} plant running within specification`,
      underWarranty: asset.warrantyEndsAt! >= performedAt,
      billable: false,
      customerSignedBy: 'Engr. Dela Cruz',
      customerSignedAt: new Date(),
    },
  });

  check(
    'work inside the warranty period is recorded as covered',
    report.underWarranty === true,
    `warranty to ${iso(asset.warrantyEndsAt!)}, performed ${iso(performedAt)}`,
  );

  const approval = await submitForApproval({
    documentType: 'pm_report',
    documentId: report.id,
    documentNumber: report.number,
    subject: `${TAG} PM`,
    requesterId: engineer.id,
  });

  await expectRejection(
    'the engineer who did the work cannot sign it off',
    () => act({ requestId: approval.id, userId: engineer.id, action: 'APPROVED' }),
    'raised yourself',
  );

  await settle(approval.id);

  const [settledReport, settledVisit] = await Promise.all([
    prisma.serviceReport.findUnique({ where: { id: report.id } }),
    prisma.serviceVisit.findUnique({ where: { id: openVisit.id } }),
  ]);
  check('approval marks the report approved', settledReport?.status === 'APPROVED');
  check(
    'and only then is the visit complete',
    settledVisit?.status === 'COMPLETED',
    `visit ${settledVisit?.status} — a visit marked done when the engineer left site counts one nobody checked`,
  );
  check(
    'the visit takes the date the work was done, not the date it was approved',
    iso(settledVisit!.performedAt!) === '2026-10-02',
    `got ${settledVisit?.performedAt ? iso(settledVisit.performedAt) : 'null'}`,
  );

  // A rejected report leaves its visit open.
  const otherVisit = afterRegen.find((v) => v.status === 'SCHEDULED' && v.id !== openVisit.id)!;
  const rejected = await prisma.serviceReport.create({
    data: {
      number: await nextNumber('pm_report'),
      kind: 'PREVENTIVE_MAINTENANCE',
      visitId: otherVisit.id,
      contractId: contract.id,
      customerId: customer.id,
      assetId: asset.id,
      templateId: template.id,
      performedAt: day('2027-01-05'),
      performedById: engineer.id,
      data: { readings: { purity: 88 }, checks: { alarms: true } },
      customerSignedBy: 'Engr. Dela Cruz',
      customerSignedAt: new Date(),
    },
  });
  const rejectedApproval = await submitForApproval({
    documentType: 'pm_report',
    documentId: rejected.id,
    documentNumber: rejected.number,
    subject: `${TAG} disputed PM`,
    requesterId: engineer.id,
  });
  await settle(rejectedApproval.id, 'REJECTED');

  const [rejectedReport, stillOpen] = await Promise.all([
    prisma.serviceReport.findUnique({ where: { id: rejected.id } }),
    prisma.serviceVisit.findUnique({ where: { id: otherVisit.id } }),
  ]);
  check('a returned report is marked rejected', rejectedReport?.status === 'REJECTED');
  check(
    'and its visit stays open — the work still has to be accounted for',
    stillOpen?.status === 'SCHEDULED',
    `visit ${stillOpen?.status}`,
  );

  // ══ Template immutability ════════════════════════════════════════════════
  console.log('\nTemplate versioning');

  const used = await prisma.reportTemplate.findUnique({
    where: { id: template.id },
    include: { _count: { select: { reports: true } } },
  });
  check('the template now has reports written against it', (used?._count.reports ?? 0) >= 1);

  const v2 = await prisma.$transaction(async (tx) => {
    await tx.reportTemplate.update({ where: { id: template.id }, data: { isCurrent: false } });
    return tx.reportTemplate.create({
      data: {
        key: template.key,
        version: template.version + 1,
        kind: template.kind,
        name: template.name,
        sections: [
          ...goodSections,
          { key: 'extra', title: 'New section', fields: [{ key: 'n', label: 'Note', type: 'note' }] },
        ] as unknown as Prisma.InputJsonValue,
        createdById: manager.id,
      },
    });
  });

  const v1After = await prisma.reportTemplate.findUnique({ where: { id: template.id } });
  const reportAfter = await prisma.serviceReport.findUnique({
    where: { id: report.id },
    include: { template: true },
  });
  check('editing a used template publishes a new version', v2.version === 2 && v2.key === template.key);
  check(
    'the old version is untouched — it still has two sections',
    (v1After!.sections as unknown as TemplateSection[]).length === 2,
  );
  check(
    'and the signed report still points at the version it was filled in on',
    reportAfter?.templateId === template.id && reportAfter.template.version === 1,
    `report is on v${reportAfter?.template.version}`,
  );
  check('only one version is current', v1After!.isCurrent === false && v2.isCurrent === true);

  // ══ Renewals ═════════════════════════════════════════════════════════════
  console.log('\nRenewals');

  // A contract about to lapse, and an uncovered asset whose warranty is going.
  const expiringJob = await prisma.job.create({
    data: {
      number: await nextNumber('project'),
      type: 'SERVICE_CONTRACT',
      name: `${TAG} Expiring PMS`,
      customerId: customer.id,
      siteId: site.id,
      costingId: serviceCosting.id,
      createdById: manager.id,
      contractValue: D(90_000),
    },
  });
  await prisma.serviceContract.create({
    data: {
      number: await nextNumber('service_contract'),
      jobId: expiringJob.id,
      status: 'ACTIVE',
      startsAt: inDays(-300),
      endsAt: inDays(45),
      frequencyMonths: 3,
      createdById: manager.id,
    },
  });

  const lapsing = await prisma.installedAsset.create({
    data: {
      code: await nextNumber('installed_asset'),
      customerId: customer.id,
      siteId: site.id,
      name: `${TAG} Uncovered Booster`,
      serialNo: `${TAG}-SN-0003`,
      installedAt: inDays(-340),
      warrantyEndsAt: inDays(25),
    },
  });

  const pipeline = await renewalPipeline(90);
  const contractRow = pipeline.find((r) => r.kind === 'CONTRACT' && r.reference.startsWith('GT-SC'));
  const warrantyRow = pipeline.find((r) => r.id === lapsing.id);

  check('a contract inside the horizon appears in the renewal pipeline', !!contractRow);
  check(
    'an uncovered asset whose warranty is lapsing appears too',
    !!warrantyRow,
    'the customer is about to start paying for repairs they get free, and nobody has offered them the alternative',
  );
  check(
    'and the pipeline is sorted by how soon, so the urgent call is first',
    pipeline.every((r, i) => i === 0 || pipeline[i - 1].daysRemaining <= r.daysRemaining),
  );
  check(
    'the contract renewal carries its value, a warranty lapse does not',
    contractRow?.value === 90_000 && warrantyRow?.value === null,
    `${contractRow?.value} / ${warrantyRow?.value}`,
  );

  // An asset that IS covered must not be chased as a warranty lapse.
  check(
    'an asset already under an active contract is not in the pipeline',
    !pipeline.some((r) => r.id === asset.id),
    'it is covered — chasing it would be a wasted call',
  );

  // ══ The sweep ════════════════════════════════════════════════════════════
  console.log('\nOverdue sweep');

  const staleJob = await prisma.job.create({
    data: {
      number: await nextNumber('project'),
      type: 'SERVICE_CONTRACT',
      name: `${TAG} Lapsed PMS`,
      customerId: customer.id,
      costingId: serviceCosting.id,
      createdById: manager.id,
      contractValue: D(50_000),
    },
  });
  const stale = await prisma.serviceContract.create({
    data: {
      number: await nextNumber('service_contract'),
      jobId: staleJob.id,
      status: 'ACTIVE',
      startsAt: inDays(-400),
      endsAt: inDays(-10),
      frequencyMonths: 3,
      createdById: manager.id,
    },
  });
  const staleVisit = await prisma.serviceVisit.create({
    data: {
      number: await nextNumber('service_visit'),
      contractId: stale.id,
      customerId: customer.id,
      dueDate: inDays(-40),
    },
  });

  await sweepOverdue();
  const [sweptContract, sweptVisit] = await Promise.all([
    prisma.serviceContract.findUnique({ where: { id: stale.id } }),
    prisma.serviceVisit.findUnique({ where: { id: staleVisit.id } }),
  ]);
  check('a contract past its end date is marked expired', sweptContract?.status === 'EXPIRED');
  check(
    'a visit long past due is marked missed rather than sitting as scheduled forever',
    sweptVisit?.status === 'MISSED',
    `visit ${sweptVisit?.status}`,
  );

  const notYet = await prisma.serviceVisit.findFirst({
    where: { contractId: contract.id, status: 'SCHEDULED' },
  });
  check(
    'a future visit is left alone by the sweep',
    !!notYet || daysBetween(today, day('2027-01-01')) < 0,
  );

  // ══ Route guards, over HTTP ══════════════════════════════════════════════
  console.log('\nRoute guards (over HTTP)');

  const reachable = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok)
    .catch(() => false);

  if (!reachable) {
    failed += 1;
    console.log(
      `  ✗ the API is not reachable at ${BASE} — the route guards were NOT verified.\n` +
        '      Start it with "npm run dev" in api/ and run this script again.',
    );
  } else {
    const managerToken = signToken(manager.id, manager.email);
    const engineerToken = signToken(engineer.id, engineer.email);
    const api = async (token: string, method: string, path: string, body?: unknown) => {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : {} };
    };

    const onProject = await api(managerToken, 'POST', '/service-contracts', {
      jobId: project.id,
      startsAt: '2026-04-01',
      endsAt: '2027-03-31',
    });
    check(
      'coverage terms cannot be attached to a delivery project',
      onProject.status === 400 && String(onProject.body.error).includes('delivery project'),
      `${onProject.status} ${JSON.stringify(onProject.body).slice(0, 140)}`,
    );

    const twice = await api(managerToken, 'POST', '/service-contracts', {
      jobId: serviceJob.id,
      startsAt: '2026-04-01',
      endsAt: '2027-03-31',
    });
    check(
      'a job cannot have two sets of coverage terms',
      twice.status === 400 && String(twice.body.error).includes('already has coverage'),
      `${twice.status} ${JSON.stringify(twice.body).slice(0, 140)}`,
    );

    const dupSerial = await api(engineerToken, 'POST', '/installed-assets', {
      customerId: customer.id,
      name: `${TAG} Duplicate`,
      serialNo: `${TAG}-SN-0001`,
    });
    check(
      'the same serial number cannot be registered twice',
      dupSerial.status === 400 && String(dupSerial.body.error).includes('already registered'),
      `${dupSerial.status} ${JSON.stringify(dupSerial.body).slice(0, 140)}`,
    );

    const derived = await api(engineerToken, 'POST', '/installed-assets', {
      customerId: customer.id,
      name: `${TAG} Derived warranty`,
      installedAt: '2026-05-31',
      warrantyMonths: 12,
    });
    check(
      'a warranty end date is derived from the install date when nobody typed one',
      derived.status === 201 && String(derived.body.warrantyEndsAt).startsWith('2027-05-31'),
      `${derived.status} ${derived.body.warrantyEndsAt}`,
    );

    const bulk = await api(engineerToken, 'POST', `/installed-assets/from-job/${project.id}`, {
      assets: [
        { name: `${TAG} Bulk A`, serialNo: `${TAG}-BULK-1` },
        { name: `${TAG} Bulk B`, serialNo: `${TAG}-BULK-2` },
      ],
      installedAt: '2026-03-01',
      warrantyMonths: 24,
    });
    check(
      'a turned-over project registers everything it installed in one go',
      bulk.status === 201 && bulk.body.length === 2,
      `${bulk.status} ${JSON.stringify(bulk.body).slice(0, 120)}`,
    );
    check(
      'and they all inherit the project, its customer and its site',
      bulk.status === 201 && bulk.body.every((a: { jobId: string; siteId: string }) => a.jobId === project.id && a.siteId === site.id),
    );

    const emptyContract = await prisma.serviceContract.findFirst({ where: { jobId: staleJob.id } });
    await prisma.serviceContract.update({ where: { id: emptyContract!.id }, data: { status: 'DRAFT' } });
    const noAssets = await api(managerToken, 'POST', `/service-contracts/${emptyContract!.id}/activate`);
    check(
      'a contract covering no equipment cannot be activated',
      noAssets.status === 400 && String(noAssets.body.error).includes('No equipment'),
      `${noAssets.status} ${JSON.stringify(noAssets.body).slice(0, 140)}`,
    );

    // A report cannot be submitted half-filled, or unsigned.
    const draft = await api(engineerToken, 'POST', '/service-reports', {
      kind: 'PREVENTIVE_MAINTENANCE',
      templateId: template.id,
      customerId: customer.id,
      assetId: secondAsset.id,
      data: { readings: {} },
    });
    check('an engineer can start a report', draft.status === 201, String(draft.status));

    const halfFilled = await api(engineerToken, 'POST', `/service-reports/${draft.body.id}/submit`);
    check(
      'a report with required fields blank cannot be submitted',
      halfFilled.status === 400 && String(halfFilled.body.error).includes('required field'),
      `${halfFilled.status} ${JSON.stringify(halfFilled.body).slice(0, 160)}`,
    );

    await api(engineerToken, 'PATCH', `/service-reports/${draft.body.id}`, {
      data: { readings: { purity: 94 }, checks: { alarms: true } },
    });
    const unsigned = await api(engineerToken, 'POST', `/service-reports/${draft.body.id}/submit`);
    check(
      'and one nobody signed for on site cannot be submitted either',
      unsigned.status === 400 && String(unsigned.body.error).includes('signed'),
      `${unsigned.status} ${JSON.stringify(unsigned.body).slice(0, 160)}`,
    );

    await api(engineerToken, 'PATCH', `/service-reports/${draft.body.id}`, {
      customerSignedBy: 'Engr. Dela Cruz',
    });
    const signed = await api(engineerToken, 'POST', `/service-reports/${draft.body.id}/submit`);
    check('complete and signed, it goes for approval', signed.status === 200, String(signed.status));

    const locked = await api(engineerToken, 'PATCH', `/service-reports/${draft.body.id}`, {
      findings: 'changed my mind',
    });
    check(
      'a submitted report cannot be edited — its content is what was signed',
      locked.status === 400 && String(locked.body.error).includes('what was signed'),
      `${locked.status} ${JSON.stringify(locked.body).slice(0, 140)}`,
    );

    const dashboard = await api(managerToken, 'GET', '/aftermarket/dashboard');
    check('the aftermarket dashboard runs', dashboard.status === 200, String(dashboard.status));
    check(
      'and counts the installed base, its cover and what is due',
      typeof dashboard.body.installedBase?.total === 'number' &&
        typeof dashboard.body.installedBase?.uncovered === 'number' &&
        typeof dashboard.body.visits?.overdue === 'number',
      JSON.stringify(dashboard.body).slice(0, 160),
    );

    const renewals = await api(managerToken, 'GET', '/aftermarket/renewals?withinDays=90');
    check(
      'the renewal pipeline runs and separates contracts from warranties',
      renewals.status === 200 &&
        typeof renewals.body.counts?.contracts === 'number' &&
        typeof renewals.body.counts?.warranties === 'number',
      `${renewals.status} ${JSON.stringify(renewals.body.counts ?? {}).slice(0, 120)}`,
    );

    const costings = await api(managerToken, 'GET', '/costings?jobType=SERVICE_CONTRACT');
    check(
      'service costing is the costing list narrowed to service contracts',
      costings.status === 200 && costings.body.rows.some((c: { id: string }) => c.id === serviceCosting.id),
      `${costings.status}, ${costings.body.rows?.length} row(s)`,
    );

    const nosy = await api(engineerToken, 'PUT', '/aftermarket/settings', { expiryWarningDays: 30 });
    check(
      'an engineer cannot change the aftermarket rules',
      nosy.status === 403,
      String(nosy.status),
    );
  }

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch(async (err) => {
    console.error('\nVerification crashed:', err);
    await cleanup().catch(() => {});
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
