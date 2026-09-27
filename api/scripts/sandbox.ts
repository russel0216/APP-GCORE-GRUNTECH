/**
 * Test sandbox — people and data to actually try the system with.
 *
 *   npx tsx scripts/sandbox.ts          create it
 *   npx tsx scripts/sandbox.ts --clear  remove it again
 *
 * Every user it creates has the same password and an @sandbox.local address,
 * so signing in as different roles is quick and removing them afterwards is
 * one command. Nothing here touches records you created yourself.
 *
 * This is for a laptop. It refuses to run against a production database, and
 * it would be a poor idea on the server for the obvious reason that eight
 * people would share one password.
 */

import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { nextNumber } from '../src/shared/numbering';

if (env.isProduction) {
  console.error('Refusing to run against a production database.');
  process.exit(1);
}

const DOMAIN = '@sandbox.local';
const PASSWORD = 'Sandbox!2026';
const D = (v: number) => new Prisma.Decimal(v);

/** Who to create, and what they can do. Mirrors a real small contractor. */
const PEOPLE: {
  name: string;
  login: string;
  roles: string[];
  position: string;
  reportsTo?: string;
  rate?: number;
}[] = [
  { name: 'Ramon Bautista',   login: 'director',  roles: ['executive'],       position: 'Managing Director' },
  { name: 'Cecilia Tan',      login: 'sales',     roles: ['sales_manager'],   position: 'Sales Manager',      reportsTo: 'director', rate: 2200 },
  // A salesperson distinct from the manager who approves their quotations, and
  // a second project manager. Not padding: with one holder of each role, the
  // only person who could approve a document is the person who raised it, and
  // the engine refuses that. audit-workflows.ts reports it as a fault, because
  // in a real company it is one.
  { name: 'Paolo Jimenez',    login: 'agent',     roles: ['sales'],           position: 'Sales Executive',    reportsTo: 'sales',    rate: 1500 },
  { name: 'Miguel Reyes',     login: 'pm',        roles: ['project_manager'], position: 'Project Manager',    reportsTo: 'director', rate: 2000 },
  { name: 'Teresa Lim',       login: 'pm2',       roles: ['project_manager'], position: 'Project Manager',    reportsTo: 'director', rate: 2000 },
  { name: 'Grace Villanueva', login: 'finance',   roles: ['finance'],         position: 'Finance Officer',    reportsTo: 'director', rate: 1800 },
  { name: 'Lito Ocampo',      login: 'hr',        roles: ['hr'],              position: 'HR Officer',         reportsTo: 'director', rate: 1600 },
  { name: 'Danilo Cruz',      login: 'service',   roles: ['service_manager'], position: 'Service Manager',    reportsTo: 'director', rate: 1900 },
  { name: 'Arnel Mendoza',    login: 'engineer',  roles: ['project_engineer'],position: 'Project Engineer',   reportsTo: 'pm',       rate: 1400 },
  { name: 'Joel Santiago',    login: 'tech',      roles: ['service_engineer'],position: 'Service Engineer',   reportsTo: 'service',  rate: 1300 },
  { name: 'Erwin Dela Peña',  login: 'buyer',     roles: ['procurement'],     position: 'Purchasing Officer', reportsTo: 'finance',  rate: 1300 },
  { name: 'Rosa Aquino',      login: 'store',     roles: ['warehouse'],       position: 'Warehouse Custodian',reportsTo: 'pm',       rate: 1100 },
];

const ITEMS: { code: string; name: string; unit: string; cost: number; reorder: number; category: RegExp }[] = [
  { code: 'SS-PIPE-50',  name: 'Stainless pipe 50mm x 6m',      unit: 'length', cost: 2850, reorder: 20, category: /pipe/i },
  { code: 'SS-ELB-50',   name: 'Stainless elbow 50mm 90deg',    unit: 'pcs',    cost: 480,  reorder: 40, category: /pipe/i },
  { code: 'VLV-BALL-50', name: 'Ball valve 50mm stainless',     unit: 'pcs',    cost: 3200, reorder: 10, category: /valv/i },
  { code: 'VLV-REG-O2',  name: 'Oxygen pressure regulator',     unit: 'pcs',    cost: 8500, reorder: 5,  category: /valv/i },
  { code: 'ELE-PNL-30',  name: 'Control panel enclosure 30A',   unit: 'pcs',    cost: 12500, reorder: 3, category: /elec/i },
  { code: 'ELE-CBL-4C',  name: 'Power cable 4C x 4.0mm',        unit: 'metre',  cost: 185,  reorder: 200, category: /elec/i },
  { code: 'CMP-FLT-AIR', name: 'Compressor air filter element', unit: 'pcs',    cost: 1650, reorder: 8,  category: /comp/i },
  { code: 'CMP-OIL-20L', name: 'Compressor oil 20L',            unit: 'pail',   cost: 4200, reorder: 6,  category: /comp/i },
  { code: 'CON-WELD-32', name: 'Welding rod 3.2mm stainless',   unit: 'kg',     cost: 620,  reorder: 25, category: /cons/i },
  { code: 'SAF-PPE-SET', name: 'PPE set (helmet, gloves, vest)',unit: 'set',    cost: 1450, reorder: 15, category: /safe/i },
];

