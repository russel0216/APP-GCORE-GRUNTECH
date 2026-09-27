/**
 * Numbering verification — the house quotation scheme and its admin screen.
 *
 *   npx tsx scripts/verify-numbering.ts      (the API must be running for the
 *                                             admin route cases; it says so
 *                                             loudly rather than skipping them)
 *
 * `0012609001` is employee 001's first quotation of September 2026: the
 * author's employee digits, the year, the month, a running number that is
 * counted PER EMPLOYEE and PER MONTH. Three things are easy to get wrong
 * quietly:
 *
 *   · Two authors, or two months, sharing one counter — the runs must be dense
 *     and separate, even when the authors save at the same moment.
 *   · The wrong employee number: the Employee record is the person, the
 *     cosmetic `User.employeeNo` is the fallback, and nobody borrows a run.
 *   · A per-employee counter configured without {EMP} — refused when it is
 *     saved in Admin › Numbering, and again if one ever reaches issue time.
 *
 * Everything runs on throwaway document types, so it does not depend on how a
 * given database's real quotation template happens to be configured.
 */

import bcrypt from 'bcryptjs';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { signToken } from '../src/auth/middleware';
import {
  nextNumber,
  previewNext,
  employeeToken,
  periodKeyFor,
  scopedPeriodKey,
} from '../src/shared/numbering';
import { issuedThisPeriod } from '../src/routes/admin';

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

const TAG = 'ZZNUM';
const BASE = `http://localhost:${env.port}/api`;
const HOUSE = { pattern: '{EMP}{YY}{MM}{SEQ}', padding: 3, period: 'MONTH', scope: 'OWNER' } as const;

// ── Fixtures ─────────────────────────────────────────────────────────────────

