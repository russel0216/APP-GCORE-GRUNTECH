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

import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/prisma';
import type { ApprovalStep, Prisma } from '@prisma/client';
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
  approversForStep,
  supportersFor,
  leadersFor,
  deciderFor,
  preparedAt,
  slotSignatories,
  contactOf,
  contactsOf,
} from '../src/shared/approvals';
import {
  renderDocument,
  companyCurrency,
  formatAmount,
  formatQuantity,
  formatDate,
  formatDateTime,
  formatMoney,
  formatShortDate,
  pdfSafe,
  signoffColumns,
  websiteForPrint,
} from '../src/shared/pdf';
import { designSchema, readDesign, renderDesigned, resolveTemplate, unknownFields, type DesignData, type PdfDesign } from '../src/shared/pdfDesign';
import { QUOTATION_FIELDS, QUOTATION_FIELD_KEYS, STANDARD_QUOTATION_DESIGN } from '../src/shared/quotationTemplate';
import { STANDARD_SALES_ORDER_DESIGN, salesOrderSample } from '../src/shared/salesOrderTemplate';
// The PDF Templates editor's copies of the text rule and the sign-off columns: DOM-free, held equal below.
import { resolveTemplate as editorResolve, emptyFieldsIn, signoffColumns as editorSignoffColumns } from '../../web/src/lib/pdfTemplate';
import { cleanNumberText, editNumberText, formatNumberText, isPartialNumber } from '../../web/src/lib/number';
import {
  countActiveFilters,
  filterKeysOf,
  MAX_SELECTED,
  pageSelection,
  togglePage,
  readListUrl,
  readView,
  saveView,
  startFilters,
  viewQuery,
  cleanViewName,
  isBareVisit,
  openingView,
  viewHidden,
  queryObject,
  queryString,
  keepDefaults,
  fillDefaults,
  writeListUrl,
  yearStartKey,
  type FilterDef,
} from '../../web/src/lib/listUrl';
import {
  MAX_ROWS,
  columnName,
  isSpreadsheet,
  looksNumeric,
  matchRanges,
  matchingRows,
  rowKeys,
} from '../../web/src/lib/spreadsheet';
import { readWorkbook } from '../../web/src/lib/spreadsheetRead';
import { workingDayDate } from '../src/shared/day';
import { ARCHIVE_ATTACHMENT, ARCHIVE_LIST_KEY, SCORO_ARCHIVE_REMOVED, removeScoroArchive } from '../src/shared/scoroArchive';
import { recordLink } from '../../web/src/lib/links';
import { parseDelimited, rowsToPrLines, prLineAmount, matchCategory, orderTotals, preferredFrom } from '../../web/src/lib/prLines';
import * as XLSX from '../../web/node_modules/xlsx/xlsx.mjs';
import { readAppearance } from '../src/routes/appearance';
import { contentStreams, pdfRuns, pdfText, runWidth, shown, type PdfRun } from './lib/paper';
import { attachmentKind, fitImage } from '../src/shared/pdfAttachments';
import { contentDisposition, kindOfFile, paperFileName } from '../src/shared/paperName';
import { issueTicket, redeemTicket, ticketPath, TICKET_TTL_MS, TICKET_REUSE_MS } from '../src/shared/printTickets';

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
/** G-CHAIN's two flows (the owner's order of 2026-10-14), as built so far. */
const PROCUREMENT_STRIP = 'Purchase Requests,RFQ,Canvass,Purchase Orders';
const WAREHOUSE_STRIP = 'Incoming,Inventory,Outgoing,Borrow Slips,Pull-out Slips';
/**
 * What every approval this script submits is about. A seeded workflow routes
 * to whoever really holds the role, so its notifications reach real people;
 * cleanup() takes them back by this. Letters only: in a Prisma `contains`,
 * `_` and `%` are wildcards, and TAG would match far more than this script's.
 */
const SUBJECT = 'ZZFOUNDATION';

/** Where the Letterhead section parks the company's tagline while it prints without one. */
const TAGLINE_STASH = 'company.documentTagline.__verify__';

async function restoreTagline() {
  const stash = await prisma.setting.findUnique({ where: { key: TAGLINE_STASH } });
  if (!stash) return;
  const { tagline } = stash.value as { tagline: string | null };
  await prisma.company.update({ where: { id: 'company' }, data: { documentTagline: tagline } });
  await prisma.setting.delete({ where: { key: TAGLINE_STASH } });
}

/**
 * Where the archive section parks the install's own `seed.scoroArchiveRemoved`
 * while it proves the removal is marked once. The stash also records when the
 * run began, which is how the audit rows the removal wrote during it are told
 * from the install's own.
 */
const ARCHIVE_STASH = `${SCORO_ARCHIVE_REMOVED}.__verify__`;
/** The fixture PDF's stored name under the upload folder. */
const ARCHIVE_FIXTURE_FILE = '__verify__-scoro-quote.pdf';

async function restoreArchiveMark() {
  const stash = await prisma.setting.findUnique({ where: { key: ARCHIVE_STASH } });
  if (!stash) return;
  const { setting, startedAt } = stash.value as {
    setting: { value: Prisma.InputJsonValue; description: string | null } | null;
    startedAt: string;
  };
  await prisma.auditLog.deleteMany({
    where: { entityType: ARCHIVE_ATTACHMENT, entityId: 'archive', at: { gte: new Date(startedAt) } },
  });
  if (setting) {
    await prisma.setting.upsert({
      where: { key: SCORO_ARCHIVE_REMOVED },
      create: { key: SCORO_ARCHIVE_REMOVED, value: setting.value, description: setting.description },
      update: { value: setting.value, description: setting.description },
    });
  } else {
    await prisma.setting.deleteMany({ where: { key: SCORO_ARCHIVE_REMOVED } });
  }
  try {
    fs.unlinkSync(path.join(env.uploadDir, ARCHIVE_FIXTURE_FILE));
  } catch {
    /* already gone — the removal takes the file with the row */
  }
  await prisma.setting.delete({ where: { key: ARCHIVE_STASH } });
}

