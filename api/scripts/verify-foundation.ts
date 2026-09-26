/**
 * Foundation verification.
 *
 *   npx tsx scripts/verify-foundation.ts
 *
 * Phase 1 ships services rather than screens — the approval engine, numbering,
 * permission resolution, the PDF engine. Those are exercised by *modules*,
 * which do not exist yet, so there is no click-path that proves they work.
 * This script drives them exactly the way a Phase 3+ module will: by importing
 * the same functions and calling them.
 *
 * It creates its own users, asserts, and cleans up after itself. Safe to run
 * against a development database; it refuses to run against production.
 */

import zlib from 'node:zlib';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { resolveUser, can, canEditRecord, menuFor } from '../src/permissions/resolve';
import { allPermissions } from '../src/permissions/registry';
import {
  nextNumber,
  previewNext,
  employeeToken,
  periodKeyFor,
  scopedPeriodKey,
  renderPattern,
} from '../src/shared/numbering';
import { redact } from '../src/shared/audit';
import {
  submitForApproval,
  act,
  pendingFor,
  onApprovalSettled,
  approvalSignoffs,
} from '../src/shared/approvals';
import { renderDocument, formatDateTime, formatMoney } from '../src/shared/pdf';
import { readAppearance } from '../src/routes/appearance';

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

const TAG = '__verify__';