async function cleanup() {
  await prisma.numberSequence.deleteMany({ where: { documentType: { startsWith: TAG } } });
  await prisma.employee.deleteMany({ where: { lastName: { startsWith: TAG } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { startsWith: TAG } } });
  const users = await prisma.user.findMany({
    where: { email: { endsWith: '@verifynum.local' } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.role.deleteMany({ where: { key: { startsWith: 'zznum_' } } });
}

/** A role holding exactly the permissions named — never a seeded one. */
async function makeRole(key: string, name: string, permissionKeys: string[]) {
  const permissions = await prisma.permission.findMany({
    where: { key: { in: permissionKeys } },
    select: { id: true, key: true },
  });
  if (permissions.length !== permissionKeys.length) {
    const found = new Set(permissions.map((p) => p.key));
    throw new Error(`Unknown permission(s): ${permissionKeys.filter((k) => !found.has(k)).join(', ')}`);
  }
  return prisma.role.create({
    data: { key, name, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } },
  });
}

async function makeUser(name: string, email: string, roleIds: string[], employeeNo?: string) {
  return prisma.user.create({
    data: {
      name,
      email,
      employeeNo: employeeNo ?? null,
      passwordHash: await bcrypt.hash('x', 10),
      roles: { create: roleIds.map((roleId) => ({ roleId })) },
    },
  });
}

/** A throwaway document type carrying the given template. */
async function makeType(suffix: string, tpl: { pattern: string; padding?: number; period: string; scope: string }) {
  const documentType = `${TAG}_${suffix}`;
  await prisma.numberSequence.create({
    data: {
      documentType,
      label: `Verify — ${suffix}`,
      pattern: tpl.pattern,
      typeCode: 'VN',
      period: tpl.period as 'YEAR' | 'MONTH' | 'NONE',
      scope: tpl.scope as 'GLOBAL' | 'OWNER',
      padding: tpl.padding ?? 3,
    },
  });
  return documentType;
}

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

async function api(token: string, method: string, path: string, body?: unknown): Promise<HttpResult> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

async function apiReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

const issueOf = (details: unknown): string =>
  Array.isArray(details) ? details.map((d) => String((d as { message?: string }).message ?? '')).join(' | ') : '';

// ── The run ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nG-CORE numbering verification\n');
  await cleanup();

  const sept = new Date(2026, 8, 17, 9, 13);
  const oct = new Date(2026, 9, 1, 8, 0);

  // Three logins: one linked to an employee (and carrying a DIFFERENT cosmetic
  // User.employeeNo, to prove which one wins), one with only the cosmetic
  // number, one with nothing at all.
  const viewRole = await makeRole('zznum_viewer', `${TAG} Viewer`, ['admin.numbering.view_all']);
  const editRole = await makeRole('zznum_editor', `${TAG} Editor`, [
    'admin.numbering.view_all',
    'admin.numbering.edit_all',
  ]);
  const linked = await makeUser('ZZ Linked', 'linked@verifynum.local', [editRole.id], `${TAG}-U-0099`);
  const cosmetic = await makeUser('ZZ Cosmetic', 'cosmetic@verifynum.local', [], `${TAG}-U-0002`);
  const unlinked = await makeUser('ZZ Unlinked', 'unlinked@verifynum.local', [viewRole.id]);
  await prisma.employee.create({
    data: {
      employeeNo: `${TAG}-EMP-0001`,
      firstName: 'Verify',
      lastName: `${TAG} Linked`,
      userId: linked.id,
    },
  });

  // ══ The token chain ═══════════════════════════════════════════════════════
  console.log('The {EMP} token');

  check(
    '{EMP} is the last run of digits padded to three',
    employeeToken('GT-EMP-2026-0007') === '007' && employeeToken('12') === '012',
    `${employeeToken('GT-EMP-2026-0007')} ${employeeToken('12')}`,
  );
  check('a number wider than three digits is kept whole', employeeToken('1234') === '1234', employeeToken('1234'));
  check(
    'no digits, null and undefined are all 000',
    employeeToken(null) === '000' && employeeToken(undefined) === '000' && employeeToken('ADMIN') === '000',
  );
  check('a monthly period key is year-month', periodKeyFor('MONTH', sept) === '2026-09', periodKeyFor('MONTH', sept));
  check(
    'and carries the author for a per-employee counter',
    scopedPeriodKey('MONTH', 'OWNER', sept, '001') === '2026-09@001',
    scopedPeriodKey('MONTH', 'OWNER', sept, '001'),
  );

  // ══ The house scheme ══════════════════════════════════════════════════════
  console.log('\nThe house quotation scheme');

  const qt = await makeType('qt', HOUSE);

  // 1. Format.
  const first = await nextNumber(qt, prisma, { ownerId: linked.id, at: sept });
  check('employee 001’s first quotation of Sep 2026 is 0012609001', first === '0012609001', first);

  // 2. Employee beats User.employeeNo — the login above carries ...0099 on the
  //    User row and ...0001 on the Employee, and the number said 001.
  check('the Employee record’s number wins over the cosmetic User.employeeNo', first.startsWith('001'));
  const viaCosmetic = await nextNumber(qt, prisma, { ownerId: cosmetic.id, at: sept });
  check('a login with only User.employeeNo falls back to it', viaCosmetic === '0022609001', viaCosmetic);

  // 3. Per employee: the second author's run did not continue the first's.
  const second = await nextNumber(qt, prisma, { ownerId: linked.id, at: sept });
  check('the same author continues their own run', second === '0012609002', second);
  check('and a colleague’s run started at 001, not 003', viaCosmetic.endsWith('001'));

  // 4. Per month.
  const nextMonth = await nextNumber(qt, prisma, { ownerId: linked.id, at: oct });
  check('October restarts the author’s run', nextMonth === '0012610001', nextMonth);
  const backInSept = await nextNumber(qt, prisma, { ownerId: linked.id, at: sept });
  check('while September’s counter carries on where it was', backInSept === '0012609003', backInSept);

  // 5. Unlinked → 000, visibly, rather than borrowing anyone's run.
  const nobody = await nextNumber(qt, prisma, { ownerId: unlinked.id, at: sept });
  check('a login with no employee record numbers under 000', nobody === '0002609001', nobody);

  // 6. The counter row is keyed by month and author.
  const row = await prisma.numberSequence.findUnique({
    where: { documentType_periodKey: { documentType: qt, periodKey: '2026-09@001' } },
  });
  check('the counter row is keyed 2026-09@001', row !== null && row.lastNumber === 3, `${row?.lastNumber}`);
  const template = await prisma.numberSequence.findFirst({ where: { documentType: qt, periodKey: '' } });
  check('the template row itself was never incremented', template?.lastNumber === 0, `${template?.lastNumber}`);

  // 7. Concurrency in a fresh month: dense 001..025, nothing skipped, nothing
  //    repeated. Same author, same instant, 25 transactions.
  const nov = new Date(2026, 10, 3);
  const burst = await Promise.all(
    Array.from({ length: 25 }, () => nextNumber(qt, prisma, { employeeNo: `${TAG}-EMP-0001`, at: nov })),
  );
  const seqs = burst.map((n) => Number(n.slice(-3))).sort((a, b) => a - b);
  check(
    '25 concurrent creates in a fresh month are dense 001..025',
    seqs.length === 25 && seqs.every((n, i) => n === i + 1),
    seqs.join(','),
  );
  check(
    'and all render under the author’s digits',
    burst.every((n) => n.startsWith('0012611')),
    burst.find((n) => !n.startsWith('0012611')),
  );

  // 8. Two owners interleaved, each dense.
  const dec = new Date(2026, 11, 3);
  const mixed = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      nextNumber(qt, prisma, { employeeNo: i % 2 === 0 ? 'GT-EMP-0005' : 'GT-EMP-0006', at: dec }),
    ),
  );
  const runOf = (emp: string) =>
    mixed
      .filter((n) => n.startsWith(emp))
      .map((n) => Number(n.slice(-3)))
      .sort((a, b) => a - b);
  const five = runOf('005');
  const six = runOf('006');
  check(
    'two authors saving at once each get a dense run of their own',
    five.length === 10 && six.length === 10 && five.every((n, i) => n === i + 1) && six.every((n, i) => n === i + 1),
    `005: ${five.join(',')} · 006: ${six.join(',')}`,
  );

  // 9. OWNER without {EMP} is refused at issue time — the backstop behind the
  //    admin screen's own refusal, checked over HTTP below.
  const blind = await makeType('blind', { pattern: '{PREFIX}-{TYPE}-{SEQ}', period: 'NONE', scope: 'OWNER' });
  await expectRejection(
    'a per-employee counter without {EMP} is refused before anything is written',
    () => nextNumber(blind, prisma, { employeeNo: '7' }),
    'needs {EMP}',
  );
  check(
    'and left only its template row behind',
    (await prisma.numberSequence.count({ where: { documentType: blind } })) === 1,
  );

  // 10. The preview says what is then issued, for the same author.
  const peek = await previewNext(qt, { ownerId: linked.id, at: sept });
  const issued = await nextNumber(qt, prisma, { ownerId: linked.id, at: sept });
  check('previewNext equals the number nextNumber then issues', peek.number === issued, `${peek.number} vs ${issued}`);
  check('the preview knows the author is linked', peek.linked && peek.employeeNo === `${TAG}-EMP-0001`);
  const peekNobody = await previewNext(qt, { ownerId: unlinked.id, at: sept });
  check(
    'and says so when they are not',
    !peekNobody.linked && peekNobody.employeeNo === null && peekNobody.number.startsWith('000'),
    peekNobody.number,
  );

  // A flat per-employee counter: no period at all, still one run per author.
  const flat = await makeType('flat', { pattern: '{EMP}-{SEQ}', period: 'NONE', scope: 'OWNER' });
  const flat1 = await nextNumber(flat, prisma, { employeeNo: '3' });
  const flat2 = await nextNumber(flat, prisma, { employeeNo: '4' });
  const flat3 = await nextNumber(flat, prisma, { employeeNo: '3' });
  check('a NONE + per-employee counter still runs per author', flat1 === '003-001' && flat2 === '004-001' && flat3 === '003-002', [flat1, flat2, flat3].join(' '));

  // ══ "Issued this period" ═════════════════════════════════════════════════
  console.log('\nIssued this period');

  const counters = await prisma.numberSequence.findMany({
    where: { documentType: { startsWith: TAG } },
    select: { documentType: true, periodKey: true, lastNumber: true },
  });
  check(
    'a per-employee monthly count sums every author’s run for the month',
    issuedThisPeriod(counters, qt, '2026-09') === 4 + 1 + 1, // 001 ×4, 002 ×1, 000 ×1
    String(issuedThisPeriod(counters, qt, '2026-09')),
  );
  check('and leaves other months out', issuedThisPeriod(counters, qt, '2026-10') === 1);
  check(
    'a flat per-employee counter sums its authors off the empty key',
    issuedThisPeriod(counters, flat, '') === 3,
    String(issuedThisPeriod(counters, flat, '')),
  );
  check('a type with nothing issued reports zero', issuedThisPeriod(counters, blind, '') === 0);
  check(
    'a company-wide yearly key does not pick up a month key that shares its prefix',
    issuedThisPeriod([{ documentType: 'x', periodKey: '2026-09', lastNumber: 9 }], 'x', '2026') === 0,
  );

  // ══ Admin › Numbering over HTTP ══════════════════════════════════════════
  console.log('\nAdmin › Numbering');

  if (!(await apiReachable())) {
    failed += 1;
    console.log(
      `  ✗ the API is not reachable at ${BASE} — the admin route guards were NOT verified.\n` +
        '      Start it with "npm run dev" in api/ and run this script again.',
    );
  } else {
    const editor = signToken(linked.id, linked.email);
    const viewer = signToken(unlinked.id, unlinked.email);

    const list = await api(editor, 'GET', '/numbering');
    const rows = (list.body.rows ?? []) as Array<Record<string, unknown>>;
    check('an administrator can read the numbering table', list.status === 200 && rows.length > 0, `${list.status}`);
    check('every row carries its scope', rows.every((r) => r.scope === 'GLOBAL' || r.scope === 'OWNER'));
    const previewFor = list.body.previewFor as { employeeNo: string | null; linked: boolean } | undefined;
    check(
      'the samples say whose employee number they carry',
      previewFor?.linked === true && previewFor.employeeNo === `${TAG}-EMP-0001`,
      JSON.stringify(previewFor),
    );

    // The screen's "Issued this period" must agree with the counter rows.
    const all = await prisma.numberSequence.findMany({
      select: { documentType: true, periodKey: true, lastNumber: true, period: true },
    });
    const disagreements = rows.filter((r) => {
      const tpl = all.find((s) => s.documentType === r.documentType && s.periodKey === '');
      if (!tpl) return true;
      return r.lastNumber !== issuedThisPeriod(all, String(r.documentType), periodKeyFor(tpl.period, new Date()));
    });
    check(
      'every row’s issued-this-period equals the sum of its current counters',
      disagreements.length === 0,
      disagreements.map((r) => `${r.documentType}: ${r.lastNumber}`).join(', '),
    );
    const poRow = rows.find((r) => r.documentType === 'purchase_order');
    check(
      'a company-wide yearly type still previews on the stock pattern',
      typeof poRow?.preview === 'string' && /^[A-Z0-9]+-PO-\d{4}-\d{4}$/.test(poRow.preview),
      String(poRow?.preview),
    );

    const viewerList = await api(viewer, 'GET', '/numbering');
    check('a viewer without a linked employee sees 000 in the samples', viewerList.status === 200 && (viewerList.body.previewFor as { linked: boolean }).linked === false);

    // Saving: the three collision rules, then a valid save.
    const ownerBlind = await api(editor, 'PUT', `/numbering/${qt}`, {
      pattern: '{YY}{MM}{SEQ}',
      typeCode: 'VN',
      padding: 3,
      period: 'MONTH',
      scope: 'OWNER',
    });
    check(
      'per employee without {EMP} is refused with the reason',
      ownerBlind.status === 400 && issueOf(ownerBlind.body.details).includes('needs {EMP}'),
      `${ownerBlind.status} ${issueOf(ownerBlind.body.details)}`,
    );
    const monthBlind = await api(editor, 'PUT', `/numbering/${qt}`, {
      pattern: '{EMP}{YY}{SEQ}',
      typeCode: 'VN',
      padding: 3,
      period: 'MONTH',
      scope: 'OWNER',
    });
    check(
      'monthly without {MM} is refused',
      monthBlind.status === 400 && issueOf(monthBlind.body.details).includes('needs {MM}'),
      `${monthBlind.status} ${issueOf(monthBlind.body.details)}`,
    );
    const yearBlind = await api(editor, 'PUT', `/numbering/${qt}`, {
      pattern: '{PREFIX}-{TYPE}-{SEQ}',
      typeCode: 'VN',
      padding: 4,
      period: 'YEAR',
      scope: 'GLOBAL',
    });
    check(
      'yearly without a year token is refused',
      yearBlind.status === 400 && issueOf(yearBlind.body.details).includes('needs {YYYY}'),
      `${yearBlind.status} ${issueOf(yearBlind.body.details)}`,
    );
    const untouched = await prisma.numberSequence.findFirst({ where: { documentType: qt, periodKey: '' } });
    check('a refused save changed nothing', untouched?.pattern === HOUSE.pattern && untouched.scope === 'OWNER');

    const forbidden = await api(viewer, 'PUT', `/numbering/${qt}`, {
      pattern: '{EMP}{YY}{MM}{SEQ}',
      typeCode: 'VN',
      padding: 3,
      period: 'MONTH',
      scope: 'OWNER',
    });
    check('view-only cannot save', forbidden.status === 403, `${forbidden.status}`);

    const saved = await api(editor, 'PUT', `/numbering/${qt}`, {
      pattern: '{PREFIX}-{TYPE}-{YYYY}-{SEQ}',
      typeCode: 'VN',
      padding: 4,
      period: 'YEAR',
      scope: 'GLOBAL',
    });
    check('a valid save is accepted', saved.status === 200, `${saved.status} ${JSON.stringify(saved.body)}`);
    const after = await prisma.numberSequence.findMany({ where: { documentType: qt } });
    check(
      'and reaches every row of the type, template and counters alike',
      after.length > 1 && after.every((r) => r.period === 'YEAR' && r.scope === 'GLOBAL' && r.padding === 4),
    );
    check(
      'the old per-employee counters are kept as history, not deleted',
      after.some((r) => r.periodKey === '2026-09@001' && r.lastNumber === 4),
    );
    const audited = await prisma.auditLog.findFirst({
      where: { entityType: 'number_sequence', entityId: qt, actorId: linked.id },
      orderBy: { at: 'desc' },
    });
    check('the save was audited', audited !== null && audited.summary.includes('YEAR, GLOBAL'), audited?.summary);

    // Default scope: a caller that never learned about scope still saves.
    const legacy = await api(editor, 'PUT', `/numbering/${flat}`, {
      pattern: '{PREFIX}-{SEQ}',
      typeCode: 'VN',
      padding: 3,
      period: 'NONE',
    });
    const legacyRow = await prisma.numberSequence.findFirst({ where: { documentType: flat, periodKey: '' } });
    check('scope defaults to company-wide when omitted', legacy.status === 200 && legacyRow?.scope === 'GLOBAL', `${legacy.status}`);

    const unknown = await api(editor, 'PUT', `/numbering/${TAG}_nothing`, {
      pattern: '{PREFIX}-{SEQ}',
      typeCode: 'VN',
      padding: 3,
      period: 'NONE',
    });
    check('an unknown document type is a 404', unknown.status === 404, `${unknown.status}`);
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