async function cleanup() {
  await restoreTagline();
  await restoreArchiveMark();
  await prisma.notification.deleteMany({ where: { title: { contains: SUBJECT } } });
  const users = await prisma.user.findMany({
    where: { email: { endsWith: '@verify.local' } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.employee.deleteMany({ where: { userId: { in: ids } } });
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

  // Every box on Admin › Roles must do something (2026-10-10, C2): 109 keys
  // nobody checked were trimmed — Export on lists anyone may print, Approve
  // where the workflow's roles decide, Delete where a document is cancelled.
  // So the source is read: a key counts as checked when it appears whole in
  // the API or the web app, or when its action is built into a template
  // (`${base}.edit_all`) beside its module.screen; the two view keys always
  // count, because canView() puts the screen in the menu with them.
  const permissionKeys = new Set(allPermissions().map((p) => p.key));
  {
    const roots = [path.resolve(__dirname, '../src'), path.resolve(__dirname, '../../web/src')];
    const registryFile = path.resolve(__dirname, '../src/permissions/registry.ts');
    let corpus = '';
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && full !== registryFile) corpus += fs.readFileSync(full, 'utf8') + '\n';
      }
    };
    roots.forEach(walk);
    const templated = new Set([...corpus.matchAll(/\$\{[^}]+\}\.(\w+)[`'"]/g)].map((m) => m[1]));
    const unchecked = allPermissions()
      .filter((p) => !['view_all', 'view_own'].includes(p.action))
      .filter((p) => !corpus.includes(p.key) && !(templated.has(p.action) && corpus.includes(`${p.module}.${p.submodule}`)))
      .map((p) => p.key);
    check('every permission the registry mints is checked by a route or a screen', unchecked.length === 0, unchecked.join(', '));
  }
  check('approval goes to the workflow, not to a key: no ghr.clearances.approve, no gops.quotations.approve', !permissionKeys.has('ghr.clearances.approve') && !permissionKeys.has('gops.quotations.approve'));
  check(
    'the three approve rights left are the ones something checks (CAD dispatch, progress reports, certificates)',
    [...permissionKeys].filter((k) => k.endsWith('.approve')).sort().join() === 'ghr.passports.approve,gops.cad_job_orders.approve,gops.progress_billing.approve',
    [...permissionKeys].filter((k) => k.endsWith('.approve')).join(),
  );

  // A hidden screen is still a screen: the menu carries it flagged hidden, so
  // the sidebar knows which section its page sits in, and its permission keys
  // survive. The project registers are hidden (2026-10-06): each is a tab
  // inside the project, and Project Management's strip is Costing, Job
  // Orders, Projects — the owner's order, which the registry's order carries.
  // Three duplicate entries went the same way on 2026-10-10 (C3): Service
  // Costing (the costing list filtered), Employee Pay Rates (the employees
  // list) and Document Templates (the Report Templates screen) — hidden,
  // never deleted. The SCORO Archive, hidden since 2026-10-04, was removed
  // outright on 2026-10-10 (the owner's call) and is no longer a screen.
  const superMenu = menuFor(superUser).flatMap((m) => m.submodules.map((s) => ({ id: `${m.key}.${s.key}`, hidden: s.hidden === true })));
  check(
    'the hidden screens are the five project registers and the three duplicates',
    superMenu.filter((s) => s.hidden).map((s) => s.id).sort().join() ===
      'admin.templates,ghr.employee_rates,gops.budget_monitoring,gops.budget_requests,gops.plans,gops.progress_billing,gops.purchase_requests,gops.service_costing',
    superMenu.filter((s) => s.hidden).map((s) => s.id).join(),
  );
  const pmStrip = menuFor(superUser)
    .find((m) => m.key === 'gops')!
    .submodules.filter((s) => s.group === 'Project Management' && !s.hidden)
    .map((s) => s.label);
  check('Project Management shows Costing, Projects, Job Orders, CAD J.O. in that order', pmStrip.join() === 'Costing,Projects,Job Orders,CAD J.O.', pmStrip.join());
  // The owner's order of 2026-10-14: the divisions G-OPS, G-CHAIN, G-FIN,
  // G-HR, and G-CHAIN's two flows.
  const divisions = menuFor(superUser).map((m) => m.key).filter((k) => ['gops', 'gchain', 'gfin', 'ghr'].includes(k));
  check('the divisions run G-OPS, G-CHAIN, G-FIN, G-HR', divisions.join() === 'gops,gchain,gfin,ghr', divisions.join());
  const chainStrip = (group: string) =>
    menuFor(superUser).find((m) => m.key === 'gchain')!.submodules.filter((s) => s.group === group && !s.hidden).map((s) => s.label).join();
  check(
    `Procurement is ${PROCUREMENT_STRIP.replace(/,/g, ', ')}; Warehouse is ${WAREHOUSE_STRIP.replace(/,/g, ', ')}`,
    chainStrip('Procurement') === PROCUREMENT_STRIP && chainStrip('Warehouse') === WAREHOUSE_STRIP,
    `${chainStrip('Procurement')} | ${chainStrip('Warehouse')}`,
  );
  // The Sales strip is the sales flow (2026-10-08, the owner's call).
  const salesStrip = menuFor(superUser)
    .find((m) => m.key === 'gops')!
    .submodules.filter((s) => s.group === 'Sales' && !s.hidden)
    .map((s) => s.label);
  check(
    'Sales shows Sales Pipeline, Forecast, Leads, Quotations, Sales Orders, Customers, Partners, Calendar in that order',
    salesStrip.join() === 'Sales Pipeline,Forecast,Leads,Quotations,Sales Orders,Customers,Partners,Calendar',
    salesStrip.join(),
  );
  // Working days on real dates: Thursday 1 Jan 2026.
  const jan1 = new Date('2026-01-01');
  const onDay = (n: number) => workingDayDate(jan1, n).toISOString().slice(0, 10);
  check(
    'a working day counts Mon–Sat from the start, skipping Sundays',
    onDay(1) === '2026-01-01' && onDay(3) === '2026-01-03' && onDay(4) === '2026-01-05' && onDay(9) === '2026-01-10' && onDay(10) === '2026-01-12',
    [1, 3, 4, 9, 10].map(onDay).join(' '),
  );
  check(
    'a start on a Sunday counts from the Monday after it; a Saturday is a working day',
    workingDayDate(new Date('2026-01-04'), 1).toISOString().slice(0, 10) === '2026-01-05' &&
      workingDayDate(new Date('2026-01-03'), 1).toISOString().slice(0, 10) === '2026-01-03',
  );

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

  // A SUPERVISOR step may name the role that decides when the requester has
  // no supervisor (the quotation's: sales managers); one naming none keeps
  // HR, which is what leave, overtime and claims rely on.
  const salesManagerRole = await prisma.role.findUnique({ where: { key: 'sales_manager' } });
  const salesHead = await makeUser('Verify Sales Head', 'saleshead@verify.local', ['sales_manager']);
  const supervisorElse = (roleId: string | null) =>
    ({ approverType: 'SUPERVISOR', roleId, userId: null }) as unknown as ApprovalStep;
  const withSupervisor = await approversForStep(supervisorElse(salesManagerRole!.id), employee.id);
  check('a supervisor step with a fallback role still goes to the supervisor when there is one', withSupervisor.length === 1 && withSupervisor[0] === supervisor.id);
  const unsupervised = await approversForStep(supervisorElse(salesManagerRole!.id), hrPerson.id);
  check(
    'with no supervisor set it goes to the fallback role, not to HR',
    unsupervised.includes(salesHead.id) && !unsupervised.includes(hrPerson.id),
    JSON.stringify(unsupervised),
  );
  const plainFallback = await approversForStep(supervisorElse(null), salesHead.id);
  check('a supervisor step naming no role still falls back to HR', plainFallback.includes(hrPerson.id) && !plainFallback.includes(salesHead.id));

  // Back Support decides for the teams it supports (2026-10-12): the
  // holders on the preparer's team, else those naming no team, else all.
  const [kat, hit] = await Promise.all(
    ['KAT', 'HIT'].map((code) => prisma.industry.findFirstOrThrow({ where: { code }, select: { id: true } })),
  );
  const preparer = await makeUser('Verify Preparer', 'preparer@verify.local', ['sales'], salesHead.id);
  await prisma.employee.create({
    data: { employeeNo: `${TAG}EMP1`, firstName: 'Verify', lastName: 'Preparer', userId: preparer.id, industryId: kat.id },
  });
  const loner = await makeUser('Verify Loner', 'loner@verify.local', ['sales']);
  const bsKat = await makeUser('Verify BS KAT', 'bskat@verify.local', ['back_support']);
  const bsHit = await makeUser('Verify BS HIT', 'bshit@verify.local', ['back_support']);
  const bsAll = await makeUser('Verify BS All', 'bsall@verify.local', ['back_support']);
  // Nothing ticked: handles their own team (2026-10-13, the Technical Manager's rule).
  const bsOwn = await makeUser('Verify BS Own', 'bsown@verify.local', ['back_support']);
  await prisma.employee.create({
    data: { employeeNo: `${TAG}EMP5`, firstName: 'Verify', lastName: 'BS Own', userId: bsOwn.id, industryId: kat.id },
  });
  await prisma.userSupportTeam.createMany({
    data: [
      { userId: bsKat.id, industryId: kat.id },
      { userId: bsHit.id, industryId: hit.id },
    ],
  });
  const three = [bsKat.id, bsHit.id, bsAll.id];
  const forKat = await supportersFor(three, preparer.id);
  const forNoTeam = await supportersFor(three, loner.id);
  const onlyHit = await supportersFor([bsHit.id], preparer.id);
  check(
    'Back Support goes to whoever supports the preparer’s team — not their own manager’s choice',
    forKat.join() === bsKat.id,
    JSON.stringify(forKat),
  );
  check(
    'a preparer with no team goes to every Back Support; nobody on the team never stalls it',
    forNoTeam.length === 3 && onlyHit.join() === bsHit.id,
    `${JSON.stringify(forNoTeam)} / ${JSON.stringify(onlyHit)}`,
  );
  const withOwn = await supportersFor([...three, bsOwn.id], preparer.id);
  check(
    'with nothing ticked a Back Support handles their own team — never every team',
    withOwn.includes(bsKat.id) && withOwn.includes(bsOwn.id) && !withOwn.includes(bsAll.id) && !withOwn.includes(bsHit.id),
    JSON.stringify(withOwn),
  );
  const backRole = await prisma.role.findUniqueOrThrow({ where: { key: 'back_support' } });
  const viaStep = await approversForStep(
    { approverType: 'ROLE', roleId: backRole.id, userId: null } as unknown as ApprovalStep,
    preparer.id,
  );
  check(
    'the ROLE step reads it: a KAT preparer’s Back Support step leaves out the HIT supporter',
    viaStep.includes(bsKat.id) && !viaStep.includes(bsHit.id),
    JSON.stringify(viaStep),
  );

  // ── 4c. The routing sheet of 2026-10-12 ────────────────────────────────────
  console.log('\nThe preparer signs what they hold; a manager may stand in');

  // A SUPERVISOR step's fallback goes to the leaders on the preparer's team.
  const roleA = await prisma.role.create({ data: { key: `${TAG}_rolea`, name: 'Verify Reviewer' } });
  const roleB = await prisma.role.create({ data: { key: `${TAG}_roleb`, name: 'Verify Approver' } });
  const leadKat = await makeUser('Verify Lead KAT', 'leadkat@verify.local', []);
  const leadHit = await makeUser('Verify Lead HIT', 'leadhit@verify.local', []);
  const katSeller = await makeUser('Verify KAT Seller', 'katseller@verify.local', []);
  await prisma.employee.createMany({
    data: [
      { employeeNo: `${TAG}EMP2`, firstName: 'Verify', lastName: 'Lead KAT', userId: leadKat.id, industryId: kat.id },
      { employeeNo: `${TAG}EMP3`, firstName: 'Verify', lastName: 'Lead HIT', userId: leadHit.id, industryId: hit.id },
      { employeeNo: `${TAG}EMP4`, firstName: 'Verify', lastName: 'KAT Seller', userId: katSeller.id, industryId: kat.id },
    ],
  });
  const leaders = [leadKat.id, leadHit.id];
  check(
    'no "Reports to": the Team Leader step goes to the leader on the preparer’s own team',
    (await leadersFor(leaders, katSeller.id)).join() === leadKat.id,
    JSON.stringify(await leadersFor(leaders, katSeller.id)),
  );
  check(
    'a team with no leader, or a preparer with no team, goes to every leader — never to nobody',
    (await leadersFor([leadHit.id], katSeller.id)).join() === leadHit.id && (await leadersFor(leaders, loner.id)).length === 2,
  );
  check('the preparer is never what makes a team led: a leader alone on their team falls back to all', (await leadersFor(leaders, leadKat.id)).length === 2);
  await prisma.userRole.createMany({ data: [{ userId: leadKat.id, roleId: roleB.id }, { userId: leadHit.id, roleId: roleB.id }] });
  const leaderStep = await approversForStep({ approverType: 'SUPERVISOR', roleId: roleB.id, userId: null } as unknown as ApprovalStep, katSeller.id);
  check('the SUPERVISOR step reads it', leaderStep.join() === leadKat.id, JSON.stringify(leaderStep));
  await prisma.userRole.deleteMany({ where: { roleId: roleB.id } });

  // A Technical Manager step goes to the Technical Manager on the preparer's
  // team (2026-10-13, the owner's report: a HIT costing waited on every
  // Technical Manager), else every one. Real holders of the role may be on
  // file, so the checks name only this script's two.
  const tmRole = await prisma.role.findUniqueOrThrow({ where: { key: 'technical_manager' } });
  await prisma.userRole.createMany({ data: [{ userId: leadKat.id, roleId: tmRole.id }, { userId: leadHit.id, roleId: tmRole.id }] });
  const tmStep = { approverType: 'ROLE', roleId: tmRole.id, userId: null } as unknown as ApprovalStep;
  const tmForKat = await approversForStep(tmStep, katSeller.id);
  const tmForLoner = await approversForStep(tmStep, loner.id);
  check(
    'a Technical Manager step goes to the Technical Manager on the preparer’s own team, not to every one',
    tmForKat.includes(leadKat.id) && !tmForKat.includes(leadHit.id),
    JSON.stringify(tmForKat),
  );
  check('a preparer with no team goes to every Technical Manager', tmForLoner.includes(leadKat.id) && tmForLoner.includes(leadHit.id));
  await prisma.userRole.deleteMany({ where: { roleId: tmRole.id, userId: { in: [leadKat.id, leadHit.id] } } });

  // The preparer signs, at submit, the steps whose role they hold — only
  // where the route says so — and a manager may stand in only where it says so.
  const signer = await makeUser('Verify Signer', 'signer@verify.local', []);
  const reviewer = await makeUser('Verify Reviewer', 'reviewer@verify.local', []);
  const bossOf = await makeUser('Verify Boss', 'boss@verify.local', []);
  const approverB = await makeUser('Verify Approver B', 'approverb@verify.local', [], bossOf.id);
  await prisma.userRole.createMany({
    data: [
      { userId: signer.id, roleId: roleA.id },
      { userId: reviewer.id, roleId: roleA.id },
      { userId: approverB.id, roleId: roleB.id },
    ],
  });
  const twoSteps = [
    { sequence: 1, name: 'Reviewer', approverType: 'ROLE' as const, roleId: roleA.id },
    { sequence: 2, name: 'Approver', approverType: 'ROLE' as const, roleId: roleB.id },
  ];
  await prisma.approvalWorkflow.create({
    data: { documentType: `${TAG}_sign_doc`, name: 'Verify — the preparer signs', preparerSigns: true, standIns: true, steps: { create: twoSteps } },
  });
  await prisma.approvalWorkflow.create({
    data: { documentType: `${TAG}_nosign_doc`, name: 'Verify — nobody signs their own', steps: { create: twoSteps } },
  });
  const heldPreview = await routePreview(`${TAG}_sign_doc`, null, signer.id);
  check(
    'before submitting, the step the preparer holds is named as theirs',
    heldPreview?.steps[0].held === true && heldPreview.steps[0].approvers.map((p) => p.id).join() === signer.id && heldPreview.steps[1].held === false,
    JSON.stringify(heldPreview?.steps),
  );
  const signedReq = await submitForApproval({ documentType: `${TAG}_sign_doc`, documentId: `${TAG}-sign`, subject: `${SUBJECT} preparer signs`, requesterId: signer.id });
  const signedActions = await prisma.approvalAction.findMany({ where: { requestId: signedReq.id } });
  check(
    'submitted, the held step is signed by the preparer at the submit instant, and the request waits on the next',
    signedReq.status === 'PENDING' &&
      signedReq.currentSequence === 2 &&
      signedActions.length === 1 &&
      signedActions[0].selfSigned &&
      signedActions[0].approverId === signer.id &&
      signedActions[0].actedAt.getTime() === signedReq.createdAt.getTime(),
    JSON.stringify(signedActions),
  );
  const signedSlots = await approvalSlots(`${TAG}_sign_doc`, `${TAG}-sign`);
  check(
    'its slots carry the signature, and "Prepared by" takes the same instant',
    signedSlots[0]?.selfSigned === true && signedSlots[0].name === signer.name && preparedAt(signedSlots)?.getTime() === signedReq.createdAt.getTime() && !signedSlots[1]?.name,
  );
  check('a draft’s preview carries no signature, so Prepared by keeps the document’s date', preparedAt(await approvalSlots(`${TAG}_sign_doc`, `${TAG}-sign-draft`, { amount: null, requesterId: signer.id })) === undefined);
  const standInSays = await deciderFor({ ...signedReq, workflow: { standIns: true } }, (await prisma.approvalStep.findFirstOrThrow({ where: { workflow: { documentType: `${TAG}_sign_doc` }, sequence: 2 } })), bossOf.id);
  check('the approver’s manager may decide the step, in their place', standInSays.may && standInSays.onBehalfOfId === approverB.id, JSON.stringify(standInSays));
  check('but is not queued', !(await pendingFor(bossOf.id)).some((r) => r.id === signedReq.id));
  const signedHistory = await historyFor(`${TAG}_sign_doc`, `${TAG}-sign`);
  check(
    'nor named as an approver',
    !JSON.stringify(signedHistory[0]?.workflow?.steps ?? []).includes(bossOf.id) && JSON.stringify(signedHistory[0]?.workflow?.steps ?? []).includes(approverB.id),
  );
  await act({ requestId: signedReq.id, userId: bossOf.id, action: 'APPROVED' });
  const standInAct = await prisma.approvalAction.findFirstOrThrow({ where: { requestId: signedReq.id, sequence: 2 } });
  check(
    'their decision settles it, in their name, standing in for the approver',
    (await prisma.approvalRequest.findUniqueOrThrow({ where: { id: signedReq.id } })).status === 'APPROVED' && standInAct.approverId === bossOf.id && standInAct.onBehalfOfId === approverB.id,
  );

  const plainReq = await submitForApproval({ documentType: `${TAG}_nosign_doc`, documentId: `${TAG}-nosign`, subject: `${SUBJECT} nobody signs their own`, requesterId: signer.id });
  check(
    'where the route does not let the preparer sign, a step they hold waits on the others like any',
    plainReq.status === 'PENDING' && plainReq.currentSequence === 1 && (await prisma.approvalAction.count({ where: { requestId: plainReq.id } })) === 0,
  );
  await act({ requestId: plainReq.id, userId: reviewer.id, action: 'APPROVED' });
  await expectRejection(
    'and where it allows no stand-in, the approver’s manager is refused',
    () => act({ requestId: plainReq.id, userId: bossOf.id, action: 'APPROVED' }),
    'not yours',
  );
  await expectRejection('nobody stands in for their own document', () => act({ requestId: plainReq.id, userId: signer.id, action: 'APPROVED' }), 'raised yourself');

  // Every step the preparer's own: approved on submit, settled once.
  await prisma.approvalWorkflow.create({
    data: {
      documentType: `${TAG}_mine_doc`,
      name: 'Verify — all the preparer’s',
      preparerSigns: true,
      steps: { create: [{ sequence: 1, name: 'Reviewer', approverType: 'ROLE', roleId: roleA.id }] },
    },
  });
  let settledMine = 0;
  onApprovalSettled(`${TAG}_mine_doc`, async (_r, outcome) => {
    if (outcome === 'APPROVED') settledMine += 1;
  });
  const mineReq = await submitForApproval({ documentType: `${TAG}_mine_doc`, documentId: `${TAG}-mine`, subject: `${SUBJECT} all mine`, requesterId: signer.id });
  check(
    'a route whose every step the preparer holds is approved on submit, closed at that instant, settled once',
    mineReq.status === 'APPROVED' && mineReq.closedAt?.getTime() === mineReq.createdAt.getTime() && settledMine === 1,
    `${mineReq.status} ${settledMine}`,
  );

  // One signature per person (2026-10-13): an approver's Approve signs every
  // LATER step they hold in their own right, at the same instant — only where
  // the route lets the preparer sign — and a stand-in signs only their step.
  console.log('\nOne signature per person');
  const roleC = await prisma.role.create({ data: { key: `${TAG}_rolec`, name: 'Verify Finance Manager' } });
  const dual = await makeUser('Verify Dual', 'dual@verify.local', []);
  const coPrep = await makeUser('Verify Co Preparer', 'coprep@verify.local', []);
  await prisma.userRole.createMany({
    data: [
      { userId: dual.id, roleId: roleA.id },
      { userId: dual.id, roleId: roleC.id },
    ],
  });
  const threeSteps = [
    ...twoSteps,
    { sequence: 3, name: 'Finance Manager', approverType: 'ROLE' as const, roleId: roleC.id },
  ];
  await prisma.approvalWorkflow.create({
    data: { documentType: `${TAG}_cosign_doc`, name: 'Verify — one signature per person', preparerSigns: true, standIns: true, steps: { create: threeSteps } },
  });
  await prisma.approvalWorkflow.create({
    data: { documentType: `${TAG}_coplain_doc`, name: 'Verify — asked at every step', steps: { create: threeSteps } },
  });
  const coReq = await submitForApproval({ documentType: `${TAG}_cosign_doc`, documentId: `${TAG}-cosign`, subject: `${SUBJECT} co-sign`, requesterId: coPrep.id });
  await act({ requestId: coReq.id, userId: dual.id, action: 'APPROVED' });
  const coActions = await prisma.approvalAction.findMany({ where: { requestId: coReq.id }, orderBy: { sequence: 'asc' } });
  const coAfter = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: coReq.id } });
  check(
    'an approver holding a later step signs it with the same Approve, at the same instant — even with a step between',
    coActions.length === 2 &&
      coActions[0].sequence === 1 && coActions[0].coSignedWith === null &&
      coActions[1].sequence === 3 && coActions[1].coSignedWith === 1 && coActions[1].approverId === dual.id &&
      coActions[1].actedAt.getTime() === coActions[0].actedAt.getTime() &&
      coAfter.status === 'PENDING' && coAfter.currentSequence === 2,
    JSON.stringify({ coActions, status: coAfter.status, at: coAfter.currentSequence }),
  );
  check(
    'nobody is asked for the step already signed: the next step waits, the co-signed one never queues',
    (await pendingFor(approverB.id)).some((r) => r.id === coReq.id) &&
      !(await pendingFor(dual.id)).some((r) => r.id === coReq.id) &&
      (await prisma.notification.count({ where: { userId: dual.id, type: 'approval.required', title: { startsWith: 'Finance Manager:' } } })) === 0,
  );
  await act({ requestId: coReq.id, userId: approverB.id, action: 'APPROVED' });
  const coDone = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: coReq.id } });
  const coSlots = await approvalSlots(`${TAG}_cosign_doc`, `${TAG}-cosign`);
  check(
    'the middle step settles it, the co-signed step already standing; the paper prints one timestamp for the one person',
    coDone.status === 'APPROVED' &&
      coSlots.length === 3 &&
      coSlots[2].coSigned === true && coSlots[2].name === dual.name &&
      coSlots[2].at?.getTime() === coSlots[0].at?.getTime() && !coSlots[0].coSigned,
    JSON.stringify(coSlots.map((x) => [x.step, x.name, x.at, x.coSigned])),
  );
  check(
    'the trail says so',
    (await prisma.auditLog.count({ where: { entityId: `${TAG}-cosign`, summary: { contains: 'signed with Reviewer (holds both)' } } })) === 1,
  );
  // A stand-in who also holds a later step signs only the step they stood in for.
  await prisma.userRole.create({ data: { userId: bossOf.id, roleId: roleC.id } });
  const standReq = await submitForApproval({ documentType: `${TAG}_cosign_doc`, documentId: `${TAG}-costand`, subject: `${SUBJECT} co-sign stand-in`, requesterId: coPrep.id });
  await act({ requestId: standReq.id, userId: signer.id, action: 'APPROVED' });
  await act({ requestId: standReq.id, userId: bossOf.id, action: 'APPROVED' });
  const standAfter = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: standReq.id } });
  check(
    'a step held by nobody who pressed it is not signed; a stand-in signs only the step they stood in for',
    standAfter.status === 'PENDING' &&
      standAfter.currentSequence === 3 &&
      (await prisma.approvalAction.count({ where: { requestId: standReq.id, coSignedWith: { not: null } } })) === 0,
    `${standAfter.status} ${standAfter.currentSequence}`,
  );
  const plainCo = await submitForApproval({ documentType: `${TAG}_coplain_doc`, documentId: `${TAG}-coplain`, subject: `${SUBJECT} co-sign off`, requesterId: coPrep.id });
  await act({ requestId: plainCo.id, userId: dual.id, action: 'APPROVED' });
  check(
    'where the route does not let the preparer sign, the same person is asked again at their later step',
    (await prisma.approvalRequest.findUniqueOrThrow({ where: { id: plainCo.id } })).currentSequence === 2 &&
      (await prisma.approvalAction.count({ where: { requestId: plainCo.id } })) === 1,
  );
  const returnedCo = await submitForApproval({ documentType: `${TAG}_cosign_doc`, documentId: `${TAG}-coreturn`, subject: `${SUBJECT} co-sign returned`, requesterId: coPrep.id });
  await act({ requestId: returnedCo.id, userId: dual.id, action: 'RETURNED', comment: 'fix it' });
  check(
    'a return signs nothing more',
    (await prisma.approvalAction.count({ where: { requestId: returnedCo.id } })) === 1 &&
      (await prisma.approvalRequest.findUniqueOrThrow({ where: { id: returnedCo.id } })).status === 'CANCELLED',
  );

  // ── 5. Amount bands pick the workflow ──────────────────────────────────────
  console.log('\nApproval thresholds');

  // Someone has to hold the project_manager role, or these workflows route to
  // nobody. The engine warns loudly in that case rather than silently stalling.
  // The supplier bill's routes: the purchase requisition's became one route
  // with no band on 2026-10-13, and the bill's still band at ₱50,000 and do
  // not let the preparer sign — what these checks are about.
  const pm = await makeUser('Verify PM', 'pm@verify.local', ['project_manager']);

  const small = await submitForApproval({
    documentType: 'supplier_bill',
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
    documentType: 'supplier_bill',
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
    documentType: 'supplier_bill',
    documentId: `${TAG}-pr-large`,
    subject: `${SUBJECT} large PR`,
    amount: 450_000,
    requesterId: employee.id,
  });
  const largeWf = await prisma.approvalWorkflow.findUnique({
    where: { id: large.workflowId! },
    include: { steps: true },
  });
  check('a large request collects more signatures', (largeWf?.steps.length ?? 0) === 2, `${largeWf?.steps.length} steps`);

  await expectRejection(
    'the same document cannot be submitted twice while pending',
    () =>
      submitForApproval({
        documentType: 'supplier_bill',
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
  const asSigned = slotSignatories(slotsAfter);
  check(
    'a slot maps to a sign-off with the step as the role and the signer’s name, contact lines and date',
    asSigned[0].role === 'Manager' && asSigned[0].name === pm.name && asSigned[0].email === pm.email && !!asSigned[0].at,
    JSON.stringify(asSigned[0]),
  );
  const mapped = slotSignatories([
    { step: 'Signed', name: 'A Signer', position: 'Head of Signing', at: new Date() },
    { step: 'One open', assigned: [{ id: 'b', name: 'B Assigned', position: 'Assignee', email: 'b@verify.local' }] },
    {
      step: 'Two open',
      assigned: [
        { id: 'c', name: 'C One', position: 'P', email: 'c@verify.local' },
        { id: 'd', name: 'D Two', position: 'Q', email: 'd@verify.local' },
      ],
    },
  ]);
  check(
    'the position travels with a signer and a lone assignee (a designed layout may print it); several assignees read "A or B" with none',
    mapped[0].position === 'Head of Signing' &&
      mapped[1].position === 'Assignee' &&
      mapped[1].email === 'b@verify.local' &&
      mapped[2].name === 'C One or D Two' &&
      mapped[2].position === undefined &&
      mapped[2].email === undefined,
    JSON.stringify(mapped),
  );
  const draftWhileOpen = await approvalSlots(`${TAG}_opt_doc`, `${TAG}-opt-big`, { amount: 5_000, requesterId: employee.id });
  check(
    'asked as a draft while its request is still open, a document prints that open request — a preview never hides a signature in progress',
    draftWhileOpen.length === 2 && draftWhileOpen[0].name === pm.name && !draftWhileOpen[1].name,
  );
  // Refused at the Boss: the request closes, and nobody will sign that step.
  await act({ requestId: optioned.id, userId: pm.id, action: 'REJECTED', comment: 'Verify — refused at the boss' });
  const slotsClosed = await approvalSlots(`${TAG}_opt_doc`, `${TAG}-opt-big`);
  check(
    'a request closed without approval keeps only the steps that signed, each dated — never "Pending" under one nobody will sign',
    slotsClosed.length === 1 && slotsClosed[0].step === 'Manager' && slotsClosed[0].name === pm.name && !!slotsClosed[0].at,
    JSON.stringify(slotsClosed.map((x) => [x.step, x.name])),
  );
  const redraft = await approvalSlots(`${TAG}_opt_doc`, `${TAG}-opt-big`, { amount: 5_000, requesterId: employee.id, optionId: optionRoute.id });
  check(
    'back in draft behind that closed request, it prints the route a resubmission would take — every step open, the old signature gone',
    redraft.length === 2 && redraft.every((x) => !x.name && !x.at && !!x.assigned?.some((p) => p.id === pm.id)),
    JSON.stringify(redraft.map((x) => [x.step, x.name, x.assigned?.length])),
  );
  const reach = await contactOf(pm.id);
  const reachMany = await contactsOf([pm.id, null, pm.id, employee.id]);
  check(
    'contactOf reads how to reach a person for the paper; contactsOf the same for several, each with the name on file',
    reach.email === pm.email &&
      Object.keys(await contactOf(null)).length === 0 &&
      reachMany.size === 2 &&
      reachMany.get(pm.id)?.name === pm.name &&
      reachMany.get(pm.id)?.email === reach.email &&
      reachMany.get(employee.id)?.email === employee.email,
  );

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

  // 60 table rows over FOUR pages (2026-10-10). It was three on the house
  // dress (~22pt a row, 14pt margins); on the one dress every row is the
  // designed quotation's — 9pt type on 20pt of padding, 30.4pt — under a
  // letterhead with its DETAILS block, inside 36pt margins, above a
  // strapline: page 1 holds thirteen or fourteen rows (fewer when the
  // company's details run to a fifth line), each page after it 22, and the
  // sixtieth row goes over to a fourth page. A deliberate change, and the
  // exact number is kept here so the next change to row metrics is
  // deliberate too.
  //
  // What this really guards is the footer: it sits below the bottom margin, and
  // when PDFKit treated that as overflow it gave every footer a page of its own
  // and turned this document into six.
  const pageCount = Number((pdf.toString('latin1').match(/\/Count\s+(\d+)/) ?? [])[1] ?? 0);
  check('long content paginates without runaway pages', pageCount === 4, `${pageCount} pages`);

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
  const qtys = [formatQuantity(4704), formatQuantity('4704.000'), formatQuantity('0.500'), formatQuantity('12345.678')];
  check(
    'a quantity prints with thousands separators and no trailing zeros',
    qtys.join('|') === '4,704|4,704|0.5|12,345.678',
    qtys.join('|'),
  );
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

  // A record's date is Manila's day (2026-10-10). Until 08:00 in Manila the
  // UTC date is still yesterday's: formatDate had no timezone, and the CAD
  // paper printed "October 9" over a sign-off dated "Oct 10, 2026, 6:07 AM".
  // A DATE column is UTC midnight — 08:00 in Manila, the same day.
  const earlyMorning = new Date('2026-10-09T22:07:00Z');
  check('a timestamp before 08:00 Manila prints its Manila day', formatDate(earlyMorning) === 'October 10, 2026', formatDate(earlyMorning));
  check('the same day its sign-off is stamped with', formatDateTime(earlyMorning).startsWith('Oct 10, 2026,'), formatDateTime(earlyMorning));
  check('and a DATE column still prints its own day', formatDate(new Date('2026-10-09T00:00:00Z')) === 'October 9, 2026', formatDate(new Date('2026-10-09T00:00:00Z')));

  // A negated relation never prints as its opposite. "≠" decomposes to "="
  // plus a combining slash, and the base-letter fallback for characters a
  // standard font lacks printed "invoiced ≠ collectible" as "invoiced =
  // collectible". Each negated relation people type has a stand-in that
  // keeps the meaning; any other carrying the slash prints "?".
  check('"≠" prints as "!=", never as "="', pdfSafe('invoiced ≠ collectible') === 'invoiced != collectible', pdfSafe('invoiced ≠ collectible'));
  const negated = ['≮', '≯', '≰', '≱', '≢', '∉', '∌', '⊄', '⊅'];
  const negatedOut = negated.map((c) => pdfSafe(`a ${c} b`));
  check(
    'every negated relation keeps its negation, in characters a standard font has',
    negatedOut.every((t) => /\bnot\b|!=/.test(t) && [...t].every((c) => c.codePointAt(0)! < 0x80)),
    negatedOut.join(' | '),
  );
  check(
    'one with no stand-in prints "?" — never its base, which says the opposite',
    pdfSafe('≇') === '?' && pdfSafe('≁') === '?' && pdfSafe('⊈') === '?' && pdfSafe('x\u0338') === 'x?',
    [pdfSafe('≇'), pdfSafe('≁'), pdfSafe('⊈'), pdfSafe('x\u0338')].join(' '),
  );
  check('an accented letter outside Latin-1 still prints its base letter', pdfSafe('Kayseri ş') === 'Kayseri s', pdfSafe('Kayseri ş'));

  // The margin is the quotation template's, 36pt — one dress for every
  // document (2026-10-10). Measured off the page rather than read back off
  // the constant.
  const edges = pdfEdges(signed);
  check('content starts 36pt from the edge, as the designed quotation does', edges.left === 36, `${edges.left}pt`);
  check('and nothing runs off the bottom', edges.bottom > 12, `${edges.bottom}pt clear`);

  // ── 10. The letterhead every document carries ──────────────────────────────
  console.log('\nLetterhead');

  /*
    The letterhead, the strapline and the sign-offs are drawn by the engine,
    never by a module, so one document proves them for all of them — in the
    one dress every document wears (2026-10-10): the designed quotation's.
    The fields are only borrowed when the database has none: a value an
    administrator already set is asserted as it stands and never overwritten,
    and whatever this sets is put back to null afterwards.
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
      signatories: [
        { role: 'Requested by', name: 'Erwin Dela Pena', position: 'Never Printed Position', phone: '0917 555 0177', email: `${TAG}.erwin@verify.local`, at: new Date('2026-01-02T03:04:00Z') },
        { role: 'Approved by — Project Manager' },
      ],
      footerNote: 'Pesos ₱ only — net of discount',
    });
    const letteredText = pdfText(lettered);
    const letteredLines = letteredText.split('\n');
    const site = websiteForPrint(co.website);
    // The letterhead: the registered name in capitals, then the details by
    // the designed rule — "TIN: … | REG NO: …", "Tel No.: … | Fax No.: …".
    check('the letterhead names the company in capitals', letteredText.includes((co.legalName?.trim() || co.name).toUpperCase()));
    check('and prints REG NO as the designed quotation does', letteredText.includes('REG NO: '));
    check('with the registration number itself', letteredText.includes(co.regNo ?? '\u0000'));
    check('and Tel / Fax when set', !co.fax || (letteredText.includes('Fax No.: ') && letteredText.includes(co.fax)));
    check('and the website as www.…', !co.website || letteredText.includes(`Website: ${site}`));
    check('it names the document in capitals with "# number"', letteredText.includes('QUOTATION') && letteredText.includes(`# ${TAG}-LH`));
    // The strapline: the tagline alone, in capitals; the website is never
    // appended to it (it has its own line on the letterhead).
    const tagline = (co.documentTagline ?? '\u0000').toUpperCase();
    check('the foot carries the tagline in capitals', letteredLines.includes(tagline));
    check(
      'and nothing more — the website is not appended to it',
      !site || tagline.includes(site.toUpperCase()) || !letteredLines.some((l) => l.includes(tagline) && l.includes(site.toUpperCase())),
    );
    check('no peso sign ever reaches the page as ±', !letteredText.includes('±'));
    check('it prints as the currency code instead', letteredText.includes('PHP 1,000 allowance'));
    check('and the footer note is cleaned the same way', letteredText.includes('Pesos PHP only'));
    // The sign-offs: the role in capitals (a long one on two lines, never cut),
    // the name, the contact number and the email on lines of their own, the
    // date — and Pending where nobody has signed. No position.
    check(
      'the sign-offs name who signed, with their contact lines, and say Pending where nobody has',
      letteredLines.includes('REQUESTED BY') &&
        letteredLines.includes('Erwin Dela Pena') &&
        letteredLines.includes('0917 555 0177') &&
        letteredLines.includes(`${TAG}.erwin@verify.local`) &&
        letteredText.includes(stamp(new Date('2026-01-02T03:04:00Z'))) &&
        letteredLines.includes('Pending'),
    );
    check('a long role wraps to a second line rather than losing a word', letteredText.includes('APPROVED BY') && letteredText.includes('MANAGER') && !letteredText.includes('…'));
    check('and no position', !letteredText.includes('Never Printed'));
    const signerAt = textAt(lettered, 'Erwin Dela Pena');
    const signerPhoneAt = textAt(lettered, '0917 555 0177');
    check('the name sits over the contact number, larger', !!signerAt && !!signerPhoneAt && signerPhoneAt.y - signerAt.y > 9, `${signerAt?.y} → ${signerPhoneAt?.y}`);
    const letteredEdges = pdfEdges(lettered);
    check('the strapline stays clear of the bottom edge', letteredEdges.bottom > 12, `${letteredEdges.bottom}pt clear`);
    check('and the content starts 36pt from the edge', letteredEdges.left === 36, `${letteredEdges.left}pt`);
    check('a letterhead does not cost a page', pages(lettered) === 1, `${pages(lettered)} pages`);
    check('and a one-page document carries no "Page 1 of 1"', !letteredText.includes('Page 1 of 1'));

    // With no tagline the strapline is the website — never blank, never both.
    // The real tagline is put back whatever happens.
    // The real tagline is stashed in a Setting first (`cleanup()` puts it
    // back too), so a run killed between the two never leaves the company
    // without its tagline.
    if (co.website) {
      await prisma.setting.upsert({
        where: { key: TAGLINE_STASH },
        create: { key: TAGLINE_STASH, value: { tagline: co.documentTagline } },
        update: { value: { tagline: co.documentTagline } },
      });
      await prisma.company.update({ where: { id: 'company' }, data: { documentTagline: null } });
      try {
        const noTagline = pdfText(await renderDocument({ title: 'Quotation', documentNumber: `${TAG}-NT`, sections: [{ kind: 'text', body: 'x' }] }));
        check('with no tagline the strapline is the website, in capitals', noTagline.split('\n').includes(site.toUpperCase()));
      } finally {
        await restoreTagline();
      }
    }

    // A wide list prints landscape (`landscape: true`): the same dress on a
    // wider page, so ten column heads print whole instead of breaking mid-word.
    const wideHead = ['Code', 'Customer', 'Sub-industry', 'Team', 'Contacts', 'Sites', 'Open quotes', 'Projects', 'Added', 'Status'];
    const wideList = await renderDocument({
      title: 'Customers',
      landscape: true,
      sections: [{ kind: 'table', head: wideHead, rows: [['GT-CUST-2026-0075', 'ABOITIZ LAND, INC.', '—', 'GIB', '1', '1', '0', '0', '10/08/2026', 'Active']] }],
    });
    const wideListText = pdfText(wideList);
    check('a wide list prints on landscape pages', wideList.toString('latin1').includes('/MediaBox [0 0 841.89 595.28]'));
    check(
      'and its column heads and codes print whole',
      wideListText.split('\n').some((l) => l.includes('SUB-INDUSTRY')) && wideListText.split('\n').some((l) => l.includes('GT-CUST-2026-0075')) && wideListText.split('\n').some((l) => l.includes('10/08/2026')),
    );
    check('and still carries the strapline', wideListText.toUpperCase().includes((co.documentTagline ?? co.website ?? '').toUpperCase().slice(0, 12)));

    // A table's group band (2026-10-14, the canvass sheet): runs of columns
    // named over the head — the supplier's name in capitals, its contact
    // under it — and redrawn with the head on every page the rows reach.
    const grouped = await renderDocument({
      title: 'Canvass Sheet',
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Item', 'Qty', 'Unit cost', 'Amount', 'Unit cost', 'Amount'],
          groups: [
            { label: '', span: 2 },
            { label: 'Reference budget', sub: 'approved PR estimate', span: 2 },
            { label: `${TAG} Supply Co.`, sub: 'Tel 0917 · Ana', span: 2, accent: true },
          ],
          rows: Array.from({ length: 40 }, (_, i) => [`Line ${i + 1}`, '1', '1.00', '1.00', '2.00', '2.00']),
        },
      ],
    });
    const groupedLines = pdfText(grouped).split('\n');
    const groupedPages = pages(grouped);
    check(
      'a table can name runs of its columns over its head, the band repeated with the head on every page',
      groupedPages >= 2 &&
        groupedLines.filter((l) => l === `${TAG.toUpperCase()} SUPPLY CO.`).length === groupedPages &&
        groupedLines.filter((l) => l === 'REFERENCE BUDGET').length === groupedPages &&
        groupedLines.filter((l) => l === 'Tel 0917 · Ana').length === groupedPages,
      `${groupedPages} pages: ${groupedLines.filter((l) => l.includes('SUPPLY') || l.includes('REFERENCE')).join(' | ')}`,
    );

    // A document long enough for a second page carries the running header
    // — reference, document and number, the date as MM/DD/YYYY — on every
    // page after the first, and "Page n of m" on every page.
    const twoPages = await renderDocument({
      title: 'Job Order',
      documentNumber: `${TAG}-RH`,
      date: new Date('2026-08-17T02:00:00Z'),
      reference: `${TAG} Customer Inc.`,
      sections: [{ kind: 'table', head: ['Item', 'Amount'], align: ['left', 'right'], rows: Array.from({ length: 30 }, (_, i) => [`Row ${i + 1}`, '1.00']) }],
    });
    const twoText = pdfText(twoPages);
    const twoCount = pages(twoPages);
    check('a long document runs over', twoCount >= 2, `${twoCount} pages`);
    const runningLines = twoText.split('\n').filter((l) => l.includes(`${TAG} Customer Inc.`) && l.includes(`Job Order # ${TAG}-RH`) && l.includes('08/17/2026'));
    check('every page after the first carries the running header', runningLines.length === twoCount - 1, `${runningLines.length} on ${twoCount} pages`);
    check('and every page "Page n of m"', twoText.includes(`Page ${twoCount} of ${twoCount}`) && twoText.includes(`Page 1 of ${twoCount}`));
    check('the table head repeats on the next page, in capitals', twoText.split('\n').filter((l) => l === 'ITEM').length === twoCount);
    // The second ITEM is page two's head: 11pt into a head band that starts
    // at the template's flowTop, 50 — the baseline reads 8.5pt's ascender lower.
    const headOnTwo = textAt(twoPages, 'ITEM', 1);
    check('the continuation page starts 50pt down, as the template does', !!headOnTwo && Math.abs(headOnTwo.y - (50 + 11 + 8.5 * 0.718)) < 1, `${headOnTwo?.y}`);

    // ── The one dress, measured against the template (2026-10-10) ────────
    // Under the rule the engine heads its date and reference DETAILS, as the
    // quotation heads its own: the heading 22.75 under the rule, its lines
    // 22 under the heading, and every `fields` section in the same bold
    // "Label: value". The rule itself sits 14.75 under the last letterhead
    // line's bottom (its baseline plus 3.29 at 7.5pt) and never above 114.25
    // — the designed engine's push for a box that grew.
    check('a field prints as one "Label: value" line, the DETAILS style', signedText.split('\n').includes('Checked: Yes'));
    const detailsAt = textAt(lettered, 'DETAILS');
    const regNoAt = textAt(lettered, 'REG NO: ');
    const ruleAt = regNoAt ? Math.max(114.25, regNoAt.y - 7.5 * 0.718 + 7.5 * 1.156 + 14.75) : NaN;
    check(
      'DETAILS heads the date 22.75 under the letterhead rule, where the template puts it',
      !!detailsAt && Math.abs(detailsAt.y - (ruleAt + 22.75 + 8.5 * 0.718)) < 0.5,
      `${detailsAt?.y} vs ${(ruleAt + 22.75 + 8.5 * 0.718).toFixed(2)}`,
    );
    const dateAt = textAt(lettered, 'Date: ');
    check('and its lines sit 22 under the heading', !!detailsAt && !!dateAt && Math.abs(dateAt.y - detailsAt.y - (22 + (9.5 - 8.5) * 0.718)) < 0.5, `${detailsAt?.y} → ${dateAt?.y}`);
    // An untitled table hangs 23 under the DETAILS box (41pt, or its lines at
    // 14.98), as the template's line table hangs under its details: 22 + 41 + 23, then the head's 11.
    const headAt = textAt(lettered, 'PRODUCT DESCRIPTION');
    check(
      "an untitled table starts where the template's line table does",
      !!headAt && !!detailsAt && Math.abs(headAt.y - detailsAt.y - (22 + 41 + 23 + 11)) < 0.5,
      `${headAt && detailsAt ? (headAt.y - detailsAt.y).toFixed(2) : '?'} under DETAILS`,
    );

    // The totals box measures its rows: a figure is never wrapped (PDFKit
    // wraps any box given a width, whatever `lineBreak` says), and a label
    // longer than its 122.6pt box wraps inside the room the figure leaves,
    // making its row taller — the next row sits under its last line.
    const wide = await renderDocument({
      title: 'Progress Billing',
      documentNumber: `${TAG}-TOT`,
      sections: [
        {
          kind: 'table',
          head: ['No.', 'Description', 'Unit', 'Qty', 'Unit cost', 'Amount'],
          widths: [7, 47, 8, 8, 14, 16],
          headingSpan: 2,
          rows: [{ heading: '1   Materials and consumables' }, ['101', { title: 'Line', body: 'x' }, 'lot', '1', '1.00', '1.00']],
        },
        {
          kind: 'totals',
          rows: [
            { label: 'Margin (33.333333% of the price)', value: formatMoney(41_152_263.02) },
            { label: 'Subtotal', value: formatMoney(123_456_789.06) },
            { label: 'GRAND TOTAL', value: formatMoney(138_271_603.75), bold: true },
          ],
        },
      ],
    });
    const wideLines = pdfText(wide).split('\n');
    check('a nine-digit total prints as one run, never "PHP" over a second line', wideLines.includes('PHP 123,456,789.06') && wideLines.includes('PHP 138,271,603.75'));
    const marginAt = textAt(wide, 'Margin (33.333333%');
    const marginValueAt = textAt(wide, 'PHP 41,152,263.02');
    const marginEnd = textAt(wide, 'price)');
    const subtotalAt = textAt(wide, 'Subtotal');
    check(
      "a label longer than its box wraps inside it and takes the row's height",
      !!marginAt && !!marginValueAt && !!marginEnd && !!subtotalAt && marginAt.y === marginValueAt.y && marginEnd.y > marginAt.y && subtotalAt.y > marginEnd.y + 9,
      `${marginAt?.y}/${marginValueAt?.y} … ${marginEnd?.y} → ${subtotalAt?.y}`,
    );
    // A subheading wraps inside the table's leading columns (No. + Description
    // here, the product column on the designed table) rather than across the
    // whole row — 30 characters at 9.5pt fit in two columns, never in "No.".
    check('a subheading spans the columns the table names', wideLines.includes('1   Materials and consumables'));
    // The title: 24pt, wrapped inside its 185pt box like the template's title
    // box (two lines of 27.74 against a 28pt box) — never shrunk to fit one
    // line — pushing the number and the rule down by what it grew.
    check('a long title wraps in its box rather than shrinking', wideLines.includes('PROGRESS') && wideLines.includes('BILLING'));
    const numberAt = textAt(wide, `# ${TAG}-TOT`);
    const numberShort = textAt(lettered, `# ${TAG}-LH`);
    check(
      'and pushes the number line down by exactly what it grew',
      !!numberAt && !!numberShort && Math.abs(numberAt.y - numberShort.y - (2 * 24 * 1.156 - 28)) < 0.5,
      `${numberShort?.y} → ${numberAt?.y}`,
    );

    // A row taller than a page is split as the designed table splits it: what
    // fits above the foot, then the rest under a repeated head — its short
    // cells on the first page, beside the start of the long one — never drawn
    // off the page, never a page of its own for each stray cell.
    const tallEngine = await renderDocument({
      title: 'Progress Report',
      documentNumber: `${TAG}-TALL`,
      sections: [
        {
          kind: 'table',
          head: ['Item', 'Qty', 'Amount'],
          widths: [3, 1, 1],
          align: ['left', 'right', 'right'],
          rows: [
            [{ title: 'Spec sheet', body: Array.from({ length: 90 }, (_, i) => `Spec line ${i + 1}`).join('\n') }, '1 lot', 'PHP 1.00'],
            ['After the spec', '2', 'PHP 2.00'],
          ],
        },
      ],
    });
    const tallLines = pdfText(tallEngine).split('\n');
    check(
      'a row taller than a page is carried over under a repeated head, not cut off',
      pages(tallEngine) === 2 && tallLines.includes('Spec line 90') && tallLines.filter((l) => l === 'ITEM').length === 2,
      `${pages(tallEngine)} pages`,
    );
    check(
      'its short cells print on the first page, beside the start of the long one',
      pageOf(tallEngine, '1 lot') === 1 && pageOf(tallEngine, 'Spec sheet') === 1 && pageOf(tallEngine, 'After the spec') === 2,
      `${pageOf(tallEngine, '1 lot')} / ${pageOf(tallEngine, 'After the spec')}`,
    );
    check('and nothing is drawn off the bottom', pdfEdges(tallEngine).bottom > 12, `${pdfEdges(tallEngine).bottom}pt clear`);

    // A section title goes over WITH what it heads: whatever room is left at
    // the foot of a page, the title and the table head share a page.
    const orphans: string[] = [];
    for (const n of [38, 44, 46, 48]) {
      const doc = await renderDocument({
        title: 'Job Order',
        documentNumber: `${TAG}-ORPHAN-${n}`,
        sections: [
          { kind: 'text', body: Array.from({ length: n }, (_, i) => `Line ${i + 1}`).join('\n') },
          { kind: 'table', title: 'Cost summary', head: ['Item', 'Description', 'Amount'], rows: [['x', 'y', '1.00']] },
        ],
      });
      if (pageOf(doc, 'COST SUMMARY') !== pageOf(doc, 'ITEM')) orphans.push(`${n} lines: title on page ${pageOf(doc, 'COST SUMMARY')}, head on ${pageOf(doc, 'ITEM')}`);
    }
    check('a section title never ends a page with its table head on the next', orphans.length === 0, orphans.join('; ') || 'none orphaned');

    // ── Paper fixes handed back by the module passes (2026-10-10) ────────
    // A table with no rows prints one muted line under its head, ruled off
    // as a row would be — a head over nothing read as a failed print.
    const emptyTable = await renderDocument({
      title: 'Customers',
      documentNumber: `${TAG}-EMPTY`,
      reference: '0 customers',
      sections: [
        { kind: 'table', head: ['Code', 'Customer', 'Status'], rows: [] },
        { kind: 'text', title: 'Note', body: 'EWT is withheld at source: invoiced ≠ collectible.' },
      ],
    });
    const emptyLines = pdfText(emptyTable).split('\n');
    const emptyHeadAt = textAt(emptyTable, 'CODE');
    const nothingAt = textAt(emptyTable, 'Nothing to list.');
    check(
      'a table with no rows says "Nothing to list." under its head',
      emptyLines.includes('Nothing to list.') && !!emptyHeadAt && !!nothingAt && nothingAt.y > emptyHeadAt.y && nothingAt.x === emptyHeadAt.x,
      `${emptyHeadAt?.y} → ${nothingAt?.y}`,
    );
    check('a table with rows never says it', !pdfText(pdf).includes('Nothing to list.') && !wideListText.includes('Nothing to list.'));
    check('"≠" reaches the page as "!="', emptyLines.some((l) => l.includes('invoiced != collectible')));

    // A head of several words over short figures takes two lines at most
    // where the page has room — never one word a line ("COST / TO / DATE /
    // (PHP)") — and on one line where it has more; no word is broken.
    const budgetHead = ['Category', 'Description', 'Budget (PHP)', 'Committed (PHP)', 'Cost to date (PHP)', 'Available (PHP)'];
    const budgetRows = [
      ['Materials', 'Pipes, fittings, valves and the consumables for the oxygen header tie-in', '1,000,000.00', '200,000.00', '300,000.00', '500,000.00'],
      ['Labor', 'Installation crew', '50,000.00', '0.00', '10,000.00', '40,000.00'],
    ];
    const headLines = (doc: Buffer, starts: string) => {
      const runs = pdfRuns(doc);
      const at = runs.find((r) => r.text.startsWith(starts));
      return at ? runs.filter((r) => r.page === at.page && r.x === at.x && r.size === at.size && r.y >= at.y && r.y < at.y + 30).map((r) => r.text) : [];
    };
    for (const landscape of [false, true]) {
      const budgetDoc = await renderDocument({
        // Titled so that no head's first word starts the title too.
        title: 'Project Ledger',
        documentNumber: `${TAG}-HEADS`,
        landscape,
        // Left-aligned, so a head's lines share their x and can be read back as one head.
        sections: [{ kind: 'table', head: budgetHead, rows: budgetRows }],
      });
      const costHead = headLines(budgetDoc, 'COST');
      const budgetLines = pdfText(budgetDoc).split('\n');
      check(
        landscape
          ? 'with a landscape page to spare, "COST TO DATE (PHP)" prints on one line'
          : 'on a portrait page "COST TO DATE (PHP)" takes two lines, never one word a line',
        costHead.join(' ') === 'COST TO DATE (PHP)' && costHead.length === (landscape ? 1 : 2),
        costHead.join(' / '),
      );
      check(
        `and every figure and word under the heads prints whole (${landscape ? 'landscape' : 'portrait'})`,
        ['1,000,000.00', '200,000.00', '300,000.00', '500,000.00', '50,000.00', '10,000.00', '40,000.00'].every((f) => budgetLines.includes(f)) &&
          budgetHead.every((h) => headLines(budgetDoc, h.toUpperCase().split(' ')[0]).join(' ') === h.toUpperCase()),
        budgetHead.map((h) => headLines(budgetDoc, h.toUpperCase().split(' ')[0]).join(' / ')).join(' | '),
      );
    }
    // Crowded: two long text columns take every point over the heads, so a
    // column of small figures is given exactly its head's two-line width.
    // That width must be measured as the head is set — word by word, space by
    // space — or the kerning of the space before T, V, A, W or Y leaves it a
    // point short and the head stacks one word a line ("EST. / VALUE / (PHP)").
    const crowdedHead = ['Code', 'Description', 'Customer', 'Est. value (PHP)', 'Net total (PHP)', 'Left to book', 'Status'];
    const crowded = await renderDocument({
      title: 'Booking Register',
      documentNumber: `${TAG}-CROWDED`,
      sections: [
        {
          kind: 'table',
          head: crowdedHead,
          rows: [
            ['GT-SO-0001', 'Supply and installation of a 200 m3/h oxygen generator with its dryer, filters, receiver tank and the header tie-in', 'Metro Manila General Hospital and Medical Center, Inc.', '1.00', '1.00', '1.00', 'Open'],
            ['GT-SO-0002', 'Preventive maintenance of the medical air compressors and the vacuum plant, quarterly for twelve months', 'Southern Luzon Regional Medical Center Foundation', '1.00', '1.00', '0.00', 'Issued'],
          ],
        },
      ],
    });
    const crowdedHeads = crowdedHead.map((h) => headLines(crowded, h.toUpperCase().split(' ')[0]));
    check(
      'a crowded portrait table: every head takes two lines at most, read whole',
      crowdedHeads.every((lines, i) => lines.length >= 1 && lines.length <= 2 && lines.join(' ') === crowdedHead[i].toUpperCase()),
      crowdedHeads.map((lines) => lines.join(' / ')).join(' | '),
    );

    // Four sign-offs in a row, as a clearance prints them. A role runs to
    // three lines and is never cut while three hold it — the seeded step
    // "Finance — no outstanding accountabilities" was cut at two with an
    // ellipsis; only a role past three lines ends in one. Every line wraps
    // inside its own column, an email after its @.
    const clearance = await renderDocument({
      title: 'Clearance',
      documentNumber: `${TAG}-CLR`,
      sections: [{ kind: 'fields', fields: [{ label: 'Employee', value: 'Erwin Dela Pena' }] }],
      signatories: [
        { role: 'Requested by', name: 'Erwin Dela Pena', phone: '0917 555 0177', email: `${TAG}.erwin@verify.local`, at: new Date('2026-10-09T22:07:00Z') },
        { role: 'Supervisor', name: 'Juan dela Cruz', at: new Date('2026-10-10T01:00:00Z') },
        { role: 'Finance — no outstanding accountabilities', name: 'Camille Reyes', email: 'camille.reyes@gruntechnology.com' },
        { role: 'HR — final clearance, the release of the last pay and the certificate of employment', name: 'Ana Lim' },
      ],
    });
    const clearanceRuns = pdfRuns(clearance);
    const roleLines = (first: string) => {
      const at = clearanceRuns.find((r) => r.text === first);
      return at ? clearanceRuns.filter((r) => r.page === at.page && r.x === at.x && r.size === at.size && r.y >= at.y - 0.5).map((r) => r.text) : [];
    };
    const financeRole = roleLines('FINANCE — NO');
    check(
      'a long role takes a third line rather than being cut',
      financeRole.join(' ') === 'FINANCE — NO OUTSTANDING ACCOUNTABILITIES' && financeRole.length === 3,
      financeRole.join(' / '),
    );
    const hrRole = roleLines(clearanceRuns.find((r) => r.text.startsWith('HR — '))?.text ?? '\u0000');
    check(
      'and only one longer than three lines ends in an ellipsis, on its third',
      hrRole.length === 3 && hrRole[2].endsWith('…') && !financeRole.some((l) => l.includes('…')),
      hrRole.join(' / '),
    );
    const clearanceLines = pdfText(clearance).split('\n');
    check(
      // One line, shrunk to fit (2026-10-14, the owner's call: "email is only one liner throughout the PDF").
      'an email too long for its column stays on one line, smaller, never broken after its @',
      clearanceLines.includes('camille.reyes@gruntechnology.com') && !clearanceLines.includes('camille.reyes@'),
      clearanceLines.filter((l) => l.includes('camille') || l.includes('gruntech')).join(' / '),
    );
    const houseOverruns = signoffOverruns(clearanceRuns, 'REQUESTED BY', 595.28 - 36, 841.89 - 57.38);
    check("no sign-off line runs past its column into the next", houseOverruns.length === 0, houseOverruns.join('; ') || 'none');
    check('the requester\'s date is Manila\'s', clearanceLines.includes(formatDateTime(new Date('2026-10-09T22:07:00Z'))) && formatDateTime(new Date('2026-10-09T22:07:00Z')).startsWith('Oct 10'));

    // The column rule both engines share: each column ends a gutter before
    // the next begins, however many sign-offs the block holds, and the last
    // ends at the block's right edge.
    const columnFaults: string[] = [];
    for (const block of [
      { name: 'house portrait', x: 36, w: 523.28, colWidth: 133, gutter: 8 },
      { name: 'house landscape', x: 36, w: 769.89, colWidth: 133, gutter: 8 },
      { name: 'designed quotation', x: 36, w: 523.28, colWidth: 133, gutter: 10 },
      { name: 'designed sales order', x: 36, w: 500, colWidth: 150, gutter: 10 },
    ]) {
      for (let n = 1; n <= 8; n++) {
        const cols = signoffColumns(block, n);
        cols.forEach((c, i) => {
          if (i + 1 < cols.length && c.x + c.width > cols[i + 1].x - block.gutter + 0.01) columnFaults.push(`${block.name} n=${n} column ${i + 1}`);
          // One sign-off alone has the whole block, as it always had.
          if (n > 1 && c.width > block.colWidth + 0.01) columnFaults.push(`${block.name} n=${n} column ${i + 1} wider than ${block.colWidth}`);
        });
        const last = cols[cols.length - 1];
        if (Math.abs(last.x + last.width - (block.x + block.w)) > 0.01) columnFaults.push(`${block.name} n=${n} last column ends at ${last.x + last.width}`);
      }
    }
    check("each sign-off column's x + width stops a gutter short of the next column's x", columnFaults.length === 0, columnFaults.join('; ') || 'none');
    // Admin › PDF Templates draws the sign-offs with its own copy of the rule
    // (web/src/lib/pdfTemplate.ts), so the canvas shows the columns the PDF
    // prints — the sales order's five at their shared width, not overlapping.
    const editorColumnFaults: string[] = [];
    for (const block of [
      { x: 36, w: 523.28, colWidth: 133, gutter: 10 },
      { x: 36, w: 500, colWidth: 150, gutter: 10 },
      { x: 36, w: 769.89, colWidth: 340, gutter: 10 },
      { x: 40, w: 120, colWidth: 200, gutter: 10 },
    ]) {
      for (let n = 0; n <= 8; n++) {
        if (JSON.stringify(signoffColumns(block, n)) !== JSON.stringify(editorSignoffColumns(block, n))) editorColumnFaults.push(`${block.w}/${block.colWidth} n=${n}`);
      }
    }
    check("the PDF Templates editor's copy of the sign-off columns reads every block the same", editorColumnFaults.length === 0, editorColumnFaults.join('; ') || 'none');
    const roomy = signoffColumns({ x: 36, w: 523.28, colWidth: 133, gutter: 10 }, 3);
    check(
      'with room to spare a column keeps the layout\'s width — the quotation\'s three are 133pt, first and last at the edges',
      roomy.every((c) => Math.abs(c.width - 133) < 0.01) && roomy[0].x === 36,
      roomy.map((c) => `${c.x.toFixed(1)}+${c.width.toFixed(1)}`).join(', '),
    );

    // The currency a route prints is read every time: a changed setting
    // prints at once, with nothing cached in the process to go stale.
    await prisma.company.update({ where: { id: 'company' }, data: { currency: 'USD' } });
    try {
      check('a changed currency prints at once — nothing caches it', (await companyCurrency()) === 'USD');
    } finally {
      await prisma.company.update({ where: { id: 'company' }, data: { currency: co.currency } });
    }

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
    // The engine's DETAILS is the designed quotation's DETAILS, to the
    // hundredth: both read the same letterhead, both push the rule by the
    // same amount, both set the heading and its lines at the same distances.
    const designedDetails = textAt(letter, 'DETAILS');
    const designedDate = textAt(letter, 'Date: 08/17/2026');
    check(
      'the engine heads its details where the designed quotation heads its own',
      !!designedDetails && !!detailsAt && Math.abs(designedDetails.y - detailsAt.y) < 0.01,
      `${detailsAt?.y} vs ${designedDetails?.y}`,
    );
    check('and dates them on the same line', !!designedDate && !!dateAt && Math.abs(designedDate.y - dateAt.y) < 0.01, `${dateAt?.y} vs ${designedDate?.y}`);
    check('the standard layout names itself QUOTATION, with "# number" and the revision', letterText.includes('QUOTATION') && letterText.includes(`# ${TAG}-LT R2`));
    check('CUSTOMER and DETAILS head the two blocks', letterText.includes('CUSTOMER') && letterText.includes('DETAILS'));
    check('the details print as labelled lines — the date the 08/17/2026 way', letterText.includes('Date: 08/17/2026') && letterText.includes('PR Number: PR-77'));
    check('{{field|—}} prints the dash when the field is empty', letterText.includes('Payment Terms: —'));
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

    // The designed table with no lines says so too, under its head.
    const noLines = pdfText(await renderDesigned(STANDARD_QUOTATION_DESIGN, quoteData({ rows: [] }))).split('\n');
    check('a designed document with no lines prints "Nothing to list." under the head', noLines.includes('Nothing to list.') && noLines.includes('PRODUCT DESCRIPTION'));
    check('and one with lines never does', !letterText.includes('Nothing to list.'));

    // The standard sales order: Prepared by and the four steps of its route
    // in a 500pt box beside the totals. Each column used to be given at
    // least colWidth (150pt) whatever the step, so the names and emails ran
    // into the next column; now the columns share the box and every line
    // wraps inside its own.
    const orderData = salesOrderSample(false);
    orderData.fields = { ...orderData.fields, 'order.draftNote': '' };
    orderData.signatories = [
      { role: 'Prepared by', name: 'Maria Clara Santos-Villanueva', phone: '0917 555 0100', email: 'maria.santos@gruntechnology.com', at: new Date('2026-10-07T01:30:00Z') },
      { role: 'Team Leader', name: 'Juan dela Cruz', phone: '0917 555 0101', email: 'juan.delacruz@gruntechnology.com', at: new Date('2026-10-07T03:10:00Z') },
      { role: 'Back Support / Admin', name: 'Erica Mae Bautista', phone: '0917 555 0102', email: 'erica.bautista@gruntechnology.com', at: earlyMorning },
      { role: 'Cost Controller', name: 'Camille Reyes', phone: '0917 555 0103', email: 'camille.reyes@gruntechnology.com' },
      { role: 'CEO Approval', name: 'Carter T. Gasiong', email: 'ctg@gruntechnology.com' },
    ];
    const order = await renderDesigned(STANDARD_SALES_ORDER_DESIGN, orderData);
    const orderBox = STANDARD_SALES_ORDER_DESIGN.blocks.find((b) => b.type === 'signoffs')!;
    const footerRule = STANDARD_SALES_ORDER_DESIGN.blocks.find((b) => b.id === 'footer-rule')!;
    const orderOverruns = signoffOverruns(pdfRuns(order), 'PREPARED BY', orderBox.x + orderBox.w, footerRule.y);
    const orderLines = pdfText(order).split('\n');
    check(
      "five sign-offs on the standard sales order: no line runs past its column into the next",
      orderOverruns.length === 0 && ['PREPARED BY', 'TEAM LEADER', 'COST CONTROLLER', 'CEO APPROVAL'].every((r) => orderLines.includes(r)),
      orderOverruns.join('; ') || 'none',
    );
    // The approvals are ONE bordered row at the foot of the last page
    // (2026-10-11, the owner's call): the step, the name and the date —
    // no phone, no email — and the draft note under the footer rule, never
    // on the table.
    const orderText = pdfText(order).replace(/\s+/g, ' ');
    check(
      'the one-row approvals table prints the name and the date, never a phone or an email',
      !['maria.santos@', 'juan.delacruz@', '0917 555 0100', 'ctg@'].some((t) => orderText.includes(t)) &&
        orderText.includes('Maria Clara Santos-Villanueva') && orderText.includes('Erica Mae Bautista') && orderText.includes('Pending'),
      orderText.slice(-300),
    );
    const orderRuns = pdfRuns(order);
    const lastPage = Math.max(...orderRuns.map((r) => r.page));
    const preparedRun = orderRuns.find((r) => r.text === 'PREPARED BY');
    check(
      'and it sits at the foot of the last page, above the footer rule',
      !!preparedRun && preparedRun.page === lastPage && preparedRun.y >= orderBox.y - 1 && preparedRun.y < footerRule.y,
      JSON.stringify(preparedRun),
    );
    const draftOrder = pdfRuns(await renderDesigned(STANDARD_SALES_ORDER_DESIGN, salesOrderSample(false)));
    const draftRun = draftOrder.find((r) => r.text.startsWith('DRAFT'));
    check(
      'a short order (two lines, the six totals cells with cost) prints on ONE page, approvals and all',
      Math.max(...draftOrder.map((r) => r.page)) === Math.min(...draftOrder.map((r) => r.page)) &&
        draftOrder.some((r) => r.text === 'PREPARED BY') && draftOrder.some((r) => r.text === 'MARGIN (%)'),
      String(new Set(draftOrder.map((r) => r.page)).size),
    );
    // The owner's slide (2026-10-12): the totals are two bands of three
    // cells, flush right under the table, the figure over its label — and
    // no Subtotal or Discount anywhere; the approvals keep to the foot.
    // The last run of each label: the line table's head says MARGIN too.
    const cellAt = (label: string) => draftOrder.filter((r) => r.text === label).pop();
    const totalsBox = STANDARD_SALES_ORDER_DESIGN.blocks.find((b) => b.type === 'totals')!;
    const [tp, tc, mg, vat, inc, pct] = ['TOTAL PRICE', 'TOTAL COST', 'MARGIN', 'VAT (12%)', 'VAT INCLUDED', 'MARGIN (%)'].map(cellAt);
    check(
      'the totals are two bands of three cells, the figure over its label, flush right',
      !!tp && !!tc && !!mg && !!vat && !!inc && !!pct &&
        tp.y === tc.y && tc.y === mg.y && vat.y === inc.y && inc.y === pct.y && vat.y > tp.y &&
        tp.x < tc.x && tc.x < mg.x && tp.x >= totalsBox.x - 1 &&
        draftOrder.some((r) => r.text === '125,000.00' && r.y < tp.y) && draftOrder.some((r) => r.text === '30.80' && r.y < pct.y),
      JSON.stringify([tp, mg, vat, pct]),
    );
    check(
      'no Subtotal, no Discount, no "Sum without tax" on the order paper',
      !draftOrder.some((r) => /^(Subtotal|Discount|Sum without tax)/i.test(r.text)),
    );
    const sigNote = draftOrder.find((r) => r.text.startsWith('The name, date and time are considered a digital signature'));
    const prepared = draftOrder.find((r) => r.text === 'PREPARED BY');
    check(
      'the digital-signature note sits right above the approvals table, which ends over the footer rule',
      !!sigNote && !!prepared && sigNote.y < prepared.y && prepared.y - sigNote.y < 30 && orderBox.y + orderBox.h <= footerRule.y,
      JSON.stringify([sigNote?.y, prepared?.y]),
    );
    const longOrder = pdfRuns(await renderDesigned(STANDARD_SALES_ORDER_DESIGN, salesOrderSample(true)));
    const longLast = Math.max(...longOrder.map((r) => r.page));
    const longPrepared = longOrder.find((r) => r.text === 'PREPARED BY');
    const longCells = longOrder.find((r) => r.text === 'TOTAL PRICE');
    check(
      'a long order keeps the approvals at the foot of its LAST page, the totals cells above them',
      longLast > 0 && longPrepared?.page === longLast && longPrepared.y >= orderBox.y - 1 && !!longCells && longCells.page === longLast && longCells.y < longPrepared.y,
      JSON.stringify({ longLast, longPrepared, longCells }),
    );
    check(
      'the draft note prints under the footer rule, clear of the approvals table',
      !!draftRun && draftRun.y > footerRule.y,
      JSON.stringify(draftRun),
    );

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
    const marked = (lines: { text: string; bold: boolean }[][]) => lines.map((l) => l.map((r) => (r.bold ? `<b>${r.text}</b>` : r.text)).join('')).join('/');
    check('a part whose fields are empty drops out, alone', marked(resolveTemplate(cases[0][0], cases[0][1])) === 'Email: x@y.ph');
    check('a line whose parts all dropped is left out', resolveTemplate(cases[1][0], cases[1][1]).length === 0);
    check('{{field|—}} keeps the line, and ** marks bold', marked(resolveTemplate(cases[2][0], cases[2][1])) === '<b>Delivery:</b> —');
    check('blank lines and fixed text stay', marked(resolveTemplate(cases[3][0], cases[3][1])) === 'Static//After');
    check('a value is printed as typed — its ** is not markup', marked(resolveTemplate(cases[4][0], cases[4][1])) === 'a**b**');
    check('a value with newlines runs over as many lines', marked(resolveTemplate(cases[5][0], cases[5][1])) === '<b>Terms:</b>/one/two');
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

  // ── The requisition page's lines (web/src/lib/prLines.ts) ─────────────────
  {
    console.log('\nPurchase requisition lines: import and paste');
    const cats = [
      { id: 'mat', code: 'MAT', name: 'Materials' },
      { id: 'eqp', code: 'EQP', name: 'Equipment' },
    ];
    const csv = 'Budget line,Part No.,Item,Description,Unit,Qty,Est. unit cost\r\nMaterials,S3 R 68,"COMPRESSOR OIL, 4L","Corena ""S3""",pcs,2,"1,240.00"\r\n2,A048199,OIL FILTER,,,1,1650\r\n,,,,,,\r\n';
    const fromCsv = rowsToPrLines(parseDelimited(csv), cats);
    check(
      'an imported CSV is read by its headings: quotes, doubled quotes, commas in a figure, a budget line by name or place',
      fromCsv.lines.length === 2 && fromCsv.lines[0].name === 'COMPRESSOR OIL, 4L' && fromCsv.lines[0].description === 'Corena "S3"' &&
        fromCsv.lines[0].estimatedCost === '1240' && fromCsv.lines[0].costCategoryId === 'mat' && fromCsv.lines[1].costCategoryId === 'eqp' &&
        fromCsv.lines[1].unit === 'pcs',
      JSON.stringify(fromCsv),
    );
    const pasted = rowsToPrLines(parseDelimited('A1\tAIR FILTER\t\tpc\t3\t1,250\nB2\t\t\tpc\t1\t5\nC3\tSEPARATOR\t\tpc\tx\t5'), cats);
    check(
      'a block pasted from a spreadsheet (tabs, no headings) is read in the page\'s column order, and a row that cannot be read is named, never dropped silently',
      pasted.lines.length === 1 && pasted.lines[0].partNumber === 'A1' && pasted.lines[0].quantity === '3' && pasted.lines[0].estimatedCost === '1250' &&
        pasted.skipped.length === 2 && /Row 2/.test(pasted.skipped[0]) && /Row 3/.test(pasted.skipped[1]),
      JSON.stringify(pasted),
    );
    check(
      'a line\'s amount is the server\'s centavo rule, and a budget line matches by code, name or "1 Materials"',
      prLineAmount(4, 950.555) === Math.round(4 * 950.555 * 100) / 100 && matchCategory('eqp', cats) === 'eqp' &&
        matchCategory('1 Materials', cats) === 'mat' && matchCategory('Labour', cats) === '',
    );
    const added = orderTotals([3502, 1200], 0.12, false);
    const inside = orderTotals([2626.5], 0.12, true);
    check(
      'the order page\'s money is recalcPo\'s: VAT added to the subtotal, or taken out of it when the prices include it',
      added.subtotal === 4702 && added.vatAmount === 564.24 && added.total === 5266.24 &&
        inside.subtotal === 2626.5 && inside.vatAmount === 281.41 && inside.total === 2626.5,
      JSON.stringify([added, inside]),
    );
    const many = Array.from({ length: 30 }, (_, i) => `SUPPLIER NUMBER ${i}`);
    check(
      'lines from the costing fill an empty preferred supplier with their suppliers, each once, and never overwrite one typed',
      preferredFrom('', ['ABB', null, ' abb ', 'Schneider  PH', '']) === 'ABB, Schneider PH' &&
        preferredFrom('Typed Co', ['ABB']) === 'Typed Co' &&
        preferredFrom('', [null]) === '' &&
        preferredFrom('', many).length <= 200,
    );
  }

  // ── Numeric inputs (web/src/lib/number.ts) ─────────────────────────────────
  console.log('\nNumeric inputs');
  check(
    'money and quantities print with commas and two decimals',
    formatNumberText(1562.2, 'money') === '1,562.20' && formatNumberText('1250000', 'quantity') === '1,250,000.00',
    `${formatNumberText(1562.2, 'money')} ${formatNumberText('1250000', 'quantity')}`,
  );
  check(
    'a value is never rounded for display: a 3-dp quantity keeps its third decimal',
    formatNumberText('1.125', 'quantity') === '1.125' && formatNumberText(0.5, 'percent') === '0.50',
  );
  check(
    'counts print whole with commas, a year prints plain',
    formatNumberText(12500, 'count') === '12,500' && formatNumberText(7.5, 'count') === '7.5' && formatNumberText(2026, 'plain') === '2026',
  );
  check(
    'typed commas are accepted and dropped, and only a number can be typed',
    cleanNumberText('1,250.50') === '1250.50' &&
      isPartialNumber('12.') &&
      isPartialNumber('-') &&
      !isPartialNumber('-', false) &&
      !isPartialNumber('1.2.3') &&
      !isPartialNumber('12a'),
  );
  check(
    'empty stays empty, and the edit text has no commas',
    formatNumberText('', 'money') === '' && formatNumberText(null, 'money') === '' && editNumberText('1,000.5') === '1000.5' && editNumberText(42) === '42',
  );

  // ── One way to do each thing (rules 17, 19, 20) ───────────────────────────
  // These rules have no click-path a test could take, and each was broken by
  // hand-written copies before it was written down — 23 /users/lookup fetches,
  // nine local confirm bars. So the source itself is read: every page and
  // component, comments left out.
  console.log('\nOne way to do each thing (the web source)');
  {
    const webSrc = path.resolve(__dirname, '../../web/src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(tsx?|jsx?)$/.test(entry.name)) files.push(full);
      }
    };
    walk(webSrc);
    const code = (file: string) =>
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .map((line, i) => ({ line: i + 1, text: line }))
        .filter(({ text }) => !/^\s*(\/\/|\*|\/\*)/.test(text));
    const offenders = (pattern: RegExp, except: string[] = []) =>
      files
        .filter((f) => !except.some((e) => f.endsWith(e)))
        .flatMap((f) => code(f).filter(({ text }) => pattern.test(text)).map(({ line }) => `${path.relative(webSrc, f)}:${line}`));

    const lookups = offenders(/\.get(<[^(]*>)?\(\s*[`'"]\/users\/lookup/, ['components/People.tsx']);
    check(
      'people are fetched in one place: no screen calls /users/lookup itself (usePeople / loadPeople)',
      lookups.length === 0,
      lookups.join(', '),
    );
    const numberBoxes = offenders(/<input[^>]*type=["']number["']/);
    check('no screen writes <input type="number"> (NumberInput, rule 17)', numberBoxes.length === 0, numberBoxes.join(', '));
    const browserAsks = offenders(/(window\.(confirm|prompt|alert)\(|(^|[^.\w])(confirm|prompt|alert)\()/, ['components/Confirm.tsx']);
    check(
      'nothing asks through the browser: no confirm(), prompt() or alert() (useConfirm, rule 19)',
      browserAsks.length === 0,
      browserAsks.join(', '),
    );
    check('the source scan found the web app', files.length > 100, `${files.length} files`);
  }

  // A printed list audits as EXPORTED with entityId 'list'; that row opens
  // the list, never a record page asking the API for a record called "list"
  // (the link crawl of 2026-10-10 found seven such 404s).
  check(
    "a record link for 'list' opens the list itself, and a real id its record",
    recordLink('lead', 'list') === '/g-ops/leads' && recordLink('lead', 'abc') === '/g-ops/leads/abc' && recordLink('customer', 'list') === '/g-ops/customers',
    `${recordLink('lead', 'list')} ${recordLink('lead', 'abc')}`,
  );

  // ── The list pattern's URL (web/src/lib/listUrl.ts, rule 16) ───────────────
  console.log('\nList URLs, filters and saved views');
  {
    const defs: FilterDef[] = [
      { key: 'ownerId', label: 'Owner', options: [] },
      { key: 'createdFrom', toKey: 'createdTo', label: 'Raised', type: 'dateRange' },
      { key: 'customerId', label: 'Client', type: 'lookup', search: async () => [] },
    ];
    const keys = filterKeysOf(defs, { key: 'stage', options: [] });
    check(
      'a list owns one key per filter, two for a date range, one for its tabs',
      keys.join(',') === 'ownerId,createdFrom,createdTo,customerId,stage',
      keys.join(','),
    );

    // Year to date on a bare visit (2026-10-11): defaults fill a URL that names
    // no search and none of the list's filters — never a link that filters.
    const ytd = { createdFrom: yearStartKey(new Date(2026, 9, 11, 23, 30)) };
    const bareVisit = startFilters(readListUrl(new URLSearchParams('scope=all&new=1'), keys), undefined, ytd);
    const linkedVisit = startFilters(readListUrl(new URLSearchParams('closingFrom=2026-11-01&stage=OPPORTUNITY'), [...keys, 'closingFrom']), undefined, ytd);
    const searched = startFilters(readListUrl(new URLSearchParams('q=pump'), keys), { ownerId: 'u1' }, ytd);
    check(
      'a list’s defaults (year to date) fill a bare visit only; a link that filters, or a search, keeps its own set',
      ytd.createdFrom === '2026-01-01' && JSON.stringify(bareVisit) === JSON.stringify({ createdFrom: '2026-01-01' }) &&
        !('createdFrom' in linkedVisit) && linkedVisit.stage === 'OPPORTUNITY' && JSON.stringify(searched) === JSON.stringify({ ownerId: 'u1' }),
      JSON.stringify({ bareVisit, linkedVisit, searched }),
    );
    const ytdUrl = writeListUrl(new URLSearchParams(), { q: '', scope: 'all', page: 1, active: bareVisit }, { filterKeys: keys, defaultScope: 'all' });
    check('a default is written to the URL like any filter, so removing its chip shows everything', ytdUrl.get('createdFrom') === '2026-01-01', ytdUrl.toString());

    const linked = new URLSearchParams('stage=COMPLETED&createdFrom=2026-03-01&new=1&visit=abc&scope=all&page=2&q=pump');
    const read = readListUrl(linked, keys);
    check(
      'reading the URL takes only the list’s own keys',
      read.q === 'pump' && read.scope === 'all' && read.page === 2 &&
        JSON.stringify(read.filters) === JSON.stringify({ createdFrom: '2026-03-01', stage: 'COMPLETED' }),
      JSON.stringify(read),
    );
    check(
      'a link may say ?scope=team; anything else than mine, team or all reads as unset',
      readListUrl(new URLSearchParams('scope=team'), keys).scope === 'team' && readListUrl(new URLSearchParams('scope=ours'), keys).scope === null,
    );

    const written = writeListUrl(
      linked,
      { q: '', scope: 'mine', page: 1, active: { stage: 'LOST', ownerId: '', createdTo: '2026-03-31' } },
      { filterKeys: keys, defaultScope: 'mine' },
    );
    check(
      'writing keeps every key the list does not own, and drops its own that are off',
      written.get('new') === '1' && written.get('visit') === 'abc' && !written.has('q') && !written.has('page') &&
        !written.has('ownerId') && !written.has('createdFrom') && written.get('createdTo') === '2026-03-31' &&
        written.get('stage') === 'LOST',
      written.toString(),
    );
    check(
      'the default scope is never written; the other one always is',
      !written.has('scope') &&
        writeListUrl(new URLSearchParams(), { q: '', scope: 'all', page: 1, active: {} }, { filterKeys: keys, defaultScope: 'mine' }).get('scope') === 'all' &&
        !writeListUrl(new URLSearchParams(), { q: '', scope: 'all', page: 1, active: {} }, { filterKeys: keys, defaultScope: 'all' }).has('scope'),
    );
    check(
      'a route’s preset stays out of the URL, a departure from it goes in',
      !writeListUrl(new URLSearchParams(), { q: '', scope: 'all', page: 1, active: { stage: 'LOST' } }, { filterKeys: keys, defaultScope: 'all', presets: { stage: 'LOST' } }).has('stage') &&
        writeListUrl(new URLSearchParams(), { q: '', scope: 'all', page: 1, active: { stage: 'WON' } }, { filterKeys: keys, defaultScope: 'all', presets: { stage: 'LOST' } }).get('stage') === 'WON',
    );

    const q1 = viewQuery({ q: 'pump', scope: 'all', active: { stage: 'COMPLETED', ownerId: '' } }, keys);
    const back = readView(q1, keys, 'mine');
    check(
      'a saved view keeps search, scope and filters — and reads back the same',
      back.q === 'pump' && back.scope === 'all' && JSON.stringify(back.active) === JSON.stringify({ stage: 'COMPLETED' }),
      q1,
    );
    let views = saveView([], '  My   open deals ', q1);
    views = saveView(views, 'MY OPEN DEALS', 'scope=mine');
    views = saveView(views, '   ', 'scope=all');
    check(
      'saving a view of the same name replaces it, case-blind; a blank name saves nothing',
      views.length === 1 && views[0].name === 'MY OPEN DEALS' && views[0].query === 'scope=mine',
      JSON.stringify(views),
    );
    // Your own views (2026-10-12): the opening view, its columns, its query.
    const myViews = [
      { name: 'Won this year', isDefault: false },
      { name: 'My open deals', isDefault: true },
    ];
    check(
      'a bare visit opens on the person’s opening view; a link, a search or a scope in the URL never does',
      openingView(readListUrl(new URLSearchParams('new=1&page=2'), keys), myViews)?.name === 'My open deals' &&
        openingView(readListUrl(new URLSearchParams('stage=LOST'), keys), myViews) === null &&
        openingView(readListUrl(new URLSearchParams('q=pump'), keys), myViews) === null &&
        openingView(readListUrl(new URLSearchParams('scope=all'), keys), myViews) === null &&
        openingView(readListUrl(new URLSearchParams(''), keys), [{ isDefault: false }]) === null &&
        isBareVisit(readListUrl(new URLSearchParams('jobId=j1'), keys)),
    );
    const cols = ['number', 'name', 'customer', 'total'];
    check(
      'a view’s hidden columns keep to the list’s own keys, and never hide them all',
      JSON.stringify(viewHidden(['total', 'gone', 'total', 7], cols)) === '["total"]' &&
        viewHidden(null, cols) === null &&
        viewHidden('total', cols) === null &&
        JSON.stringify(viewHidden([...cols], cols)) === '[]',
    );
    check(
      'a view’s query goes to the API as an object and comes back as the same string; a name is kept tidy',
      queryString(queryObject(q1)) === q1 &&
        queryString({ scope: 'all', stage: '', n: 3 }) === 'scope=all' &&
        queryString([1]) === null &&
        cleanViewName('  My   open\tdeals ') === 'My open deals' &&
        cleanViewName('x'.repeat(60)).length === 40,
    );
    const kept = keepDefaults('scope=all&createdFrom=2026-01-01&stage=LOST', { createdFrom: '2026-01-01' });
    check(
      'a view saved on year to date keeps year to date: next year it opens on next year’s 1 January',
      kept === 'scope=all&createdFrom=%40default&stage=LOST' &&
        fillDefaults(kept, { createdFrom: '2027-01-01' }) === 'scope=all&createdFrom=2027-01-01&stage=LOST' &&
        fillDefaults(kept, undefined) === 'scope=all&stage=LOST' &&
        keepDefaults('createdFrom=2025-06-01', { createdFrom: '2026-01-01' }) === 'createdFrom=2025-06-01',
      kept,
    );
    const page = ['a', 'b', 'c'];
    check(
      'the header box reads none, some or all of the page',
      pageSelection(page, new Set()) === 'none' && pageSelection(page, new Set(['b', 'z'])) === 'some' &&
        pageSelection(page, new Set(['a', 'b', 'c', 'z'])) === 'all',
    );
    const ticked = togglePage(page, new Set(['b', 'z']));
    const unticked = togglePage(page, ticked);
    check(
      'clicking it ticks the whole page, then clears it — rows on other pages are kept both times',
      [...ticked].sort().join(',') === 'a,b,c,z' && [...unticked].join(',') === 'z',
      `${[...ticked]} / ${[...unticked]}`,
    );
    const full = new Set(Array.from({ length: MAX_SELECTED - 1 }, (_, i) => `k${i}`));
    check('a selection stops at the most the server will take', togglePage(page, full).size === MAX_SELECTED);
    check(
      'the Filters badge counts filters — a date range once, the tab strip never',
      countActiveFilters({ stage: 'LOST', createdTo: '2026-03-31', createdFrom: '2026-03-01', ownerId: 'u1' }, defs) === 2,
    );
  }

  // ── The SCORO archive's removal (shared/scoroArchive.ts) ───────────────────
  // The seed runs removeScoroArchive() on every deploy (2026-10-10, the
  // owner's call: "remove also scoro data"). Its rule: whatever it finds goes,
  // row and file; the audit row and the completion setting are written ONCE;
  // a later run with the setting present and nothing to remove does nothing.
  // The fixture is the archive's leavings — a PDF attached under its entity
  // type and a saved view of its list — never a row of the retired table
  // itself, which nothing but that function may write.
  console.log('\nThe SCORO archive, removed');
  {
    const started = new Date();
    const mark = await prisma.setting.findUnique({ where: { key: SCORO_ARCHIVE_REMOVED } });
    // The install's own completion mark is parked in a Setting first, as the
    // tagline is, so a run killed mid-section never leaves it missing.
    const stash = { setting: mark ? { value: mark.value, description: mark.description } : null, startedAt: started.toISOString() };
    await prisma.setting.upsert({ where: { key: ARCHIVE_STASH }, create: { key: ARCHIVE_STASH, value: stash }, update: { value: stash } });
    await prisma.setting.deleteMany({ where: { key: SCORO_ARCHIVE_REMOVED } });
    try {
      // Count only the script's own: a database that has not seeded since the
      // removal may still hold the real archive's leavings, and they go too.
      const before = {
        pdfs: await prisma.attachment.count({ where: { entityType: ARCHIVE_ATTACHMENT } }),
        views: await prisma.savedFilter.count({ where: { listKey: ARCHIVE_LIST_KEY } }),
      };
      const pdfFile = path.join(env.uploadDir, ARCHIVE_FIXTURE_FILE);
      fs.writeFileSync(pdfFile, '%PDF-1.4\n');
      const pdf = await prisma.attachment.create({
        data: {
          entityType: ARCHIVE_ATTACHMENT,
          entityId: `${TAG}-scoro-quote`,
          fileName: 'SCORO quote.pdf',
          storedName: ARCHIVE_FIXTURE_FILE,
          mimeType: 'application/pdf',
          size: 9,
          uploadedById: salesUser.id,
        },
      });
      const view = await prisma.savedFilter.create({
        data: { userId: salesUser.id, listKey: ARCHIVE_LIST_KEY, name: `${SUBJECT} archive view`, query: { q: 'x' } },
      });
      const archiveRows = () =>
        prisma.auditLog.findMany({
          where: { entityType: ARCHIVE_ATTACHMENT, entityId: 'archive', at: { gte: started } },
          orderBy: { at: 'asc' },
        });

      const first = await removeScoroArchive();
      check(
        'the first run removes the PDF and the saved view, and marks the removal',
        first?.pdfs === before.pdfs + 1 && first?.views === before.views + 1 && first?.marked === true,
        JSON.stringify(first),
      );
      check('the PDF goes row and file', !(await prisma.attachment.findUnique({ where: { id: pdf.id } })) && !fs.existsSync(pdfFile));
      check('and the saved view with it', !(await prisma.savedFilter.findUnique({ where: { id: view.id } })));
      const rows = await archiveRows();
      check(
        'one audit row, by the system, saying what went',
        rows.length === 1 &&
          rows[0].actorName === 'system' &&
          rows[0].action === 'DELETED' &&
          rows[0].summary === `Removed the SCORO archive: ${before.pdfs + 1} PDFs, ${before.views + 1} saved views`,
        rows.map((r) => `${r.actorName}: ${r.summary}`).join(' | ') || 'none',
      );
      const written = (await prisma.setting.findUnique({ where: { key: SCORO_ARCHIVE_REMOVED } }))?.value as
        | { at?: string; pdfs?: number; views?: number }
        | undefined;
      check(
        'and the completion setting, dated, carrying the counts',
        typeof written?.at === 'string' && written.pdfs === before.pdfs + 1 && written.views === before.views + 1,
        JSON.stringify(written),
      );

      check('a second run with nothing to remove does nothing', (await removeScoroArchive()) === null);
      check('— and writes no second audit row', (await archiveRows()).length === 1);

      // A leaving found after the mark still goes, counted, but is neither
      // marked nor audited again: the mark says the archive was removed once.
      await prisma.savedFilter.create({
        data: { userId: salesUser.id, listKey: ARCHIVE_LIST_KEY, name: `${SUBJECT} stray view`, query: {} },
      });
      const later = await removeScoroArchive();
      check(
        'a saved view found after the mark is removed and counted, never marked again',
        later?.views === 1 && later?.marked === false,
        JSON.stringify(later),
      );
      check('— and the audit row stays one', (await archiveRows()).length === 1);
    } finally {
      await restoreArchiveMark();
    }
  }

  // ── Spreadsheet viewer (web/src/lib/spreadsheet*.ts) ───────────────────────
  // An attached workbook opens at /files/:id instead of downloading. The page
  // parses in a worker; these are the rules that worker and page share.
  console.log('\nSpreadsheet viewer');

  check(
    'a spreadsheet is known by its extension, not its MIME type',
    isSpreadsheet({ fileName: 'Price List.XLSX' }) &&
      isSpreadsheet({ fileName: 'rates.csv' }) &&
      isSpreadsheet({ fileName: 'old.xls' }) &&
      !isSpreadsheet({ fileName: 'quote.pdf' }) &&
      !isSpreadsheet({ fileName: 'xlsx' }),
  );
  check(
    'columns are named as Excel names them',
    [0, 25, 26, 701, 702].map(columnName).join() === 'A,Z,AA,ZZ,AAA',
  );
  const numericCases: [string, boolean][] = [
    ['12,500.00', true], ['(1,234.00)', true], ['PHP 1,562.20', true], ['₱12,500.00', true],
    ['15%', true], ['1.2E+10', true], ['-3.5', true],
    ['00123', false], ['ACS580', false], ['6/1/26', false], ['', false], ['USD', false],
  ];
  const wrongNumeric = numericCases.filter(([text, want]) => looksNumeric(text) !== want).map(([t]) => t);
  check('a CSV cell reads as a number only when it is one (codes keep their zeros)', wrongNumeric.length === 0, wrongNumeric.join(' | '));

  // A price list shaped like a real one: a merged title, a validity line, a
  // blank row, then the headings — and formatting that runs past the data.
  const vfd = XLSX.utils.aoa_to_sheet([
    ['FY2026 JUNE PRICELIST - DISTRIBUTORS'],
    ['Valid from 1 June 2026'],
    [],
    ['Model', 'Description', 'Frame', 'List price', 'Stock', 'Updated'],
    ['ACS580-01-02A7-4', '0.75 kW drive', 'R1', 12500, 3, new Date(Date.UTC(2026, 5, 1))],
    ['00123', 'Spare fan', '', 850.5, 0],
    ['ACS580-01-04A1-4', '1.5 kW drive\nIP21', 'R1', 1562.2, 2],
  ], { cellDates: true });
  vfd['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 4 } }];
  for (const ref of ['D5', 'D6', 'D7']) vfd[ref].z = '#,##0.00';
  vfd['F5'].z = 'yyyy-mm-dd';
  vfd['!ref'] = 'A1:J60';
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, vfd, 'VFD');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['internal']]), 'Rates');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['secret']]), 'Calc');
  book.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 1 }, { Hidden: 2 }] };

  const xlsxBytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const viewed = readWorkbook(new Uint8Array(xlsxBytes), 'FY2026 JUNE PRICELIST.xlsx');
  const sheet = viewed.sheets[0];
  check(
    'only the sheets Excel shows are shown; a hidden one is named, a very hidden one is not',
    viewed.sheets.map((s) => s.name).join() === 'VFD' && viewed.hiddenSheets.join() === 'Rates',
    JSON.stringify({ sheets: viewed.sheets.map((s) => s.name), hidden: viewed.hiddenSheets }),
  );
  check('the headings row is found under the title rows (row 4)', sheet?.headerRow === 3, String(sheet?.headerRow));
  check(
    'a number reads as Excel shows it, through its own format, and aligns as a number',
    sheet?.rows[4]?.[3] === '12,500.00' && sheet?.kinds[4]?.[3] === 'n',
    `${sheet?.rows[4]?.[3]} ${sheet?.kinds[4]}`,
  );
  check(
    'a part number typed as text keeps its leading zeros and stays text',
    sheet?.rows[5]?.[0] === '00123' && sheet?.kinds[5]?.[0] !== 'n',
  );
  check('a date reads through its format', sheet?.rows[4]?.[5] === '2026-06-01', sheet?.rows[4]?.[5]);
  check('a line break inside a cell survives', !!sheet?.rows[6]?.[1]?.includes('\n'));
  check(
    'a merged title spans its columns',
    !!sheet?.spans.some((s) => s.r === 0 && s.c === 0 && s.cols === 5),
    JSON.stringify(sheet?.spans),
  );
  check(
    'formatting past the data is trimmed (six columns, seven rows)',
    sheet?.colCount === 6 && sheet?.rows.length === 7,
    `${sheet?.colCount} × ${sheet?.rows.length}`,
  );
  const keys = sheet ? rowKeys(sheet) : [];
  check(
    'search is case- and comma-blind and never matches across two cells',
    matchingRows(keys, '12500').join() === '4' &&
      matchingRows(keys, 'acs580').join() === '4,6' &&
      matchingRows(keys, 'R1 0.75').length === 0 &&
      matchingRows(keys, '  ').length === 0,
  );
  check(
    'and marks what it found the same way, commas included',
    JSON.stringify(matchRanges('9,137.25', '9137.25')) === '[[0,8]]' &&
      JSON.stringify(matchRanges('ACS580 / acs580', 'ACS')) === '[[0,3],[9,12]]' &&
      matchRanges('Drive', 'pump').length === 0,
    JSON.stringify([matchRanges('9,137.25', '9137.25'), matchRanges('ACS580 / acs580', 'ACS')]),
  );

  const xlsBytes = XLSX.write(book, { type: 'buffer', bookType: 'biff8' }) as Buffer;
  const fromXls = readWorkbook(new Uint8Array(xlsBytes), 'old price list.xls');
  check(
    'an old .xls reads the same',
    fromXls.sheets[0]?.rows[4]?.[3] === '12,500.00' && fromXls.sheets[0]?.headerRow === 3,
    fromXls.sheets[0]?.rows[4]?.join(' | '),
  );

  const csvText = 'Part,Description,Price\r\n00123,Señor fan ₱,"1,250.00"\r\nACS580,Drive,12500\r\n';
  const csvBytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(csvText)]);
  const csv = readWorkbook(csvBytes, 'rates.csv').sheets[0];
  check(
    'a CSV is read as written: zeros kept, UTF-8 and its BOM handled, numbers aligned',
    csv?.rows[1]?.[0] === '00123' &&
      csv?.rows[1]?.[1] === 'Señor fan ₱' &&
      csv?.rows[1]?.[2] === '1,250.00' &&
      csv?.kinds[1] === 'ssn' &&
      csv?.rows[0]?.[0] === 'Part' &&
      csv?.headerRow === 0,
    JSON.stringify({ rows: csv?.rows, kinds: csv?.kinds }),
  );
  // "Peñalosa" as an older Excel saves it, in Windows-1252.
  const ansi = new Uint8Array([...'Name\r\nPe'].map((ch) => ch.charCodeAt(0)).concat([0xf1], [...'alosa\r\n'].map((ch) => ch.charCodeAt(0))));
  check(
    'a CSV that is not UTF-8 is read as Windows-1252',
    readWorkbook(ansi, 'old.csv').sheets[0]?.rows[1]?.[0] === 'Peñalosa',
    readWorkbook(ansi, 'old.csv').sheets[0]?.rows[1]?.[0],
  );

  const tall = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    tall,
    XLSX.utils.aoa_to_sheet(Array.from({ length: MAX_ROWS + 5 }, (_, i) => [`row ${i + 1}`])),
    'Long',
  );
  const long = readWorkbook(new Uint8Array(XLSX.write(tall, { type: 'buffer', bookType: 'xlsx' }) as Buffer), 'long.xlsx').sheets[0];
  check(
    `a sheet past ${MAX_ROWS.toLocaleString()} rows is cut there and says so`,
    long?.rows.length === MAX_ROWS && long?.truncatedRows === true,
    `${long?.rows.length} ${long?.truncatedRows}`,
  );

  // ── The name a paper is saved under, and the print ticket (2026-10-12) ────
  console.log('\nPaper names and print tickets');
  check(
    'a paper is named <Kind> <Number> R<n> - <Author> - <the document\'s Manila day>',
    paperFileName({ kind: 'Quotation', number: '0062602018', revision: 0, author: 'Carter Gasiong', date: new Date('2026-10-07T17:30:00Z') }) ===
      'Quotation 0062602018 R0 - Carter Gasiong - 2026-10-08.pdf' &&
      paperFileName({ kind: 'Sales Order', number: '4720', author: 'Carter Gasiong', date: '2026-05-30' }) ===
        'Sales Order 4720 - Carter Gasiong - 2026-05-30.pdf',
    paperFileName({ kind: 'Quotation', number: '0062602018', revision: 0, author: 'Carter Gasiong', date: new Date('2026-10-07T17:30:00Z') }),
  );
  const oddName = paperFileName({ kind: 'Purchase Order', number: 'PO/2026:01*', author: 'A  "B"  <C>|D', date: null });
  check(
    'a character a file system refuses becomes "-", spaces run as one, and a missing part drops out',
    oddName === 'Purchase Order PO-2026-01- - A -B- -C--D.pdf' &&
      paperFileName({ kind: 'Lead', number: 'GT-LD-1', author: null, date: undefined }) === 'Lead GT-LD-1.pdf',
    oddName,
  );
  const longName = paperFileName({ kind: 'Quotation', number: 'X'.repeat(300), author: 'Someone', date: '2026-01-01' });
  check('a name is kept under 150 characters before its extension', longName.length <= 154 && longName.endsWith('.pdf'), String(longName.length));
  check(
    "a list's old file name becomes its kind; a name outside ASCII travels whole in filename*",
    kindOfFile('sales-forecast.pdf') === 'Sales Forecast' &&
      contentDisposition('Lead 1 - Peñalosa.pdf') === `inline; filename="Lead 1 - Pe_alosa.pdf"; filename*=UTF-8''Lead%201%20-%20Pe%C3%B1alosa.pdf`,
    contentDisposition('Lead 1 - Peñalosa.pdf'),
  );
  check(
    'a ticket names an API path only, in one spelling, with any ticket parameter taken out',
    ticketPath('/api/quotations/1/revisions/2/pdf?option=x&ticket=abc') === '/api/quotations/1/revisions/2/pdf?option=x' &&
      ticketPath('/api/a/pdf?q=x%20y') === ticketPath('/api/a/pdf?q=x+y') &&
      ticketPath('https://evil.example/api/a/pdf') === null && ticketPath('//evil.example/api/a') === null && ticketPath('/g-ops/x') === null,
  );
  {
    const t0 = 1_800_000_000_000;
    const paper = '/api/quotations/q1/revisions/r1/pdf';
    const t = issueTicket('user1', paper, t0);
    const other = redeemTicket(t, '/api/quotations/q2/revisions/r1/pdf', t0 + 1000);
    const forgedUser = redeemTicket(t.replace('.user1.', '.user2.'), paper, t0 + 1000);
    const late = redeemTicket(issueTicket('user1', paper, t0), paper, t0 + TICKET_TTL_MS + 1);
    const first = redeemTicket(t, paper, t0 + 1000);
    const viewer = redeemTicket(t, paper, t0 + 1000 + TICKET_REUSE_MS);
    const again = redeemTicket(t, paper, t0 + 1001 + TICKET_REUSE_MS);
    const muchLater = redeemTicket(t, paper, t0 + 1000 + TICKET_TTL_MS + TICKET_REUSE_MS - 1);
    check(
      'a ticket opens its own path for its own person within two minutes, and again for a minute after (a viewer extension) — another path, another person, late or after that minute are refused',
      'userId' in first && first.userId === 'user1' &&
        'userId' in viewer && viewer.userId === 'user1' &&
        'refused' in other && other.refused === 'forged' &&
        'refused' in forgedUser && forgedUser.refused === 'forged' &&
        'refused' in late && late.refused === 'expired' &&
        'refused' in again && again.refused === 'used' &&
        'refused' in muchLater && muchLater.refused === 'used' &&
        'refused' in (redeemTicket('garbage', paper, t0) as object),
      JSON.stringify({ first, viewer, other, forgedUser, late, again, muchLater }),
    );
  }

  // ── Attachments printed behind a document (2026-10-12) ────────────────────
  console.log('\nAttachments on paper');
  const bigImage = fitImage(4000, 3000);
  const smallImage = fitImage(200, 100);
  check(
    'an image is fitted inside the 36pt margins, never enlarged past its pixels, and centred',
    bigImage.width <= 595.28 - 72 + 1e-6 && bigImage.x >= 36 - 1e-6 && bigImage.y >= 36 && smallImage.width === 200 && smallImage.height === 100 &&
      Math.abs(smallImage.x - (595.28 - 200) / 2) < 1e-6,
    JSON.stringify({ bigImage, smallImage }),
  );
  check(
    'a file is printed by what it is: a PDF, an image, or only listed',
    attachmentKind({ fileName: 'PO.PDF', mimeType: 'application/octet-stream' }) === 'pdf' &&
      attachmentKind({ fileName: 'site.webp', mimeType: 'image/webp' }) === 'image' &&
      attachmentKind({ fileName: 'specs.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }) === 'other',
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
 * Where the first text run containing `needle` was drawn: x from the left
 * edge and y from the top of its page, at the baseline — PDFKit sets each run
 * with its own "1 0 0 1 x y Tm" just before the TJ that shows it.
 */
function textAt(pdf: Buffer, needle: string, nth = 0): { x: number; y: number } | null {
  let seen = 0;
  for (const body of contentStreams(pdf)) {
    let at: { x: number; y: number } | null = null;
    for (const t of body.matchAll(/1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm|\[([^\]]*)\]\s*TJ/g)) {
      if (t[1] !== undefined) {
        at = { x: Number(t[1]), y: Math.round((841.89 - Number(t[2])) * 100) / 100 };
        continue;
      }
      if (at && shown(t[3]).includes(needle) && seen++ === nth) return at;
    }
  }
  return null;
}

/**
 * Which page (from 1) first shows a text run containing `needle`: PDFKit
 * writes one content stream per page, in page order, and a stream that
 * inflates to text operators is a page's.
 */
function pageOf(pdf: Buffer, needle: string): number | null {
  let page = 0;
  for (const body of contentStreams(pdf)) {
    if (!/\]\s*TJ/.test(body)) continue;
    page++;
    for (const t of body.matchAll(/\[([^\]]*)\]\s*TJ/g)) if (shown(t[1]).includes(needle)) return page;
  }
  return null;
}

/**
 * The runs of a sign-off block that end past the next column's start. The
 * columns begin where the roles' first lines do — the runs set beside
 * `firstRole`, on its page and baseline, at its size — and the last ends at
 * `right`. Only runs from the roles' baseline down to `bottom` are the
 * block's.
 */
function signoffOverruns(runs: PdfRun[], firstRole: string, right: number, bottom: number): string[] {
  const first = runs.find((run) => run.text === firstRole);
  if (!first) return [`no "${firstRole}" on the page`];
  const { page, y: top } = first;
  const starts = runs
    .filter((r) => r.page === page && Math.abs(r.y - top) < 0.5 && r.size === first.size)
    .map((r) => r.x)
    .sort((a, b) => a - b);
  const bad: string[] = [];
  for (const run of runs) {
    if (run.page !== page || run.y < top - 0.5 || run.y >= bottom || run.x < starts[0] - 0.5 || run.x > right) continue;
    const col = starts.reduce((c, x, i) => (run.x >= x - 0.5 ? i : c), 0);
    const limit = col + 1 < starts.length ? starts[col + 1] : right;
    const ends = run.x + runWidth(run);
    if (ends > limit + 0.01) bad.push(`"${run.text}" ends at ${ends.toFixed(1)}, past ${limit.toFixed(1)}`);
  }
  return bad;
}

/**
 * Where the ink actually starts and stops on page 1, in points. The margin is
 * a stated requirement rather than an implementation detail, so it is
 * measured off the rendered page — reading it back off the constant would
 * pass even if the drawing code ignored it.
 */
function pdfEdges(pdf: Buffer): { left: number; bottom: number } {
  let left = Infinity;
  let lowest = 0;
  for (const body of contentStreams(pdf)) {
    // "1 0 0 1 <x> <y> Tm" — PDFKit's text-positioning matrix.
    for (const t of body.matchAll(/1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm/g)) {
      left = Math.min(left, Number(t[1]));
      lowest = Math.max(lowest, 841.89 - Number(t[2]));
    }
  }
  return { left: Math.round(left), bottom: Math.round(841.89 - lowest) };
}
