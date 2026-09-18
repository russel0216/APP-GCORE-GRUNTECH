import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { allPermissions, permissionsFor } from '../src/permissions/registry';
import { DOCUMENT_TYPES } from '../src/shared/numbering';

const prisma = new PrismaClient();

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@gruntech.com';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe!2026';

/**
 * Role definitions.
 *
 * `grants` are (module, submodule?) pairs granting every action on that scope;
 * `only` grants specific permission keys. Roles are seeded once and then become
 * the customer's to edit — "Roles should be customizable" — so this is a
 * starting point, not a constraint.
 */
interface RoleSeed {
  key: string;
  name: string;
  description: string;
  grants?: [string, string?][];
  only?: string[];
}

const VIEW_OWN_SELF = (mod: string, sub: string) => [
  `${mod}.${sub}.view_own`,
  `${mod}.${sub}.create`,
  `${mod}.${sub}.edit_own`,
];

const ROLES: RoleSeed[] = [
  {
    key: 'executive',
    name: 'Executive / Management',
    description: 'Sees everything across the business, approves at the top band, changes nothing operationally',
    only: allPermissions()
      .filter((p) => ['view_all', 'export', 'approve'].includes(p.action))
      .map((p) => p.key)
      .filter((k) => !k.startsWith('admin.')),
  },
  {
    key: 'sales',
    name: 'Sales',
    description: 'Works own leads and quotations; sees the shared customer master',
    grants: [['gops', 'leads'], ['gops', 'customers'], ['gops', 'calendar']],
    only: [
      ...VIEW_OWN_SELF('gops', 'quotations'),
      'gops.quotations.view_all',
      'gops.quotations.export',
      ...VIEW_OWN_SELF('gops', 'costing'),
      'gops.costing.export',
      'gops.dashboard.view_all',
      'gops.pipeline.view_all',
      'gops.projects.view_all',
    ],
  },
  {
    key: 'sales_manager',
    name: 'Sales Manager',
    description: 'Everything Sales can do, plus approval of quotations and visibility over the whole pipeline',
    grants: [
      ['gops', 'leads'],
      ['gops', 'customers'],
      ['gops', 'calendar'],
      ['gops', 'quotations'],
      ['gops', 'pipeline'],
      ['gops', 'costing'],
    ],
    only: ['gops.dashboard.view_all', 'gops.projects.view_all', 'gops.projects.export'],
  },
  {
    key: 'project_manager',
    name: 'Project Manager',
    description: 'Runs projects — budget, procurement requests, progress and billing',
    grants: [
      ['gops', 'projects'],
      ['gops', 'plans'],
      ['gops', 'budget_monitoring'],
      ['gops', 'purchase_requests'],
      ['gops', 'budget_requests'],
      ['gops', 'progress_billing'],
      ['gops', 'costing'],
    ],
    only: [
      'gops.dashboard.view_all',
      'gops.customers.view_all',
      'gops.quotations.view_all',
      'gchain.purchase_requests.view_all',
      'gchain.purchase_orders.view_all',
      'gchain.inventory.view_all',
      'gfin.budget_vs_actual.view_all',
      'ghr.overtime.approve',
    ],
  },
  {
    key: 'project_engineer',
    name: 'Project Engineer',
    description: 'Executes the work: progress reports, purchase requests, plans',
    only: [
      'gops.projects.view_all',
      'gops.plans.view_all',
      ...VIEW_OWN_SELF('gops', 'progress_billing'),
      ...VIEW_OWN_SELF('gops', 'purchase_requests'),
      'gops.budget_monitoring.view_all',
      'gops.customers.view_all',
      'gchain.inventory.view_all',
    ],
  },
  {
    key: 'service_engineer',
    name: 'Service Engineer',
    description: 'After-market: commissioning, preventive maintenance and inspection reports',
    grants: [
      ['gops', 'commissioning_reports'],
      ['gops', 'pm_reports'],
      ['gops', 'inspection_reports'],
    ],
    only: [
      'gops.service_contracts.view_all',
      ...VIEW_OWN_SELF('gops', 'service_costing'),
      'gops.customers.view_all',
      'gchain.inventory.view_all',
      ...VIEW_OWN_SELF('gops', 'purchase_requests'),
    ],
  },
  {
    key: 'procurement',
    name: 'Procurement',
    description: 'Canvasses suppliers and issues purchase orders — does not receive and does not pay',
    grants: [
      ['gchain', 'canvass'],
      ['gchain', 'purchase_orders'],
      ['gchain', 'suppliers'],
      ['gchain', 'reports'],
    ],
    only: [
      'gchain.dashboard.view_all',
      'gchain.purchase_requests.view_all',
      'gchain.purchase_requests.edit_all',
      'gchain.inventory.view_all',
      'gops.projects.view_all',
    ],
  },
  {
    key: 'warehouse',
    name: 'Warehouse',
    description: 'Receives goods, issues stock, manages borrow slips — does not issue POs',
    grants: [
      ['gchain', 'receiving'],
      ['gchain', 'stock_issuance'],
      ['gchain', 'borrow_slips'],
      ['gchain', 'inventory'],
    ],
    only: [
      'gchain.dashboard.view_all',
      'gchain.purchase_orders.view_all',
      'gchain.reports.view_all',
      'gchain.reports.export',
    ],
  },
  {
    key: 'finance',
    name: 'Finance',
    description: 'Receivables, payables, expenses and cash — approves disbursements',
    grants: [
      ['gfin', 'ar'],
      ['gfin', 'ap'],
      ['gfin', 'expenses'],
      ['gfin', 'cashflow'],
      ['gfin', 'budget_vs_actual'],
      ['gfin', 'reports'],
      ['gfin', 'dashboard'],
    ],
    only: [
      'gops.projects.view_all',
      'gops.progress_billing.view_all',
      'gops.customers.view_all',
      'gchain.purchase_orders.view_all',
      'gchain.receiving.view_all',
    ],
  },
  {
    key: 'accounting',
    name: 'Accounting',
    description: 'Books the transactions; reads operations, does not change them',
    only: [
      'gfin.ar.view_all',
      'gfin.ar.create',
      'gfin.ar.edit_all',
      'gfin.ar.export',
      'gfin.ap.view_all',
      'gfin.ap.create',
      'gfin.ap.edit_all',
      'gfin.ap.export',
      'gfin.expenses.view_all',
      'gfin.reports.view_all',
      'gfin.reports.export',
      'gops.projects.view_all',
      'gchain.receiving.view_all',
    ],
  },
  {
    key: 'hr',
    name: 'HR',
    description: 'Employees, attendance, leave and overtime — the second approval on overtime',
    grants: [
      ['ghr', 'leave'],
      ['ghr', 'overtime'],
      ['ghr', 'employees'],
      ['ghr', 'reports'],
      ['ghr', 'settings'],
      ['ghr', 'dashboard'],
    ],
    only: ['ghr.clock.view_own', 'ghr.clock.create'],
  },
  {
    key: 'supervisor',
    name: 'Supervisor',
    description: 'Approves leave and overtime for their direct reports',
    only: [
      'ghr.clock.view_own',
      'ghr.clock.create',
      'ghr.dashboard.view_all',
      ...VIEW_OWN_SELF('ghr', 'leave'),
      'ghr.leave.view_all',
      'ghr.leave.approve',
      ...VIEW_OWN_SELF('ghr', 'overtime'),
      'ghr.overtime.view_all',
      'ghr.overtime.approve',
    ],
  },
  {
    key: 'employee',
    name: 'Employee',
    description: 'Clocks in, files leave and overtime, sees their own records',
    only: [
      'ghr.clock.view_own',
      'ghr.clock.create',
      ...VIEW_OWN_SELF('ghr', 'leave'),
      ...VIEW_OWN_SELF('ghr', 'overtime'),
    ],
  },
];