async function cleanup() {
  const users = await prisma.user.findMany({
    where: { email: { endsWith: '@verify.local' } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.approvalAction.deleteMany({ where: { approverId: { in: ids } } });
    await prisma.approvalRequest.deleteMany({ where: { requesterId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.auditLog.deleteMany({ where: { entityId: { startsWith: TAG } } });
  await prisma.approvalWorkflow.deleteMany({ where: { documentType: { startsWith: TAG } } });
  await prisma.numberSequence.deleteMany({ where: { documentType: { startsWith: TAG } } });
  await prisma.role.deleteMany({ where: { key: { startsWith: TAG } } });
}

async function makeUser(name: string, email: string, roleKeys: string[], supervisorId?: string) {
  const roles = await prisma.role.findMany({ where: { key: { in: roleKeys } } });
  return prisma.user.create({
    data: {
      name,
      email,
      passwordHash: await bcrypt.hash('verify-only', 10),
      supervisorId: supervisorId ?? null,
      roles: { create: roles.map((r) => ({ roleId: r.id })) },
    },
  });
}

async function main() {
  console.log('\nG-CORE foundation verification\n');
  await cleanup();

  // ── 1. Permission resolution ───────────────────────────────────────────────
  console.log('Permissions');

  const supervisor = await makeUser('Verify Supervisor', 'sup@verify.local', ['supervisor']);
  const hrPerson = await makeUser('Verify HR', 'hr@verify.local', ['hr']);
  const employee = await makeUser('Verify Employee', 'emp@verify.local', ['employee'], supervisor.id);

  const empResolved = (await resolveUser(employee.id))!;
  check('employee inherits role permissions', can(empResolved, 'ghr.leave.create'));
  check('employee does not inherit what the role lacks', !can(empResolved, 'admin.users.view_all'));

  // A per-person DENY must beat the role grant — that is the whole point of
  // overrides, and the ordering is easy to get backwards.
  const leaveCreate = await prisma.permission.findUnique({ where: { key: 'ghr.leave.create' } });
  await prisma.userPermissionOverride.create({
    data: { userId: employee.id, permissionId: leaveCreate!.id, effect: 'DENY' },
  });
  const denied = (await resolveUser(employee.id))!;
  check('a per-person DENY beats the role grant', !can(denied, 'ghr.leave.create'));

  // And an ALLOW grants something no role gave them.
  const auditView = await prisma.permission.findUnique({ where: { key: 'admin.audit.view_all' } });
  await prisma.userPermissionOverride.create({
    data: { userId: employee.id, permissionId: auditView!.id, effect: 'ALLOW' },
  });
  const allowed = (await resolveUser(employee.id))!;
  check('a per-person ALLOW grants beyond the role', can(allowed, 'admin.audit.view_all'));

  // Record ownership — "only the author can edit the quotation".
  const salesUser = await makeUser('Verify Sales', 'sales@verify.local', ['sales']);
  const sales = (await resolveUser(salesUser.id))!;
  check(
    'author may edit their own record',
    canEditRecord(sales, 'gops', 'quotations', salesUser.id),
  );
  check(
    'non-author may not edit someone else’s record',
    !canEditRecord(sales, 'gops', 'quotations', supervisor.id),
  );

  const admin = await prisma.user.findFirst({ where: { isSuperAdmin: true } });
  const superUser = (await resolveUser(admin!.id))!;
  check(
    'super admin may edit any record',
    canEditRecord(superUser, 'gops', 'quotations', salesUser.id),
  );

  // The menu is derived from permissions, so it can never show an unreachable
  // screen.
  const menu = menuFor(sales);
  const salesScreens = menu.flatMap((m) => m.submodules.map((s) => `${m.key}.${s.key}`));
  check('sales sees quotations in their menu', salesScreens.includes('gops.quotations'));
  check('sales does not see admin screens', !salesScreens.some((s) => s.startsWith('admin.')));

  // The hire-to-separate screens reach HR through the registry, not through a
  // hand-written menu — so the menu is the assertion.
  const hrResolved = (await resolveUser(hrPerson.id))!;
  const hrScreens = menuFor(hrResolved).flatMap((m) => m.submodules.map((s) => `${m.key}.${s.key}`));
  for (const screen of ['ghr.plantilla', 'ghr.clearances', 'ghr.evaluations', 'ghr.courses']) {
    check(`hr sees ${screen} in their menu`, hrScreens.includes(screen));
  }

  // A clearance is signed off through the engine; a plantilla position is
  // master data. The registry must only mint the approve right where a
  // document actually routes.
  const permissionKeys = new Set(allPermissions().map((p) => p.key));
  check('the registry defines ghr.clearances.approve', permissionKeys.has('ghr.clearances.approve'));
  check('and does not define ghr.plantilla.approve', !permissionKeys.has('ghr.plantilla.approve'));

  // ── 2. Document numbering ──────────────────────────────────────────────────
  console.log('\nNumbering');

  // The purchase order carries the stock company-wide yearly pattern. (The
  // quotation used to be the specimen here, until it took the house scheme —
  // per-author, per-month — which has its own cases below.)
  const first = await nextNumber('purchase_order');
  check('number matches the configured pattern', /^GT-PO-\d{4}-\d{4}$/.test(first), first);

  const thisYear = String(new Date().getFullYear());
  const poCounter = await prisma.numberSequence.findUnique({
    where: { documentType_periodKey: { documentType: 'purchase_order', periodKey: thisYear } },
  });
  check(
    'a company-wide yearly counter is keyed by the bare year',
    poCounter !== null && poCounter.lastNumber >= 1,
    poCounter ? `${poCounter.periodKey} → ${poCounter.lastNumber}` : 'no counter row',
  );

  // Concurrency is the failure mode that matters: two people saving a document
  // at the same moment must not receive the same number.
  const concurrent = await Promise.all(Array.from({ length: 25 }, () => nextNumber('purchase_order')));
  check(
    '25 concurrent numbers are all unique',
    new Set(concurrent).size === 25,
    `${new Set(concurrent).size} distinct`,
  );

  const codes = await Promise.all([nextNumber('purchase_order'), nextNumber('invoice')]);
  check('each document type has its own counter', /GT-PO-/.test(codes[0]) && /GT-INV-/.test(codes[1]));

  // The token chain, off the database. These are the examples the contract
  // gives, so a change to any of them is a change to every number issued.
  check(
    '{EMP} is the last run of digits, padded to three',
    employeeToken('GT-EMP-2026-0007') === '007' &&
      employeeToken('12') === '012' &&
      employeeToken('1234') === '1234',
    [employeeToken('GT-EMP-2026-0007'), employeeToken('12'), employeeToken('1234')].join(' '),
  );
  check(
    'an author with no employee number is 000, not an error',
    employeeToken(null) === '000' && employeeToken('no-digits') === '000',
  );
  const sept = new Date(2026, 8, 17, 9, 13);
  check(
    'a period key is the year, the month, or nothing',
    periodKeyFor('YEAR', sept) === '2026' && periodKeyFor('MONTH', sept) === '2026-09' && periodKeyFor('NONE', sept) === '',
    [periodKeyFor('YEAR', sept), periodKeyFor('MONTH', sept), periodKeyFor('NONE', sept)].join(' | '),
  );
  check(
    'an OWNER counter carries the author in its key',
    scopedPeriodKey('MONTH', 'OWNER', sept, '007') === '2026-09@007' &&
      scopedPeriodKey('MONTH', 'GLOBAL', sept, '007') === '2026-09',
  );
  check(
    'the house quotation scheme renders as employee, yy, mm, seq',
    renderPattern('{EMP}{YY}{MM}{SEQ}', { prefix: 'GT', typeCode: 'QT', seq: 1, padding: 3, at: sept, emp: '007' }) ===
      '0072609001',
    renderPattern('{EMP}{YY}{MM}{SEQ}', { prefix: 'GT', typeCode: 'QT', seq: 1, padding: 3, at: sept, emp: '007' }),
  );

  // The new document types are seeded with the stock pattern. Issued inside a
  // transaction that is rolled back, so the run leaves their counters alone.
  const ROLLBACK = new Error('verify — roll back');
  const newTypes = [
    'position',
    'cash_advance',
    'job_order',
    'clearance',
    'meeting',
    'evaluation',
    'training_session',
    'training_certification',
  ];
  const issued: Record<string, string> = {};
  await prisma
    .$transaction(async (tx) => {
      for (const type of newTypes) issued[type] = await nextNumber(type, tx);
      throw ROLLBACK;
    })
    .catch((err) => {
      if (err !== ROLLBACK) throw err;
    });
  for (const type of newTypes) {
    check(
      `${type} numbers on the stock pattern`,
      /^GT-(POS|CA|JO|CLR|MTG|EVAL|TS|TC)-\d{4}-\d{4}$/.test(issued[type] ?? ''),
      issued[type] ?? 'nothing issued',
    );
  }

  // Per-author counters. A throwaway type carrying the quotation's house
  // scheme, so the assertion does not depend on how this database's real
  // quotation template happens to be configured.
  await prisma.numberSequence.create({
    data: {
      documentType: `${TAG}_owner`,
      label: 'Verify — per-author monthly',
      pattern: '{EMP}{YY}{MM}{SEQ}',
      typeCode: 'VQ',
      period: 'MONTH',
      scope: 'OWNER',
      padding: 3,
    },
  });
  const preview = await previewNext(`${TAG}_owner`, { employeeNo: 'GT-EMP-2026-0007', at: sept });
  const own1 = await nextNumber(`${TAG}_owner`, prisma, { employeeNo: 'GT-EMP-2026-0007', at: sept });
  const own2 = await nextNumber(`${TAG}_owner`, prisma, { employeeNo: 'GT-EMP-2026-0007', at: sept });
  const other = await nextNumber(`${TAG}_owner`, prisma, { employeeNo: 'GT-EMP-2026-0008', at: sept });
  check('an author’s run starts at 001', own1 === '0072609001', own1);
  check('and continues for the same author', own2 === '0072609002', own2);
  check('a colleague’s run is their own', other === '0082609001', other);
  check('the preview said what was then issued', preview.number === own1, `${preview.number} vs ${own1}`);
  check('and the preview names the counter it read', preview.periodKey === '2026-09@007', preview.periodKey);
  const ownerCounter = await prisma.numberSequence.findUnique({
    where: { documentType_periodKey: { documentType: `${TAG}_owner`, periodKey: '2026-09@007' } },
  });
  check('the counter row is keyed by month and author', ownerCounter?.lastNumber === 2, `${ownerCounter?.lastNumber}`);
  const nextMonth = await nextNumber(`${TAG}_owner`, prisma, {
    employeeNo: 'GT-EMP-2026-0007',
    at: new Date(2026, 9, 1),
  });
  check('a new month restarts the run', nextMonth === '0072610001', nextMonth);

  // An author with no employee record still gets a number — under 000, which
  // is visible on the document rather than silently borrowing someone's run.
  const unlinked = await nextNumber(`${TAG}_owner`, prisma, { ownerId: salesUser.id, at: sept });
  check('an unlinked author numbers under 000', unlinked === '0002609001', unlinked);

  // An OWNER counter whose pattern cannot show the owner would hand two people
  // the same number. Refused before anything is written.
  await prisma.numberSequence.create({
    data: {
      documentType: `${TAG}_owner_blind`,
      label: 'Verify — per-author without {EMP}',
      pattern: '{PREFIX}-{TYPE}-{SEQ}',
      typeCode: 'VB',
      period: 'NONE',
      scope: 'OWNER',
    },
  });
  await expectRejection(
    'a per-author counter without {EMP} in its pattern is refused',
    () => nextNumber(`${TAG}_owner_blind`, prisma, { employeeNo: '7' }),
    'needs {EMP}',
  );
  check(
    'and nothing was written for it',
    (await prisma.numberSequence.count({ where: { documentType: `${TAG}_owner_blind` } })) === 1,
  );

  // ── 3. The approval engine ─────────────────────────────────────────────────
  console.log('\nApproval engine');

  let settledOutcome: string | null = null;
  onApprovalSettled('leave_request', async (_req, outcome) => {
    settledOutcome = outcome;
  });

  const leave = await submitForApproval({
    documentType: 'leave_request',
    documentId: `${TAG}-leave-1`,
    documentNumber: 'GT-LV-2026-0001',
    subject: 'Verify — 1 day vacation leave',
    requesterId: employee.id,
    link: '/g-hr/leave/verify-1',
  });
  check('a document can be submitted for approval', leave.status === 'PENDING');

  const supQueue = await pendingFor(supervisor.id);
  check(
    'it routes to the requester’s supervisor',
    supQueue.some((r) => r.id === leave.id),
  );

  const hrQueue = await pendingFor(hrPerson.id);
  check(
    'it does not appear in an unrelated queue',
    !hrQueue.some((r) => r.id === leave.id),
  );

  const notified = await prisma.notification.count({
    where: { userId: supervisor.id, type: 'approval.required' },
  });
  check('the approver is notified', notified > 0);

  const notification = await prisma.notification.findFirst({
    where: { userId: supervisor.id, type: 'approval.required' },
  });
  check(
    'the notification deep-links to the record, not a list',
    notification?.link === '/g-hr/leave/verify-1',
    notification?.link ?? 'no link',
  );

  // Segregation of duties. Here the requester is not an eligible approver
  // anyway; the case where they ARE is covered under thresholds below.
  await expectRejection(
    'the requester cannot approve their own document',
    () => act({ requestId: leave.id, userId: employee.id, action: 'APPROVED' }),
    'cannot approve a document you raised',
  );
  await expectRejection(
    'an unrelated person cannot approve it',
    () => act({ requestId: leave.id, userId: salesUser.id, action: 'APPROVED' }),
    'not yours to act on',
  );

  const approvedLeave = await act({
    requestId: leave.id,
    userId: supervisor.id,
    action: 'APPROVED',
    comment: 'Approved by verification',
  });
  check('the supervisor can approve it', approvedLeave.status === 'APPROVED');
  check('the outcome subscriber fires', settledOutcome === 'APPROVED', String(settledOutcome));

  const requesterNotified = await prisma.notification.count({
    where: { userId: employee.id, type: 'approval.approved' },
  });
  check('the requester is told the outcome', requesterNotified > 0);

  await expectRejection(
    'a decided request cannot be decided twice',
    () => act({ requestId: leave.id, userId: supervisor.id, action: 'REJECTED' }),
    'already been decided',
  );

  // ── 4. Overtime: cost must not post until BOTH approvals exist ─────────────
  console.log('\nOvertime — the two-step rule');

  let overtimePosted = false;
  onApprovalSettled('overtime_request', async (_req, outcome) => {
    // This is where Phase 6 will post the labour cost to the job cost ledger.
    if (outcome === 'APPROVED') overtimePosted = true;
  });

  const ot = await submitForApproval({
    documentType: 'overtime_request',
    documentId: `${TAG}-ot-1`,
    documentNumber: 'GT-OT-2026-0001',
    subject: 'Verify — 3 hours overtime',
    amount: 1875,
    requesterId: employee.id,
  });

  await act({ requestId: ot.id, userId: supervisor.id, action: 'APPROVED' });
  const afterSupervisor = await prisma.approvalRequest.findUnique({ where: { id: ot.id } });
  check('after the supervisor it is still pending', afterSupervisor?.status === 'PENDING');
  check('cost has NOT posted on one approval alone', !overtimePosted);
  check('it has advanced to step 2', afterSupervisor?.currentSequence === 2);

  const hrSees = await pendingFor(hrPerson.id);
  check('HR now sees it', hrSees.some((r) => r.id === ot.id));

  await act({ requestId: ot.id, userId: hrPerson.id, action: 'APPROVED' });
  const afterHr = await prisma.approvalRequest.findUnique({ where: { id: ot.id } });
  check('after HR it is approved', afterHr?.status === 'APPROVED');
  check('cost posts only once BOTH have approved', overtimePosted);

  // ── 5. Amount bands pick the workflow ──────────────────────────────────────
  console.log('\nApproval thresholds');

  // Someone has to hold the project_manager role, or these workflows route to
  // nobody. The engine warns loudly in that case rather than silently stalling.
  const pm = await makeUser('Verify PM', 'pm@verify.local', ['project_manager']);

  const small = await submitForApproval({
    documentType: 'purchase_request',
    documentId: `${TAG}-pr-small`,
    subject: 'Verify — small PR',
    amount: 20_000,
    requesterId: employee.id,
  });
  check(
    'a role-routed step reaches everyone holding that role',
    (await pendingFor(pm.id)).some((r) => r.id === small.id),
  );

  // A document whose only eligible approver is the requester can never move.
  //
  // This uses a throwaway role and workflow rather than project_manager: the
  // assertion is about a role with exactly ONE holder, and a shared role's
  // membership depends on whatever else is in the database. An earlier version
  // of this test passed or failed depending on who happened to exist.
  const soloRole = await prisma.role.create({
    data: { key: `${TAG}_solo`, name: 'Verify Solo Approver' },
  });
  await prisma.userRole.create({ data: { userId: pm.id, roleId: soloRole.id } });
  await prisma.approvalWorkflow.create({
    data: {
      documentType: `${TAG}_solo_doc`,
      name: 'Verify — routes only to the requester',
      steps: {
        create: [
          { sequence: 1, name: 'Solo approval', approverType: 'ROLE', roleId: soloRole.id },
        ],
      },
    },
  });

  await expectRejection(
    'a document whose only approver is the requester is refused at submission',
    () =>
      submitForApproval({
        documentType: `${TAG}_solo_doc`,
        documentId: `${TAG}-solo`,
        subject: 'Verify — sole approver raises their own document',
        amount: 20_000,
        requesterId: pm.id,
      }),
    'only to you',
  );

  // With a second project manager the same document submits fine — and the
  // self-approval rule is what stops the requester acting on it.
  const pm2 = await makeUser('Verify PM Two', 'pm2@verify.local', ['project_manager']);
  const pmOwnRequest = await submitForApproval({
    documentType: 'purchase_request',
    documentId: `${TAG}-pr-pm-own`,
    subject: 'Verify — PM raises their own PR',
    amount: 20_000,
    requesterId: pm.id,
  });
  check('with a second approver it submits', pmOwnRequest.status === 'PENDING');
  await expectRejection(
    'an eligible approver still cannot approve their OWN document',
    () => act({ requestId: pmOwnRequest.id, userId: pm.id, action: 'APPROVED' }),
    'cannot approve a document you raised',
  );
  check(
    'and it stays out of their own queue',
    !(await pendingFor(pm.id)).some((r) => r.id === pmOwnRequest.id),
  );
  check(
    'but it is in the other approver’s queue',
    (await pendingFor(pm2.id)).some((r) => r.id === pmOwnRequest.id),
  );
  const smallWf = await prisma.approvalWorkflow.findUnique({
    where: { id: small.workflowId! },
    include: { steps: true },
  });
  check('a small request takes the short route', smallWf?.steps.length === 1, `${smallWf?.steps.length} steps`);

  const large = await submitForApproval({
    documentType: 'purchase_request',
    documentId: `${TAG}-pr-large`,
    subject: 'Verify — large PR',
    amount: 450_000,
    requesterId: employee.id,
  });
  const largeWf = await prisma.approvalWorkflow.findUnique({
    where: { id: large.workflowId! },
    include: { steps: true },
  });
  check('a large request collects more signatures', (largeWf?.steps.length ?? 0) === 3, `${largeWf?.steps.length} steps`);

  await expectRejection(
    'the same document cannot be submitted twice while pending',
    () =>
      submitForApproval({
        documentType: 'purchase_request',
        documentId: `${TAG}-pr-small`,
        subject: 'Verify — duplicate',
        amount: 20_000,
        requesterId: employee.id,
      }),
    'already awaiting approval',
  );

  // ── 6. Audit trail ─────────────────────────────────────────────────────────
  console.log('\nAudit trail');

  const trail = await prisma.auditLog.findMany({
    where: { entityId: `${TAG}-leave-1` },
    orderBy: { at: 'asc' },
  });
  check(
    'the lifecycle is recorded: submitted then approved',
    trail.map((t) => t.action).join(' → ') === 'SUBMITTED → APPROVED',
    trail.map((t) => t.action).join(' → ') || 'nothing recorded',
  );
  check('the decision records who made it', trail.some((t) => t.summary?.includes('Verify Supervisor')));

  // Pay data and statutory numbers must never reach the audit log — the log is
  // readable by anyone holding admin.audit.view_all, which is not the same
  // right as ghr.employee_rates.view_all.
  const stripped = redact({
    name: 'Verify Employee',
    dailyRate: 1,
    burdenMultiplier: 1,
    sssNo: 'x',
    philhealthNo: 'x',
    pagibigNo: 'x',
    tin: 'x',
  });
  const payKeys = ['dailyRate', 'burdenMultiplier', 'sssNo', 'philhealthNo', 'pagibigNo', 'tin'];
  check(
    'redact() strips pay data and statutory numbers',
    payKeys.every((k) => !(k in stripped)),
    payKeys.filter((k) => k in stripped).join(', ') || 'none leaked',
  );
  check('and keeps the honest fields', stripped.name === 'Verify Employee');

  // ── 7. PDF engine ──────────────────────────────────────────────────────────
  console.log('\nDocument engine');

  const pdf = await renderDocument({
    title: 'Verification Document',
    documentNumber: first,
    revision: '0',
    reference: 'Foundation verification',
    sections: [
      { kind: 'fields', title: 'Header', fields: [{ label: 'Checked', value: 'Yes' }] },
      {
        kind: 'table',
        title: 'Lines',
        head: ['Item', 'Amount'],
        align: ['left', 'right'],
        rows: Array.from({ length: 60 }, (_, i) => [`Line item ${i + 1}`, '1,000.00']),
      },
    ],
  });
  check('a PDF renders', pdf.length > 1000, `${pdf.length} bytes`);
  check('it is a valid PDF', pdf.subarray(0, 5).toString() === '%PDF-');

  // 60 table rows over three pages. It was two until the rows were given the
  // height the reference documents use — a deliberate change, and the exact
  // number is kept here so the next change to row metrics is deliberate too.
  //
  // What this really guards is the footer: it sits below the bottom margin, and
  // when PDFKit treated that as overflow it gave every footer a page of its own
  // and turned this document into six.
  const pageCount = Number((pdf.toString('latin1').match(/\/Count\s+(\d+)/) ?? [])[1] ?? 0);
  check('long content paginates without runaway pages', pageCount === 3, `${pageCount} pages`);

  // ── 8. Signature timestamps ────────────────────────────────────────────────
  console.log('\nSignature timestamps');

  // The approval engine records who acted and when; that is what fills in a
  // name and a date under "Checked by" and "Approved by" on the printed sheet.
  const signoffs = await approvalSignoffs('overtime_request', `${TAG}-ot-1`);
  check('both approvals come back as sign-offs', signoffs.length === 2, `${signoffs.length}`);
  check('in step order', signoffs[0]?.name === supervisor.name && signoffs[1]?.name === hrPerson.name);
  check('each carries the moment it was approved', signoffs.every((x) => x.at instanceof Date));

  const signed = await renderDocument({
    title: 'Signed Document',
    documentNumber: 'GT-OT-2026-0001',
    sections: [{ kind: 'fields', fields: [{ label: 'Checked', value: 'Yes' }] }],
    signatories: [
      { role: 'Prepared by', name: employee.name, at: ot.createdAt },
      { role: 'Checked by', ...signoffs[0] },
      { role: 'Approved by', ...signoffs[1] },
    ],
  });
  const signedText = pdfText(signed);

  const stamp = (d: Date) => formatDateTime(d);
  check('the preparer is dated', signedText.includes(stamp(ot.createdAt)));
  check('the checker is dated', signedText.includes(stamp(signoffs[0].at)));
  check('the approver is dated', signedText.includes(stamp(signoffs[1].at)));
  check(
    'each name is still printed against its role',
    signedText.includes(employee.name) &&
      signedText.includes(supervisor.name) &&
      signedText.includes(hrPerson.name),
  );

  // Pinned to the form the reference documents use: "Sep 17, 2026, 9:13 AM".
  check(
    'the stamp reads the way the reference documents print it',
    /^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M$/.test(stamp(new Date('2026-09-19T07:40:00Z'))),
    stamp(new Date('2026-09-19T07:40:00Z')),
  );

  // An unsigned slot says Pending. Borrowing the document's own date would make
  // an unapproved document look approved.
  const unsigned = await renderDocument({
    title: 'Unsigned Document',
    date: new Date('2026-01-02T03:04:00Z'),
    sections: [{ kind: 'fields', fields: [{ label: 'Checked', value: 'Yes' }] }],
    signatories: [
      { role: 'Prepared by', name: employee.name, at: ot.createdAt },
      { role: 'Approved by' },
    ],
  });
  const unsignedText = pdfText(unsigned);
  check(
    'an unsigned slot carries no date at all',
    !unsignedText.includes(stamp(new Date('2026-01-02T03:04:00Z'))),
  );
  check('and says so rather than sitting blank', unsignedText.includes('Pending'));

  const pages = (buf: Buffer) => Number((buf.toString('latin1').match(/\/Count\s+(\d+)/) ?? [])[1] ?? 0);
  check('the sign-offs do not cost the document a page', pages(signed) === 1, `${pages(signed)} pages`);

  // ── 9. Printing to the reference pattern ───────────────────────────────────
  console.log('\nDocument pattern');

  // Money is printed with the currency CODE. U+20B1 is outside WinAnsi, which
  // is all a standard PDF font can draw, so the peso sign silently rendered as
  // "±" on every amount this engine has ever produced.
  const money = formatMoney(1562.2);
  check('money reads as the reference prints it', money === 'PHP 1,562.20', money);
  check(
    'and is drawable by a standard PDF font',
    [...money].every((c) => c.codePointAt(0)! <= 0xff),
    [...money].filter((c) => c.codePointAt(0)! > 0xff).join(''),
  );
  check(
    'an amount survives the round trip into the page',
    pdfText(
      await renderDocument({
        title: 'Money',
        sections: [{ kind: 'table', head: ['Item', 'Amount'], align: ['left', 'right'], rows: [['x', money]] }],
      }),
    ).includes('PHP 1,562.20'),
  );

  // The margin is the "maximise the print margin" the layout was asked for.
  // Measured off the page rather than read back off the constant.
  const edges = pdfEdges(signed);
  check('content starts 14pt from the edge', edges.left === 14, `${edges.left}pt`);
  check('and nothing runs off the bottom', edges.bottom > 12, `${edges.bottom}pt clear`);


  // ══ Appearance ═══════════════════════════════════════════════════════════
  console.log('');
  console.log('Appearance');

  /*
    Token values are written straight into a <style> element, so the sanitiser
    is the only thing between a saved setting and a rule nobody asked for. A
    value carrying a brace could close the declaration and open its own; a
    name carrying `</style>` could leave CSS altogether.
  */
  const hostile = readAppearance({
    tokens: {
      'fs-base': '16px',
      'sidebar-w': '240px; } body { display: none; ',
      'evil</style><script>alert(1)</script>': 'x',
      'has space': '10px',
      'comment': '10px /* ',
    },
    dark: { neon: '#39ff9d' },
    day: { neon: '#0a7148' },
    css: '.page-head h1 { letter-spacing: 3px; }',
  });

  check(
    'a token value that would close its own declaration is dropped',
    hostile.tokens['sidebar-w'] === undefined,
    JSON.stringify(hostile.tokens['sidebar-w']),
  );
  check(
    'and a token name that would leave the style element with it',
    Object.keys(hostile.tokens).every((k) => /^[a-z0-9-]+$/.test(k)),
    Object.keys(hostile.tokens).join(', '),
  );
  check(
    'the honest ones in the same payload still come through',
    hostile.tokens['fs-base'] === '16px',
    JSON.stringify(hostile.tokens),
  );
  check(
    'each theme keeps its own colours rather than sharing one set',
    hostile.dark.neon === '#39ff9d' && hostile.day.neon === '#0a7148',
    `dark ${hostile.dark.neon}, day ${hostile.day.neon}`,
  );
  check(
    'custom CSS is kept as written — it is the sanctioned way to write a rule',
    hostile.css.includes('letter-spacing: 3px'),
  );

  const empty = readAppearance(undefined);
  check(
    'an unset appearance reads as nothing overridden, not as a broken one',
    !Object.keys(empty.tokens).length &&
      !Object.keys(empty.dark).length &&
      !Object.keys(empty.day).length &&
      empty.css === '',
  );

  /*
    An empty value means "use the stylesheet", so it must not survive as a
    token — `--fs-base: ;` is a parse error that takes the whole block with it.
  */
  const blanks = readAppearance({ tokens: { 'fs-base': '   ', 'fs-lg': '18px' } });
  check(
    'a blank value clears the override instead of writing an empty rule',
    blanks.tokens['fs-base'] === undefined && blanks.tokens['fs-lg'] === '18px',
    JSON.stringify(blanks.tokens),
  );

  /*
    Per-element rules from the layout editor.

    The selector whitelist shipped without `/` in it, which quietly threw away
    every rule the editor produced — they all begin `[data-route="/g-ops"]`.
    The save returned 200 and the layout snapped back on the next load, which
    is the worst shape a bug can take: a success message over a discarded
    write. The real selector is the assertion.
  */
  const real =
    '[data-route="/g-ops"] .panel-block:nth-child(1) div:nth-child(3) .kpi-card:nth-child(1)';
  const editor = readAppearance({
    rules: {
      [real]: { transform: 'translate(40px, 24px)', width: '497px' },
      'body } * { display: none': { width: '10px' },
      '.card': { 'background: red; x': '1px' },
      '.empty': {},
    },
  });

  check(
    'a selector the layout editor actually produces is stored, route scope and all',
    editor.rules[real]?.transform === 'translate(40px, 24px)' &&
      editor.rules[real]?.width === '497px',
    JSON.stringify(editor.rules[real]),
  );
  check(
    'a selector that would close the rule and open its own is dropped',
    editor.rules['body } * { display: none'] === undefined,
  );
  check(
    'so is a property name smuggling a second declaration',
    Object.keys(editor.rules['.card'] ?? {}).length === 0,
    JSON.stringify(editor.rules['.card']),
  );
  check(
    'and a selector with nothing left to say is not stored as an empty rule',
    editor.rules['.empty'] === undefined,
  );

  // ── Done ───────────────────────────────────────────────────────────────────
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

/**
 * Readable text out of a rendered PDF.
 *
 * PDFKit Flate-compresses its content streams, so the words are not in the raw
 * bytes — which is why the older assertions here could only count page objects
 * and never what those pages said.
 *
 * Two things to know about what comes out of the inflate. PDFKit writes text as
 * `[<hex> kern <hex>] TJ` rather than `(literal) Tj`, and it splits a run at
 * every kerning pair — so "Marikina" arrives as `<4d6172> -15 <696b696e61>`.
 * Both halves of one TJ array belong to the same word, so they are joined with
 * nothing between them and only whole operators are separated.
 */
function pdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const out: string[] = [];

  const stream = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = stream.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;

    let body: string;
    try {
      body = zlib.inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1');
    } catch {
      continue; // not every stream is text, and a font program is not a failure
    }

    for (const show of body.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      let piece = '';
      for (const part of show[1].matchAll(/<([0-9A-Fa-f]*)>|\(((?:\\.|[^\\()])*)\)/g)) {
        piece += part[1]
          ? Buffer.from(part[1], 'hex').toString('latin1')
          : part[2].replace(/\\([()\\])/g, '$1');
      }
      if (piece) out.push(piece);
    }
  }
  return out.join('\n');
}

/**
 * Where the ink actually starts and stops on page 1, in points.
 *
 * The margin is a stated requirement rather than an implementation detail, so
 * it is measured off the rendered page. Reading it back off the constant would
 * pass even if the drawing code ignored it.
 */
function pdfEdges(pdf: Buffer): { left: number; bottom: number } {
  const raw = pdf.toString('latin1');
  let left = Infinity;
  let lowest = 0;
  const stream = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = stream.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    let body: string;
    try {
      body = zlib.inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    // "1 0 0 1 <x> <y> Tm" — PDFKit's text-positioning matrix.
    for (const t of body.matchAll(/1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm/g)) {
      left = Math.min(left, Number(t[1]));
      lowest = Math.max(lowest, 841.89 - Number(t[2]));
    }
  }
  return { left: Math.round(left), bottom: Math.round(841.89 - lowest) };
}
