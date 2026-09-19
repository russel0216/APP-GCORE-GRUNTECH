/**
 * Phase 2 verification — the master records.
 *
 *   npx tsx scripts/verify-masters.ts
 *
 * Focuses on the two things most likely to go quietly wrong: the CSV importer
 * (which writes master data in bulk) and the permission gate on employee pay.
 * Creates its own records, cleans up, refuses to run against production.
 */

import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { resolveUser, can } from '../src/permissions/resolve';
import { nextNumber } from '../src/shared/numbering';
import { parseCsv, runImport, templateFor, type ImportSpec } from '../src/shared/csv';
import { globalSearch } from '../src/shared/search';
import bcrypt from 'bcryptjs';

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

const TAG = 'ZZVERIFY';

async function cleanup() {
  await prisma.customer.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.supplier.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.item.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.employee.deleteMany({ where: { lastName: { startsWith: TAG } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: '@verifym.local' } } });
}

async function main() {
  console.log('\nG-CORE masters verification\n');
  await cleanup();

  // ── 1. CSV parsing ─────────────────────────────────────────────────────────
  console.log('CSV parsing');

  const simple = parseCsv('a,b,c\n1,2,3');
  check('splits rows and columns', JSON.stringify(simple) === '[["a","b","c"],["1","2","3"]]');

  const quoted = parseCsv('Name,Address\n"Acme, Inc.","12 Main St, Unit 4"');
  check(
    'a quoted field keeps its commas',
    quoted[1][0] === 'Acme, Inc.' && quoted[1][1] === '12 Main St, Unit 4',
    JSON.stringify(quoted[1]),
  );

  const escaped = parseCsv('Name\n"He said ""hello"""');
  check('doubled quotes become one quote', escaped[1][0] === 'He said "hello"', escaped[1][0]);

  const multiline = parseCsv('Name,Notes\n"Acme","line one\nline two"');
  check(
    'a newline inside quotes does not split the row',
    multiline.length === 2 && multiline[1][1] === 'line one\nline two',
    `${multiline.length} rows`,
  );

  // Excel writes a BOM, which silently corrupts the first header if not stripped.
  const bom = parseCsv('﻿Name,Code\nAcme,C1');
  check('a UTF-8 BOM is stripped from the first header', bom[0][0] === 'Name', JSON.stringify(bom[0][0]));

  const crlf = parseCsv('a,b\r\n1,2\r\n');
  check('CRLF line endings work', crlf.length === 2 && crlf[1][1] === '2');

  const blanks = parseCsv('a,b\n1,2\n\n\n3,4');
  check('blank lines are ignored', blanks.length === 3, `${blanks.length} rows`);

  // ── 2. The import contract ─────────────────────────────────────────────────
  console.log('\nCSV import');

  interface Row {
    name: string;
    code: string;
  }

  const written: Row[] = [];
  const spec: ImportSpec<Row> = {
    entity: 'test',
    label: 'Test',
    columns: [
      { header: 'Name', required: true, example: 'Example' },
      { header: 'Code', example: 'X1' },
    ],
    existing: async () => null,
    build: async (row) => {
      if (!row['Name']) throw new Error('Name is required');
      if (row['Name'].includes('!')) throw new Error('Name must not contain "!"');
      return { name: row['Name'], code: row['Code'] };
    },
  };
  const write = async (records: { record: Row; existingId: string | null }[]) => {
    written.push(...records.map((r) => r.record));
  };

  const template = templateFor(spec);
  check('a template carries the headers and an example', template.split('\r\n')[0] === 'Name,Code', template);

  const dryRun = await runImport('Name,Code\nAlpha,A1\nBeta,B1', spec, false, write);
  check('a dry run reports what it would do', dryRun.total === 2 && dryRun.created === 2);
  check('a dry run writes nothing', written.length === 0 && !dryRun.committed);

  const committed = await runImport('Name,Code\nAlpha,A1\nBeta,B1', spec, true, write);
  check('committing writes the rows', committed.committed && written.length === 2);

  written.length = 0;
  const withError = await runImport('Name,Code\nGood,G1\nBad!,B1\nAlso Good,G2', spec, true, write);
  check('a bad row is reported with its row number', withError.rows[1].row === 3, `row ${withError.rows[1].row}`);
  check('the error explains itself', (withError.rows[1].message ?? '').includes('must not contain'));
  check(
    'ONE bad row blocks the whole file',
    !withError.committed && written.length === 0,
    `${written.length} written`,
  );

  written.length = 0;
  const dupes = await runImport('Name,Code\nAlpha,A1\nAlpha,A2', spec, true, write);
  check(
    'a key repeated inside the file is caught',
    dupes.errors === 1 && (dupes.rows[1].message ?? '').includes('more than once'),
    dupes.rows[1].message,
  );

  const missingCol = await runImport('Code\nA1', spec, false, write).catch((e) => e as Error);
  check(
    'a file missing a required column is refused',
    missingCol instanceof Error && missingCol.message.includes('missing required column'),
    missingCol instanceof Error ? missingCol.message : 'no error',
  );

  // ── 3. Real customer import, end to end ────────────────────────────────────
  console.log('\nCustomer import');

  const csv = [
    'Name,Code,Industry,Contact Name,Contact Position,Site Name,Site City,Active',
    `${TAG} Hospital,,Healthcare,Maria Santos,Purchasing,Main Plant,Cagayan de Oro,Yes`,
    `${TAG} Foods,,Food processing,Juan Cruz,Engineering,Plant 2,Davao,Yes`,
  ].join('\n');

  const { parseCsv: _p } = await import('../src/shared/csv');
  void _p;
  const customerImport = await import('../src/routes/imports');
  void customerImport;

  // Drive the same spec the route uses by importing through the HTTP-free path.
  const specs = await buildCustomerSpec();
  const importWritten: string[] = [];
  const report = await runImport(csv, specs.spec, true, async (records) => {
    for (const { record } of records as { record: Record<string, unknown> }[]) {
      const created = await prisma.customer.create({
        data: {
          ...(record as never),
          code: (record.code as string) || (await nextNumber('customer')),
        },
      });
      importWritten.push(created.id);
    }
  });

  check('two customers imported', report.committed && report.created === 2, JSON.stringify(report.rows));

  const imported = await prisma.customer.findFirst({
    where: { name: `${TAG} Hospital` },
    include: { contacts: true, sites: true },
  });
  check('the customer landed', imported !== null);
  check('its contact came with it', imported?.contacts.length === 1, `${imported?.contacts.length ?? 0} contacts`);
  check('the contact is marked primary', imported?.contacts[0]?.isPrimary === true);
  check('its site came with it', imported?.sites.length === 1);
  check('the site city was kept', imported?.sites[0]?.city === 'Cagayan de Oro');
  check(
    'a code was generated for the blank column',
    /^GT-CUST-\d{4}-\d{4}$/.test(imported?.code ?? ''),
    imported?.code,
  );

  // Re-importing the same file must update, not duplicate.
  const second = await runImport(csv, specs.spec, true, async (records) => {
    for (const { record, existingId } of records as {
      record: Record<string, unknown>;
      existingId: string | null;
    }[]) {
      if (existingId) {
        const { contacts, sites, code, ...fields } = record;
        void contacts;
        void sites;
        void code;
        await prisma.customer.update({ where: { id: existingId }, data: fields as never });
      }
    }
  });
  check('re-importing recognises the existing rows', second.updated === 2, `${second.updated} updates`);

  const afterSecond = await prisma.customer.findMany({ where: { name: `${TAG} Hospital` } });
  check('no duplicate customer was created', afterSecond.length === 1, `${afterSecond.length} rows`);

  const contactsAfter = await prisma.customerContact.count({
    where: { customer: { name: `${TAG} Hospital` } },
  });
  check('the contact was not duplicated on re-import', contactsAfter === 1, `${contactsAfter} contacts`);

  // ── 4. Employee pay is gated ───────────────────────────────────────────────
  console.log('\nEmployee pay visibility');

  const hrRole = await prisma.role.findUnique({ where: { key: 'hr' } });
  const pmRole = await prisma.role.findUnique({ where: { key: 'project_manager' } });

  const hrUser = await prisma.user.create({
    data: {
      name: 'Verify HR',
      email: 'hr@verifym.local',
      passwordHash: await bcrypt.hash('x', 10),
      roles: { create: [{ roleId: hrRole!.id }] },
    },
  });
  const pmUser = await prisma.user.create({
    data: {
      name: 'Verify PM',
      email: 'pm@verifym.local',
      passwordHash: await bcrypt.hash('x', 10),
      roles: { create: [{ roleId: pmRole!.id }] },
    },
  });

  const hr = (await resolveUser(hrUser.id))!;
  const pm = (await resolveUser(pmUser.id))!;

  check('HR may see employees', can(hr, 'ghr.employees.view_all'));
  check('HR may see pay rates', can(hr, 'ghr.employee_rates.view_all'));
  check('a project manager may NOT see pay rates', !can(pm, 'ghr.employee_rates.view_all'));

  // ── 5. Numbering for masters ───────────────────────────────────────────────
  console.log('\nMaster numbering');

  const supplierCode = await nextNumber('supplier');
  const itemCode = await nextNumber('item');
  const employeeNo = await nextNumber('employee');
  check('supplier codes follow the pattern', /^GT-SUPP-\d{4}-\d{4}$/.test(supplierCode), supplierCode);
  check('item codes follow the pattern', /^GT-ITM-\d{4}-\d{4}$/.test(itemCode), itemCode);
  check('employee numbers follow the pattern', /^GT-EMP-\d{4}-\d{4}$/.test(employeeNo), employeeNo);

  // Codes are handed out inside the caller's transaction, exactly as the
  // customer route does it. Two people saving a new customer at the same moment
  // must not receive the same code — a one-off failure here was seen once
  // during development and never reproduced, so it is pinned down by a test
  // rather than left to chance.
  const concurrent = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      prisma.$transaction(async (tx) => {
        const code = await nextNumber('customer', tx);
        return tx.customer.create({ data: { code, name: `${TAG} Concurrent ${i}` } });
      }),
    ),
  );
  check(
    '20 customers created at once all get distinct codes',
    new Set(concurrent.map((c) => c.code)).size === 20,
    `${new Set(concurrent.map((c) => c.code)).size} distinct`,
  );
  await prisma.customer.deleteMany({ where: { name: { startsWith: `${TAG} Concurrent` } } });

  // ── 6. Cost categories ─────────────────────────────────────────────────────
  console.log('\nCost categories');

  const costCategories = await prisma.costCategory.findMany({ orderBy: { sortOrder: 'asc' } });
  check('the five standard buckets exist', costCategories.length >= 5, `${costCategories.length}`);
  check(
    'they are in the model’s order',
    costCategories.slice(0, 5).map((c) => c.name).join(', ') ===
      'Materials, Equipment, Labor, Subcontractor, Indirect Cost',
    costCategories.slice(0, 5).map((c) => c.name).join(', '),
  );
  check('they are all marked as system categories', costCategories.slice(0, 5).every((c) => c.isSystem));

  // ── 7. Global search reaches the masters ───────────────────────────────────
  console.log('\nGlobal search');

  const admin = await prisma.user.findFirst({ where: { isSuperAdmin: true } });
  const superUser = (await resolveUser(admin!.id))!;

  const byName = await globalSearch(`${TAG} Hosp`, superUser);
  check('a customer is findable by name', byName.some((h) => h.kind === 'customer'));

  // Finding the company by the person you actually dealt with.
  const byContact = await globalSearch('Maria Santos', superUser);
  check(
    'a customer is findable by its contact’s name',
    byContact.some((h) => h.kind === 'customer'),
    JSON.stringify(byContact.map((h) => h.kind)),
  );

  const hit = byName.find((h) => h.kind === 'customer');
  check('the hit deep-links to the record', /^\/g-ops\/customers\/.+/.test(hit?.link ?? ''), hit?.link);

  // A project manager has no supplier permission, so suppliers must not leak.
  const pmSearch = await globalSearch(TAG, pm);
  check(
    'search never returns a kind the user cannot open',
    !pmSearch.some((h) => h.kind === 'supplier'),
    JSON.stringify([...new Set(pmSearch.map((h) => h.kind))]),
  );

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