async function clear() {
  console.log('\nRemoving the sandbox…\n');

  const users = await prisma.user.findMany({
    where: { email: { endsWith: DOMAIN } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);

  if (ids.length) {
    // Anything that points at these people has to go first, or the foreign
    // keys refuse — which is the database protecting real history, correctly.
    await prisma.approvalAction.deleteMany({ where: { approverId: { in: ids } } });
    await prisma.approvalRequest.deleteMany({ where: { requesterId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.savedFilter.deleteMany({ where: { userId: { in: ids } } });
    await prisma.attachment.deleteMany({ where: { uploadedById: { in: ids } } });

    await prisma.leaveRequest.deleteMany({ where: { employee: { userId: { in: ids } } } });
    await prisma.overtimeRequest.deleteMany({ where: { employee: { userId: { in: ids } } } });
    await prisma.leaveBalance.deleteMany({ where: { employee: { userId: { in: ids } } } });
    await prisma.attendance.deleteMany({ where: { employee: { userId: { in: ids } } } });
    await prisma.faceEnrollment.deleteMany({ where: { employee: { userId: { in: ids } } } });
    await prisma.employee.deleteMany({ where: { userId: { in: ids } } });

    await prisma.user.updateMany({ where: { supervisorId: { in: ids } }, data: { supervisorId: null } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  const codes = ITEMS.map((i) => i.code);
  await prisma.inventoryTransaction.deleteMany({ where: { item: { code: { in: codes } } } });
  await prisma.inventoryBalance.deleteMany({ where: { item: { code: { in: codes } } } });
  await prisma.item.deleteMany({ where: { code: { in: codes } } });

  await prisma.customerSite.deleteMany({ where: { customer: { code: { startsWith: 'SBX-' } } } });
  await prisma.customer.deleteMany({ where: { code: { startsWith: 'SBX-' } } });
  await prisma.supplier.deleteMany({ where: { code: { startsWith: 'SBX-' } } });

  console.log(`Removed ${ids.length} user(s) and their sandbox data.`);
  console.log('Your own records, and the GT-PRJ-2026-0006 worked example, are untouched.\n');
}

async function create() {
  console.log('\nBuilding the sandbox…\n');

  const hash = await bcrypt.hash(PASSWORD, 10);

  // ── People ─────────────────────────────────────────────────────────────
  const byLogin = new Map<string, string>();

  for (const p of PEOPLE) {
    const email = `${p.login}${DOMAIN}`;
    const roles = await prisma.role.findMany({ where: { key: { in: p.roles } } });
    if (roles.length !== p.roles.length) {
      const found = new Set(roles.map((r) => r.key));
      throw new Error(`Missing role(s): ${p.roles.filter((k) => !found.has(k)).join(', ')} — run the seed first.`);
    }

    const user = await prisma.user.upsert({
      where: { email },
      create: {
        email,
        name: p.name,
        position: p.position,
        passwordHash: hash,
        roles: { create: roles.map((r) => ({ roleId: r.id })) },
      },
      update: { name: p.name, position: p.position, passwordHash: hash },
    });
    byLogin.set(p.login, user.id);
  }

  // The reporting line lives on User, because the approval engine routes by
  // user and SUPERVISOR steps read it. Set after everyone exists.
  for (const p of PEOPLE) {
    if (!p.reportsTo) continue;
    await prisma.user.update({
      where: { id: byLogin.get(p.login)! },
      data: { supervisorId: byLogin.get(p.reportsTo)! },
    });
  }

  // ── Employee records, so HR works ──────────────────────────────────────
  // A user is a login; an employee is a person. Clocking in, leave and
  // overtime all need the second, and the two are linked 1:1.
  const departments = await prisma.department.findMany();
  const dept = (match: RegExp) => departments.find((d) => match.test(d.name))?.id ?? null;

  for (const p of PEOPLE) {
    if (!p.rate) continue;
    const userId = byLogin.get(p.login)!;
    const existing = await prisma.employee.findUnique({ where: { userId } });
    if (existing) continue;

    const [firstName, ...rest] = p.name.split(' ');
    await prisma.employee.create({
      data: {
        employeeNo: await nextNumber('employee'),
        firstName,
        lastName: rest.join(' ') || firstName,
        userId,
        position: p.position,
        departmentId:
          dept(/sales/i) && /Sales/.test(p.position) ? dept(/sales/i)
          : /Service/.test(p.position) ? dept(/service/i)
          : /Engineer|Project/.test(p.position) ? dept(/engineer/i)
          : dept(/management|admin/i),
        dateHired: new Date(Date.UTC(2024, 0, 15)),
        dailyRate: D(p.rate),
        // Burdened cost = daily rate x this. A project bears the real cost of
        // an hour, which is more than what lands in the payslip.
        burdenMultiplier: D(1.4),
        isActive: true,
      },
    });
  }

  // ── Customers and sites ────────────────────────────────────────────────
  const customers = [
    { code: 'SBX-C001', name: 'St. Luke’s Medical Center — Quezon City', terms: '30 days', site: 'Main Hospital', city: 'Quezon City', industry: 'HI' },
    { code: 'SBX-C002', name: 'Davao Doctors Hospital', terms: '45 days', site: 'Annex Building', city: 'Davao City', industry: 'HI' },
    { code: 'SBX-C003', name: 'Cebu Industrial Gases Inc.', terms: '15 days', site: 'Mandaue Plant', city: 'Mandaue', industry: 'GI' },
  ];
  // Every customer is filed under an industry (the seed creates the five);
  // a sandbox customer without one would only ever show as "Unclassified".
  const industryIds = new Map(
    (await prisma.industry.findMany({ select: { id: true, code: true } })).map((i) => [i.code, i.id]),
  );
  for (const c of customers) {
    const industryId = industryIds.get(c.industry) ?? null;
    const customer = await prisma.customer.upsert({
      where: { code: c.code },
      create: { code: c.code, name: c.name, paymentTerms: c.terms, creditLimit: D(2_000_000), industryId },
      // Fills an unclassified sandbox customer from before industries existed;
      // leaves one somebody has reclassified by hand alone.
      update: {},
    });
    if (!customer.industryId && industryId) {
      await prisma.customer.update({ where: { id: customer.id }, data: { industryId } });
    }
    const site = await prisma.customerSite.findFirst({
      where: { customerId: customer.id, name: c.site },
    });
    if (!site) {
      await prisma.customerSite.create({
        data: { customerId: customer.id, name: c.site, city: c.city },
      });
    }
  }

  // ── Suppliers ──────────────────────────────────────────────────────────
  const suppliers = [
    { code: 'SBX-S001', name: 'Metro Steel Supply Corp.', category: 'Piping and fittings', terms: '30 days' },
    { code: 'SBX-S002', name: 'Pacific Valves & Controls', category: 'Valves and regulators', terms: '30 days' },
    { code: 'SBX-S003', name: 'Northern Electrical Trading', category: 'Electrical', terms: '15 days' },
    { code: 'SBX-S004', name: 'Allied Fabrication Services', category: 'Subcontract fabrication', terms: '45 days' },
  ];
  for (const s of suppliers) {
    await prisma.supplier.upsert({
      where: { code: s.code },
      create: { code: s.code, name: s.name, category: s.category, paymentTerms: s.terms, city: 'Metro Manila' },
      update: {},
    });
  }

  // ── Items ──────────────────────────────────────────────────────────────
  const itemCategories = await prisma.itemCategory.findMany();
  const costCategories = await prisma.costCategory.findMany({ orderBy: { sortOrder: 'asc' } });
  const materials = costCategories[0];

  for (const i of ITEMS) {
    await prisma.item.upsert({
      where: { code: i.code },
      create: {
        code: i.code,
        name: i.name,
        unit: i.unit,
        standardCost: D(i.cost),
        reorderLevel: D(i.reorder),
        categoryId: itemCategories.find((c) => i.category.test(c.name))?.id ?? null,
        costCategoryId: materials?.id ?? null,
      },
      update: {},
    });
  }

  // ── Report it ──────────────────────────────────────────────────────────
  const rows = await prisma.user.findMany({
    where: { email: { endsWith: DOMAIN } },
    select: {
      name: true,
      email: true,
      position: true,
      supervisor: { select: { name: true } },
      roles: { select: { role: { select: { name: true } } } },
    },
    orderBy: { email: 'asc' },
  });

  console.log(`Everybody's password is:  ${PASSWORD}\n`);
  console.log('  Sign in as                     Who they are          Reports to');
  console.log('  ' + '-'.repeat(76));
  for (const u of rows) {
    console.log(
      `  ${u.email.padEnd(30)} ${(u.roles[0]?.role.name ?? '').padEnd(21)} ${u.supervisor?.name ?? '-'}`,
    );
  }

  const [items, custs, sups, emps] = await Promise.all([
    prisma.item.count(),
    prisma.customer.count(),
    prisma.supplier.count(),
    prisma.employee.count(),
  ]);
  console.log(`\n  ${custs} customers, ${sups} suppliers, ${items} items, ${emps} employees.`);
  console.log('\nRemove it all again with:  npx tsx scripts/sandbox.ts --clear\n');
}

const clearing = process.argv.includes('--clear');

(clearing ? clear() : create())
  .catch((err) => {
    console.error('\nSandbox failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
