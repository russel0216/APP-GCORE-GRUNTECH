/**
 * Hire-to-separate verification, part one — the plantilla and the clearance.
 *
 *   npx tsx scripts/verify-plantilla.ts      (the API must be running)
 *
 * What is easy to get wrong here, and expensive to get wrong quietly:
 *
 *   · Filled and vacant are COUNTED off active employees. A stored figure, or
 *     one that counts leavers, makes the plantilla lie the day someone goes.
 *   · `Employee.position` is a mirror of the plantilla title with ONE writer.
 *     A rename that misses a holder splits a position in every search.
 *   · An import dry run must not write. `build` runs on every dry run, so a
 *     Position created there would appear — and burn a POS number — for a
 *     file the user then abandoned.
 *   · A clearance item that points at a record takes its status from that
 *     record. Nobody may tick "tools returned" while the slip says OUT.
 *   · The leaver never signs their own clearance; approval — and only
 *     approval — records the separation; the login closes only behind an
 *     approved clearance.
 *   · Turnover is arithmetic over the employee dates, and it has to be the
 *     right arithmetic.
 *
 * The route guards and the approval chain are exercised over HTTP, because
 * that is where they live; the arithmetic and the sweep are called directly.
 */

import bcrypt from 'bcryptjs';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { signToken } from '../src/auth/middleware';
import { dayKey } from '../src/shared/hr';
import { runImport } from '../src/shared/csv';
import { employeesImport } from '../src/routes/imports/employees';
import { plantillaSummary } from '../src/shared/plantilla';
import { hrSignsOwnWork, sweepSeparations, turnover, tenureMonths } from '../src/shared/clearance';

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

const TAG = 'ZZPL';
const MAIL = '@verifypl.local';
const BASE = `http://localhost:${env.port}/api`;

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const addDays = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));
const iso = (d: Date) => d.toISOString().slice(0, 10);
const sameDay = (a: Date | string | null | undefined, b: Date) => !!a && iso(new Date(a)) === iso(b);

// ── Fixtures ─────────────────────────────────────────────────────────────────

async function cleanup() {
  const employees = await prisma.employee.findMany({
    where: { OR: [{ employeeNo: { startsWith: TAG } }, { lastName: { startsWith: TAG } }] },
    select: { id: true },
  });
  const employeeIds = employees.map((e) => e.id);

  const clearances = await prisma.employeeClearance.findMany({
    where: { OR: [{ employeeId: { in: employeeIds } }, { number: { startsWith: TAG } }] },
    select: { id: true },
  });
  const clearanceIds = clearances.map((c) => c.id);
  if (clearanceIds.length) {
    const requests = await prisma.approvalRequest.findMany({
      where: { documentType: 'clearance', documentId: { in: clearanceIds } },
      select: { id: true },
    });
    await prisma.approvalAction.deleteMany({ where: { requestId: { in: requests.map((r) => r.id) } } });
    await prisma.approvalRequest.deleteMany({ where: { id: { in: requests.map((r) => r.id) } } });
    await prisma.notification.deleteMany({
      where: { link: { in: clearanceIds.map((id) => `/g-hr/clearances/${id}`) } },
    });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: clearanceIds } } });
    await prisma.employeeClearance.deleteMany({ where: { id: { in: clearanceIds } } });
  }

  await prisma.borrowSlip.deleteMany({ where: { purpose: { startsWith: TAG } } });
  // The sweep tells real administrators to close a fixture's login.
  await prisma.notification.deleteMany({ where: { title: { contains: TAG } } });

  if (employeeIds.length) {
    await prisma.auditLog.deleteMany({ where: { entityType: 'employee', entityId: { in: employeeIds } } });
    await prisma.leaveBalance.deleteMany({ where: { employeeId: { in: employeeIds } } });
    await prisma.employee.deleteMany({ where: { id: { in: employeeIds } } });
  }

  const positions = await prisma.position.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } });
  if (positions.length) {
    await prisma.auditLog.deleteMany({ where: { entityType: 'position', entityId: { in: positions.map((p) => p.id) } } });
    await prisma.position.deleteMany({ where: { id: { in: positions.map((p) => p.id) } } });
  }
  await prisma.department.deleteMany({ where: { code: { startsWith: TAG } } });

  const users = await prisma.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.approvalAction.deleteMany({ where: { approverId: { in: ids } } });
    await prisma.approvalRequest.deleteMany({ where: { requesterId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { entityId: { in: ids } }] } });
    await prisma.user.updateMany({ where: { supervisorId: { in: ids } }, data: { supervisorId: null } });
    await prisma.userRole.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.role.deleteMany({ where: { key: { startsWith: 'zzpl_' } } });
}

async function makeRole(key: string, permissionKeys: string[]) {
  const permissions = await prisma.permission.findMany({ where: { key: { in: permissionKeys } } });
  if (permissions.length !== permissionKeys.length) {
    const found = new Set(permissions.map((p) => p.key));
    throw new Error(`Unknown permission(s): ${permissionKeys.filter((k) => !found.has(k)).join(', ')}`);
  }
  return prisma.role.create({
    data: { key, name: key, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } },
  });
}