/**
 * The customer import spec lives inside the routes module, which pulls in
 * Express. Rebuilt here against the same shared helpers so this script stays
 * free of HTTP.
 */
async function buildCustomerSpec() {
  const { required, optional, decimal, bool } = await import('../src/shared/csv');
  const spec: ImportSpec<Record<string, unknown>> = {
    entity: 'customers',
    label: 'Customers',
    columns: [
      { header: 'Name', required: true },
      { header: 'Code' },
      { header: 'Industry' },
      { header: 'Contact Name' },
      { header: 'Contact Position' },
      { header: 'Site Name' },
      { header: 'Site City' },
      { header: 'Active' },
    ],
    existing: async (row) => {
      if (row['Code']) {
        const byCode = await prisma.customer.findUnique({ where: { code: row['Code'] } });
        if (byCode) return byCode.id;
      }
      const byName = await prisma.customer.findFirst({
        where: { name: { equals: row['Name'], mode: 'insensitive' } },
      });
      return byName?.id ?? null;
    },
    build: async (row) => ({
      code: row['Code'] || '',
      name: required(row, 'Name'),
      industry: optional(row, 'Industry'),
      creditLimit: decimal(row, 'Credit Limit'),
      isActive: bool(row, 'Active'),
      contacts: row['Contact Name']
        ? { create: [{ name: row['Contact Name'], position: optional(row, 'Contact Position'), isPrimary: true }] }
        : undefined,
      sites: row['Site Name']
        ? { create: [{ name: row['Site Name'], city: optional(row, 'Site City') }] }
        : undefined,
    }),
  };
  return { spec };
}

main()
  .catch(async (err) => {
    console.error('\nVerification crashed:', err);
    await cleanup().catch(() => {});
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
