/**
 * SCORO archive verification — the import, numbering continuation, and
 * "Continue in G-CORE".
 *
 *   npx tsx scripts/verify-archive.ts
 *
 * Needs the API running: the route guards, the PDF stream, the audited CSV and
 * the continue flow are checked over HTTP, and the script FAILS loudly rather
 * than skipping them when the API is down.
 *
 * Builds a throwaway bundle (TAG'd source, customers, users, roles), imports it
 * with counters seeded against a throwaway document type, so the real quotation
 * template and counters are never touched. Then dry-runs the REAL SCORO bundle
 * if it is present. Cleans up at the start and the end; refuses production.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { resolveUser } from '../src/permissions/resolve';
import { signToken } from '../src/auth/middleware';
import { globalSearch } from '../src/shared/search';
import { deleteAttachment } from '../src/shared/attachments';
import { nextNumber } from '../src/shared/numbering';
import { manilaMonthKey } from '../src/shared/day';
import {
  LEGACY_QUOTE_ENTITY,
  MSG_LINK_CUSTOMER,
  counterTargets,
  parseYearNumber,
  cleanText,
  readBundle,
  importBundle,
  isOpenStatus,
  outcomeFor,
  parseHouseNumber,
  quoteTotals,
  scoroIdsIn,
} from '../src/shared/legacyQuotes';

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

const TAG = 'ZZARCH';
const MAIL = '@verifyarch.local';
const ROLE = 'zzarch_';
const COUNTER_TYPE = 'zzarch_quotation';
const BASE = `http://localhost:${env.port}/api`;
const REAL_BUNDLE =
  process.env.SCORO_BUNDLE ??
  'C:\\Users\\russe\\AppData\\Local\\Temp\\claude\\C--Users-russe-Desktop-APP-GCORE-GRUNTECH\\742311b9-3770-4d84-adfb-28e2cac2caf6\\scratchpad\\scoro_bundle';

// ── The fixture month: this Manila month, and the one before it ──
const now = new Date();
const month = manilaMonthKey(now); // 2026-09
const yymm = `${month.slice(2, 4)}${month.slice(5, 7)}`;
const prevDate = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 2, 15));
const prevMonth = `${prevDate.getUTCFullYear()}-${String(prevDate.getUTCMonth() + 1).padStart(2, '0')}`;
const prevYymm = `${prevMonth.slice(2, 4)}${prevMonth.slice(5, 7)}`;
const nextDate = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 15));
const nextMonth = `${nextDate.getUTCFullYear()}-${String(nextDate.getUTCMonth() + 1).padStart(2, '0')}`;
const nextYymm = `${nextMonth.slice(2, 4)}${nextMonth.slice(5, 7)}`;

const N = {
  q1: `987${yymm}005`, // Opportunity, Alpha by name, owner A
  q2: `987${yymm}012`, // Negotiation, Beta by SCORO id, owner A, 10% discount
  q3: `987${yymm}007`, // Completed (closed), Alpha
  q4: `986${yymm}003`, // Hold, unmatched, owner B (mismatched code)
  q5: `987${prevYymm}099`, // last month — no counter
  q6: `${TAG}-X1`, // not a house number, lines do not reconcile, its PDF is missing from the bundle
  q7: `${TAG}-X2`, // SCORO exported no PDF ("pdf": null)
  q8: `83${yymm}0163`, // Camille's format: "83" + YYMM + a four-digit run — no counter
  q9: `987${nextYymm}044`, // ten digits, but next month's YYMM on a quote dated this month — no counter
  q10: `985${yymm}021`, // a colleague's code on owner A's quote — seeds code 985
};

async function cleanup() {
  const lqs = await prisma.legacyQuote.findMany({ where: { source: TAG }, select: { id: true } });
  const lqIds = lqs.map((l) => l.id);
  if (lqIds.length) {
    const files = await prisma.attachment.findMany({
      where: { entityType: LEGACY_QUOTE_ENTITY, entityId: { in: lqIds } },
      select: { id: true },
    });
    for (const f of files) await deleteAttachment(f.id);
  }
  await prisma.quotation.deleteMany({ where: { number: { in: Object.values(N) } } });
  await prisma.legacyQuote.deleteMany({ where: { source: TAG } });
  await prisma.numberSequence.deleteMany({ where: { documentType: COUNTER_TYPE } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: TAG } } });

  const users = await prisma.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await prisma.quotation.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.attachment.deleteMany({ where: { uploadedById: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.role.deleteMany({ where: { key: { startsWith: ROLE } } });
}

async function makeRole(key: string, permissionKeys: string[]) {
  const permissions = await prisma.permission.findMany({ where: { key: { in: permissionKeys } }, select: { id: true, key: true } });
  if (permissions.length !== permissionKeys.length) {
    const found = new Set(permissions.map((p) => p.key));
    throw new Error(`Unknown permission(s): ${permissionKeys.filter((k) => !found.has(k)).join(', ')}`);
  }
  return prisma.role.create({
    data: { key: `${ROLE}${key}`, name: `${TAG} ${key}`, permissions: { create: permissions.map((p) => ({ permissionId: p.id })) } },
  });
}

async function makeUser(name: string, local: string, roleIds: string[], employeeNo?: string) {
  return prisma.user.create({
    data: {
      name,
      email: `${local}${MAIL}`,
      employeeNo: employeeNo ?? null,
      passwordHash: await bcrypt.hash('x', 10),
      roles: { create: roleIds.map((roleId) => ({ roleId })) },
    },
  });
}

interface HttpResult {
  status: number;
  text: string;
  body: Record<string, unknown>;
  type: string;
}

async function http(token: string, method: string, p: string, body?: unknown): Promise<HttpResult> {
  const isForm = body instanceof FormData;
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: isForm ? (body as FormData) : JSON.stringify(body) } : {}),
  });
  const type = res.headers.get('content-type') ?? '';
  const text = type.includes('pdf') ? `<${(await res.arrayBuffer()).byteLength} bytes>` : await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text && type.includes('json') ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, text, body: parsed, type };
}

async function apiReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

const PDF_BYTES = (n: string) =>
  Buffer.from(`%PDF-1.4\n% ${TAG} ${n}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1');

function line(title: string, qty: string, unitPrice: string, amount: string) {
  return { title, description: `${title} — supply and install`, quantity: qty, unit: 'lot', unitPrice, amount };
}

function quote(o: Partial<Record<string, unknown>> & { scoroId: string; number: string }) {
  return {
    date: `${month}-02`,
    dueDate: `${month}-30`,
    estimatedClosing: `${month}-28`,
    confirmedAt: null,
    owner: `${TAG.toLowerCase()}  owner a`,
    customer: `${TAG.toLowerCase()} alpha   corp`,
    customerScoroId: '1',
    contact: 'Juan dela Cruz',
    name: 'Compressor controls',
    project: '',
    status: 'Opportunity',
    previousStatus: '',
    statusChangedAt: `${month}-03 13:40:05`,
    statusChangedBy: 'Owner A',
    currency: 'PHP',
    discountPct: '0.000000',
    subtotal: '300.00',
    vat: '36.00',
    total: '336.00',
    cost: '150.0000',
    prNumber: 'PR-77',
    delivery: '4-6 weeks',
    paymentTerms: '30 days',
    comment: 'Site survey done',
    invoiceNos: '',
    isSent: true,
    lines: [line('Controller', '1', '100.00', '100.00'), line('Panel', '2', '100.00', '200.00')],
    linesReconcile: true,
    pdf: `pdf/${o.number}.pdf`,
    ...o,
  };
}

function writeBundle(dir: string, quotes: ReturnType<typeof quote>[], withPdf: (n: string) => boolean) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'pdf'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'quotes.json'), JSON.stringify({ source: TAG, quotes }, null, 1));
  for (const q of quotes) if (withPdf(q.number)) fs.writeFileSync(path.join(dir, 'pdf', `${q.number}.pdf`), PDF_BYTES(q.number));
}

function fixtureQuotes(overrides: Record<string, Partial<Record<string, unknown>>> = {}) {
  return [
    quote({ scoroId: `${TAG}-1`, number: N.q1, ...overrides.q1 }),
    quote({
      scoroId: `${TAG}-2`,
      number: N.q2,
      status: 'Negotiation',
      customer: 'Beta Old Trading Name',
      customerScoroId: '9002',
      discountPct: '10.000000',
      subtotal: '270.00',
      vat: '32.40',
      total: '302.40',
      ...overrides.q2,
    }),
    quote({ scoroId: `${TAG}-3`, number: N.q3, status: 'Completed', ...overrides.q3 }),
    quote({
      scoroId: `${TAG}-4`,
      number: N.q4,
      status: 'Hold',
      owner: `${TAG} Owner B`,
      customer: 'Gamma Unknown',
      customerScoroId: '9003',
      ...overrides.q4,
    }),
    quote({ scoroId: `${TAG}-5`, number: N.q5, date: `${prevMonth}-10`, ...overrides.q5 }),
    quote({
      scoroId: `${TAG}-6`,
      number: N.q6,
      customer: 'Gamma Unknown',
      customerScoroId: '9003',
      subtotal: '999.00',
      linesReconcile: false,
      ...overrides.q6,
    }),
  ];
}

async function main() {
  console.log('\nG-CORE SCORO archive verification\n');
  await cleanup();
  const startedAt = new Date();

  const admin = await prisma.user.findFirst({ where: { isSuperAdmin: true, isActive: true } });
  if (!admin) throw new Error('No super admin — run the seed first');
  const realTemplateBefore = await prisma.numberSequence.findMany({ where: { documentType: 'quotation' }, orderBy: { periodKey: 'asc' } });

  // ══ 1. The pure rules ═══════════════════════════════════════════════════
  console.log('The rules');
  check('a house number parses', JSON.stringify(parseHouseNumber('0012609059', '2026-09-03')) === JSON.stringify({ emp: '001', month: '2026-09', seq: 59 }));
  check('a dotted revision number does not parse', parseHouseNumber('0012008039.3', '2020-08-01') === null);
  // SCORO dropped leading zeros on some numbers (Daniel's export): restored,
  // they count against the code they were issued under.
  check('a number that lost its zeros is read as the house number it was',
    JSON.stringify(parseHouseNumber('12609060', '2026-09-24')) === JSON.stringify({ emp: '001', month: '2026-09', seq: 60 }) &&
    JSON.stringify(parseHouseNumber('542609034', '2026-09-02')) === JSON.stringify({ emp: '054', month: '2026-09', seq: 34 }) &&
    JSON.stringify(parseHouseNumber('012312009', '2023-12-01')) === JSON.stringify({ emp: '001', month: '2023-12', seq: 9 }));
  check('padding cannot invent a house number the date does not confirm',
    parseHouseNumber('12609060', '2026-08-24') === null && parseHouseNumber('402601037', '2026-09-24') === null && parseHouseNumber('1234567', '2026-09-01') === null);
  {
    const t = counterTargets([
      { number: '0012609059', date: '2026-09-24' },
      { number: '12609060', date: '2026-09-24' },   // Daniel's, under Carter's code
    ], '2026-09');
    check("a colleague's zero-dropped number raises that code's counter", t.get('2026-09@001')?.seq === 60, JSON.stringify([...t]));
  }
  // SCORO's count ran through the year: with a YEAR template the counter is
  // `<YYYY>@<code>` and carries every month's numbers, including a number whose
  // month part lags its date, and earlier years are closed.
  {
    const quotes = [
      { number: '0012601001', date: '2026-01-05' },
      { number: '0012604011', date: '2026-03-04' },   // month part lags its date
      { number: '0012609059', date: '2026-09-24' },
      { number: '12609060', date: '2026-09-24' },     // zero-dropped
      { number: '0012512099', date: '2025-12-20' },   // last year: closed
      { number: '8326090163', date: '2026-09-25' },   // Camille's run: code 832 "year 60"
    ];
    const t = counterTargets(quotes, '2026-09', 'YEAR');
    check('a yearly count keys <YYYY>@<code> with the year\'s highest number', t.get('2026@001')?.seq === 60 && t.size === 1, JSON.stringify([...t]));
    check('its report prints the next number for the current month', t.get('2026@001')?.month === '2026-09');
    check('a lagging month part still counts in a yearly run', parseYearNumber('0012604011', '2026-03-04')?.seq === 11);
    check('the year must still be the quote\'s own', parseYearNumber('0012609059', '2025-09-24') === null && parseYearNumber('8326090163', '2026-09-25') === null);
    check('a new year starts a new counter', counterTargets([{ number: '0012701004', date: '2027-01-08' }], '2026-09', 'YEAR').get('2027@001')?.seq === 4);
  }
  // SCORO's PDFs leave NULs in some descriptions, and PostgreSQL refuses a NUL
  // in text and jsonb: one rolled back a whole 191-quote import on the server.
  {
    check('cleanText drops control characters and keeps line breaks and tabs',
      cleanText('A\u0000B\u0007C\nD\tE\u007F') === 'ABC\nD\tE');
    const dir = path.join(os.tmpdir(), `${TAG}-nul`);
    const dirty = quote({ scoroId: '991', number: '0019909001', comment: 'bad\u0000comment',
      lines: [line('Pump\u0000 set', '1', '300.00', '300.00')] });
    writeBundle(dir, [dirty], () => false);
    const read = readBundle(dir).quotes[0];
    check('a bundle with a NUL in its text reads back without it',
      !JSON.stringify(read).includes('\\u0000') && read.comment === 'badcomment' && read.lines[0].title === 'Pump set',
      JSON.stringify({ comment: read.comment, title: read.lines[0].title }));
    fs.rmSync(dir, { recursive: true, force: true });
  }
  check('a month 13 is not a month', parseHouseNumber('0012613001', '2026-13-01') === null);
  check('a house number needs its own date', parseHouseNumber('0012609059', '') === null && parseHouseNumber('0012609059', '2026-08-31') === null);
  check('"83"+YYMM+SEQ is not read as code 832 in 2060', parseHouseNumber('8326010050', '2026-01-15') === null && parseHouseNumber('8326090163', '2026-09-25') === null);
  check('"SCORO id 39, 40" names both ids', JSON.stringify(scoroIdsIn('Imported (SCORO id 39, 40). Notes')) === '["39","40"]');
  check('and id 39 never matches 390', !scoroIdsIn('(SCORO id 390)').includes('39'));
  const t = quoteTotals({ amounts: ['100.00', '200.00'], discountPct: '10', vatRate: '0.12' });
  check(
    'totals: VAT is on the discounted figure',
    t.subtotal.toFixed(2) === '300.00' && t.discountAmount.toFixed(2) === '30.00' && t.vatAmount.toFixed(2) === '32.40' && t.total.toFixed(2) === '302.40',
    `${t.subtotal} ${t.discountAmount} ${t.vatAmount} ${t.total}`,
  );
  check('open statuses are the six', ['Opportunity', 'Negotiation', 'Closing', 'Hold', 'This Month Forecast', 'Confirmed'].every(isOpenStatus));
  check('closed statuses are not open', !['Completed', 'Rejected', 'Cancelled', 'Confirmed Project'].some(isOpenStatus));
  check(
    'outcomes map as agreed',
    outcomeFor('Opportunity') === 'OPEN' && outcomeFor('This Month Forecast') === 'OPEN' && outcomeFor('Hold') === 'OPEN' &&
      outcomeFor('Negotiation') === 'NEGOTIATION' && outcomeFor('Closing') === 'NEGOTIATION' && outcomeFor('Confirmed') === 'NEGOTIATION',
  );
  const targets = counterTargets(
    [
      { number: '0012609059', date: '2026-09-20' },
      { number: '0012609010', date: '2026-09-02' },
      { number: '0012608099', date: '2026-08-28' },
      { number: '0342610004', date: '2026-10-01' },
    ],
    '2026-09',
  );
  check(
    'counter targets: the highest per employee per month, this month on',
    targets.get('2026-09@001')?.seq === 59 && !targets.has('2026-08@001') && targets.get('2026-10@034')?.seq === 4,
    JSON.stringify([...targets.entries()]),
  );
  check(
    'a Camille-style number dated this month seeds nothing',
    counterTargets([{ number: N.q8, date: `${month}-25` }], month).size === 0,
  );
  check(
    'a house number whose YYMM differs from its date seeds nothing',
    counterTargets([{ number: N.q9, date: `${month}-05` }], month).size === 0,
  );
  const colleague = counterTargets([{ number: N.q10, date: `${month}-05` }], month);
  check('a matching one seeds its CODE', colleague.size === 1 && colleague.get(`${month}@985`)?.seq === 21, JSON.stringify([...colleague.entries()]));

  // ══ 2. Fixtures ═════════════════════════════════════════════════════════
  const alpha = await prisma.customer.create({ data: { code: `${TAG}-A`, name: `${TAG} Alpha Corp` } });
  const beta = await prisma.customer.create({
    data: { code: `${TAG}-B`, name: `${TAG} Beta Holdings`, notes: 'Imported from SCORO on 2026-09-27 (SCORO id 9001, 9002).' },
  });
  const gamma = await prisma.customer.create({
    data: { code: `${TAG}-G`, name: `${TAG} Gamma Inc`, notes: 'Imported from SCORO (SCORO id 90030).' },
  });
  const salesRole = await makeRole('sales', [
    'gops.quote_archive.view_all',
    'gops.quotations.view_all',
    'gops.quotations.create',
    'gops.customers.view_all',
  ]);
  const viewerRole = await makeRole('viewer', ['gops.quote_archive.view_all', 'gops.customers.view_all']);
  const plainRole = await makeRole('plain', ['gops.customers.view_all']);
  const ownerA = await makeUser(`${TAG} Owner A`, 'ownera', [salesRole.id], 'ZZ-987');
  const ownerB = await makeUser(`${TAG} Owner B`, 'ownerb', [salesRole.id], 'ZZ-555');
  const sales = await makeUser(`${TAG} Sales`, 'sales', [salesRole.id]);
  const viewer = await makeUser(`${TAG} Viewer`, 'viewer', [viewerRole.id]);
  const plain = await makeUser(`${TAG} Plain`, 'plain', [plainRole.id]);
  await prisma.numberSequence.create({
    data: {
      documentType: COUNTER_TYPE,
      label: `${TAG} quotation`,
      pattern: '{EMP}{YY}{MM}{SEQ}',
      typeCode: 'ZQ',
      period: 'MONTH',
      scope: 'OWNER',
      periodKey: '',
      padding: 3,
    },
  });
  // Owner B's counter is already ahead of SCORO: it must not come down.
  await prisma.numberSequence.create({
    data: {
      documentType: COUNTER_TYPE,
      label: `${TAG} quotation`,
      pattern: '{EMP}{YY}{MM}{SEQ}',
      typeCode: 'ZQ',
      period: 'MONTH',
      scope: 'OWNER',
      periodKey: `${month}@986`,
      padding: 3,
      lastNumber: 50,
    },
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zzarch-bundle-'));
  writeBundle(dir, fixtureQuotes(), (n) => n !== N.q6);
  const opts = { counterDocumentType: COUNTER_TYPE, actorId: admin.id, actorName: `${TAG} verify` };

  // ══ 3. Dry run ══════════════════════════════════════════════════════════
  console.log('\nDry run');
  const counts = async () => ({
    lq: await prisma.legacyQuote.count({ where: { source: TAG } }),
    files: await prisma.attachment.count({ where: { entityType: LEGACY_QUOTE_ENTITY } }),
    seq: JSON.stringify(await prisma.numberSequence.findMany({ where: { documentType: COUNTER_TYPE }, select: { periodKey: true, lastNumber: true }, orderBy: { periodKey: 'asc' } })),
    audit: await prisma.auditLog.count({ where: { entityType: LEGACY_QUOTE_ENTITY } }),
  });
  const before = await counts();
  const dry = await importBundle(dir, { ...opts, commit: false });
  const afterDry = await counts();
  check('a dry run writes nothing', JSON.stringify(before) === JSON.stringify(afterDry), `${JSON.stringify(before)} → ${JSON.stringify(afterDry)}`);
  check('and reports every quote', dry.totals.quotes === 6 && dry.totals.created === 6 && !dry.committed, JSON.stringify(dry.totals));
  check('open and closed are counted', dry.totals.open === 5 && dry.totals.closed === 1, `${dry.totals.open}/${dry.totals.closed}`);
  check('customers match by name, case and spacing aside', dry.customers.matchedByName === 3, String(dry.customers.matchedByName));
  check(
    'and by the "SCORO id" in a customer\'s notes',
    dry.customers.matchedByScoroId === 1 && dry.customers.matched.some((m) => m.customerId === beta.id && m.by === 'scoro_id'),
  );
  check(
    'an id that is only a prefix of another does not match (9003 vs 90030)',
    dry.customers.unmatched.some((u) => u.name === 'Gamma Unknown' && u.quotes === 2) && dry.customers.unmatchedQuotes === 2,
    JSON.stringify(dry.customers.unmatched),
  );
  const oa = dry.owners.find((o) => o.user?.id === ownerA.id);
  const ob = dry.owners.find((o) => o.user?.id === ownerB.id);
  check('owners are matched by name, case-insensitively', !!oa && !!ob);
  check('an owner whose code matches is not flagged', !!oa && oa.primaryCode === '987' && oa.user?.token === '987' && !oa.mismatch);
  check(
    'an owner whose employee number does not give their SCORO code is flagged',
    !!ob && ob.mismatch && ob.primaryCode === '986' && ob.user?.token === '555' && /ending in 986/.test(ob.message ?? ''),
    ob?.message ?? '',
  );
  check('quotes whose lines do not add up are listed', dry.notReconciling.length === 1 && dry.notReconciling[0].number === N.q6);
  check('a missing PDF is reported, not fatal', dry.pdfs.missing.length === 1 && dry.pdfs.missing[0] === N.q6);
  const plan987 = dry.counters.find((c) => c.periodKey === `${month}@987`);
  const plan986 = dry.counters.find((c) => c.periodKey === `${month}@986`);
  check('the plan creates this month\'s counter at SCORO\'s last', plan987?.change === 'create' && plan987.target === 12, JSON.stringify(plan987));
  check('and keeps a counter already ahead', plan986?.change === 'keep' && plan986.target === 50, JSON.stringify(plan986));
  check('last month is not continued', !dry.counters.some((c) => c.month === prevMonth));

  // ══ 4. Commit ═══════════════════════════════════════════════════════════
  console.log('\nCommit');
  const done = await importBundle(dir, { ...opts, commit: true });
  const rows = await prisma.legacyQuote.findMany({ where: { source: TAG }, orderBy: { number: 'asc' } });
  const byNo = new Map(rows.map((r) => [r.number, r]));
  check('commit imports every quote', rows.length === 6 && done.committed, String(rows.length));
  check('with its PDF through the attachment store', done.pdfs.stored === 5, JSON.stringify(done.pdfs));
  check('linked to the customer matched by name', byNo.get(N.q1)?.customerId === alpha.id);
  check('and to the customer matched by SCORO id', byNo.get(N.q2)?.customerId === beta.id);
  check('an unmatched quote is archived without one', byNo.get(N.q4)?.customerId === null);
  check('the owner login is linked', byNo.get(N.q1)?.ownerUserId === ownerA.id);
  check('money is kept exactly', byNo.get(N.q2)?.total.toFixed(2) === '302.40' && byNo.get(N.q2)?.discountPct.toFixed(4) === '10.0000');
  check('SCORO\'s timestamp is read as Manila time', byNo.get(N.q1)?.statusChangedAt?.toISOString() === `${month}-03T05:40:05.000Z`, byNo.get(N.q1)?.statusChangedAt?.toISOString());
  const c987 = await prisma.numberSequence.findUnique({ where: { documentType_periodKey: { documentType: COUNTER_TYPE, periodKey: `${month}@987` } } });
  const c986 = await prisma.numberSequence.findUnique({ where: { documentType_periodKey: { documentType: COUNTER_TYPE, periodKey: `${month}@986` } } });
  check('the counter is seeded at the highest SCORO sequence', c987?.lastNumber === 12, String(c987?.lastNumber));
  check(
    'copying the template as nextNumber does',
    c987?.pattern === '{EMP}{YY}{MM}{SEQ}' && c987.period === 'MONTH' && c987.scope === 'OWNER' && c987.padding === 3 && c987.typeCode === 'ZQ',
  );
  check('a counter already ahead is never lowered', c986?.lastNumber === 50, String(c986?.lastNumber));
  check(
    'no counter for last month',
    (await prisma.numberSequence.count({ where: { documentType: COUNTER_TYPE, periodKey: { startsWith: prevMonth } } })) === 0,
  );
  const issued = await prisma.$transaction((tx) => nextNumber(COUNTER_TYPE, tx, { ownerId: ownerA.id }));
  check('the next number follows SCORO\'s last', issued === `987${yymm}013`, issued);
  check(
    'the import is audited',
    (await prisma.auditLog.count({ where: { entityType: LEGACY_QUOTE_ENTITY, entityId: 'import', summary: { contains: TAG }, at: { gte: startedAt } } })) === 1,
  );

  // ══ 5. Search ═══════════════════════════════════════════════════════════
  console.log('\nSearch');
  const adminResolved = (await resolveUser(admin.id))!;
  const hits = await globalSearch(N.q6, adminResolved);
  const hit = hits.find((h) => h.kind === 'legacy_quote');
  check('Ctrl+K finds a SCORO quote by number', !!hit && hit.link === `/g-ops/quote-archive/${byNo.get(N.q6)!.id}`, JSON.stringify(hit));
  const plainHits = await globalSearch(N.q6, (await resolveUser(plain.id))!);
  check('but not for someone without the archive', !plainHits.some((h) => h.kind === 'legacy_quote'));

  // ══ 6. Over HTTP ════════════════════════════════════════════════════════
  console.log('\nRoutes (over HTTP)');
  if (!(await apiReachable())) {
    failed += 1;
    console.log(
      `  ✗ the API is not reachable at ${BASE} — the routes were NOT verified.\n` +
        '      Start it with "npm run dev" in api/ and run this script again.',
    );
  } else {
    const T = (u: { id: string; email: string }) => signToken(u.id, u.email);
    const adminT = T(admin);
    const salesT = T(sales);
    const viewerT = T(viewer);
    const plainT = T(plain);
    const id = (n: string) => byNo.get(n)!.id;

    // The owner filter takes the name as SCORO spelled it — the facets offer exactly those.
    const list = await http(viewerT, 'GET', `/quote-archive?owner=${encodeURIComponent(byNo.get(N.q1)!.ownerName.toUpperCase())}&pageSize=50`);
    check('the list answers to view_all', list.status === 200 && (list.body.total as number) === 5, `${list.status} ${list.text.slice(0, 120)}`);
    check('and is refused without it', (await http(plainT, 'GET', '/quote-archive')).status === 403);
    const open = await http(viewerT, 'GET', `/quote-archive?search=${TAG}&status=OPEN`);
    const shut = await http(viewerT, 'GET', `/quote-archive?search=${TAG}&status=CLOSED`);
    check(
      'status=OPEN and CLOSED split the set',
      open.status === 200 && (open.body.total as number) === 5 && (shut.body.total as number) === 1,
      `${open.body.total}/${shut.body.total}`,
    );
    const byCustomer = await http(viewerT, 'GET', `/quote-archive?customerId=${alpha.id}`);
    check('customerId filters to one customer', (byCustomer.body.total as number) === 3, String(byCustomer.body.total));

    const detail = await http(viewerT, 'GET', `/quote-archive/${id(N.q1)}`);
    check(
      'the detail carries its lines and its PDF',
      detail.status === 200 && (detail.body.lines as unknown[]).length === 2 && typeof detail.body.attachmentId === 'string',
      detail.text.slice(0, 160),
    );
    check('SCORO cost is stripped for someone who may not see costings', !('cost' in detail.body));
    const adminDetail = await http(adminT, 'GET', `/quote-archive/${id(N.q1)}`);
    check('and present for someone who may', adminDetail.body.cost === 150);

    const pdf = await http(viewerT, 'GET', `/quote-archive/${id(N.q1)}/pdf`);
    check('the PDF endpoint returns application/pdf', pdf.status === 200 && pdf.type.includes('application/pdf'), `${pdf.status} ${pdf.type}`);
    check('a quote with no PDF says so', (await http(viewerT, 'GET', `/quote-archive/${id(N.q6)}/pdf`)).status === 404);

    check('the CSV needs export', (await http(viewerT, 'GET', '/quote-archive/export.csv')).status === 403);
    const auditBefore = await prisma.auditLog.count({ where: { entityType: LEGACY_QUOTE_ENTITY, entityId: 'export', action: 'EXPORTED' } });
    const csv = await http(adminT, 'GET', `/quote-archive/export.csv?search=${TAG}`);
    const auditAfter = await prisma.auditLog.count({ where: { entityType: LEGACY_QUOTE_ENTITY, entityId: 'export', action: 'EXPORTED' } });
    check('the CSV is served', csv.status === 200 && csv.type.includes('text/csv') && csv.text.includes(N.q6), `${csv.status} ${csv.type}`);
    check('and audited', auditAfter === auditBefore + 1);

    // Continue
    check('continuing needs gops.quotations.create', (await http(viewerT, 'POST', `/quote-archive/${id(N.q1)}/continue`)).status === 403);
    const closed = await http(salesT, 'POST', `/quote-archive/${id(N.q3)}/continue`);
    check('a closed quote cannot be continued', closed.status === 400, `${closed.status} ${closed.text.slice(0, 120)}`);
    const unlinked = await http(salesT, 'POST', `/quote-archive/${id(N.q4)}/continue`);
    check('an unlinked quote asks for its customer first', unlinked.status === 400 && String(unlinked.body.error) === MSG_LINK_CUSTOMER, unlinked.text);

    const cont = await http(salesT, 'POST', `/quote-archive/${id(N.q1)}/continue`);
    check('continue creates the quotation', cont.status === 201 && typeof cont.body.quotationId === 'string', `${cont.status} ${cont.text.slice(0, 160)}`);
    const q = cont.body.quotationId
      ? await prisma.quotation.findUnique({
          where: { id: cont.body.quotationId as string },
          include: { revisions: { include: { items: { orderBy: { sortOrder: 'asc' } } } }, contact: true },
        })
      : null;
    check('under the SAME number', q?.number === N.q1, q?.number);
    check('owned by the matched SCORO owner', q?.ownerId === ownerA.id);
    check('with its lines as revision 0, draft', q?.revisions.length === 1 && q.revisions[0].revision === 0 && q.revisions[0].status === 'DRAFT' && q.revisions[0].items.length === 2);
    check('titles and descriptions kept apart', q?.revisions[0].items[0].title === 'Controller' && /supply and install/.test(q?.revisions[0].items[0].description ?? ''));
    check('PR Number, Delivery and Payment Terms carried', q?.revisions[0].prNumber === 'PR-77' && q.revisions[0].delivery === '4-6 weeks' && q.revisions[0].paymentTerms === '30 days');
    check('outcome mapped from the SCORO stage', q?.outcome === 'OPEN');
    check('the contact person became a customer contact', q?.contact?.name === 'Juan dela Cruz' && q.contact.customerId === alpha.id);
    check('the archive now points at it', (await prisma.legacyQuote.findUnique({ where: { id: id(N.q1) } }))?.continuedQuotationId === q?.id);
    const again = await http(salesT, 'POST', `/quote-archive/${id(N.q1)}/continue`);
    check('a second continue is refused with 409 naming the quotation', again.status === 409 && String(again.body.error).includes(N.q1), again.text);

    const c2 = await http(salesT, 'POST', `/quote-archive/${id(N.q2)}/continue`);
    const q2 = c2.body.quotationId
      ? await prisma.quotation.findUnique({ where: { id: c2.body.quotationId as string }, include: { revisions: true } })
      : null;
    const r2 = q2?.revisions[0];
    const vatRate = r2 ? Number(r2.vatRate) : 0.12;
    const expectVat = Math.round(270 * vatRate * 100) / 100;
    check('Negotiation continues as NEGOTIATION', q2?.outcome === 'NEGOTIATION');
    check(
      'discount comes off before VAT',
      !!r2 && r2.subtotal.toFixed(2) === '300.00' && r2.discountAmount.toFixed(2) === '30.00' && Number(r2.vatAmount) === expectVat && Number(r2.total) === 270 + expectVat,
      r2 ? `${r2.subtotal} ${r2.discountAmount} ${r2.vatAmount} ${r2.total}` : 'none',
    );
    check(
      'both are audited',
      (await prisma.auditLog.count({ where: { entityType: LEGACY_QUOTE_ENTITY, entityId: id(N.q1), action: 'CONVERTED' } })) === 1 &&
        (await prisma.auditLog.count({ where: { entityType: 'quotation', entityId: q?.id ?? '-', action: 'CREATED' } })) === 1,
    );

    // Linking by hand
    check('linking a customer needs the import right', (await http(viewerT, 'PATCH', `/quote-archive/${id(N.q6)}/customer`, { customerId: alpha.id })).status === 403);
    const link = await http(adminT, 'PATCH', `/quote-archive/${id(N.q6)}/customer`, { customerId: gamma.id });
    check('an admin links an unmatched quote', link.status === 200, link.text);
    await prisma.quotation.create({
      data: {
        number: N.q6,
        customerId: gamma.id,
        ownerId: admin.id,
        subject: `${TAG} clash`,
        revisions: { create: [{ revision: 0 }] },
      },
    });
    const clash = await http(salesT, 'POST', `/quote-archive/${id(N.q6)}/continue`);
    check('a number already used by a G-CORE quotation is refused', clash.status === 409, `${clash.status} ${clash.text}`);

    // Customer 360
    const c360 = await http(viewerT, 'GET', `/customers/${alpha.id}`);
    const legacy = (c360.body.legacyQuotes as { number: string }[] | undefined) ?? [];
    check('Customer 360 lists the SCORO history', legacy.length === 3 && legacy.some((l) => l.number === N.q1), c360.text.slice(0, 160));
    const c360plain = await http(plainT, 'GET', `/customers/${alpha.id}`);
    check('but not to someone without the archive', Array.isArray(c360plain.body.legacyQuotes) && (c360plain.body.legacyQuotes as unknown[]).length === 0);

    // Import from the browser
    const fd = new FormData();
    fd.append('quotes', new Blob([fs.readFileSync(path.join(dir, 'quotes.json'))], { type: 'application/json' }), 'quotes.json');
    fd.append('pdfs', new Blob([PDF_BYTES(N.q1)], { type: 'application/pdf' }), `${N.q1}.pdf`);
    const lqBefore = await prisma.legacyQuote.count({ where: { source: TAG } });
    const up = await http(adminT, 'POST', '/quote-archive/import', fd);
    check(
      'the browser import dry-runs the same bundle',
      up.status === 200 && (up.body.totals as { quotes: number }).quotes === 6 && up.body.committed === false,
      `${up.status} ${up.text.slice(0, 160)}`,
    );
    check('and writes nothing', (await prisma.legacyQuote.count({ where: { source: TAG } })) === lqBefore);
    const fd2 = new FormData();
    fd2.append('quotes', new Blob([fs.readFileSync(path.join(dir, 'quotes.json'))], { type: 'application/json' }), 'quotes.json');
    check('the browser import needs the import right', (await http(salesT, 'POST', '/quote-archive/import', fd2)).status === 403);
  }

  // ══ 7. Re-import ════════════════════════════════════════════════════════
  console.log('\nRe-import');
  await prisma.numberSequence.update({
    where: { documentType_periodKey: { documentType: COUNTER_TYPE, periodKey: `${month}@987` } },
    data: { lastNumber: 20 },
  });
  const q4Before = await prisma.legacyQuote.findUnique({ where: { number: N.q4 } });
  await prisma.legacyQuote.update({ where: { number: N.q4 }, data: { customerId: gamma.id } }); // linked by hand
  const continuedBefore = (await prisma.legacyQuote.findUnique({ where: { number: N.q1 } }))?.continuedQuotationId ?? null;
  writeBundle(dir, fixtureQuotes({ q1: { name: 'Compressor controls, revised' } }), (n) => n !== N.q6);
  const filesBefore = await prisma.attachment.count({ where: { entityType: LEGACY_QUOTE_ENTITY, entityId: { in: rows.map((r) => r.id) } } });
  const re = await importBundle(dir, { ...opts, commit: true });
  const rowsAfter = await prisma.legacyQuote.findMany({ where: { source: TAG } });
  const q1After = rowsAfter.find((r) => r.number === N.q1);
  check('a re-import updates rather than duplicates', rowsAfter.length === 6 && re.totals.created === 0 && re.totals.updated === 6, JSON.stringify(re.totals));
  check('it takes the new fields', q1After?.name === 'Compressor controls, revised');
  check('and never clears the continued link', !!continuedBefore && q1After?.continuedQuotationId === continuedBefore, `${continuedBefore} → ${q1After?.continuedQuotationId}`);
  check('nor a customer linked by hand', rowsAfter.find((r) => r.number === N.q4)?.customerId === gamma.id, `was ${q4Before?.customerId}`);
  check(
    'the same PDF is kept, not stored twice',
    (await prisma.attachment.count({ where: { entityType: LEGACY_QUOTE_ENTITY, entityId: { in: rows.map((r) => r.id) } } })) === filesBefore && re.pdfs.kept === 5,
    JSON.stringify(re.pdfs),
  );
  const c987b = await prisma.numberSequence.findUnique({ where: { documentType_periodKey: { documentType: COUNTER_TYPE, periodKey: `${month}@987` } } });
  check('a counter that moved on is never pulled back', c987b?.lastNumber === 20, String(c987b?.lastNumber));

  // A changed PDF replaces the old one.
  fs.writeFileSync(path.join(dir, 'pdf', `${N.q3}.pdf`), Buffer.concat([PDF_BYTES(N.q3), Buffer.from('% changed\n')]));
  const re2 = await importBundle(dir, { ...opts, commit: true });
  check(
    'a changed PDF replaces the stored one',
    re2.pdfs.replaced === 1 &&
      (await prisma.attachment.count({ where: { entityType: LEGACY_QUOTE_ENTITY, entityId: byNo.get(N.q3)!.id } })) === 1,
    JSON.stringify(re2.pdfs),
  );

  const realTemplateAfter = await prisma.numberSequence.findMany({ where: { documentType: 'quotation' }, orderBy: { periodKey: 'asc' } });
  check(
    'the real quotation numbering was never touched',
    JSON.stringify(realTemplateBefore.map((r) => [r.periodKey, r.pattern, r.lastNumber])) ===
      JSON.stringify(realTemplateAfter.map((r) => [r.periodKey, r.pattern, r.lastNumber])),
  );

  // ══ 7b. Numbers outside the house format, and a quote with no PDF ═══════
  console.log('\nHouse format and "no PDF"');
  const extra = [
    { ...quote({ scoroId: `${TAG}-7`, number: N.q7, status: 'Completed' }), pdf: null as string | null },
    quote({ scoroId: `${TAG}-8`, number: N.q8, date: `${month}-25`, owner: `${TAG} Camille` }),
    quote({ scoroId: `${TAG}-9`, number: N.q9, date: `${month}-05` }),
    quote({ scoroId: `${TAG}-10`, number: N.q10, date: `${month}-05` }),
  ];
  writeBundle(dir, extra as ReturnType<typeof quote>[], (n) => n !== N.q7);
  const dry2 = await importBundle(dir, { ...opts, commit: false });
  check(
    'a quote SCORO exported no PDF for is counted as "no PDF", not as missing',
    dry2.totals.noPdf === 1 && dry2.pdfs.noPdf.join() === N.q7 && dry2.pdfs.missing.length === 0 && dry2.totals.withPdf === 3,
    JSON.stringify({ totals: dry2.totals, pdfs: dry2.pdfs }),
  );
  const nhf = dry2.notHouseFormat.map((x) => x.number);
  check(
    'numbers outside the house format are listed, a matching one is not',
    nhf.includes(N.q8) && nhf.includes(N.q9) && nhf.includes(N.q7) && !nhf.includes(N.q10),
    nhf.join(', '),
  );
  check(
    'only the matching code\'s counter would be seeded',
    dry2.counters.map((c) => c.periodKey).join() === `${month}@985` && dry2.counters[0].target === 21,
    JSON.stringify(dry2.counters),
  );
  const done2 = await importBundle(dir, { ...opts, commit: true });
  const q7Row = await prisma.legacyQuote.findUnique({ where: { number: N.q7 } });
  check(
    'the no-PDF quote is archived without an attachment',
    !!q7Row &&
      done2.pdfs.stored === 3 &&
      (await prisma.attachment.count({ where: { entityType: LEGACY_QUOTE_ENTITY, entityId: q7Row.id } })) === 0,
    JSON.stringify(done2.pdfs),
  );
  const seeded = await prisma.numberSequence.findMany({ where: { documentType: COUNTER_TYPE }, select: { periodKey: true, lastNumber: true } });
  check(
    'code 985 is seeded; nothing for 832 or for next month',
    seeded.find((r) => r.periodKey === `${month}@985`)?.lastNumber === 21 &&
      !seeded.some((r) => r.periodKey.endsWith('@832') || r.periodKey.startsWith(nextMonth)),
    JSON.stringify(seeded),
  );
  if (q7Row && (await apiReachable())) {
    const viewerT = signToken(viewer.id, viewer.email);
    const d7 = await http(viewerT, 'GET', `/quote-archive/${q7Row.id}`);
    check('its detail carries no attachment', d7.status === 200 && d7.body.attachmentId === null, d7.text.slice(0, 120));
    const p7 = await http(viewerT, 'GET', `/quote-archive/${q7Row.id}/pdf`);
    check('and /pdf answers a clean 404', p7.status === 404 && /No PDF/i.test(String(p7.body.error)), `${p7.status} ${p7.text.slice(0, 120)}`);
  }

  fs.rmSync(dir, { recursive: true, force: true });

  // ══ 8. The real SCORO bundle, dry run ═══════════════════════════════════
  console.log('\nThe real SCORO bundles (dry run)');
  for (const extraBundle of [`${REAL_BUNDLE}_brian`, `${REAL_BUNDLE}_3`, `${REAL_BUNDLE}_4`]) {
    if (!fs.existsSync(path.join(extraBundle, 'quotes.json'))) continue;
    const r = await importBundle(extraBundle, { commit: false });
    const bogus = r.counters.filter((c) => c.month > nextMonth);
    check(`${path.basename(extraBundle)}: no counter is seeded for a month that has not come`, bogus.length === 0, JSON.stringify(bogus));
  }
  if (!fs.existsSync(path.join(REAL_BUNDLE, 'quotes.json'))) {
    console.log(`  - skipped: no bundle at ${REAL_BUNDLE} (set SCORO_BUNDLE to point at one)`);
  } else {
    const lqAll = await prisma.legacyQuote.count();
    const seqAll = await prisma.numberSequence.count();
    const real = await importBundle(REAL_BUNDLE, { commit: false });
    check('the real bundle dry-runs to completion with 191 quotes', real.totals.quotes === 191, String(real.totals.quotes));
    check('and every one has its PDF', real.totals.missingPdf === 0, String(real.totals.missingPdf));
    check(
      'Carter Gasiong\'s counter would continue from 59 (keyed by the template\'s period)',
      real.counters.some((c) => (c.periodKey === '2026-09@001' || c.periodKey === '2026@001') && c.scoroSeq === 59) || month !== '2026-09',
      JSON.stringify(real.counters),
    );
    check('and it wrote nothing', (await prisma.legacyQuote.count()) === lqAll && (await prisma.numberSequence.count()) === seqAll);
  }

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch(async (err) => {
    console.error('\nVerification crashed:', err);
    failed++;
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup().catch((e) => console.error('cleanup failed:', e));
    await prisma.$disconnect();
  });
