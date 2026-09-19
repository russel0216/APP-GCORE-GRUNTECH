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
      ['gfin', 'settings'],
      ['gfin', 'payments'],
    ],
    only: [
      'gops.projects.view_all',
      'gops.progress_billing.view_all',
      'gops.customers.view_all',
      'gchain.purchase_orders.view_all',
      'gchain.receiving.view_all',
      // Finance costs labour, so it needs the rates — model §4.4.
      'ghr.employees.view_all',
      'ghr.employee_rates.view_all',
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
      ['ghr', 'employee_rates'],
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
    // Prior approval is authorisation to work, not a cost decision, so the
    // supervisor who directed the work is the only sign-off. HR joins on the
    // actual filing, where the money is.
    documentType: 'overtime_prior',
    name: 'Overtime prior approval — supervisor',
    steps: [{ sequence: 1, name: 'Supervisor authorisation', approverType: 'SUPERVISOR' }],
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
    name: 'Budget Request — finance then management',
    // Deliberately NOT routed to project managers. A PM is normally the person
    // raising a budget request — routing step 1 back to their own role means
    // the only eligible approver is the requester, and the request stalls
    // forever. A budget increase is a money decision anyway.
    steps: [
      { sequence: 1, name: 'Finance review', approverType: 'ROLE', roleKey: 'finance' },
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
    name: 'Purchase Order — project manager then finance',
    // NOT routed to procurement: procurement is who raises a purchase order,
    // and nobody approves their own document. Routing step 1 back to their own
    // role would stall every order in a team with one buyer.
    //
    // The project manager owns the budget it spends; finance owns the cash that
    // leaves. Those are the two people with a reason to look.
    steps: [
      { sequence: 1, name: 'Project Manager', approverType: 'ROLE', roleKey: 'project_manager' },
      { sequence: 2, name: 'Finance approval', approverType: 'ROLE', roleKey: 'finance' },
    ],
  },
  {
    // A supplier's bill arrives in finance, so finance is the one who RAISES
    // it — which is exactly why finance cannot be a step on it. The check that
    // matters is the project manager who ordered the goods confirming they are
    // what turned up, and management on anything large.
    documentType: 'supplier_bill',
    name: 'Supplier bill — up to P50,000',
    maxAmount: 50_000,
    steps: [{ sequence: 1, name: 'Project Manager', approverType: 'ROLE', roleKey: 'project_manager' }],
  },
  {
    documentType: 'supplier_bill',
    name: 'Supplier bill — P50,000 and above',
    minAmount: 50_000,
    steps: [
      { sequence: 1, name: 'Project Manager', approverType: 'ROLE', roleKey: 'project_manager' },
      { sequence: 2, name: 'Management approval', approverType: 'ROLE', roleKey: 'executive' },
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
  //
  // Re-running the seed must never undo an administrator's deliberate change,
  // but it must still deliver permissions introduced by a later phase —
  // otherwise every new screen stays invisible to every existing role until
  // someone notices and ticks it by hand.
  //
  // Those two requirements only reconcile if the seed remembers what it has
  // already offered. A pair it has never offered is granted; a pair it has
  // offered before is left alone, because its absence now means someone
  // revoked it on purpose.
  const OFFER_KEY = 'seed.offeredRolePermissions';
  const offeredSetting = await prisma.setting.findUnique({ where: { key: OFFER_KEY } });
  const offered = new Set<string>((offeredSetting?.value as string[] | undefined) ?? []);
  const isFirstEverRun = offeredSetting === null;

  let grantedLater = 0;
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

    const neverOffered = [...keys].filter((k) => !offered.has(`${seed.key}:${k}`));
    const additions = neverOffered
      .map((k) => permissionByKey.get(k))
      .filter((id): id is string => !!id);

    if (additions.length) {
      await prisma.rolePermission.createMany({
        data: additions.map((permissionId) => ({ roleId: role.id, permissionId })),
        skipDuplicates: true,
      });
      if (!isFirstEverRun) grantedLater += additions.length;
    }

    for (const k of keys) offered.add(`${seed.key}:${k}`);
  }

  await prisma.setting.upsert({
    where: { key: OFFER_KEY },
    create: {
      key: OFFER_KEY,
      value: [...offered],
      description:
        'Role/permission pairs the seed has already offered. Prevents re-granting anything an administrator revoked, while still delivering permissions added by a later phase.',
    },
    update: { value: [...offered] },
  });

  console.log(
    `  ✓ Roles (${ROLES.length})${grantedLater ? ` — granted ${grantedLater} newly introduced permission(s)` : ''}`,
  );

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

  // Seeded workflows that were superseded by a corrected version. Left in place
  // but deactivated, so they stop matching new documents while any history
  // routed through them stays readable. Deleting them would orphan that.
  const RETIRED = [
    'Budget Request — management',
    'Purchase Order — procurement then finance',
  ];
  for (const name of RETIRED) {
    const stale = await prisma.approvalWorkflow.findFirst({ where: { name, isActive: true } });
    if (stale) {
      await prisma.approvalWorkflow.update({ where: { id: stale.id }, data: { isActive: false } });
      console.log(`  · Retired superseded workflow "${name}"`);
    }
  }

  for (const seed of WORKFLOWS) {
    const already = await prisma.approvalWorkflow.findFirst({
      where: { documentType: seed.documentType, name: seed.name },
      include: { _count: { select: { requests: true } } },
    });

    if (already) {
      // An unused seeded workflow is refreshed, so a corrected routing reaches
      // an existing database. One that has already routed documents is left
      // alone: it is in use, and the customer may have edited it deliberately.
      if (already._count.requests === 0) {
        await prisma.$transaction(async (tx) => {
          await tx.approvalStep.deleteMany({ where: { workflowId: already.id } });
          await tx.approvalStep.createMany({
            data: seed.steps.map((s) => ({
              workflowId: already.id,
              sequence: s.sequence,
              name: s.name,
              approverType: s.approverType,
              roleId: s.roleKey ? (roleByKey.get(s.roleKey) ?? null) : null,
            })),
          });
        });
      }
      continue;
    }

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

  // ── Cost categories ────────────────────────────────────────────────────────
  // The five buckets every costing, budget and cost-ledger row is grouped by
  // (model §5.1). Marked isSystem so they cannot be deleted out from under the
  // ledger; the labels stay editable.
  for (const [i, c] of [
    { code: 'MAT', name: 'Materials' },
    { code: 'EQP', name: 'Equipment' },
    { code: 'LAB', name: 'Labor' },
    { code: 'SUB', name: 'Subcontractor' },
    { code: 'IND', name: 'Indirect Cost' },
  ].entries()) {
    await prisma.costCategory.upsert({
      where: { code: c.code },
      create: { ...c, sortOrder: i, isSystem: true },
      update: { isSystem: true },
    });
  }
  console.log('  ✓ Cost categories (5)');

  // ── Item categories ────────────────────────────────────────────────────────
  // A starting tree for an industrial gas and mechanical contractor. Fully
  // editable — this is a head start, not a constraint.
  for (const c of [
    { code: 'PIPE', name: 'Piping & Fittings' },
    { code: 'VALV', name: 'Valves & Regulators' },
    { code: 'ELEC', name: 'Electrical & Controls' },
    { code: 'COMP', name: 'Compressors & Pumps' },
    { code: 'GASE', name: 'Gas Equipment' },
    { code: 'FAB', name: 'Fabrication Materials' },
    { code: 'CONS', name: 'Consumables' },
    { code: 'TOOL', name: 'Tools & Instruments' },
    { code: 'SAFE', name: 'Safety & PPE' },
  ]) {
    await prisma.itemCategory.upsert({ where: { code: c.code }, create: c, update: {} });
  }
  console.log('  ✓ Item categories (9)');

  // ── Warehouse ──────────────────────────────────────────────────────────────
  await prisma.warehouse.upsert({
    where: { code: 'MAIN' },
    create: { code: 'MAIN', name: 'Main Warehouse' },
    update: {},
  });
  console.log('  ✓ Warehouse');

  // ── Leave types ────────────────────────────────────────────────────────────
  // Philippine statutory minimum is five days of Service Incentive Leave. Most
  // employers split that into vacation and sick; the allotments here are a
  // starting point HR edits in G-HR › Settings, not a legal position.
  for (const t of [
    { code: 'VL', name: 'Vacation Leave', daysPerYear: 5, isPaid: true, requiresProof: false, sortOrder: 1 },
    { code: 'SL', name: 'Sick Leave', daysPerYear: 5, isPaid: true, requiresProof: true, sortOrder: 2 },
    { code: 'EL', name: 'Emergency Leave', daysPerYear: 3, isPaid: true, requiresProof: false, sortOrder: 3 },
    { code: 'BL', name: 'Bereavement Leave', daysPerYear: 3, isPaid: true, requiresProof: true, sortOrder: 4 },
    { code: 'LWOP', name: 'Leave Without Pay', daysPerYear: 0, isPaid: false, requiresProof: false, sortOrder: 9 },
  ]) {
    await prisma.leaveType.upsert({ where: { code: t.code }, create: t, update: {} });
  }
  console.log('  ✓ Leave types (5)');

  // ── HR rules ───────────────────────────────────────────────────────────────
  // Written once, then owned by HR. The overtime premium is the statutory 125%
  // for ordinary-day overtime; the face threshold is face-api's own default.
  await prisma.setting.upsert({
    where: { key: 'hr.rules' },
    create: {
      key: 'hr.rules',
      description: 'Working day, breaks, overtime premium and face-match threshold',
      value: {
        workStart: '08:00',
        workEnd: '17:00',
        graceMinutes: 15,
        breakMinutes: 60,
        dinnerBreakStart: '17:00',
        dinnerBreakEnd: '18:00',
        dinnerBreakMinutes: 60,
        overtimeMultiplier: 1.25,
        hoursPerDay: 8,
        faceThreshold: 0.6,
      },
    },
    update: {},
  });
  console.log('  ✓ HR rules');

  // ── Finance rules ──────────────────────────────────────────────────────────
  // Supplier withholding follows the usual BIR schedule — 1% on goods, 2% on
  // services — but defaults to zero on each bill, because withholding when you
  // should not have underpays a supplier and is awkward to unwind. These are
  // the SUGGESTIONS the bill screen offers, not an automatic deduction.
  await prisma.setting.upsert({
    where: { key: 'finance.rules' },
    create: {
      key: 'finance.rules',
      description: 'Payment terms, supplier withholding rates and aging buckets',
      value: {
        defaultTermsDays: 30,
        supplierEwtGoods: 0.01,
        supplierEwtServices: 0.02,
        agingBuckets: [30, 60, 90],
      },
    },
    update: {},
  });
  console.log('  ✓ Finance rules');

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