/**
 * Default approval workflows.
 *
 * Purchase Requests are banded by amount — the configurable threshold from the
 * requirements. Overtime deliberately has TWO steps: the supervisor who
 * directed the work, then HR. Cost only posts to a project when both exist
 * (model §4.4), and that rule lives in the workflow shape rather than in code.
 */
interface WorkflowSeed {
  documentType: string;
  name: string;
  minAmount?: number;
  maxAmount?: number;
  steps: {
    sequence: number;
    name: string;
    approverType: 'ROLE' | 'USER' | 'SUPERVISOR' | 'HR';
    roleKey?: string;
  }[];
}

const WORKFLOWS: WorkflowSeed[] = [
  {
    documentType: 'leave_request',
    name: 'Leave — supervisor, else HR',
    steps: [{ sequence: 1, name: 'Supervisor approval', approverType: 'SUPERVISOR' }],
  },
  {
    documentType: 'overtime_request',
    name: 'Overtime — supervisor then HR',
    steps: [
      { sequence: 1, name: 'Supervisor approval', approverType: 'SUPERVISOR' },
      { sequence: 2, name: 'HR approval', approverType: 'HR' },
    ],
  },
  {
    documentType: 'purchase_request',
    name: 'Purchase Request — up to ₱50,000',
    maxAmount: 50_000,
    steps: [
      { sequence: 1, name: 'Project Manager', approverType: 'ROLE', roleKey: 'project_manager' },
    ],
  },
  {
    documentType: 'purchase_request',
    name: 'Purchase Request — ₱50,000 and above',
    minAmount: 50_000,
    steps: [
      { sequence: 1, name: 'Project Manager', approverType: 'ROLE', roleKey: 'project_manager' },
      { sequence: 2, name: 'Finance review', approverType: 'ROLE', roleKey: 'finance' },
      { sequence: 3, name: 'Management approval', approverType: 'ROLE', roleKey: 'executive' },
    ],
  },
  {
    documentType: 'budget_request',
    name: 'Budget Request — management',
    steps: [
      { sequence: 1, name: 'Project Manager', approverType: 'ROLE', roleKey: 'project_manager' },
      { sequence: 2, name: 'Management approval', approverType: 'ROLE', roleKey: 'executive' },
    ],
  },
  {
    documentType: 'quotation',
    name: 'Quotation — sales manager',
    steps: [{ sequence: 1, name: 'Sales Manager', approverType: 'ROLE', roleKey: 'sales_manager' }],
  },
  {
    documentType: 'purchase_order',
    name: 'Purchase Order — procurement then finance',
    steps: [
      { sequence: 1, name: 'Procurement head', approverType: 'ROLE', roleKey: 'procurement' },
      { sequence: 2, name: 'Finance approval', approverType: 'ROLE', roleKey: 'finance' },
    ],
  },
  {
    documentType: 'expense',
    name: 'Expense claim — supervisor then finance',
    steps: [
      { sequence: 1, name: 'Supervisor approval', approverType: 'SUPERVISOR' },
      { sequence: 2, name: 'Finance approval', approverType: 'ROLE', roleKey: 'finance' },
    ],
  },
];

