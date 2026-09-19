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

import bcrypt from 'bcryptjs';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { resolveUser, can, canEditRecord, menuFor } from '../src/permissions/resolve';
import { nextNumber } from '../src/shared/numbering';
import { submitForApproval, act, pendingFor, onApprovalSettled } from '../src/shared/approvals';
import { renderDocument } from '../src/shared/pdf';

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

  // ── 2. Document numbering ──────────────────────────────────────────────────
  console.log('\nNumbering');

  const first = await nextNumber('quotation');
  check('number matches the configured pattern', /^GT-QT-\d{4}-\d{4}$/.test(first), first);

  // Concurrency is the failure mode that matters: two people saving a quotation
  // at the same moment must not receive the same number.
  const concurrent = await Promise.all(Array.from({ length: 25 }, () => nextNumber('quotation')));
  check(
    '25 concurrent numbers are all unique',
    new Set(concurrent).size === 25,
    `${new Set(concurrent).size} distinct`,
  );

  const codes = await Promise.all([nextNumber('purchase_order'), nextNumber('invoice')]);
  check('each document type has its own counter', /GT-PO-/.test(codes[0]) && /GT-INV-/.test(codes[1]));

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

  // With only ONE project manager, a PR routed to that role and raised by them
  // could never be approved by anyone. Submission is refused outright rather
  // than accepted into a state nobody can move it out of.
  await expectRejection(
    'a document whose only approver is the requester is refused at submission',
    () =>
      submitForApproval({
        documentType: 'purchase_request',
        documentId: `${TAG}-pr-pm-solo`,
        subject: 'Verify — sole PM raises their own PR',
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

  // Content streams are Flate-compressed, so the footer text is not readable in
  // the raw bytes — count the page objects instead. 60 table rows should be two
  // pages; a regression in the footer's margin handling inflates this.
  const pageCount = Number((pdf.toString('latin1').match(/\/Count\s+(\d+)/) ?? [])[1] ?? 0);
  check('long content paginates without runaway pages', pageCount === 2, `${pageCount} pages`);

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
