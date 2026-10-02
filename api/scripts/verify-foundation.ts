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
import type { Prisma } from '@prisma/client';
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
  approvalOptions,
  approvalSlots,
  pickWorkflow,
  namedApprovers,
  routePreview,
  historyFor,
  cancelOpenRequest,
} from '../src/shared/approvals';
import { renderDocument, formatAmount, formatDateTime, formatMoney, formatShortDate, pdfSafe } from '../src/shared/pdf';
import { designSchema, readDesign, renderDesigned, resolveTemplate, unknownFields, type DesignData, type PdfDesign } from '../src/shared/pdfDesign';
import { QUOTATION_FIELDS, QUOTATION_FIELD_KEYS, STANDARD_QUOTATION_DESIGN } from '../src/shared/quotationTemplate';
// The PDF Templates editor's copy of the text rule: DOM-free, held equal below.
import { resolveTemplate as editorResolve, emptyFieldsIn } from '../../web/src/lib/pdfTemplate';
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
/**
 * What every approval this script submits is about. A seeded workflow routes
 * to whoever really holds the role, so its notifications reach real people;
 * cleanup() takes them back by this. Letters only: in a Prisma `contains`,
 * `_` and `%` are wildcards, and TAG would match far more than this script's.
 */
const SUBJECT = 'ZZFOUNDATION';

