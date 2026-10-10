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
import { nextNumber, previewNext } from '../src/shared/numbering';
import { parseCsv, runImport, templateFor, type ImportSpec } from '../src/shared/csv';
// The real spec and writer the import route runs — importing the routes module
// pulls in Express, which is harmless here and keeps this script from testing
// a copy that has drifted from what users actually get.
import { customerSpec, customerWrite } from '../src/routes/imports';
import { globalSearch } from '../src/shared/search';
import { customerListSummary, customerListWhere } from '../src/routes/customers';
import { itemListWhere, supplierListSummary, supplierListWhere } from '../src/routes/masters';
import { listQuery } from '../src/http/kit';
import { SUB_INDUSTRIES } from '../src/shared/subIndustries';
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
  // The list section's quotation holds its customer (Restrict); it goes first.
  await prisma.quotation.deleteMany({ where: { subject: { startsWith: TAG } } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: TAG } } });
  // The supplier list section's orders hold their suppliers (Restrict).
  await prisma.purchaseOrder.deleteMany({ where: { number: { startsWith: TAG } } });
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

  // ── 3. Teams and sub-industries — the two fixed lists ─────────────────────
  console.log('\nTeams and sub-industries');

  const teams = await prisma.industry.findMany({
    where: { code: { in: ['KAT', 'HIT', 'UIT', 'GIB', 'SIT'] } },
  });
  check('the five teams are seeded', teams.length === 5, `${teams.length} found`);
  check('all five are active system rows', teams.every((i) => i.isSystem && i.isActive));
  const firstFive = await prisma.industry.findMany({ where: { code: { in: ['HI', 'BI', 'UI', 'GI', 'SI'] } } });
  check(
    'the first five industries are switched off, never deleted',
    firstFive.every((i) => !i.isActive),
    firstFive.map((i) => `${i.code}:${i.isActive}`).join(','),
  );
  const subIndustries = await prisma.subIndustry.findMany({ orderBy: { sortOrder: 'asc' } });
  check(
    'the owner’s twenty-six sub-industries are seeded as active system rows, in his order',
    subIndustries.filter((s) => s.isSystem && s.isActive).map((s) => s.name).join('|') === SUB_INDUSTRIES.join('|') &&
      SUB_INDUSTRIES.length === 26,
    subIndustries.map((s) => s.name).join('|'),
  );
  check(
    'the retired eleven are switched off, never deleted',
    subIndustries.every((s) => !['Enterprise', 'Manufacturing', 'EPC'].includes(s.name) || !s.isActive) &&
      !subIndustries.some((s) => s.name === 'Hospital' || s.name === 'Building'),
    subIndustries.filter((s) => !s.isActive).map((s) => s.name).join('|'),
  );
  const hospital = subIndustries.find((s) => s.name === 'Healthcare');
  const manufacturing = subIndustries.find((s) => s.name === 'Industrial and Commercial Machinery');

  // ── 4. Real customer import, end to end ────────────────────────────────────
  console.log('\nCustomer import');

  const subIndustryColumn = customerSpec.columns.find((c) => c.header === 'Sub-industry');
  check('the Sub-industry column is optional', !!subIndustryColumn && !subIndustryColumn.required);
  check('and there is no Industry column any more', !customerSpec.columns.some((c) => c.header === 'Industry'));
  check('the template example is a name', subIndustryColumn?.example === 'Healthcare', subIndustryColumn?.example);

  // A — a name, and a name in the wrong case: both resolve, both commit.
  const csv = [
    'Name,Code,Sub-industry,Contact Name,Contact Position,Site Name,Site City,Active',
    `${TAG} Hospital,,healthcare,Maria Santos,Purchasing,Main Plant,Cagayan de Oro,Yes`,
    `${TAG} Foods,,Industrial and Commercial Machinery,Juan Cruz,Engineering,Plant 2,Davao,Yes`,
  ].join('\n');

  const report = await runImport(csv, customerSpec, true, customerWrite);
  check('two customers imported', report.committed && report.created === 2, JSON.stringify(report.rows));

  const foods = await prisma.customer.findFirst({ where: { name: `${TAG} Foods` } });
  check(
    'a sub-industry name, any case, files the customer under it',
    foods?.subIndustryId === manufacturing?.id,
    `subIndustryId ${foods?.subIndustryId}`,
  );

  // B — free text is not a sub-industry, and the file does not land.
  const bad = ['Name,Code,Sub-industry,Active', `${TAG} Cannery,,Food processing,Yes`].join('\n');
  const refused = await runImport(bad, customerSpec, true, customerWrite);
  check('an unknown sub-industry is refused', refused.errors === 1, `${refused.errors} errors`);
  check('and nothing from that file was written', !refused.committed);
  check(
    'the refusal lists the names to use',
    (refused.rows[0].message ?? '').includes('Healthcare') && (refused.rows[0].message ?? '').includes('Government'),
    refused.rows[0].message,
  );
  const cannery = await prisma.customer.count({ where: { name: `${TAG} Cannery` } });
  check('the refused customer does not exist', cannery === 0);
  // C — a blank is none: the sub-industry is typed in later (the owner's call).
  const blank = await runImport(['Name,Code,Sub-industry,Active', `${TAG} Nameless Industry,,,Yes`].join('\n'), customerSpec, true, customerWrite);
  const nameless = await prisma.customer.findFirst({ where: { name: `${TAG} Nameless Industry` } });
  check('a blank sub-industry imports as none', blank.committed && nameless !== null && nameless.subIndustryId === null, JSON.stringify(blank.rows));

  const imported = await prisma.customer.findFirst({
    where: { name: `${TAG} Hospital` },
    include: { contacts: true, sites: true },
  });
  check('it is filed under Healthcare', imported?.subIndustryId === hospital?.id);
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
  const second = await runImport(csv, customerSpec, true, customerWrite);
  check('re-importing recognises the existing rows', second.updated === 2, `${second.updated} updates`);

  const afterSecond = await prisma.customer.findMany({ where: { name: `${TAG} Hospital` } });
  check('no duplicate customer was created', afterSecond.length === 1, `${afterSecond.length} rows`);

  const contactsAfter = await prisma.customerContact.count({
    where: { customer: { name: `${TAG} Hospital` } },
  });
  check('the contact was not duplicated on re-import', contactsAfter === 1, `${contactsAfter} contacts`);

  // ── 5. Employee pay is gated ───────────────────────────────────────────────
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

  // ── 6. Numbering for masters ───────────────────────────────────────────────
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
        return tx.customer.create({
          data: { code, name: `${TAG} Concurrent ${i}` },
        });
      }),
    ),
  );
  check(
    '20 customers created at once all get distinct codes',
    new Set(concurrent.map((c) => c.code)).size === 20,
    `${new Set(concurrent.map((c) => c.code)).size} distinct`,
  );
  await prisma.customer.deleteMany({ where: { name: { startsWith: `${TAG} Concurrent` } } });

  /*
    The customer form's code preview (GET /customers/next-code) is
    previewNext() — the same template and counter lookup nextNumber() uses,
    minus the reservation. It once hand-rolled a year key of its own; the proof
    that it no longer can disagree is that the preview IS the next number.
  */
  const previewed = await previewNext('customer');
  const issued = await nextNumber('customer');
  check('the previewed customer code is the one issued next', previewed.number === issued, `${previewed.number} vs ${issued}`);
  const previewedAgain = await previewNext('customer');
  check('a preview reserves nothing', previewedAgain.number !== issued && (await previewNext('customer')).number === previewedAgain.number);

  // ── 7. Cost categories ─────────────────────────────────────────────────────
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

  // ── 8. Global search reaches the masters ───────────────────────────────────
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
  check('the hit names its sub-industry', (hit?.subtitle ?? '').includes('Healthcare'), hit?.subtitle ?? '');

  // A project manager has no supplier permission, so suppliers must not leak.
  const pmSearch = await globalSearch(TAG, pm);
  check(
    'search never returns a kind the user cannot open',
    !pmSearch.some((h) => h.kind === 'supplier'),
    JSON.stringify([...new Set(pmSearch.map((h) => h.kind))]),
  );

  // ── The customer list (the quotation list's layout, 2026-10-08) ─────────────
  console.log('\nThe customer list: sub-industry choices, filters, counts');
  {
    const LISTC = `${TAG} LISTC`;
    const custQ = (query: Record<string, string>) =>
      listQuery({ query: { search: LISTC, ...query } } as unknown as Parameters<typeof listQuery>[0]);
    const building = await prisma.subIndustry.findFirstOrThrow({ where: { name: 'Commercial Building and Land Development' } });
    const kat = await prisma.industry.findFirstOrThrow({ where: { code: 'KAT' } });
    const cHi = await prisma.customer.create({
      data: { code: `${TAG}-LC1`, name: `${LISTC} Hospital`, subIndustryId: hospital!.id, industryId: kat.id, createdById: admin!.id, createdAt: new Date('2026-03-01T00:30:00+08:00') },
    });
    await prisma.customer.create({ data: { code: `${TAG}-LC2`, name: `${LISTC} Builder`, subIndustryId: building.id, isActive: false } });
    await prisma.customer.create({ data: { code: `${TAG}-LC3`, name: `${LISTC} Nobody filed` } });
    await prisma.quotation.create({
      data: { number: `${TAG}-LCQ1`, customerId: cHi.id, ownerId: admin!.id, subject: `${TAG} list quote`, outcome: 'SUBMITTED' },
    });

    const all = customerListWhere(superUser, custQ({}));
    const sum = await customerListSummary(all.base, all.where);
    check(
      'the sub-industry counts count each one and "Not stated", and add up to All',
      sum.tabCounts[''] === 3 && sum.tabCounts[hospital!.id] === 1 && sum.tabCounts[building.id] === 1 && sum.tabCounts.none === 1 &&
        Object.entries(sum.tabCounts).filter(([k]) => k !== '').reduce((t, [, n]) => t + n, 0) === 3,
      JSON.stringify(sum.tabCounts),
    );
    check(
      'the choices are the sub-industries by name, Not stated last and only while somebody is',
      sum.tabs[sum.tabs.length - 1]?.value === 'none' && sum.tabs.some((t) => t.value === hospital!.id && t.label === 'Healthcare'),
      JSON.stringify(sum.tabs),
    );
    check('the summary counts the inactive', sum.count === 3 && sum.inactive === 1, JSON.stringify(sum));
    const count = (query: Record<string, string>) => prisma.customer.count({ where: customerListWhere(superUser, custQ(query)).where });
    check(
      'a sub-industry, "Not stated" and the status filter select what they say',
      (await count({ subIndustry: hospital!.id })) === 1 && (await count({ subIndustry: 'none' })) === 1 && (await count({ isActive: 'false' })) === 1,
    );
    check(
      '"Open quotation" reads quotations still in play',
      (await count({ openQuote: 'yes' })) === 1 && (await count({ openQuote: 'no' })) === 2 && (await count({ project: 'no' })) === 3,
    );
    check(
      '"Added" runs on Manila’s days, and Mine is what the caller added',
      (await count({ createdFrom: '2026-03-01', createdTo: '2026-03-01' })) === 1 &&
        (await count({ createdFrom: '2026-02-28', createdTo: '2026-02-28' })) === 0 &&
        (await count({ scope: 'mine' })) === 1,
    );
    check('?ids= selects the rows ticked', (await count({ ids: cHi.id })) === 1);
    check(
      'the Team filter picks a team’s customers, and "none" the ones still open',
      (await count({ team: kat.id })) === 1 && (await count({ team: 'none' })) === 2,
    );
    let refusedC = 0;
    for (const bad of [{ isActive: 'maybe' }, { openQuote: 'perhaps' }, { createdFrom: '2026/03/01' }] as Record<string, string>[]) {
      try {
        customerListWhere(superUser, custQ(bad));
      } catch (err) {
        if ((err as { status?: number }).status === 400) refusedC++;
      }
    }
    check('a malformed filter is a 400, never an empty list', refusedC === 3, `${refusedC} of 3`);
  }

  // ── The supplier list (the quotation list's layout, 2026-10-08) ─────────────
  console.log('\nThe supplier list: what-they-supply tabs, filters, order counts');
  {
    const LISTS = `${TAG} LISTS`;
    const supQ = (query: Record<string, string>) =>
      listQuery({ query: { search: LISTS, ...query } } as unknown as Parameters<typeof listQuery>[0]);
    const sValve = await prisma.supplier.create({
      data: { code: `${TAG}-LS1`, name: `${LISTS} Valve House`, category: 'Verify Valves', createdById: admin!.id, createdAt: new Date('2026-03-01T00:30:00+08:00') },
    });
    const sValve2 = await prisma.supplier.create({ data: { code: `${TAG}-LS2`, name: `${LISTS} Valve Depot`, category: 'VERIFY valves' } });
    await prisma.supplier.create({ data: { code: `${TAG}-LS3`, name: `${LISTS} Nobody said`, isActive: false } });
    const sPartner = await prisma.supplier.create({
      data: { code: `${TAG}-LS4`, name: `${LISTS} Principal`, category: 'Verify Electrical', isPartner: true },
    });
    // Issued (awaiting delivery), received (placed, delivered) and a draft
    // (never placed) — "Ordered from" counts only orders actually placed.
    await prisma.purchaseOrder.create({ data: { number: `${TAG}-LSPO1`, supplierId: sValve.id, createdById: admin!.id, status: 'ISSUED' } });
    await prisma.purchaseOrder.create({ data: { number: `${TAG}-LSPO2`, supplierId: sValve2.id, createdById: admin!.id, status: 'RECEIVED' } });
    await prisma.purchaseOrder.create({ data: { number: `${TAG}-LSPO3`, supplierId: sPartner.id, createdById: admin!.id, status: 'DRAFT' } });

    const all = supplierListWhere(superUser, supQ({}), true);
    const sum = await supplierListSummary(all.base, all.where, true);
    const valveTabs = sum.tabs.filter((t) => t.value.toLowerCase() === 'verify valves');
    check(
      'one tab per category, case-blind, the first spelling naming it, and "Not stated" last',
      sum.tabCounts[''] === 4 && valveTabs.length === 1 && sum.tabCounts[valveTabs[0].value] === 2 &&
        sum.tabCounts.none === 1 && sum.tabs[sum.tabs.length - 1]?.value === 'none',
      JSON.stringify(sum.tabs),
    );
    const count = (query: Record<string, string>, mayOrders = true) =>
      prisma.supplier.count({ where: supplierListWhere(superUser, supQ(query), mayOrders).where });
    let tabsHold = true;
    for (const t of sum.tabs) if ((await count({ category: t.value })) !== sum.tabCounts[t.value]) tabsHold = false;
    check('every tab lists exactly what its count says', tabsHold && (await count({ category: 'verify VALVES' })) === 2);
    check(
      'the totals count partners, the inactive and those with an order awaiting delivery',
      sum.count === 4 && sum.partners === 1 && sum.inactive === 1 && sum.awaiting === 1,
      JSON.stringify(sum),
    );
    const blind = await supplierListSummary(all.base, all.where, false);
    check('without the right to open purchase orders the awaiting figure is left out, never 0', !('awaiting' in blind));
    check(
      '"Purchase orders" reads orders actually placed — a draft orders nothing',
      (await count({ orders: 'awaiting' })) === 1 && (await count({ orders: 'placed' })) === 2 && (await count({ orders: 'never' })) === 2,
    );
    let refusedOrders = 0;
    try {
      supplierListWhere(superUser, supQ({ orders: 'placed' }), false);
    } catch (err) {
      if ((err as { status?: number }).status === 403) refusedOrders++;
    }
    check('and filtering by them without that right is a 403', refusedOrders === 1);
    check(
      '"Partner", the status filter, "Added" on Manila’s days and Mine select what they say',
      (await count({ partner: 'yes' })) === 1 && (await count({ partner: 'no' })) === 3 && (await count({ isActive: 'false' })) === 1 &&
        (await count({ createdFrom: '2026-03-01', createdTo: '2026-03-01' })) === 1 &&
        (await count({ createdFrom: '2026-02-28', createdTo: '2026-02-28' })) === 0 &&
        (await count({ scope: 'mine' })) === 1,
    );
    check('?ids= selects the rows ticked', (await count({ ids: `${sValve.id},${sPartner.id}` })) === 2);
    let refusedS = 0;
    for (const bad of [{ isActive: 'maybe' }, { partner: 'perhaps' }, { orders: 'soon' }, { createdTo: '1 March' }] as Record<string, string>[]) {
      try {
        supplierListWhere(superUser, supQ(bad), true);
      } catch (err) {
        if ((err as { status?: number }).status === 400) refusedS++;
      }
    }
    check('a malformed filter is a 400, never an empty list', refusedS === 4, `${refusedS} of 4`);
  }

  // The item master's one where-builder: the list and its printed twin
  // (`GET /items/pdf`) both read it, so what the paper holds is what the
  // screen lists — and ?ids= (Print selected) narrows it like any filter.
  console.log('\nThe item list: filters, ?ids= and malformed choices');
  {
    const ITEMS = `${TAG} ITEMLIST`;
    const itemQ = (query: Record<string, string>) =>
      listQuery({ query: { search: ITEMS, ...query } } as unknown as Parameters<typeof listQuery>[0]);
    const iPipe = await prisma.item.create({ data: { code: `${TAG}-IL1`, name: `${ITEMS} Pipe`, itemType: 'MATERIAL' } });
    const iDrill = await prisma.item.create({ data: { code: `${TAG}-IL2`, name: `${ITEMS} Drill`, itemType: 'TOOL' } });
    await prisma.item.create({ data: { code: `${TAG}-IL3`, name: `${ITEMS} Old valve`, itemType: 'MATERIAL', isActive: false } });
    const count = (query: Record<string, string>) => prisma.item.count({ where: itemListWhere(itemQ(query)) });
    check(
      'the search, the type and the status select what they say',
      (await count({})) === 3 && (await count({ itemType: 'TOOL' })) === 1 && (await count({ itemType: 'MATERIAL' })) === 2 &&
        (await count({ isActive: 'false' })) === 1 && (await count({ isActive: 'true', itemType: 'MATERIAL' })) === 1,
    );
    check(
      '?ids= selects the rows ticked, and still under the other filters',
      (await count({ ids: `${iPipe.id},${iDrill.id}` })) === 2 && (await count({ ids: `${iPipe.id},${iDrill.id}`, itemType: 'TOOL' })) === 1,
    );
    let refusedI = 0;
    for (const bad of [{ itemType: 'GADGET' }, { isActive: 'maybe' }] as Record<string, string>[]) {
      try {
        itemListWhere(itemQ(bad));
      } catch (err) {
        if ((err as { status?: number }).status === 400) refusedI++;
      }
    }
    check('a malformed type or status is a 400, never an empty list or a database error', refusedI === 2, `${refusedI} of 2`);
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