/** A user in the named roles — seeded ones (hr, finance, warehouse) or this script's own. */
async function makeUser(name: string, local: string, roleKeys: string[], supervisorId?: string) {
  const roles = await prisma.role.findMany({ where: { key: { in: roleKeys } } });
  if (roles.length !== roleKeys.length) throw new Error(`Missing role(s) among ${roleKeys.join(', ')} — run the seed first`);
  return prisma.user.create({
    data: {
      name,
      email: `${local}${MAIL}`,
      passwordHash: await bcrypt.hash('x', 10),
      supervisorId: supervisorId ?? null,
      roles: { create: roles.map((r) => ({ roleId: r.id })) },
    },
  });
}

interface HttpResult {
  status: number;
  body: Record<string, unknown> & { message?: string; error?: string };
  text: string;
  headers: Headers;
}

/**
 * `fetch`, riding out a dev-server reload. `tsx watch` restarts the API on
 * any saved file, and a refused connection mid-run is that, not a verdict.
 * Only GETs are retried: a write that reset may have landed.
 */
async function fetchApi(url: string, init: RequestInit = {}): Promise<Response> {
  const retry = !init.method || init.method === 'GET';
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      // A refused connection never reached the server, so even a write is safe to repeat.
      const refused = String((err as Error)?.cause ?? err).includes('ECONNREFUSED');
      if (attempt >= 40 || (!retry && !refused)) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function http(token: string, method: string, path: string, body?: unknown): Promise<HttpResult> {
  const res = await fetchApi(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : {};
  } catch {
    parsed = {};
  }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

const msg = (r: HttpResult) => String(r.body.message ?? r.body.error ?? r.text).slice(0, 200);

async function apiReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitFor<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 4000): Promise<T> {
  const until = Date.now() + ms;
  let v = await read();
  while (!ok(v) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 100));
    v = await read();
  }
  return v;
}

interface Item {
  id: string;
  area: string;
  description: string;
  sourceType: string | null;
  status: string;
  clearedAt: string | null;
  clearedBy: { id: string; name: string } | null;
  remarks: string | null;
}