async function cleanup() {
  await prisma.notification.deleteMany({ where: { title: { contains: SUBJECT } } });
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
  // Each type against its OWN code: one shared alternation would pass a cash
  // advance numbered GT-JO-…, which is exactly the mix-up worth catching.
  const newTypeCodes: Record<string, string> = {
    position: 'POS',
    cash_advance: 'CA',
    job_order: 'JO',
    clearance: 'CLR',
    meeting: 'MTG',
    evaluation: 'EVAL',
    training_session: 'TS',
    training_certification: 'TC',
  };
  const newTypes = Object.keys(newTypeCodes);
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
      `${type} numbers on the stock pattern (GT-${newTypeCodes[type]}-yyyy-nnnn)`,
      new RegExp(`^GT-${newTypeCodes[type]}-\\d{4}-\\d{4}$`).test(issued[type] ?? ''),
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

  // The template is the periodKey '' row. Before the rewrite an unfiltered
  // findFirst could return an old year's counter instead — same type, but a
  // stale pattern and somebody's lastNumber. Seed exactly that trap.
  await prisma.numberSequence.create({
    data: {
      documentType: `${TAG}_tpl`,
      label: 'Verify — template lookup',
      pattern: '{PREFIX}-{TYPE}-{YYYY}-{SEQ}',
      typeCode: 'VT',
      period: 'YEAR',
      scope: 'GLOBAL',
      padding: 4,
    },
  });
  await prisma.numberSequence.create({
    data: {
      documentType: `${TAG}_tpl`,
      label: 'Verify — template lookup',
      pattern: 'OLD-{SEQ}',
      typeCode: 'VT',
      period: 'YEAR',
      scope: 'GLOBAL',
      periodKey: '2019',
      padding: 4,
      lastNumber: 500,
    },
  });
  const fromTemplate = await nextNumber(`${TAG}_tpl`, prisma, { at: sept });
  check(
    'a new period starts from the template row, not from an old counter',
    fromTemplate === 'GT-VT-2026-0001',
    fromTemplate,
  );

  // A company-wide pattern still tells a form whether its author is linked,
  // so "you are not linked to an employee" can be said before it matters.
  const globalPeek = await previewNext(`${TAG}_tpl`, { ownerId: salesUser.id, at: sept });
  check(
    'a preview on a company-wide pattern still reports the author’s link',
    globalPeek.number === 'GT-VT-2026-0002' && globalPeek.linked === false && globalPeek.periodKey === '2026',
    `${globalPeek.number} linked=${globalPeek.linked} key=${globalPeek.periodKey}`,
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
    subject: `${SUBJECT} 1 day vacation leave`,
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
    subject: `${SUBJECT} 3 hours overtime`,
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
    subject: `${SUBJECT} small PR`,
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
        subject: `${SUBJECT} sole approver raises their own document`,
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
    subject: `${SUBJECT} PM raises their own PR`,
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
    subject: `${SUBJECT} large PR`,
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
        subject: `${SUBJECT} duplicate`,
        amount: 20_000,
        requesterId: employee.id,
      }),
    'already awaiting approval',
  );

  // ── 5b. An optional route, taken only when the submitter asks ─────────────
  console.log('\nOptional routes (the CEO on a quotation over ₱1,000,000)');

  const pmRole = await prisma.role.findUniqueOrThrow({ where: { key: 'project_manager' } });
  const standardRoute = await prisma.approvalWorkflow.create({
    data: {
      documentType: `${TAG}_opt_doc`,
      name: 'Verify — standard route',
      steps: { create: [{ sequence: 1, name: 'Manager', approverType: 'ROLE', roleId: pmRole.id }] },
    },
  });
  const optionRoute = await prisma.approvalWorkflow.create({
    data: {
      documentType: `${TAG}_opt_doc`,
      name: 'Verify — with the boss',
      optionLabel: 'Verify — add the boss',
      minAmount: 1_000,
      steps: {
        create: [
          { sequence: 1, name: 'Manager', approverType: 'ROLE', roleId: pmRole.id },
          { sequence: 2, name: 'Boss', approverType: 'ROLE', roleId: pmRole.id },
        ],
      },
    },
  });
  check('below its band, no option is offered', (await approvalOptions(`${TAG}_opt_doc`, 500)).length === 0);
  const offered = await approvalOptions(`${TAG}_opt_doc`, 5_000);
  check('in its band, the option is offered by its label', offered.length === 1 && offered[0].id === optionRoute.id && offered[0].label === 'Verify — add the boss');
  check('a standard pick never lands on an option, whatever the amount', (await pickWorkflow(`${TAG}_opt_doc`, 5_000))?.id === standardRoute.id);
  await expectRejection(
    'an option asked for outside its band is refused',
    () =>
      submitForApproval({
        documentType: `${TAG}_opt_doc`,
        documentId: `${TAG}-opt-small`,
        subject: `${SUBJECT} option too small`,
        amount: 500,
        requesterId: employee.id,
        optionId: optionRoute.id,
      }),
    'does not apply',
  );
  const optioned = await submitForApproval({
    documentType: `${TAG}_opt_doc`,
    documentId: `${TAG}-opt-big`,
    subject: `${SUBJECT} option taken`,
    amount: 5_000,
    requesterId: employee.id,
    optionId: optionRoute.id,
  });
  check('asked for, the option is the route taken', optioned.workflowId === optionRoute.id);
  const slotsBefore = await approvalSlots(`${TAG}_opt_doc`, `${TAG}-opt-big`);
  check('every step is a sign-off slot, pending until it acts', slotsBefore.length === 2 && slotsBefore.every((x) => !x.name && !x.at));
  // Who will sign is named before they do — never the requester.
  check(
    'an open step names who may decide it, and never the requester',
    slotsBefore.every((x) => !!x.assigned?.some((p) => p.id === pm.id) && !x.assigned.some((p) => p.id === employee.id)),
    JSON.stringify(slotsBefore.map((x) => x.assigned?.map((p) => p.name))),
  );
  const managerStep = await prisma.approvalStep.findFirstOrThrow({ where: { workflowId: optionRoute.id, sequence: 1 } });
  check(
    'a role holder who raised the document is left out of the names, as act() would refuse them',
    !(await namedApprovers(managerStep, pm.id)).some((p) => p.id === pm.id) && (await namedApprovers(managerStep, employee.id)).some((p) => p.id === pm.id),
  );
  const routeAhead = await routePreview(`${TAG}_opt_doc`, 5_000, employee.id, optionRoute.id);
  check(
    'before submitting, the route it would take is named: the option’s steps, each with who decides',
    routeAhead?.workflowId === optionRoute.id && routeAhead.steps.length === 2 && routeAhead.steps.every((st) => st.approvers.some((p) => p.id === pm.id)),
  );
  const draftSlots = await approvalSlots(`${TAG}_opt_doc`, `${TAG}-opt-draft`, { amount: 5_000, requesterId: employee.id });
  check(
    "and a draft's sign-off slots are the standard route, assigned but unsigned",
    draftSlots.length === 1 && draftSlots[0].step === 'Manager' && !draftSlots[0].name && !!draftSlots[0].assigned?.some((p) => p.id === pm.id),
  );
  const openHistory = await historyFor(`${TAG}_opt_doc`, `${TAG}-opt-big`);
  check(
    'the history names who an open request waits on, step by step',
    (openHistory[0]?.workflow?.steps ?? []).every((st) => !!(st as { approvers?: { id: string }[] }).approvers?.some((p) => p.id === pm.id)),
  );
  await act({ requestId: optioned.id, userId: pm.id, action: 'APPROVED' });
  const slotsAfter = await approvalSlots(`${TAG}_opt_doc`, `${TAG}-opt-big`);
  check(
    'once a step approves, its slot carries who and when; the next stays pending',
    slotsAfter[0].name === pm.name && !!slotsAfter[0].at && slotsAfter[0].step === 'Manager' && !slotsAfter[1].name && slotsAfter[1].step === 'Boss',
  );
  check('and how to reach them: the approver’s email; nothing for a step not yet taken', slotsAfter[0].email === pm.email && !slotsAfter[1].email);
  check('a document never submitted has no slots', (await approvalSlots(`${TAG}_opt_doc`, `${TAG}-never`)).length === 0);

  // ── 5c. Withdrawing a request the document moved on from ───────────────────
  // A quotation revision superseded while it waits on the approver: its
  // request is withdrawn in the same transaction, never left in a queue.
  console.log('\nWithdrawing an open request');

  // A role only these test users hold, so nobody real is asked or told.
  const wdRole = await prisma.role.create({ data: { key: `${TAG}_wd`, name: 'Verify Withdrawal Checker' } });
  await prisma.userRole.createMany({ data: [pm, pm2].map((u) => ({ userId: u.id, roleId: wdRole.id })) });
  await prisma.approvalWorkflow.create({
    data: {
      documentType: `${TAG}_wd_doc`,
      name: 'Verify — one step, two checkers',
      steps: { create: [{ sequence: 1, name: 'Checker', approverType: 'ROLE', roleId: wdRole.id }] },
    },
  });
  let wdSettled = 0;
  onApprovalSettled(`${TAG}_wd_doc`, async () => {
    wdSettled++;
  });
  const wdSubmit = (documentId: string) =>
    submitForApproval({
      documentType: `${TAG}_wd_doc`,
      documentId,
      documentNumber: `VERIFY ${documentId}`,
      subject: `${SUBJECT} withdrawn request`,
      requesterId: employee.id,
      link: `/verify/${documentId}`,
    });
  const withdraw = (documentId: string, actorId: string | null) =>
    prisma.$transaction((tx) => cancelOpenRequest(`${TAG}_wd_doc`, documentId, tx, 'superseded by R1', actorId));
  const toldOf = (documentId: string) =>
    prisma.notification.findMany({ where: { type: 'approval.withdrawn', link: `/verify/${documentId}` } });

  const wd = await wdSubmit(`${TAG}-wd-1`);
  const wdGone = await withdraw(`${TAG}-wd-1`, employee.id);
  const wdAfter = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: wd.id } });
  check(
    'a withdrawn request closes CANCELLED, with the moment it closed',
    wdGone.length === 1 && wdGone[0].id === wd.id && wdAfter.status === 'CANCELLED' && !!wdAfter.closedAt,
    wdAfter.status,
  );
  check(
    'it leaves every approver’s queue',
    !(await pendingFor(pm.id)).some((r) => r.id === wd.id) && !(await pendingFor(pm2.id)).some((r) => r.id === wd.id),
  );
  const wdTold = await toldOf(`${TAG}-wd-1`);
  check(
    'the approvers it waited on are told, linked to the record, with the reason',
    [pm.id, pm2.id].every((id) => wdTold.some((n) => n.userId === id)) &&
      wdTold.every((n) => n.title === `Withdrawn: ${SUBJECT} withdrawn request` && n.body === `VERIFY ${TAG}-wd-1 — superseded by R1`),
    JSON.stringify(wdTold.map((n) => [n.title, n.body])),
  );
  check('the requester who withdrew it is not told what they just did', !wdTold.some((n) => n.userId === employee.id));
  check('no subscriber hears of it — a withdrawal is not an outcome', wdSettled === 0, String(wdSettled));
  const wdTrail = await prisma.auditLog.findMany({ where: { entityId: `${TAG}-wd-1`, action: 'CANCELLED' } });
  check(
    'the withdrawal is audited at its step, with its reason and who did it',
    wdTrail.length === 1 && wdTrail[0].summary === 'Withdrawn from approval at Checker — superseded by R1' && wdTrail[0].actorId === employee.id,
    JSON.stringify(wdTrail.map((t) => t.summary)),
  );
  await expectRejection(
    'a withdrawn request cannot be decided',
    () => act({ requestId: wd.id, userId: pm.id, action: 'APPROVED' }),
    'no longer open',
  );
  check(
    'withdrawing again finds nothing open, and audits nothing',
    (await withdraw(`${TAG}-wd-1`, employee.id)).length === 0 &&
      (await prisma.auditLog.count({ where: { entityId: `${TAG}-wd-1`, action: 'CANCELLED' } })) === 1,
  );
  const resubmitted = await wdSubmit(`${TAG}-wd-1`);
  check('the document can be submitted afresh — nothing is left awaiting approval', resubmitted.status === 'PENDING');
  await withdraw(`${TAG}-wd-1`, null);
  check(
    'withdrawn by anybody else, the requester is told as well',
    (await toldOf(`${TAG}-wd-1`)).filter((n) => n.userId === employee.id).length === 1,
  );

  // In the caller's transaction: rolled back, it never happened.
  const wdRolled = await wdSubmit(`${TAG}-wd-2`);
  await prisma
    .$transaction(async (tx) => {
      await cancelOpenRequest(`${TAG}_wd_doc`, `${TAG}-wd-2`, tx, 'superseded by R1', employee.id);
      throw new Error('the caller failed after withdrawing');
    })
    .catch(() => undefined);
  check(
    'withdrawn in a transaction that rolls back, the request is still open — unaudited, untold',
    (await prisma.approvalRequest.findUniqueOrThrow({ where: { id: wdRolled.id } })).status === 'PENDING' &&
      (await prisma.auditLog.count({ where: { entityId: `${TAG}-wd-2`, action: 'CANCELLED' } })) === 0 &&
      (await toldOf(`${TAG}-wd-2`)).length === 0,
  );

  // A decision that landed first stands.
  await act({ requestId: wdRolled.id, userId: pm.id, action: 'APPROVED' });
  check(
    'a decision that landed first stands — withdrawing then finds nothing open',
    (await withdraw(`${TAG}-wd-2`, employee.id)).length === 0 &&
      (await prisma.approvalRequest.findUniqueOrThrow({ where: { id: wdRolled.id } })).status === 'APPROVED',
  );
  check('and the subscriber heard that decision', wdSettled === 1, String(wdSettled));

  // A decision arriving while the withdrawal is being written reads the
  // request open, waits on the row, and is then refused — never written over it.
  const wdRaced = await wdSubmit(`${TAG}-wd-3`);
  const late: { outcome?: Promise<string> } = {};
  await prisma.$transaction(async (tx) => {
    await cancelOpenRequest(`${TAG}_wd_doc`, `${TAG}-wd-3`, tx, 'superseded by R1', employee.id);
    late.outcome = act({ requestId: wdRaced.id, userId: pm.id, action: 'APPROVED' }).then(
      () => 'decided',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  const lateOutcome = await late.outcome;
  const racedAfter = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: wdRaced.id }, include: { actions: true } });
  check(
    'a decision arriving while a withdrawal is written is refused, not written over it',
    racedAfter.status === 'CANCELLED' && racedAfter.actions.length === 0 && lateOutcome !== 'decided',
    `${racedAfter.status}, ${racedAfter.actions.length} action(s) — ${lateOutcome}`,
  );

  // Two approvers deciding the same step at the same moment: one decision.
  const wdBoth = await wdSubmit(`${TAG}-wd-4`);
  const bothOutcomes = await Promise.allSettled([
    act({ requestId: wdBoth.id, userId: pm.id, action: 'APPROVED' }),
    act({ requestId: wdBoth.id, userId: pm2.id, action: 'REJECTED' }),
  ]);
  const bothAfter = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: wdBoth.id }, include: { actions: true } });
  check(
    'two approvers deciding one step at once: one decision is recorded, the other refused',
    bothOutcomes.filter((o) => o.status === 'fulfilled').length === 1 &&
      bothAfter.actions.length === 1 &&
      bothAfter.status === bothAfter.actions[0].action,
    `${bothOutcomes.map((o) => o.status).join(' / ')} → ${bothAfter.status}, ${bothAfter.actions.length} action(s)`,
  );
  check('and the subscriber heard it once', wdSettled === 2, String(wdSettled));

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

  // ── 10. The letterhead every document carries ──────────────────────────────
  console.log('\nLetterhead');

  /*
    The company block and the strapline are drawn by the engine, never by a
    module, so one document proves them for all of them. The fields are only
    borrowed when the database has none: a value an administrator already set
    is asserted as it stands and never overwritten, and whatever this sets is
    put back to null afterwards.
  */
  const companyBefore = await prisma.company.findUnique({ where: { id: 'company' } });
  const borrowed: Prisma.CompanyUpdateInput = {};
  if (!companyBefore?.regNo) borrowed.regNo = `${TAG}-REG`;
  if (!companyBefore?.documentTagline) borrowed.documentTagline = `${TAG} UTILITY SOLUTIONS`;
  if (!companyBefore?.fax) borrowed.fax = `${TAG}-FAX`;
  if (companyBefore && Object.keys(borrowed).length) {
    await prisma.company.update({ where: { id: 'company' }, data: borrowed });
  }
  try {
    const co = await prisma.company.findUniqueOrThrow({ where: { id: 'company' } });
    const lettered = await renderDocument({
      title: 'Quotation',
      documentNumber: `${TAG}-LH`,
      sections: [
        {
          kind: 'table',
          head: ['Product description', 'Total'],
          align: ['left', 'right'],
          // A peso sign pasted into a description, as SCORO's exports carry
          // them. The engine has to catch it; formatMoney only covers amounts.
          rows: [['Compressor overhaul ₱1,000 allowance', formatMoney(1562.2)]],
        },
      ],
      footerNote: 'Pesos ₱ only — net of discount',
    });
    const letteredText = pdfText(lettered);
    check('the footer prints REG. NO.', letteredText.includes('REG. NO.'));
    check('with the registration number itself', letteredText.includes(co.regNo ?? '\u0000'));
    check('and the tagline', letteredText.includes(co.documentTagline ?? '\u0000'));
    check('and Tel / Fax when set', !co.fax || letteredText.includes(`Fax: ${co.fax}`));
    check(
      'the website rides on the tagline line',
      !co.website ||
        letteredText.includes(
          co.website.replace(/^https?:\/\//i, '').replace(/\/+$/, '').toUpperCase(),
        ),
    );
    check('no peso sign ever reaches the page as ±', !letteredText.includes('±'));
    check('it prints as the currency code instead', letteredText.includes('PHP 1,000 allowance'));
    check('and the footer note is cleaned the same way', letteredText.includes('Pesos PHP only'));
    const letteredEdges = pdfEdges(lettered);
    check('the strapline stays clear of the bottom edge', letteredEdges.bottom > 12, `${letteredEdges.bottom}pt clear`);
    check('and still starts 14pt from the edge', letteredEdges.left === 14, `${letteredEdges.left}pt`);
    check('a letterhead does not cost a page', pages(lettered) === 1, `${pages(lettered)} pages`);

    // ── 11. The quotation: a layout the administrator draws, the engine prints ──
    console.log('\nDesigned documents (the quotation)');

    const day = new Date('2026-08-17T02:00:00Z');
    const blank = Object.fromEntries(QUOTATION_FIELDS.map((f) => [f.key, '']));
    const quoteData = (over: Partial<DesignData> & { fields?: Record<string, string> } = {}): DesignData => ({
      title: 'Quotation',
      rows: [],
      totals: [
        { label: 'Sub Total Price:', value: formatAmount(20_000) },
        { label: 'Total Price (PHP):', value: formatAmount(22_400), bold: true },
      ],
      signatories: [
        {
          role: 'Prepared by',
          name: employee.name,
          position: `${TAG} Sales Engineer`,
          phone: '0917 555 0199',
          email: `${TAG}.sales@verify.local`,
          at: ot.createdAt,
        },
        { role: 'Approved by' },
      ],
      ...over,
      fields: {
        ...blank,
        'quotation.number': `${TAG}-LT R2`,
        'quotation.date': formatShortDate(day),
        'quotation.prNumber': 'PR-77',
        'quotation.currency': 'PHP',
        'quotation.delivery': '2 weeks',
        'customer.name': `${TAG} Customer Inc.`,
        'customer.address': '1 Test Street',
        'contact.nameAndPosition': 'Juan Dela Cruz',
        ...(over.fields ?? {}),
      },
    });
    const lineRow = (i: number) => ({
      cells: { product: `Filter element 0.1 μm, lot ${i}`, qtyUnit: '1 lot', unitPrice: formatAmount(1000), amount: formatAmount(1000) },
    });
    // Forty rows, alternating a subheading and a line, so it runs over.
    const longRows = Array.from({ length: 40 }, (_, i) => (i % 2 ? lineRow(i) : { heading: `PRODUCT ${i}` }));

    const letter = await renderDesigned(STANDARD_QUOTATION_DESIGN, quoteData({ rows: longRows }));
    const letterText = pdfText(letter);
    const letterPages = pages(letter);
    check('the standard layout names itself QUOTATION, with "# number" and the revision', letterText.includes('QUOTATION') && letterText.includes(`# ${TAG}-LT R2`));
    check('CUSTOMER and DETAILS head the two blocks', letterText.includes('CUSTOMER') && letterText.includes('DETAILS'));
    check('the details print as labelled lines — the date the 08/17/2026 way', letterText.includes('Date: 08/17/2026') && letterText.includes('PR Number: PR-77'));
    // WinAnsi's em dash is byte 0x97, which is how this reader decodes it.
    check('{{field|—}} prints the dash when the field is empty', letterText.includes('Payment Terms: \u0097'));
    check(
      'its company block is on the letterhead: TIN and REG NO',
      (!co.tin || letterText.includes(`TIN: ${co.tin}`)) && (!co.regNo || letterText.includes(`REG NO: ${co.regNo}`)),
    );
    check('every page carries the strapline', letterText.split('\n').filter((l) => l === (co.documentTagline ?? '\u0000').toUpperCase()).length === letterPages);
    check('a long quotation runs over', letterPages >= 2, `${letterPages} pages`);
    const running = letterText
      .split('\n')
      .filter((line) => line.includes(`${TAG} Customer Inc.`) && line.includes(`${TAG}-LT R2`) && line.includes('08/17/2026'));
    check(
      'every page after the first repeats who it is for, the number and the date',
      running.length === letterPages - 1,
      `${running.length} running headers on ${letterPages} pages`,
    );
    check('the table head repeats on the next page', letterText.split('\n').filter((l) => l === 'PRODUCT DESCRIPTION').length === letterPages);
    check('and so does "Page n of m"', letterText.includes(`Page ${letterPages} of ${letterPages}`));
    check(
      'the dated sign-offs print once, on the last page',
      letterText.split('\n').filter((l) => l === 'PREPARED BY').length === 1 &&
        letterText.includes('APPROVED BY') &&
        letterText.includes(stamp(ot.createdAt)) &&
        letterText.includes('Pending'),
    );
    const signLines = letterText.split('\n');
    check(
      'a sign-off prints the name on its own, then the contact number and the email under it',
      signLines.includes(employee.name) && signLines.includes('0917 555 0199') && signLines.includes(`${TAG}.sales@verify.local`),
    );
    check('and no position, unless the layout asks for it', !letterText.includes(`${TAG} Sales Engineer`));
    const nameAt = textAt(letter, employee.name);
    const phoneAt = textAt(letter, '0917 555 0199');
    check('the name sits over the contact number, larger', !!nameAt && !!phoneAt && phoneAt.y - nameAt.y > 9, `${nameAt?.y} → ${phoneAt?.y}`);
    check('the figures carry no currency; the total names it once', letterText.includes('1,000.00') && !letterText.includes('PHP 1,000.00'));
    check('Greek mu prints as the micro sign, not "?"', pdfSafe('0.1 μm') === '0.1 µm' && letterText.includes('0.1 µm'));
    check("the content starts 36pt in, as the template's does", pdfEdges(letter).left === 36, `${pdfEdges(letter).left}pt`);
    check('and its strapline stays clear of the bottom edge', pdfEdges(letter).bottom > 12, `${pdfEdges(letter).bottom}pt clear`);

    // One page: what follows the table follows it, and closes up when empty.
    const short = await renderDesigned(STANDARD_QUOTATION_DESIGN, quoteData({ rows: [lineRow(1), lineRow(2)] }));
    const shortText = pdfText(short);
    check('a short quotation is one page, with no "Page 1 of 1"', pages(short) === 1 && !shortText.includes('Page 1 of 1'));
    check('and no running header', !shortText.split('\n').some((l) => l.includes('08/17/2026') && l.includes(`${TAG}-LT R2`)));
    const longer = await renderDesigned(STANDARD_QUOTATION_DESIGN, quoteData({ rows: [1, 2, 3, 4, 5, 6].map(lineRow) }));
    const totalsShort = textAt(short, 'Sub Total Price:');
    const totalsLonger = textAt(longer, 'Sub Total Price:');
    // A one-line row is 9pt type (10.4pt) plus 20pt of padding.
    check(
      'the totals follow the lines: four more lines, and they sit four rows lower',
      !!totalsShort && !!totalsLonger && Math.abs(totalsLonger.y - totalsShort.y - 4 * 30.4) < 2,
      `${totalsShort?.y} → ${totalsLonger?.y}`,
    );
    const signedShort = textAt(short, 'PREPARED BY');
    const signBox = STANDARD_QUOTATION_DESIGN.blocks.find((b) => b.type === 'signoffs')!;
    check(
      'the sign-offs stay where the layout put them on the last page',
      !!signedShort && Math.abs(signedShort.y - (signBox.y + 8.5 * 0.718)) < 1,
      `${signedShort?.y} vs ${signBox.y}`,
    );
    // Drawn too short for what it prints, a last-page box keeps its bottom
    // edge and grows upward — never down into the footer under it.
    const cramped: PdfDesign = {
      ...STANDARD_QUOTATION_DESIGN,
      blocks: STANDARD_QUOTATION_DESIGN.blocks.map((b) => (b.type === 'signoffs' ? { ...b, y: 750, h: 20 } : b)),
    };
    const crampedDoc = await renderDesigned(cramped, quoteData({ rows: [lineRow(1)] }));
    const crampedHead = textAt(crampedDoc, 'PREPARED BY');
    const crampedLast = textAt(crampedDoc, stamp(ot.createdAt));
    check(
      'a last-page box too short for its lines grows upward, its foot where it was drawn',
      !!crampedHead && !!crampedLast && crampedHead.y < 750 && crampedLast.y <= 770 && crampedLast.y > 760,
      `${crampedHead?.y} … ${crampedLast?.y}`,
    );
    const withPosition: PdfDesign = {
      ...STANDARD_QUOTATION_DESIGN,
      blocks: STANDARD_QUOTATION_DESIGN.blocks.map((b) => (b.type === 'signoffs' ? { ...b, showPosition: true, showEmail: false } : b)),
    };
    const positioned = pdfText(await renderDesigned(withPosition, quoteData({ rows: [lineRow(1)] })));
    check(
      'a layout can put the position back, and leave the email out',
      positioned.includes(`${TAG} Sales Engineer`) && !positioned.includes(`${TAG}.sales@verify.local`),
    );
    const withNotes = await renderDesigned(
      STANDARD_QUOTATION_DESIGN,
      quoteData({ rows: [lineRow(1)], fields: { 'quotation.notes': `${TAG} a note` } }),
    );
    const thanks = (pdf: Buffer) => textAt(pdf, 'Thank you very much')?.y ?? 0;
    const shortOne = await renderDesigned(STANDARD_QUOTATION_DESIGN, quoteData({ rows: [lineRow(1)] }));
    check('Notes print only when there are notes', pdfText(withNotes).includes(`${TAG} a note`) && !pdfText(shortOne).includes('Notes:'));
    check(
      'and without them the lines after close up into the space',
      thanks(withNotes) - thanks(shortOne) > 20 && thanks(withNotes) - thanks(shortOne) < 45,
      `${thanks(shortOne)} vs ${thanks(withNotes)}`,
    );
    check(
      'with no totals ("Hide total") the totals print nothing',
      !pdfText(await renderDesigned(STANDARD_QUOTATION_DESIGN, quoteData({ rows: [lineRow(1)], totals: null }))).includes('Total Price (PHP):'),
    );

    // A box the administrator moved prints where it was moved. It goes to the
    // top of the page, above every other box, so nothing can push it down —
    // a letterhead that grows with the company's own details would.
    const moved: PdfDesign = {
      ...STANDARD_QUOTATION_DESIGN,
      blocks: STANDARD_QUOTATION_DESIGN.blocks.map((b) => (b.id === 'number' ? { ...b, x: 40, y: 8, align: 'left' as const } : b)),
    };
    const movedAt = textAt(await renderDesigned(moved, quoteData({ rows: [lineRow(1)] })), `# ${TAG}-LT R2`);
    check('a box moved in the layout prints where it was moved', !!movedAt && Math.abs(movedAt.x - 40) < 0.5 && movedAt.y > 8 && movedAt.y < 20, JSON.stringify(movedAt));

    // Text longer than a page runs on; a line taller than a page is split, not lost.
    const longTerms = Array.from({ length: 120 }, (_, i) => `Term ${i + 1}: the customer provides access to site.`).join('\n');
    const runOn = await renderDesigned(STANDARD_QUOTATION_DESIGN, quoteData({ rows: [lineRow(1)], fields: { 'quotation.terms': longTerms } }));
    check('terms longer than a page run on to the next, to the last line', pages(runOn) >= 2 && pdfText(runOn).includes('Term 120: the customer'));
    const tallRow = { cells: { product: { title: 'Spec sheet', body: Array.from({ length: 90 }, (_, i) => `Spec line ${i + 1}`).join('\n') }, qtyUnit: '1 lot' } };
    const split = await renderDesigned(STANDARD_QUOTATION_DESIGN, quoteData({ rows: [tallRow] }));
    check('a line taller than a page is carried over, not cut off', pages(split) >= 2 && pdfText(split).includes('Spec line 90'));
    check('and nothing is drawn off the bottom of a page', pdfEdges(split).bottom > 12 && pdfEdges(runOn).bottom > 12);

    // The rule for filling text, and the browser's copy of it.
    const cases: [string, Record<string, string>, boolean][] = [
      ['Tel No.: {{a}} | Fax: {{b}} | Email: {{c}}', { a: '', b: '', c: 'x@y.ph' }, false],
      ['TIN: {{a}} | REG NO: {{b}}', {}, false],
      ['**Delivery:** {{d|—}}', {}, false],
      ['Static\n\n{{x}}\nAfter', { x: '' }, false],
      ['{{x}}', { x: 'a**b**' }, false],
      ['**Terms:**\n{{t}}', { t: 'one\ntwo' }, false],
      ['A {{x}} | B', { x: '' }, true],
      ['**open | {{gone}} | still** bold', { gone: '' }, false],
    ];
    const flat = (lines: { text: string; bold: boolean }[][]) => lines.map((l) => l.map((r) => (r.bold ? `<b>${r.text}</b>` : r.text)).join('')).join('/');
    check('a part whose fields are empty drops out, alone', flat(resolveTemplate(cases[0][0], cases[0][1])) === 'Email: x@y.ph');
    check('a line whose parts all dropped is left out', resolveTemplate(cases[1][0], cases[1][1]).length === 0);
    check('{{field|—}} keeps the line, and ** marks bold', flat(resolveTemplate(cases[2][0], cases[2][1])) === '<b>Delivery:</b> —');
    check('blank lines and fixed text stay', flat(resolveTemplate(cases[3][0], cases[3][1])) === 'Static//After');
    check('a value is printed as typed — its ** is not markup', flat(resolveTemplate(cases[4][0], cases[4][1])) === 'a**b**');
    check('a value with newlines runs over as many lines', flat(resolveTemplate(cases[5][0], cases[5][1])) === '<b>Terms:</b>/one/two');
    // The editor says which fields a box leaves out, so an empty Company
    // Settings field reads as empty rather than as a broken template.
    const leftOut = emptyFieldsIn(
      [
        {
          id: 'x', type: 'text', anchor: 'first', x: 0, y: 0, w: 100, h: 10, size: 9, bold: false, italic: false, color: '#222222',
          align: 'left', uppercase: false, spacing: 0, lineGap: 0, fit: false, multiPageOnly: false,
          text: 'Tel No.: {{company.phone}} | Email: {{company.email}}\nPR: {{quotation.prNumber|—}}\nPage {{page}} of {{pages}}',
        },
      ],
      { 'company.phone': '', 'company.email': 'sales@x.ph', 'quotation.prNumber': '' },
    );
    check(
      'the editor names the empty fields a box leaves out — not one with a fallback, not the page count',
      JSON.stringify(leftOut) === '["company.phone"]',
      JSON.stringify(leftOut),
    );
    check(
      "the editor's copy of the rule reads every case the same",
      cases.every(([text, values, bold]) => JSON.stringify(resolveTemplate(text, values, bold)) === JSON.stringify(editorResolve(text, values, bold))),
    );

    // What the save route refuses before it reaches a customer's quotation.
    const withTypo: PdfDesign = {
      ...STANDARD_QUOTATION_DESIGN,
      blocks: STANDARD_QUOTATION_DESIGN.blocks.map((b) => (b.id === 'customer' && b.type === 'text' ? { ...b, text: '{{customer.nam}}' } : b)),
    };
    check('a field the document lacks is caught, and named', unknownFields(withTypo, QUOTATION_FIELD_KEYS).some((i) => i.message.includes('customer.nam')));
    check('the standard layout names only fields the quotation has', unknownFields(STANDARD_QUOTATION_DESIGN, QUOTATION_FIELD_KEYS).length === 0);
    check('the standard layout is a layout the save would take', designSchema.safeParse(STANDARD_QUOTATION_DESIGN).success);
    const items = STANDARD_QUOTATION_DESIGN.blocks.find((b) => b.type === 'items')!;
    check('two line tables are refused', !designSchema.safeParse({ ...STANDARD_QUOTATION_DESIGN, blocks: [...STANDARD_QUOTATION_DESIGN.blocks, { ...items, id: 'again' }] }).success);
    check(
      'a colour that is not #RRGGBB is refused',
      !designSchema.safeParse({
        ...STANDARD_QUOTATION_DESIGN,
        blocks: STANDARD_QUOTATION_DESIGN.blocks.map((b) => (b.type === 'line' ? { ...b, color: 'red;}' } : b)),
      }).success,
    );
    check(
      'a box that runs off the page is refused',
      !designSchema.safeParse({
        ...STANDARD_QUOTATION_DESIGN,
        blocks: STANDARD_QUOTATION_DESIGN.blocks.map((b) => (b.id === 'title' ? { ...b, x: 500, w: 200 } : b)),
      }).success,
    );
    check('a stored layout that no longer reads falls back, never fails', readDesign({ blocks: 'nonsense' }) === null);
  } finally {
    if (companyBefore && Object.keys(borrowed).length) {
      await prisma.company.update({
        where: { id: 'company' },
        data: Object.fromEntries(Object.keys(borrowed).map((k) => [k, null])),
      });
    }
  }


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
/**
 * Where the first text run containing `needle` was drawn: x from the left
 * edge and y from the top of its page, at the baseline — PDFKit sets each run
 * with its own "1 0 0 1 x y Tm" just before the TJ that shows it.
 */
function textAt(pdf: Buffer, needle: string): { x: number; y: number } | null {
  const raw = pdf.toString('latin1');
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
    let at: { x: number; y: number } | null = null;
    for (const t of body.matchAll(/1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm|\[([^\]]*)\]\s*TJ/g)) {
      if (t[1] !== undefined) {
        at = { x: Number(t[1]), y: Math.round((841.89 - Number(t[2])) * 100) / 100 };
        continue;
      }
      let piece = '';
      for (const part of t[3].matchAll(/<([0-9A-Fa-f]*)>|\(((?:\\.|[^\\()])*)\)/g)) {
        piece += part[1] ? Buffer.from(part[1], 'hex').toString('latin1') : part[2].replace(/\\([()\\])/g, '$1');
      }
      if (at && piece.includes(needle)) return at;
    }
  }
  return null;
}

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
