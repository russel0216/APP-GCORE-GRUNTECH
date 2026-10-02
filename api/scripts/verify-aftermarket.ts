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
 *
 * Phase 10 added two things on top, and their rules are checked here too:
 *
 *   · **The service schedule** is a range feed over visits that sweeps before
 *     it answers, derives "overdue" on read, and opens any one visit by id —
 *     every `?visit=` link depends on that. A report written from a visit
 *     takes the visit's customer, contract and job, so covered work is not
 *     billed by default.
 *   · **A job order** is approved once, schedules exactly one visit, and is
 *     completed by the approved report on that visit. Regenerating a
 *     contract's schedule must never delete a call-out.
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
  coverageFor,
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
// Side-effect imports: register the three service-report approval subscribers,
// the job-order subscriber, and the search and schedule providers. Without
// them an approval here would settle into the void.
import '../src/routes/aftermarket';
import { settleJobOrder, decideCover } from '../src/routes/jobOrders';
import { scheduleFor } from '../src/routes/workspace';
import { resolveUser } from '../src/permissions/resolve';
import { globalSearch } from '../src/shared/search';

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
  // Approvals route to whoever really holds the role, so real people were told
  // about this script's documents too. Every such title carries TAG.
  await prisma.notification.deleteMany({ where: { title: { contains: TAG } } });
  // An invoice raised from a job order holds it (Restrict), so invoices go first.
  await prisma.invoice.deleteMany({ where: { customer: { name: { startsWith: TAG } } } });
  await prisma.serviceReport.deleteMany({ where: { customer: { name: { startsWith: TAG } } } });
  await prisma.jobOrder.deleteMany({ where: { customer: { name: { startsWith: TAG } } } });
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
  const director = await makeUser('ZZ Director', 'exec@verifya.local', ['executive']);
  const sales = await makeUser('ZZ Sales', 'sales@verifya.local', ['sales']);

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

  // A machine the project sold that no contract covers: warranty to 1 March 2027.
  const booster = await prisma.installedAsset.create({
    data: {
      code: await nextNumber('installed_asset'),
      customerId: customer.id,
      siteId: site.id,
      jobId: project.id,
      name: `${TAG} Booster Pump`,
      serialNo: `${TAG}-SN-0004`,
      installedAt,
      warrantyEndsAt: addMonths(installedAt, 12),
    },
  });
  const other = await prisma.customer.create({ data: { code: `${TAG}-C2`, name: `${TAG} Other Clinic` } });

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

  // ══ Job orders ═══════════════════════════════════════════════════════════
  console.log('\nJob orders');

  /** A job order as the route writes one: numbered inside its transaction. */
  const makeJobOrder = (data: Omit<Prisma.JobOrderUncheckedCreateInput, 'number'>) =>
    prisma.$transaction(async (tx) =>
      tx.jobOrder.create({ data: { ...data, number: await nextNumber('job_order', tx) } }),
    );
  /** Submits as the route does: PENDING first, then the engine. */
  const submitJobOrder = async (id: string, requesterId: string) => {
    const jo = await prisma.jobOrder.update({ where: { id }, data: { status: 'PENDING_APPROVAL' } });
    return submitForApproval({
      documentType: 'job_order',
      documentId: jo.id,
      documentNumber: jo.number,
      subject: `${TAG} ${jo.title}`,
      requesterId,
    });
  };

  const warrantyCover = await coverageFor(booster.id, day('2026-11-01'));
  check(
    'warranty is decided from the machine’s dates',
    warrantyCover.suggested === 'WARRANTY' && warrantyCover.underWarranty === true,
    `${warrantyCover.suggested}, underWarranty ${warrantyCover.underWarranty}`,
  );
  check(
    'and warranty work is charged to the project that sold the machine',
    warrantyCover.installingJob?.id === project.id,
    `installing job ${warrantyCover.installingJob?.number}`,
  );

  const lapsedCover = await coverageFor(booster.id, day('2027-04-01'));
  check(
    'after the warranty ends the same call is chargeable',
    lapsedCover.suggested === 'CHARGEABLE' && lapsedCover.underWarranty === false,
    `${lapsedCover.suggested}, underWarranty ${lapsedCover.underWarranty}`,
  );
  const decidedLapsed = await decideCover({ assetId: booster.id, requestedFor: day('2027-04-01') });
  check('and chargeable work names no job until somebody picks one', decidedLapsed.jobId === null);

  // The fixture contract was written straight into the database as a draft;
  // cover is only ever given by an ACTIVE one.
  const draftCover = await coverageFor(asset.id, day('2026-10-05'));
  check(
    'a draft contract covers nothing yet',
    draftCover.contract === null,
    `contract ${draftCover.contract?.number}`,
  );
  await prisma.serviceContract.update({ where: { id: contract.id }, data: { status: 'ACTIVE' } });
  const contractCover = await coverageFor(asset.id, day('2026-10-05'));
  const decidedContract = await decideCover({ assetId: asset.id, requestedFor: day('2026-10-05') });
  check(
    'a machine under an active contract is covered by it',
    contractCover.suggested === 'CONTRACT' && contractCover.contract?.id === contract.id,
    `${contractCover.suggested} ${contractCover.contract?.number}`,
  );
  check(
    'and the cost goes to the contract’s job',
    decidedContract.contractId === contract.id && decidedContract.jobId === serviceJob.id,
    `job ${decidedContract.jobId}`,
  );
  const outsideTerm = await coverageFor(asset.id, day('2027-06-01'));
  check(
    'a date outside the contract’s term is not covered by it',
    outsideTerm.contract === null,
    `${outsideTerm.suggested}`,
  );

  const overridden = await decideCover({
    assetId: booster.id,
    requestedFor: day('2026-11-01'),
    chargeBasis: 'CHARGEABLE',
  });
  check(
    'the decision can be overridden; the fact cannot',
    overridden.chargeBasis === 'CHARGEABLE' && overridden.underWarranty === true,
    `${overridden.chargeBasis}, underWarranty ${overridden.underWarranty}`,
  );
  await expectRejection(
    'claiming contract cover where no contract covers the machine is refused',
    () => decideCover({ assetId: booster.id, requestedFor: day('2026-11-01'), chargeBasis: 'CONTRACT' }),
    'no active service contract',
  );

  const warrantyOrder = await makeJobOrder({
    kind: 'CORRECTIVE',
    customerId: customer.id,
    siteId: site.id,
    assetId: booster.id,
    title: `${TAG} Booster tripping on high temperature`,
    description: 'Trips within ten minutes of starting.',
    requestedFor: day('2026-11-01'),
    chargeBasis: 'WARRANTY',
    underWarranty: true,
    jobId: project.id,
    requestedById: sales.id,
    assignedToId: engineer.id,
  });
  check(
    'a job order is numbered under its own document type',
    /^GT-JO-\d{4}-\d{4}$/.test(warrantyOrder.number),
    warrantyOrder.number,
  );

  const joApproval = await submitJobOrder(warrantyOrder.id, sales.id);
  await expectRejection(
    'the salesperson who asked cannot accept it',
    () => act({ requestId: joApproval.id, userId: sales.id, action: 'APPROVED' }),
    'raised yourself',
  );
  await settle(joApproval.id);

  const [approvedOrder, joVisits] = await Promise.all([
    prisma.jobOrder.findUnique({ where: { id: warrantyOrder.id } }),
    prisma.serviceVisit.findMany({ where: { jobOrderId: warrantyOrder.id } }),
  ]);
  check('approval accepts the order', approvedOrder?.status === 'APPROVED' && !!approvedOrder.approvedAt);
  check('approval schedules the visit, once', joVisits.length === 1, `${joVisits.length} visit(s)`);
  const joVisit = joVisits[0];
  check(
    'the visit carries the order’s kind, customer, site and machine',
    !!joVisit &&
      joVisit.kind === 'CORRECTIVE' &&
      joVisit.customerId === customer.id &&
      joVisit.siteId === site.id &&
      joVisit.assetId === booster.id,
  );
  check(
    'it is due on the day the customer asked for, with the engineer proposed',
    !!joVisit && iso(joVisit.dueDate) === '2026-11-01' && joVisit.assignedToId === engineer.id,
    joVisit ? `${iso(joVisit.dueDate)} / ${joVisit.assignedToId}` : 'no visit',
  );
  check(
    'it is numbered as a service visit and is not part of any generated plan',
    !!joVisit && /-SV-/.test(joVisit.number) && joVisit.sequence === null,
    joVisit?.number,
  );
  const engineerHeard = await prisma.notification.findFirst({
    where: { userId: engineer.id, link: `/g-ops/job-orders/${warrantyOrder.id}` },
  });
  check('the engineer is told, with a link to the order', !!engineerHeard);

  await settleJobOrder({ documentId: warrantyOrder.id }, 'APPROVED');
  check(
    'a settlement that arrives twice schedules nothing twice',
    (await prisma.serviceVisit.count({ where: { jobOrderId: warrantyOrder.id } })) === 1,
  );

  // A call-out under the contract: the order's basis is CONTRACT, so its
  // visit carries the contract — and regenerating the contract's schedule
  // must leave it where it is.
  const contractOrder = await makeJobOrder({
    kind: 'CORRECTIVE',
    customerId: customer.id,
    siteId: site.id,
    assetId: asset.id,
    title: `${TAG} Oxygen purity dropping`,
    description: 'Purity reads 88% at the outlet.',
    requestedFor: day('2026-10-05'),
    chargeBasis: 'CONTRACT',
    contractId: contract.id,
    jobId: serviceJob.id,
    requestedById: sales.id,
    assignedToId: engineer.id,
  });
  await settle((await submitJobOrder(contractOrder.id, sales.id)).id);
  const contractOrderVisit = await prisma.serviceVisit.findFirst({ where: { jobOrderId: contractOrder.id } });
  check(
    'a contract call-out’s visit carries the contract',
    contractOrderVisit?.contractId === contract.id,
    `contract ${contractOrderVisit?.contractId}`,
  );

  const returned = await makeJobOrder({
    kind: 'INSPECTION',
    customerId: customer.id,
    assetId: booster.id,
    title: `${TAG} Annual look at the booster`,
    description: 'Customer wants it looked at before the dry season.',
    requestedFor: day('2026-12-01'),
    chargeBasis: 'CHARGEABLE',
    underWarranty: true,
    requestedById: sales.id,
  });
  await settle((await submitJobOrder(returned.id, sales.id)).id, 'REJECTED');
  check(
    'a returned request schedules nothing',
    (await prisma.jobOrder.findUnique({ where: { id: returned.id } }))?.status === 'REJECTED' &&
      (await prisma.serviceVisit.count({ where: { jobOrderId: returned.id } })) === 0,
  );
  await prisma.jobOrder.update({ where: { id: returned.id }, data: { amount: D(8_500) } });
  await submitJobOrder(returned.id, sales.id);
  const attempts = await prisma.approvalRequest.count({
    where: { documentType: 'job_order', documentId: returned.id },
  });
  check(
    'and can be corrected and resubmitted, keeping both attempts',
    (await prisma.jobOrder.findUnique({ where: { id: returned.id } }))?.status === 'PENDING_APPROVAL' &&
      attempts === 2,
    `${attempts} approval request(s)`,
  );

  // A call-out booked by hand against the contract: no sequence, no order.
  const handCallout = await prisma.serviceVisit.create({
    data: {
      number: await nextNumber('service_visit'),
      kind: 'PREVENTIVE_MAINTENANCE',
      contractId: contract.id,
      customerId: customer.id,
      siteId: site.id,
      assetId: asset.id,
      dueDate: inDays(20),
      notes: `${TAG} extra visit the customer asked for`,
    },
  });
  const generatedBefore = await prisma.serviceVisit.count({
    where: { contractId: contract.id, sequence: { not: null } },
  });
  await prisma.$transaction((tx) => regenerateSchedule(tx, contract.id, (t) => nextNumber('service_visit', t)));
  const [calloutAfter, orderVisitAfter, generatedAfter] = await Promise.all([
    prisma.serviceVisit.findUnique({ where: { id: handCallout.id } }),
    prisma.serviceVisit.findUnique({ where: { id: contractOrderVisit!.id } }),
    prisma.serviceVisit.count({ where: { contractId: contract.id, sequence: { not: null } } }),
  ]);
  check(
    'regenerating the schedule keeps a call-out raised by a job order',
    orderVisitAfter?.id === contractOrderVisit!.id && orderVisitAfter.status === 'SCHEDULED',
    `visit ${orderVisitAfter?.status ?? 'deleted'}`,
  );
  check(
    'and a call-out booked by hand — neither is part of the generated plan',
    calloutAfter?.id === handCallout.id,
    calloutAfter ? 'kept' : 'deleted',
  );
  check(
    'while the generated visits are rewritten to the same count',
    generatedAfter === generatedBefore,
    `${generatedBefore} → ${generatedAfter}`,
  );

  // The engineer's approved report completes the order; a returned one leaves
  // it open. A corrective call is reported and approved as an inspection.
  const writeJoReport = (visitId: string, assetId: string, performed: string) =>
    prisma.$transaction(async (tx) =>
      tx.serviceReport.create({
        data: {
          number: await nextNumber('inspection_report', tx),
          kind: 'CORRECTIVE',
          visitId,
          customerId: customer.id,
          siteId: site.id,
          assetId,
          templateId: template.id,
          performedAt: day(performed),
          performedById: engineer.id,
          data: { readings: { purity: 93 }, checks: { alarms: true } },
          customerSignedBy: 'Engr. Dela Cruz',
          customerSignedAt: new Date(),
        },
      }),
    );
  const joReport = await writeJoReport(joVisit.id, booster.id, '2026-11-03');
  await settle(
    (
      await submitForApproval({
        documentType: 'inspection_report',
        documentId: joReport.id,
        documentNumber: joReport.number,
        subject: `${TAG} corrective`,
        requesterId: engineer.id,
      })
    ).id,
  );
  const [completedOrder, completedVisit] = await Promise.all([
    prisma.jobOrder.findUnique({ where: { id: warrantyOrder.id } }),
    prisma.serviceVisit.findUnique({ where: { id: joVisit.id } }),
  ]);
  check(
    'the engineer’s approved report completes the job order',
    completedOrder?.status === 'COMPLETED' && completedVisit?.status === 'COMPLETED',
    `order ${completedOrder?.status}, visit ${completedVisit?.status}`,
  );
  check(
    'on the day the work was done, not the day it was approved',
    !!completedOrder?.completedAt && iso(completedOrder.completedAt) === '2026-11-03',
    completedOrder?.completedAt ? iso(completedOrder.completedAt) : 'null',
  );

  const returnedReport = await writeJoReport(contractOrderVisit!.id, asset.id, '2026-10-06');
  await settle(
    (
      await submitForApproval({
        documentType: 'inspection_report',
        documentId: returnedReport.id,
        documentNumber: returnedReport.number,
        subject: `${TAG} corrective, disputed`,
        requesterId: engineer.id,
      })
    ).id,
    'REJECTED',
  );
  check(
    'a returned report leaves the order open',
    (await prisma.jobOrder.findUnique({ where: { id: contractOrder.id } }))?.status === 'APPROVED',
  );

  // ══ Today's schedule and Ctrl+K ══════════════════════════════════════════
  console.log('\nMy Work and search');

  const now = new Date();
  const localMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueToday = await prisma.serviceVisit.create({
    data: {
      number: await nextNumber('service_visit'),
      kind: 'INSPECTION',
      customerId: customer.id,
      assetId: secondAsset.id,
      dueDate: new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())),
      assignedToId: engineer.id,
    },
  });
  const engineerUser = await resolveUser(engineer.id);
  const todays = await scheduleFor(engineerUser!, {
    from: localMidnight,
    to: new Date(localMidnight.getTime() + 86_400_000),
  });
  check(
    'a visit due today is on the engineer’s day in My Work',
    todays.some((i) => i.id === dueToday.id && i.link === `/g-ops/visits?visit=${dueToday.id}`),
    `${todays.length} item(s): ${todays.map((i) => i.kind).join(', ')}`,
  );
  check(
    'and a visit due another day is not',
    !todays.some((i) => i.id === joVisit.id),
  );

  const managerUser = await resolveUser(manager.id);
  const hits = await globalSearch(TAG, managerUser!, 5);
  const kinds = new Set(hits.map((h) => h.kind));
  check(
    'Ctrl+K finds machines, contracts, visits and job orders',
    ['installed_asset', 'service_contract', 'service_visit', 'job_order'].every((k) => kinds.has(k)),
    [...kinds].join(', '),
  );
  const salesUser = await resolveUser(sales.id);
  const salesHits = await globalSearch(TAG, salesUser!, 20);
  check(
    'a salesperson finds their own job orders, and no visit they cannot open',
    salesHits.some((h) => h.kind === 'job_order') && !salesHits.some((h) => h.kind === 'service_visit'),
    [...new Set(salesHits.map((h) => h.kind))].join(', '),
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

    /*
      The G-OPS dashboard's "PM accomplished" tile.

      Two things it is easy to get wrong and impossible to notice by looking:
      counting visits that are merely SCHEDULED, and dating them by createdAt
      — the row's birthday — rather than performedAt, the day the engineer
      actually did the work. A visit scheduled in January and performed in
      March belongs to March, and a January range must not claim it.

      Dated in a year of their own, because the contract fixtures above
      generate and complete PM visits of their own in 2026 — an absolute
      count across this year would be measuring those too, and would drift
      the moment those fixtures change.
    */
    const directorToken = signToken(director.id, director.email);
    await prisma.serviceVisit.createMany({
      data: [
        {
          number: `${TAG}-PM-A`, kind: 'PREVENTIVE_MAINTENANCE', status: 'COMPLETED',
          customerId: customer.id, dueDate: day('2019-03-10'), performedAt: day('2019-03-12'),
        },
        {
          number: `${TAG}-PM-B`, kind: 'PREVENTIVE_MAINTENANCE', status: 'COMPLETED',
          customerId: customer.id, dueDate: day('2019-09-10'), performedAt: day('2019-09-12'),
        },
        // Neither of these is an accomplishment: one has not happened, the
        // other is a different kind of visit.
        {
          number: `${TAG}-PM-C`, kind: 'PREVENTIVE_MAINTENANCE', status: 'SCHEDULED',
          customerId: customer.id, dueDate: day('2019-09-15'),
        },
        {
          number: `${TAG}-PM-D`, kind: 'INSPECTION', status: 'COMPLETED',
          customerId: customer.id, dueDate: day('2019-09-10'), performedAt: day('2019-09-12'),
        },
      ],
    });

    const pmIn = async (from: string, to: string) => {
      const res = await api(directorToken, 'GET', `/gops/overview?from=${from}&to=${to}`);
      return (res.body.aftermarket as { pmAccomplished: number } | null)?.pmAccomplished;
    };

    const pmYear = await pmIn('2019-01-01', '2019-12-31');
    check(
      'the dashboard counts PM that was carried out, not PM that was merely booked',
      pmYear === 2,
      `${pmYear} — the scheduled visit and the inspection must not be in it`,
    );

    const pmSep = await pmIn('2019-09-01', '2019-09-30');
    check(
      'and counts it in the month the work was done',
      pmSep === 1,
      `September reported ${pmSep}`,
    );

    const pmJan = await pmIn('2019-01-01', '2019-01-31');
    check(
      'a month nothing was performed in reports none, whatever was booked then',
      pmJan === 0,
      `January reported ${pmJan}`,
    );

    const pmDay = await pmIn('2019-09-12', '2019-09-12');
    check(
      'a single-day range includes work performed on that day',
      pmDay === 1,
      `the day itself reported ${pmDay} — the "to" bound must cover its whole day`,
    );

    // ── The service schedule's calendar feed ─────────────────────────────────
    console.log('\nThe service schedule (over HTTP)');

    const pmC = await prisma.serviceVisit.findUnique({ where: { number: `${TAG}-PM-C` } });
    const sept = `/service-visits/calendar?from=2019-09-01&to=2019-09-30&customerId=${customer.id}`;
    const feed = await api(managerToken, 'GET', sept);
    const feedNumbers = ((feed.body.visits ?? []) as { number: string }[]).map((v) => v.number).sort();
    check(
      'the calendar feed returns every visit due in the window',
      feed.status === 200 && feedNumbers.join(',') === `${TAG}-PM-B,${TAG}-PM-C,${TAG}-PM-D`,
      `${feed.status} ${feedNumbers.join(',')}`,
    );
    const feedC = (feed.body.visits ?? []).find((v: { id: string }) => v.id === pmC?.id);
    check(
      'the feed sweeps before it answers — a visit long past due reads missed',
      feedC?.status === 'MISSED',
      `PM-C is ${feedC?.status}`,
    );
    check(
      'and it says after how many days late a visit counts as missed',
      typeof feed.body.missedAfterDays === 'number',
    );
    const onlyMissed = await api(managerToken, 'GET', `${sept}&status=MISSED`);
    check('a status filter narrows it', onlyMissed.body.visits?.length === 1, `${onlyMissed.body.visits?.length}`);
    const onlyPm = await api(managerToken, 'GET', `${sept}&kind=PREVENTIVE_MAINTENANCE`);
    check('and so does kind', onlyPm.body.visits?.length === 2, `${onlyPm.body.visits?.length}`);

    const pmE = await prisma.serviceVisit.create({
      data: {
        number: `${TAG}-PM-E`, kind: 'PREVENTIVE_MAINTENANCE', customerId: customer.id,
        assetId: asset.id, dueDate: inDays(3),
      },
    });
    const late = await prisma.serviceVisit.create({
      data: {
        number: `${TAG}-PM-F`, kind: 'PREVENTIVE_MAINTENANCE', customerId: customer.id,
        dueDate: inDays(-1),
      },
    });
    const around = await api(
      managerToken,
      'GET',
      `/service-visits/calendar?from=${iso(inDays(-7))}&to=${iso(inDays(7))}&customerId=${customer.id}`,
    );
    const eRow = (around.body.visits ?? []).find((v: { id: string }) => v.id === pmE.id);
    const lateRow = (around.body.visits ?? []).find((v: { id: string }) => v.id === late.id);
    check(
      'a visit due in three days is not overdue and says so',
      eRow?.overdue === false && eRow?.daysUntilDue === 3,
      JSON.stringify({ overdue: eRow?.overdue, days: eRow?.daysUntilDue }),
    );
    check(
      'a visit due yesterday is overdue but still scheduled — missed only after the grace period',
      lateRow?.overdue === true && lateRow?.status === 'SCHEDULED',
      JSON.stringify({ overdue: lateRow?.overdue, status: lateRow?.status }),
    );

    const year = await api(managerToken, 'GET', '/service-visits/calendar?from=2019-01-01&to=2019-12-31');
    check(
      'a year-long window is refused',
      year.status === 400 && String(year.body.error).includes('at most 62 days'),
      `${year.status} ${year.body.error}`,
    );
    const backwards = await api(managerToken, 'GET', '/service-visits/calendar?from=2019-09-30&to=2019-09-01');
    check('and so is one that ends before it starts', backwards.status === 400, String(backwards.status));

    const assign = await api(managerToken, 'PATCH', `/service-visits/${pmC!.id}`, { assignedToId: engineer.id });
    check('a visit can be assigned from the schedule', assign.status === 200, `${assign.status} ${assign.body.error ?? ''}`);
    const byEngineer = await api(managerToken, 'GET', `${sept}&assignedToId=${engineer.id}`);
    check(
      'the engineer filter finds what is booked on them',
      byEngineer.body.visits?.length === 1 && byEngineer.body.visits[0].id === pmC!.id,
      `${byEngineer.body.visits?.length}`,
    );
    check(
      'and the engineer list names them once',
      (byEngineer.body.engineers ?? []).filter((e: { id: string }) => e.id === engineer.id).length === 1,
    );
    const unassigned = await api(managerToken, 'GET', `${sept}&assignedToId=none`);
    check(
      '"unassigned" is its own filter',
      unassigned.body.visits?.length === 2 &&
        !(unassigned.body.visits as { id: string }[]).some((v) => v.id === pmC!.id),
      `${unassigned.body.visits?.length}`,
    );
    const assignedNote = await prisma.notification.findFirst({
      where: { userId: engineer.id, type: 'pm.due' },
      orderBy: { createdAt: 'desc' },
    });
    check(
      'the assignment notification opens the visit, not the list',
      assignedNote?.link === `/g-ops/visits?visit=${pmC!.id}`,
      String(assignedNote?.link),
    );
    const assignAudit = await prisma.auditLog.findFirst({
      where: { entityType: 'service_visit', entityId: pmC!.id, action: 'UPDATED' },
    });
    check('and the reschedule leaves a trail', !!assignAudit);

    const noCancelReason = await api(managerToken, 'PATCH', `/service-visits/${late.id}`, { status: 'CANCELLED' });
    check(
      'a visit cannot be cancelled without a reason',
      noCancelReason.status === 400 && String(noCancelReason.body.error).includes('why'),
      `${noCancelReason.status} ${noCancelReason.body.error}`,
    );

    const loose = await prisma.$transaction(async (tx) =>
      tx.serviceReport.create({
        data: {
          number: await nextNumber('inspection_report', tx),
          kind: 'INSPECTION',
          customerId: customer.id,
          templateId: template.id,
          performedAt: day('2019-09-20'),
          performedById: engineer.id,
          data: {},
        },
      }),
    );
    const withReports = await api(managerToken, 'GET', sept);
    check(
      'a report written with no visit sits on the calendar as a second series',
      withReports.body.reports?.length === 1 && withReports.body.reports[0].id === loose.id,
      `${withReports.body.reports?.length}`,
    );
    const octWindow = await api(
      managerToken,
      'GET',
      `/service-visits/calendar?from=2026-09-20&to=2026-10-20&customerId=${customer.id}`,
    );
    check(
      'a report written against a visit is not repeated there',
      !(octWindow.body.reports as { id: string }[] | undefined)?.some((r) => r.id === report.id),
    );
    const noReports = await api(managerToken, 'GET', `${sept}&includeReports=false`);
    check('and the series can be switched off', noReports.body.reports?.length === 0);

    const nobody = await makeUser('ZZAM nobody', 'nobody@verifya.local', []);
    const nobodyFeed = await api(signToken(nobody.id, nobody.email), 'GET', sept);
    check('somebody with no schedule permission cannot read the feed', nobodyFeed.status === 403, String(nobodyFeed.status));
    const mine = await api(engineerToken, 'GET', `/service-visits/calendar?from=2019-09-01&to=2019-09-30&scope=mine`);
    check(
      '"mine" is what is booked on me',
      mine.status === 200 &&
        (mine.body.visits as { assignedTo: { id: string } | null }[]).length > 0 &&
        (mine.body.visits as { assignedTo: { id: string } | null }[]).every((v) => v.assignedTo?.id === engineer.id),
      `${mine.status} ${mine.body.visits?.length}`,
    );

    const one = await api(managerToken, 'GET', `/service-visits/${pmC!.id}`);
    check(
      'one visit opens on its own — every ?visit= link depends on it',
      one.status === 200 && one.body.id === pmC!.id && one.body.report === null,
      String(one.status),
    );
    const none = await api(managerToken, 'GET', '/service-visits/nope');
    check('and an unknown one is a 404', none.status === 404, String(none.status));

    const late2 = await api(managerToken, 'GET', `/service-visits?statuses=SCHEDULED,MISSED&customerId=${customer.id}&pageSize=200`);
    check(
      'the list takes several statuses — how a late visit stays reportable',
      late2.status === 200 &&
        late2.body.rows.length > 0 &&
        (late2.body.rows as { status: string }[]).every((r) => ['SCHEDULED', 'MISSED'].includes(r.status)),
      `${late2.status} ${late2.body.rows?.length}`,
    );
    check(
      'and a customer filter',
      (late2.body.rows as { customer: { id: string } }[]).every((r) => r.customer.id === customer.id),
    );
    const byAsset = await api(managerToken, 'GET', `/service-visits?assetId=${asset.id}&pageSize=200`);
    check(
      'and a machine filter',
      byAsset.status === 200 &&
        (byAsset.body.rows as { id: string; asset: { id: string } | null }[]).some((r) => r.id === pmE.id) &&
        (byAsset.body.rows as { asset: { id: string } | null }[]).every((r) => r.asset?.id === asset.id),
      `${byAsset.body.rows?.length}`,
    );

    // Writing the report from the visit: the server fills what the visit knows.
    const wrongCustomer = await api(engineerToken, 'POST', '/service-reports', {
      visitId: handCallout.id,
      customerId: other.id,
      data: {},
    });
    check(
      'a report naming a different customer from its visit is refused',
      wrongCustomer.status === 400 && String(wrongCustomer.body.error).includes('different customer'),
      `${wrongCustomer.status} ${wrongCustomer.body.error}`,
    );
    const fromVisit = await api(engineerToken, 'POST', '/service-reports', { visitId: handCallout.id, data: {} });
    check(
      'a report written from a visit takes its customer, site, contract and kind',
      fromVisit.status === 201 &&
        fromVisit.body.customer?.id === customer.id &&
        fromVisit.body.site?.id === site.id &&
        fromVisit.body.contract?.id === contract.id &&
        fromVisit.body.kind === 'PREVENTIVE_MAINTENANCE',
      `${fromVisit.status} ${fromVisit.body.error ?? ''}`,
    );
    check(
      'so contract work is not billed by default',
      fromVisit.body.billable === false,
      `billable ${fromVisit.body.billable}`,
    );
    check(
      'and the contract’s job carries it',
      fromVisit.body.job?.id === serviceJob.id,
      `job ${fromVisit.body.job?.id}`,
    );
    const again2 = await api(engineerToken, 'POST', '/service-reports', { visitId: handCallout.id, data: {} });
    check(
      'a visit takes one report',
      again2.status === 400 && String(again2.body.error).includes('already has report'),
      `${again2.status} ${again2.body.error}`,
    );

    // ── Job orders over HTTP ──────────────────────────────────────────────────
    console.log('\nJob orders (over HTTP)');

    const salesToken = signToken(sales.id, sales.email);
    const raised = await api(salesToken, 'POST', '/job-orders', {
      customerId: customer.id,
      siteId: site.id,
      assetId: booster.id,
      kind: 'CORRECTIVE',
      title: `${TAG} Booster leaking at the seal`,
      description: 'Water on the floor under the booster set.',
      requestedFor: '2026-11-01',
      assignedToId: engineer.id,
    });
    check(
      'a salesperson can raise a job order, and cover is decided from the machine',
      raised.status === 201 && raised.body.chargeBasis === 'WARRANTY' && raised.body.underWarranty === true,
      `${raised.status} ${raised.body.chargeBasis ?? raised.body.error}`,
    );
    check(
      'warranty work is charged to the project that sold it',
      raised.body.job?.id === project.id,
      `job ${raised.body.job?.id}`,
    );
    const elsewhere = await api(salesToken, 'POST', '/job-orders', {
      customerId: other.id,
      assetId: booster.id,
      title: `${TAG} Wrong customer`,
      description: 'The machine is not theirs.',
      requestedFor: '2026-11-01',
    });
    check(
      'a machine at another customer is refused',
      elsewhere.status === 400 && String(elsewhere.body.error).includes('not at this customer'),
      `${elsewhere.status} ${elsewhere.body.error}`,
    );

    const salesList = await api(salesToken, 'GET', '/job-orders?pageSize=200');
    check(
      'with only their own view, a salesperson sees what they raised',
      salesList.status === 200 &&
        (salesList.body.rows as { requestedBy: { id: string } }[]).every((r) => r.requestedBy.id === sales.id),
      `${salesList.status} ${salesList.body.rows?.length}`,
    );
    const theirs = await api(salesToken, 'GET', `/job-orders/${raised.body.id}`);
    check('and opens it', theirs.status === 200 && theirs.body.canEdit === true, String(theirs.status));

    const meddle = await api(engineerToken, 'PATCH', `/job-orders/${raised.body.id}`, { title: `${TAG} Not mine` });
    check(
      'an engineer cannot change somebody else’s job order',
      meddle.status === 403,
      String(meddle.status),
    );
    const own = await api(salesToken, 'PATCH', `/job-orders/${raised.body.id}`, { urgent: true });
    check('its author can', own.status === 200 && own.body.urgent === true, String(own.status));

    const submitted = await api(salesToken, 'POST', `/job-orders/${raised.body.id}/submit`);
    check('and submit it for the service manager', submitted.status === 200, `${submitted.status} ${submitted.body.error ?? ''}`);
    const locked2 = await api(salesToken, 'PATCH', `/job-orders/${raised.body.id}`, { urgent: false });
    check('once submitted it cannot be edited', locked2.status === 400, String(locked2.status));
    const withdraw = await api(salesToken, 'POST', `/job-orders/${raised.body.id}/cancel`, { reason: 'changed mind' });
    check(
      'nor cancelled while the approver has it',
      withdraw.status === 400 && String(withdraw.body.error).includes('approver'),
      `${withdraw.status} ${withdraw.body.error}`,
    );

    const pdf = await fetch(`${BASE}/job-orders/${raised.body.id}/pdf`, {
      headers: { Authorization: `Bearer ${salesToken}` },
    });
    check(
      'the job order prints',
      pdf.status === 200 && (pdf.headers.get('content-type') ?? '').startsWith('application/pdf'),
      `${pdf.status} ${pdf.headers.get('content-type')}`,
    );

    const coverage = await api(salesToken, 'GET', `/job-orders/coverage?assetId=${booster.id}&date=2027-04-01`);
    check(
      'the form can ask what covers a machine before anything is saved',
      coverage.status === 200 && coverage.body.suggested === 'CHARGEABLE',
      `${coverage.status} ${coverage.body.suggested}`,
    );
    const options = await api(salesToken, 'GET', `/job-orders/options?customerId=${customer.id}`);
    check(
      'and list the customer’s machines without Installed Base access',
      options.status === 200 && (options.body.assets as { id: string }[]).some((a) => a.id === booster.id),
      `${options.status}`,
    );

    const cancelApproved = await api(managerToken, 'POST', `/job-orders/${contractOrder.id}/cancel`, {
      reason: 'Customer fixed it themselves',
    });
    const [cancelledOrder, cancelledVisit] = await Promise.all([
      prisma.jobOrder.findUnique({ where: { id: contractOrder.id } }),
      prisma.serviceVisit.findUnique({ where: { id: contractOrderVisit!.id } }),
    ]);
    check(
      'cancelling an accepted order cancels its visit too, with the reason kept',
      cancelApproved.status === 200 &&
        cancelledOrder?.status === 'CANCELLED' &&
        cancelledVisit?.status === 'CANCELLED' &&
        cancelledOrder.cancelReason === 'Customer fixed it themselves',
      `${cancelApproved.status} ${cancelledOrder?.status} / ${cancelledVisit?.status}`,
    );
    const cancelDone = await api(managerToken, 'POST', `/job-orders/${warrantyOrder.id}/cancel`, {
      reason: 'too late',
    });
    check(
      'a completed order cannot be cancelled — its record is what happened',
      cancelDone.status === 400 && String(cancelDone.body.error).includes('completed'),
      `${cancelDone.status} ${cancelDone.body.error}`,
    );

    const assetPage = await api(managerToken, 'GET', `/installed-assets/${booster.id}`);
    check(
      'the machine’s page lists the job orders raised on it',
      assetPage.status === 200 && (assetPage.body.jobOrders as { id: string }[]).some((j) => j.id === warrantyOrder.id),
      `${assetPage.status}`,
    );

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

    // A returned report is corrected and sent again. It used to be frozen,
    // which left its visit holding a dead report: a visit takes one report,
    // so nothing else could ever be written against it.
    const corrected = await api(engineerToken, 'PATCH', `/service-reports/${rejected.id}`, {
      findings: `${TAG} purity re-measured at 93.1%`,
      data: { readings: { purity: 93.1 }, checks: { alarms: true } },
    });
    check('a returned report can be corrected', corrected.status === 200, `${corrected.status} ${corrected.body.error ?? ''}`);
    const resent = await api(engineerToken, 'POST', `/service-reports/${rejected.id}/submit`);
    check(
      'and sent again, so its visit can still complete',
      resent.status === 200 &&
        (await prisma.serviceReport.findUnique({ where: { id: rejected.id } }))?.status === 'PENDING_APPROVAL',
      `${resent.status} ${resent.body.error ?? ''}`,
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

    // ── The G-OPS overview ───────────────────────────────────────────────────
    //
    // It spans sales, delivery and aftermarket, so it is checked here where
    // all three already exist. What matters is not the arithmetic — these are
    // groupBy counts — but that holding the DASHBOARD permission does not hand
    // somebody counts off screens they cannot open. A count is a small leak
    // wearing a number, and it is exactly the kind of thing that gets waved
    // through because it "is only a total".
    // The service manager does not hold the G-OPS dashboard permission by
    // role — which is the right default, and means the actor has to be given
    // it explicitly rather than the assertion being quietly weakened to match.
    const dash = await prisma.permission.findUnique({ where: { key: 'gops.dashboard.view_all' } });
    await prisma.userPermissionOverride.create({
      data: { userId: manager.id, permissionId: dash!.id, effect: 'ALLOW' },
    });

    const overview = await api(managerToken, 'GET', '/gops/overview');
    check('the G-OPS overview runs', overview.status === 200, String(overview.status));
    check(
      'it reports the stretches this person works in',
      !!overview.body.aftermarket && typeof overview.body.aftermarket.contracts === 'object',
      JSON.stringify(overview.body.aftermarket ?? {}).slice(0, 140),
    );
    check(
      'contracts come back tallied by status, not as one number',
      Object.keys(overview.body.aftermarket?.contracts ?? {}).length > 0,
      JSON.stringify(overview.body.aftermarket?.contracts ?? {}).slice(0, 140),
    );

    // The gating, which is the whole reason this endpoint exists rather than a
    // dozen list calls: a service manager holds no projects permission, so the
    // delivery block must be ABSENT — not zero, not an empty object.
    check(
      'a block the caller cannot open is absent, not zeroed',
      overview.body.delivery === null,
      JSON.stringify(overview.body.delivery),
    );
    // Same rule one level down: they can see quotations but not leads.
    check(
      'and the rule holds per screen inside a block',
      overview.body.sales !== null &&
        overview.body.sales.leads === null &&
        overview.body.sales.quotations !== null,
      JSON.stringify(overview.body.sales ?? {}).slice(0, 140),
    );

    const engineerOverview = await api(engineerToken, 'GET', '/gops/overview');
    check(
      'somebody without the dashboard permission cannot open it at all',
      engineerOverview.status === 403,
      String(engineerOverview.status),
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