// ── The run ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nG-CORE plantilla & clearance verification\n');

  if (!(await apiReachable())) {
    console.error(
      `  ✗ The API is not answering on ${BASE}. This script checks route guards and the approval\n` +
        '    chain over HTTP and will not pretend they passed. Start it with `npm run dev` and re-run.\n',
    );
    process.exitCode = 1;
    return;
  }

  await cleanup();

  // ══ Fixtures ═════════════════════════════════════════════════════════════
  await makeRole('zzpl_plain', ['ghr.clearances.view_own']);
  await makeRole('zzpl_leaver', ['ghr.clearances.view_own', 'ghr.clearances.create']);

  const hr = await makeUser(`${TAG} HR Officer`, 'hr', ['hr']);
  const hr2 = await makeUser(`${TAG} HR Second`, 'hr2', ['hr']);
  const finance = await makeUser(`${TAG} Finance`, 'fin', ['finance']);
  const warehouse = await makeUser(`${TAG} Warehouse`, 'wh', ['warehouse']);
  const supervisor = await makeUser(`${TAG} Supervisor`, 'sup', []);
  const plain = await makeUser(`${TAG} Plain`, 'plain', ['zzpl_plain']);
  const leaverUser = await makeUser(`${TAG} Leaver One`, 'leaver1', ['zzpl_leaver'], supervisor.id);
  const leaver2User = await makeUser(`${TAG} Leaver Two`, 'leaver2', ['zzpl_leaver'], supervisor.id);

  const tok = (u: { id: string; email: string }) => signToken(u.id, u.email);
  const T = {
    hr: tok(hr),
    hr2: tok(hr2),
    finance: tok(finance),
    warehouse: tok(warehouse),
    supervisor: tok(supervisor),
    plain: tok(plain),
    leaver: tok(leaverUser),
  };

  const dept = await prisma.department.create({ data: { code: `${TAG}-D`, name: `${TAG} Engineering` } });

  // ══ 1. Filled and vacant are counted ═════════════════════════════════════
  console.log('Plantilla — filled and vacant are counted, never stored');

  const baseline = await plantillaSummary();
  const created = await http(T.hr, 'POST', '/positions', {
    title: `${TAG} Site Engineer`,
    departmentId: dept.id,
    authorisedHeadcount: 2,
  });
  check('HR adds a position', created.status === 201, `${created.status} ${msg(created)}`);
  const pos = created.body as { id: string; code: string; title: string };
  check('its code comes from the POS sequence', /POS-\d{4}-\d{4}$/.test(pos.code ?? ''), pos.code);

  const dupe = await http(T.hr, 'POST', '/positions', { title: `${TAG} site engineer`, departmentId: dept.id });
  check('the same title twice in one department is refused', dupe.status === 409, `${dupe.status}`);

  const mk = (n: string, first: string, active = true, extra: Record<string, unknown> = {}) =>
    prisma.employee.create({
      data: {
        employeeNo: `${TAG}-${n}`,
        firstName: first,
        lastName: `${TAG}Holder`,
        positionId: pos.id,
        position: pos.title,
        departmentId: dept.id,
        isActive: active,
        ...extra,
      },
    });
  const h1 = await mk('P1', 'Ada');
  const h2 = await mk('P2', 'Ben');
  await mk('P3', 'Cid', false);

  const row = async () => {
    const r = await http(T.hr, 'GET', `/positions?search=${encodeURIComponent(pos.code)}`);
    return (r.body.rows as { id: string; filled: number; vacant: number; holders: unknown[] }[]).find((x) => x.id === pos.id)!;
  };
  let r1 = await row();
  check('two active holders and one inactive → filled 2, vacant 0', r1.filled === 2 && r1.vacant === 0, JSON.stringify(r1 && { f: r1.filled, v: r1.vacant }));

  await prisma.employee.update({ where: { id: h2.id }, data: { isActive: false } });
  r1 = await row();
  check('a holder leaves → vacant 1, the moment it happens', r1.filled === 1 && r1.vacant === 1, `${r1.filled}/${r1.vacant}`);
  await prisma.employee.update({ where: { id: h2.id }, data: { isActive: true } });

  const shrink = await http(T.hr, 'PATCH', `/positions/${pos.id}`, { authorisedHeadcount: 1 });
  r1 = await row();
  const afterShrink = await plantillaSummary();
  check('authorised cut to 1 with 2 holders → vacant −1 (over-complement is shown, not refused)', shrink.status === 200 && r1.vacant === -1);
  check(
    'the summary counts that one person over',
    afterShrink.overComplement - baseline.overComplement === 1,
    `${baseline.overComplement} → ${afterShrink.overComplement}`,
  );
  const sumRes = await http(T.hr, 'GET', '/positions/summary');
  check(
    'GET /positions/summary is the same figure the helper computes',
    sumRes.status === 200 && sumRes.body.filled === afterShrink.filled && sumRes.body.overComplement === afterShrink.overComplement,
  );

  const vacantOnly = await http(T.hr, 'GET', `/positions?over=true&search=${encodeURIComponent(pos.code)}`);
  check('the over-complement filter finds it', (vacantOnly.body.rows as { id: string }[]).some((x) => x.id === pos.id));

  const plainPos = await http(T.plain, 'GET', '/positions');
  check('someone without the plantilla right cannot read it', plainPos.status === 403, `${plainPos.status}`);

  // ══ 2. A position with history is deactivated, not deleted ═══════════════
  console.log('\nPlantilla — history keeps its counterpart');
  const del = await http(T.hr, 'DELETE', `/positions/${pos.id}`);
  check('deleting a position someone holds → 409', del.status === 409 && /deactivate/i.test(msg(del)), `${del.status} ${msg(del)}`);
  const off = await http(T.hr, 'PATCH', `/positions/${pos.id}`, { isActive: false });
  check('deactivating it instead is allowed', off.status === 200 && off.body.isActive === false);
  await http(T.hr, 'PATCH', `/positions/${pos.id}`, { isActive: true, authorisedHeadcount: 3 });

  // ══ 3. The mirror ════════════════════════════════════════════════════════
  console.log('\nPlantilla — the title mirror has one writer');
  const renamed = `${TAG} Field Engineer`;
  await http(T.hr, 'PATCH', `/positions/${pos.id}`, { title: renamed });
  const mirrored = await prisma.employee.findMany({ where: { positionId: pos.id }, select: { position: true } });
  check(
    'a rename reaches every holder, active or not',
    mirrored.length === 3 && mirrored.every((e) => e.position === renamed),
    mirrored.map((e) => e.position).join(', '),
  );

  // ══ 4. Employee create/patch go through the one writer ═══════════════════
  console.log('\nEmployees — a position chosen from the plantilla');
  const beforeUnclassified = (await plantillaSummary()).unclassified;
  const free = await http(T.hr, 'POST', '/employees', {
    employeeNo: `${TAG}-E1`,
    firstName: 'Eve',
    lastName: `${TAG}Free`,
    position: 'Some Title Nobody Authorised',
  });
  check('an employee with a free-text title is created unclassified', free.status === 201 && free.body.positionId === null, msg(free));
  check('…and the unclassified count rises by one', (await plantillaSummary()).unclassified === beforeUnclassified + 1);

  const none = await http(T.hr, 'GET', `/employees?positionId=none&search=${TAG}Free`);
  check('?positionId=none lists them', (none.body.rows as { id: string }[]).some((e) => e.id === free.body.id));

  const linked = await http(T.hr, 'PATCH', `/employees/${free.body.id}`, { positionId: pos.id, position: 'ignored text' });
  check(
    'giving them a position writes its title, whatever text was sent',
    linked.status === 200 && linked.body.position === renamed && linked.body.positionId === pos.id,
    `${linked.body.position}`,
  );
  check('…and the unclassified count falls back', (await plantillaSummary()).unclassified === beforeUnclassified);

  const viaCreate = await http(T.hr, 'POST', '/employees', {
    employeeNo: `${TAG}-E2`,
    firstName: 'Fay',
    lastName: `${TAG}Linked`,
    positionId: pos.id,
  });
  check('creating on a position stores the title', viaCreate.status === 201 && viaCreate.body.position === renamed, msg(viaCreate));
  const listed = await http(T.hr, 'GET', `/employees?positionId=${pos.id}&pageSize=50`);
  check(
    'the list carries positionRef and filters by positionId',
    (listed.body.rows as { id: string; positionRef: { title: string } | null }[]).some(
      (e) => e.id === viaCreate.body.id && e.positionRef?.title === renamed,
    ),
  );

  const dead = await prisma.position.create({
    data: { code: `${TAG}-POS-DEAD`, title: `${TAG} Retired Post`, isActive: false, authorisedHeadcount: 0 },
  });
  const ontoDead = await http(T.hr, 'PATCH', `/employees/${viaCreate.body.id}`, { positionId: dead.id });
  check('an inactive position cannot be given to anyone', ontoDead.status === 400, `${ontoDead.status}`);

  // ══ 5. Import: a dry run writes nothing ══════════════════════════════════
  console.log('\nImport — resolve in build, create in write');
  const posCount = await prisma.position.count();
  const seqBefore = await prisma.numberSequence.aggregate({ where: { documentType: 'position' }, _sum: { lastNumber: true } });
  const newTitle = `${TAG} Rigger`;
  const csv = [
    'Employee No,Last Name,First Name,Position,Department',
    `${TAG}-I1,${TAG}Imp,One,${newTitle},${dept.name}`,
    `${TAG}-I2,${TAG}Imp,Two,${renamed.toUpperCase()},${dept.name}`,
    `${TAG}-I3,${TAG}Imp,Three,${newTitle.toLowerCase()},`,
  ].join('\n');
  const dry = await runImport(csv, employeesImport.spec, false, employeesImport.write);
  const seqAfterDry = await prisma.numberSequence.aggregate({ where: { documentType: 'position' }, _sum: { lastNumber: true } });
  check('the dry run validates every row', dry.errors === 0 && dry.total === 3, JSON.stringify(dry.rows.filter((r) => r.action === 'error')));
  check('a dry run with a new title creates no position', (await prisma.position.count()) === posCount);
  check('…and burns no POS number', seqAfterDry._sum.lastNumber === seqBefore._sum.lastNumber);
  check('…and no employee', (await prisma.employee.count({ where: { employeeNo: { startsWith: `${TAG}-I` } } })) === 0);

  const real = await runImport(csv, employeesImport.spec, true, employeesImport.write);
  const made = await prisma.position.findMany({ where: { title: { equals: newTitle, mode: 'insensitive' } } });
  check('committing creates the unknown title once, with 0 authorised', real.committed && made.length === 1 && made[0].authorisedHeadcount === 0);
  const imported = await prisma.employee.findMany({
    where: { employeeNo: { startsWith: `${TAG}-I` } },
    include: { positionRef: true },
    orderBy: { employeeNo: 'asc' },
  });
  check(
    'rows naming the new title — in any case — share that one position',
    imported[0]?.positionId === made[0]?.id && imported[2]?.positionId === made[0]?.id,
  );
  check(
    'a row naming an existing title in capitals links to it, and carries its real spelling',
    imported[1]?.positionId === pos.id && imported[1]?.position === renamed,
    imported[1]?.position ?? 'missing',
  );

  // ══ 6. Clearance: raising builds the checklist from the records ═════════
  console.log('\nClearance — the checklist is read off the records');

  const leaver = await prisma.employee.create({
    data: {
      employeeNo: `${TAG}-L1`,
      firstName: 'Lars',
      lastName: `${TAG}Leaver`,
      userId: leaverUser.id,
      departmentId: dept.id,
      dateHired: utc(2023, 1, 9),
    },
  });
  const leaver2 = await prisma.employee.create({
    data: {
      employeeNo: `${TAG}-L2`,
      firstName: 'Lena',
      lastName: `${TAG}Leaver`,
      userId: leaver2User.id,
      departmentId: dept.id,
      dateHired: utc(2024, 5, 2),
    },
  });

  const wh = await prisma.warehouse.findFirst({ where: { isActive: true } });
  if (!wh) throw new Error('No warehouse — run the seed first');
  const slip = await prisma.borrowSlip.create({
    data: {
      number: `${TAG}-BS-1`,
      warehouseId: wh.id,
      borrowerId: leaverUser.id,
      borrowerName: `${leaver.firstName} ${leaver.lastName}`,
      issuedById: warehouse.id,
      dueAt: addDays(dayKey(new Date()), 7),
      purpose: `${TAG} site kit`,
    },
  });
  // Someone still reports to the leaver.
  const report = await makeUser(`${TAG} Report`, 'report', [], leaverUser.id);

  const yesterday = addDays(dayKey(new Date()), -1);
  const raised = await http(T.hr, 'POST', '/clearances', {
    employeeId: leaver.id,
    reason: 'RESIGNATION',
    lastWorkingDay: iso(yesterday),
    handedOverToId: supervisor.id,
  });
  check('HR raises a clearance for the leaver', raised.status === 201 && /CLR-\d{4}-\d{4}$/.test(String(raised.body.number)), `${raised.status} ${msg(raised)}`);
  const cid = String(raised.body.id);

  const detail = async (token = T.hr) => {
    const r = await http(token, 'GET', `/clearances/${cid}`);
    return r.body as unknown as { items: Item[]; readyToSubmit: boolean; status: string; canClear: Record<string, boolean> };
  };
  let d = await detail();
  const slipItem = d.items.find((i) => i.sourceType === 'borrow_slip');
  check('the open borrow slip is a WAREHOUSE item, PENDING', slipItem?.area === 'WAREHOUSE' && slipItem.status === 'PENDING');
  const reportsItem = d.items.find((i) => i.sourceType === 'reports');
  check(
    'someone reporting to the leaver is a SUPERVISOR item that says so',
    reportsItem?.status === 'PENDING' && /1 person reports/.test(reportsItem.description),
    reportsItem?.description,
  );
  check('the company-property checklist was copied in', d.items.some((i) => !i.sourceType && i.area === 'ADMIN'));

  const clearSlip = await http(T.warehouse, 'POST', `/clearances/${cid}/items/${slipItem!.id}/clear`, {});
  check(
    'a derived item cannot be ticked by hand — the refusal names the slip',
    clearSlip.status === 400 && msg(clearSlip).includes(slip.number),
    `${clearSlip.status} ${msg(clearSlip)}`,
  );
  const early = await http(T.hr, 'POST', `/clearances/${cid}/submit`);
  check('submitting with items pending is refused', early.status === 400 && /still pending/.test(msg(early)), msg(early));

  // ══ 8. One clearance at a time ═══════════════════════════════════════════
  const second = await http(T.hr, 'POST', '/clearances', { employeeId: leaver.id, reason: 'OTHER', lastWorkingDay: iso(yesterday) });
  check('a second open clearance for the same person → 409', second.status === 409, `${second.status}`);

  // ══ 11. Scope ════════════════════════════════════════════════════════════
  console.log('\nClearance — who sees what');
  const raised2 = await http(T.hr, 'POST', '/clearances', {
    employeeId: leaver2.id,
    reason: 'END_OF_CONTRACT',
    lastWorkingDay: iso(addDays(dayKey(new Date()), 7)),
  });
  const cid2 = String(raised2.body.id);
  const mine = await http(T.leaver, 'GET', '/clearances?scope=all');
  const mineRows = (mine.body.rows ?? []) as { id: string }[];
  check(
    'a view_own caller sees only their own, even asking for all',
    mine.status === 200 && mineRows.some((c) => c.id === cid) && !mineRows.some((c) => c.id === cid2),
    `${mine.status} ${mineRows.length}`,
  );
  const peek = await http(T.leaver, 'GET', `/clearances/${cid2}`);
  check("…and cannot open someone else's", peek.status === 403, `${peek.status}`);
  const forOther = await http(T.leaver, 'POST', '/clearances', { employeeId: leaver2.id, reason: 'OTHER', lastWorkingDay: iso(yesterday) });
  check('someone with only their own rights cannot raise one for a colleague', forOther.status === 403, `${forOther.status}`);
  const summaryPlain = await http(T.plain, 'GET', '/clearances/summary');
  check('company-wide turnover figures are not a view_own right', summaryPlain.status === 403, `${summaryPlain.status}`);

  // ══ 6. Waivers need a reason ═════════════════════════════════════════════
  console.log('\nClearance — clearing by the area that owns it');
  d = await detail();
  const manual = (area: string) => d.items.find((i) => !i.sourceType && i.area === area && i.status === 'PENDING');
  const toWaive = manual('ADMIN')!;
  const noReason = await http(T.hr, 'POST', `/clearances/${cid}/items/${toWaive.id}/waive`, {});
  check('waiving without a reason → 400', noReason.status === 400, `${noReason.status}`);
  const waived = await http(T.hr, 'POST', `/clearances/${cid}/items/${toWaive.id}/waive`, { reason: 'Laptop lost, charged to final pay' });
  check(
    'waiving with a written reason → WAIVED, and the reason is kept',
    waived.status === 200 && waived.body.status === 'WAIVED' && waived.body.remarks === 'Laptop lost, charged to final pay',
  );

  // ══ 9a. The right people clear the right items ═══════════════════════════
  const whItem = manual('WAREHOUSE');
  if (whItem) {
    const byPlain = await http(T.plain, 'POST', `/clearances/${cid}/items/${whItem.id}/clear`, {});
    check('a plain employee cannot clear a warehouse item', byPlain.status === 403, `${byPlain.status}`);
    const bySelf = await http(T.leaver, 'POST', `/clearances/${cid}/items/${whItem.id}/clear`, {});
    check('the leaver cannot clear their own items', bySelf.status === 403, `${bySelf.status}`);
    const bySup = await http(T.supervisor, 'POST', `/clearances/${cid}/items/${whItem.id}/clear`, {});
    check('the supervisor cannot clear a warehouse item', bySup.status === 403, `${bySup.status}`);
    const byWh = await http(T.warehouse, 'POST', `/clearances/${cid}/items/${whItem.id}/clear`, {});
    check('the warehouse clears a warehouse item', byWh.status === 200 && byWh.body.clearedById === warehouse.id, msg(byWh));
  } else {
    check('the seeded checklist has a WAREHOUSE line to test with', false, 'hr.clearanceChecklist has no WAREHOUSE row');
  }
  const supItem = manual('SUPERVISOR');
  if (supItem) {
    const bySupervisor = await http(T.supervisor, 'POST', `/clearances/${cid}/items/${supItem.id}/clear`, {});
    check("the leaver's supervisor clears a work-handover item", bySupervisor.status === 200, msg(bySupervisor));
  }
  const finItem = manual('FINANCE');
  if (finItem) {
    const byFin = await http(T.finance, 'POST', `/clearances/${cid}/items/${finItem.id}/clear`, {});
    check('finance clears a money item', byFin.status === 200, msg(byFin));
  }
  d = await detail();
  check(
    'the caller sees which areas they may clear',
    (await detail(T.warehouse)).canClear.WAREHOUSE === true && (await detail(T.warehouse)).canClear.ADMIN === false,
  );
  for (const i of d.items.filter((x) => x.status === 'PENDING' && !x.sourceType)) {
    await http(T.hr, 'POST', `/clearances/${cid}/items/${i.id}/clear`, {});
  }

  // ══ 5b / 7. Derived items settle in their own record ═════════════════════
  console.log('\nClearance — derived items follow their record');
  const returnedAt = yesterday;
  await prisma.borrowSlip.update({ where: { id: slip.id }, data: { status: 'RETURNED', returnedAt } });
  await prisma.user.update({ where: { id: report.id }, data: { supervisorId: supervisor.id } });
  d = await detail();
  const slipNow = d.items.find((i) => i.sourceType === 'borrow_slip')!;
  check(
    'the slip returned → its item is CLEARED, by nobody, on the day it came back',
    slipNow.status === 'CLEARED' && slipNow.clearedBy === null && sameDay(slipNow.clearedAt, returnedAt),
    `${slipNow.status} ${slipNow.clearedAt}`,
  );
  const reportsNow = d.items.find((i) => i.sourceType === 'reports')!;
  check('the reporting line moved → the reports item clears itself', reportsNow.status === 'CLEARED', reportsNow.status);
  check('with nothing pending the clearance is ready to submit', d.readyToSubmit === true, JSON.stringify(d.items.filter((i) => i.status === 'PENDING').map((i) => i.description)));

  // ══ 9b. The sign-off chain ═══════════════════════════════════════════════
  console.log('\nClearance — supervisor, finance, then HR; never the leaver');
  const submitted = await http(T.hr, 'POST', `/clearances/${cid}/submit`);
  check('HR submits it', submitted.status === 200, msg(submitted));
  const request = await prisma.approvalRequest.findFirst({ where: { documentType: 'clearance', documentId: cid, status: 'PENDING' } });
  check("the requester is the leaver's own login, so step 1 is their supervisor", request?.requesterId === leaverUser.id);
  const ownAudit = await prisma.auditLog.findFirst({
    where: { entityType: 'clearance', entityId: cid, action: 'SUBMITTED', actorId: hr.id },
  });
  check('the route records who actually pressed submit', ownAudit !== null);

  const act = (token: string, action = 'APPROVED') => http(token, 'POST', `/approvals/${request!.id}/act`, { action });
  const selfSign = await act(T.leaver);
  check('the leaver acting on their own clearance → 403', selfSign.status === 403, `${selfSign.status} ${msg(selfSign)}`);
  const stranger = await act(T.plain);
  check('a stranger acting on it → 403', stranger.status === 403, `${stranger.status}`);
  check('the supervisor signs step 1', (await act(T.supervisor)).status === 200);
  check('finance signs step 2', (await act(T.finance)).status === 200);
  const raiserSigns = await act(T.hr);
  check(
    'the HR raiser may sign step 3 while a second HR holder exists (they are not the requester)',
    raiserSigns.status === 200,
    msg(raiserSigns),
  );

  const settled = await waitFor(
    () => prisma.employeeClearance.findUnique({ where: { id: cid } }),
    (c) => c?.status === 'CLEARED',
  );
  check('approval clears the clearance', settled?.status === 'CLEARED', settled?.status);
  const gone = await prisma.employee.findUnique({ where: { id: leaver.id }, include: { user: true } });
  check('…records the separation on the last working day', sameDay(gone?.dateSeparated, yesterday), String(gone?.dateSeparated));
  check('…and, the day having passed, closes the employee and the login', gone?.isActive === false && gone.user?.isActive === false);

  const pdf = await fetchApi(`${BASE}/clearances/${cid}/pdf`, { headers: { Authorization: `Bearer ${T.hr}` } });
  const pdfBytes = Buffer.from(await pdf.arrayBuffer());
  check('the clearance prints', pdf.ok && pdfBytes.subarray(0, 4).toString() === '%PDF', `${pdf.status}`);

  // ══ 10. Rejection, then a future last day ════════════════════════════════
  console.log('\nClearance — rejected, fixed, resubmitted; a last day still ahead');
  d = (await http(T.hr, 'GET', `/clearances/${cid2}`)).body as unknown as typeof d;
  for (const i of d.items.filter((x) => x.status === 'PENDING')) {
    const r = await http(T.hr, 'POST', `/clearances/${cid2}/items/${i.id}/${i.sourceType ? 'waive' : 'clear'}`, {
      reason: 'Settled outside the system for this test',
    });
    if (r.status !== 200) check(`HR clears "${i.description}"`, false, msg(r));
  }
  await http(T.hr, 'POST', `/clearances/${cid2}/submit`);
  const req2 = await prisma.approvalRequest.findFirst({ where: { documentType: 'clearance', documentId: cid2, status: 'PENDING' } });
  await http(T.supervisor, 'POST', `/approvals/${req2!.id}/act`, { action: 'REJECTED', comment: 'Wrong last day' });
  const rejected = await waitFor(() => prisma.employeeClearance.findUnique({ where: { id: cid2 } }), (c) => c?.status === 'REJECTED');
  check('a rejection sends it back as REJECTED', rejected?.status === 'REJECTED', rejected?.status);
  const resubmit = await http(T.hr, 'POST', `/clearances/${cid2}/submit`);
  check('…and it can be resubmitted after fixing', resubmit.status === 200, msg(resubmit));
  const req3 = await prisma.approvalRequest.findFirst({ where: { documentType: 'clearance', documentId: cid2, status: 'PENDING' } });
  for (const t of [T.supervisor, T.finance, T.hr2]) await http(t, 'POST', `/approvals/${req3!.id}/act`, { action: 'APPROVED' });
  const cleared2 = await waitFor(() => prisma.employeeClearance.findUnique({ where: { id: cid2 } }), (c) => c?.status === 'CLEARED');
  const stay = await prisma.employee.findUnique({ where: { id: leaver2.id }, include: { user: true } });
  check(
    'approved with the last day next week → separation recorded, still active until then',
    cleared2?.status === 'CLEARED' && !!stay?.dateSeparated && stay.isActive && stay.user?.isActive === true,
  );
  const dayAfter = addDays(stay!.dateSeparated!, 1);
  const swept = await sweepSeparations(dayAfter, { employeeNo: { startsWith: TAG } });
  const after2 = await prisma.employee.findUnique({ where: { id: leaver2.id }, include: { user: true } });
  check('the sweep on the day after closes the employee', swept >= 1 && after2?.isActive === false, `swept ${swept}`);
  check('…and the login too, because an approved clearance stands behind it', after2?.user?.isActive === false);
  const sweptAudit = await prisma.auditLog.findFirst({
    where: { entityType: 'employee', entityId: leaver2.id, action: 'SEPARATED', actorName: 'system' },
  });
  check('the sweep is audited as the system, with pay data stripped', sweptAudit !== null && !JSON.stringify(sweptAudit?.after ?? {}).includes('dailyRate'));

  // ══ 13b. A hand-typed separation ═════════════════════════════════════════
  console.log('\nSeparation typed on the employee form');
  const typedUser = await makeUser(`${TAG} Typed`, 'typed', []);
  const typed = await prisma.employee.create({
    data: {
      employeeNo: `${TAG}-S1`,
      firstName: 'Tess',
      lastName: `${TAG}Typed`,
      userId: typedUser.id,
      dateSeparated: yesterday,
    },
  });
  await sweepSeparations(dayKey(new Date()), { id: typed.id });
  const typedNow = await prisma.employee.findUnique({ where: { id: typed.id }, include: { user: true } });
  check('a separation date in the past deactivates the employee', typedNow?.isActive === false);
  check('…but not the login — nothing approved stands behind it', typedNow?.user?.isActive === true);
  const told = await prisma.notification.findMany({
    where: { type: 'system', title: { contains: `${typed.firstName} ${typed.lastName}` } },
  });
  check('…and an administrator is told to close it', told.length >= 1, `${told.length}`);

  // ══ Pure rules ═══════════════════════════════════════════════════════════
  console.log('\nThe HR self-sign-off rule');
  check('a raiser who is the only HR holder would sign their own work', hrSignsOwnWork('a', ['a']));
  check('…not when a second HR holder exists', !hrSignsOwnWork('a', ['a', 'b']));
  check('…nor when the only HR holder is someone else', !hrSignsOwnWork('a', ['b']));

  // ══ 12. Turnover arithmetic ══════════════════════════════════════════════
  console.log('\nTurnover — arithmetic over the employee dates');
  const tv = (n: string, extra: Record<string, unknown>) =>
    prisma.employee.create({
      data: { employeeNo: `${TAG}-T${n}`, firstName: `T${n}`, lastName: `${TAG}Turn`, isActive: false, ...extra },
    });
  for (const n of ['1', '2', '3']) await tv(n, { dateHired: utc(2024, 6, 1) });
  const leftA = await tv('4', { dateHired: utc(2024, 6, 1), dateSeparated: utc(2025, 3, 15) });
  const leftB = await tv('5', { dateHired: utc(2024, 6, 1), dateSeparated: utc(2025, 4, 20) });
  await tv('6', { dateHired: utc(2025, 2, 10) });
  await prisma.employeeClearance.create({
    data: {
      number: `${TAG}-CLR-1`,
      status: 'CLEARED',
      employeeId: leftB.id,
      reason: 'RETIREMENT',
      lastWorkingDay: utc(2025, 4, 20),
      raisedById: hr.id,
      clearedAt: utc(2025, 4, 20),
    },
  });

  const t = await turnover(utc(2025, 1, 1), utc(2025, 6, 30), { where: { employeeNo: { startsWith: `${TAG}-T` } } });
  const mar = t.months.find((m) => m.month === '2025-03')!;
  check('February hires one (the sixth person)', t.months.find((m) => m.month === '2025-02')?.hires === 1);
  check(
    'March: opening 6, closing 5, one separation → 1 ÷ 5.5 = 18.18%',
    mar.opening === 6 && mar.closing === 5 && mar.separations === 1 && mar.ratePct === 18.18,
    JSON.stringify(mar),
  );
  const apr = t.months.find((m) => m.month === '2025-04')!;
  check('April: 1 ÷ 4.5 = 22.22%', apr.ratePct === 22.22, String(apr.ratePct));
  check('two separations and one hire over the range', t.separations === 2 && t.hires === 1);
  const byReason = Object.fromEntries(t.byReason.map((r) => [r.reason, r.count]));
  check(
    'the leaver with no clearance is UNRECORDED; the cleared one carries its reason',
    byReason.UNRECORDED === 1 && byReason.RETIREMENT === 1,
    JSON.stringify(byReason),
  );
  const tenA = tenureMonths(utc(2024, 6, 1), utc(2025, 3, 15));
  const tenB = tenureMonths(utc(2024, 6, 1), utc(2025, 4, 20));
  check('tenure is counted from the hire date', tenA === 9.5 && tenB === 10.6, `${tenA} ${tenB}`);
  check(
    'average tenure matches the dates',
    Math.abs(t.averageTenureMonths - (tenA + tenB) / 2) <= 0.051,
    `${t.averageTenureMonths}`,
  );
  check(
    'a population averaging under five is flagged too early to read',
    t.tooEarly === t.averageHeadcount < 5 && t.averageHeadcount < 5 && mar.tooEarly === false,
    `${t.averageHeadcount} ${t.tooEarly}`,
  );
  check(
    'the leavers list links the clearance behind a separation',
    t.leavers.find((l) => l.id === leftB.id)?.clearance?.number === `${TAG}-CLR-1` &&
      t.leavers.find((l) => l.id === leftA.id)?.clearance === null,
  );

  // ══ 13. Reports and reconciliation ═══════════════════════════════════════
  console.log('\nReports — the CSV is audited first, and the figures reconcile');
  const since = new Date(Date.now() - 1000);
  const csvRes = await fetchApi(`${BASE}/hr-reports/turnover.csv?from=2025-01-01&to=2025-06-30`, {
    headers: { Authorization: `Bearer ${T.hr}` },
  });
  const csvText = await csvRes.text();
  const exported = await prisma.auditLog.findFirst({
    where: { entityType: 'hr_report', entityId: 'turnover', action: 'EXPORTED', actorId: hr.id, at: { gte: since } },
  });
  check('the turnover CSV downloads with its header', csvRes.ok && csvText.includes('Month') && csvText.includes('Opening'));
  check('…and the export was logged', exported !== null);
  const report403 = await http(T.plain, 'GET', '/hr-reports/turnover');
  check('the turnover report needs the HR Reports right', report403.status === 403, `${report403.status}`);
  const reportJson = await http(T.hr, 'GET', '/hr-reports/turnover?from=2025-01-01&to=2025-06-30');
  check('the report route answers the same shape', reportJson.status === 200 && Array.isArray(reportJson.body.months));

  const clrSummary = await http(T.hr, 'GET', '/clearances/summary');
  const openDirect = await prisma.employeeClearance.count({ where: { status: 'OPEN' } });
  check('the clearance strip counts open clearances as the table does', clrSummary.body.open === openDirect, `${clrSummary.body.open} vs ${openDirect}`);

  const drift = await prisma.employee.findMany({
    where: { positionId: { not: null } },
    select: { employeeNo: true, position: true, positionRef: { select: { title: true } } },
  });
  const bad = drift.filter((e) => e.position !== e.positionRef?.title);
  check(
    'every linked employee’s title equals its position’s title (the mirror holds everywhere)',
    bad.length === 0,
    bad.slice(0, 5).map((e) => `${e.employeeNo}: ${e.position} ≠ ${e.positionRef?.title}`).join('; '),
  );

  const active = await prisma.position.findMany({ where: { isActive: true }, select: { id: true } });
  const filledDirect = await prisma.employee.count({ where: { isActive: true, positionId: { in: active.map((p) => p.id) } } });
  const summaryNow = await http(T.hr, 'GET', '/positions/summary');
  check(
    'the plantilla summary’s filled equals a direct count of active holders',
    summaryNow.body.filled === filledDirect,
    `${summaryNow.body.filled} vs ${filledDirect}`,
  );

  void h1;
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