async function main() {
  console.log('Seeding G-CORE…\n');

  // ── Company ────────────────────────────────────────────────────────────────
  await prisma.company.upsert({
    where: { id: 'company' },
    create: {
      id: 'company',
      name: 'Gruntechnology Corp',
      legalName: 'Gruntechnology Corporation',
      country: 'Philippines',
      currency: 'PHP',
      numberPrefix: 'GT',
    },
    update: {},
  });
  console.log('  ✓ Company');

  // ── Permissions ────────────────────────────────────────────────────────────
  const defs = allPermissions();
  for (const def of defs) {
    await prisma.permission.upsert({
      where: { key: def.key },
      create: def,
      update: { label: def.label, module: def.module, submodule: def.submodule, action: def.action },
    });
  }
  // Drop permissions that no longer exist in the registry, so the registry
  // really is the source of truth rather than an append-only list.
  const stale = await prisma.permission.findMany({
    where: { key: { notIn: defs.map((d) => d.key) } },
    select: { key: true },
  });
  if (stale.length) {
    await prisma.permission.deleteMany({ where: { key: { in: stale.map((s) => s.key) } } });
    console.log(`  ✓ Permissions (${defs.length}, removed ${stale.length} stale)`);
  } else {
    console.log(`  ✓ Permissions (${defs.length})`);
  }

  const permissionByKey = new Map(
    (await prisma.permission.findMany({ select: { id: true, key: true } })).map((p) => [p.key, p.id]),
  );

  // ── Roles ──────────────────────────────────────────────────────────────────
  for (const seed of ROLES) {
    const keys = new Set<string>(seed.only ?? []);
    for (const [mod, sub] of seed.grants ?? []) {
      for (const key of permissionsFor(mod, sub)) keys.add(key);
    }
    const ids = [...keys].map((k) => permissionByKey.get(k)).filter((id): id is string => !!id);

    const role = await prisma.role.upsert({
      where: { key: seed.key },
      create: { key: seed.key, name: seed.name, description: seed.description, isSystem: true },
      update: { name: seed.name, description: seed.description },
    });

    // Only set permissions on first creation — after that they belong to the
    // customer. Re-running the seed must not undo an administrator's edits.
    const existing = await prisma.rolePermission.count({ where: { roleId: role.id } });
    if (existing === 0) {
      await prisma.rolePermission.createMany({
        data: ids.map((permissionId) => ({ roleId: role.id, permissionId })),
        skipDuplicates: true,
      });
    }
  }
  console.log(`  ✓ Roles (${ROLES.length})`);

  // ── Numbering ──────────────────────────────────────────────────────────────
  for (const dt of DOCUMENT_TYPES) {
    await prisma.numberSequence.upsert({
      where: { documentType_periodKey: { documentType: dt.type, periodKey: '' } },
      create: {
        documentType: dt.type,
        label: dt.label,
        typeCode: dt.code,
        pattern: '{PREFIX}-{TYPE}-{YYYY}-{SEQ}',
        period: 'YEAR',
        periodKey: '',
        padding: 4,
        lastNumber: 0,
      },
      update: { label: dt.label },
    });
  }
  console.log(`  ✓ Numbering (${DOCUMENT_TYPES.length} document types)`);

  // ── Approval workflows ─────────────────────────────────────────────────────
  const roleByKey = new Map(
    (await prisma.role.findMany({ select: { id: true, key: true } })).map((r) => [r.key, r.id]),
  );

  for (const seed of WORKFLOWS) {
    const already = await prisma.approvalWorkflow.findFirst({
      where: { documentType: seed.documentType, name: seed.name },
    });
    if (already) continue;

    await prisma.approvalWorkflow.create({
      data: {
        documentType: seed.documentType,
        name: seed.name,
        minAmount: seed.minAmount ?? null,
        maxAmount: seed.maxAmount ?? null,
        steps: {
          create: seed.steps.map((s) => ({
            sequence: s.sequence,
            name: s.name,
            approverType: s.approverType,
            roleId: s.roleKey ? (roleByKey.get(s.roleKey) ?? null) : null,
          })),
        },
      },
    });
  }
  console.log(`  ✓ Approval workflows (${WORKFLOWS.length})`);

  // ── Departments ────────────────────────────────────────────────────────────
  for (const d of [
    { code: 'MGT', name: 'Management' },
    { code: 'SLS', name: 'Sales' },
    { code: 'ENG', name: 'Engineering' },
    { code: 'SVC', name: 'Service' },
    { code: 'PRC', name: 'Procurement' },
    { code: 'WHS', name: 'Warehouse' },
    { code: 'FIN', name: 'Finance & Accounting' },
    { code: 'HR', name: 'Human Resources' },
  ]) {
    await prisma.department.upsert({ where: { code: d.code }, create: d, update: {} });
  }
  console.log('  ✓ Departments');

  // ── Super admin ────────────────────────────────────────────────────────────
  const existingAdmin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
  if (!existingAdmin) {
    await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        name: 'System Administrator',
        position: 'Super Admin',
        passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 10),
        isSuperAdmin: true,
      },
    });
    console.log(`  ✓ Super admin created: ${ADMIN_EMAIL}`);
    console.log(`\n  ⚠  Password: ${ADMIN_PASSWORD}`);
    console.log('     Change it on first sign-in — Account › Change password.\n');
  } else {
    console.log(`  ✓ Super admin already exists: ${ADMIN_EMAIL}`);
  }

  console.log('Seed complete.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
