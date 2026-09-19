/**
 * The permission registry — the single source of truth for what exists in
 * G-Core and who may do what to it.
 *
 * Every entry becomes a `Permission` row (`module.submodule.action`) at seed
 * time, and the same tree drives the navigation menu on the web side. That is
 * deliberate: it is what makes the requirement "I can customize what they can
 * access from G-OPS, G-HR, G-FIN and G-CHAIN, also until the menu of this
 * access" true by construction rather than by remembering to keep two lists
 * in step.
 *
 * `phase` is the build phase from docs/BUSINESS-OPERATIONS-MODEL.md §11.
 * Submodules from later phases are registered NOW — so their access can be
 * configured now — and render as "coming soon" until they ship.
 */

export const ACTIONS = [
  'view_own',
  'view_all',
  'create',
  'edit_own',
  'edit_all',
  'delete',
  'approve',
  'export',
] as const;

export type Action = (typeof ACTIONS)[number];

export const ACTION_LABELS: Record<Action, string> = {
  view_own: 'View Own',
  view_all: 'View All',
  create: 'Create',
  edit_own: 'Edit Own',
  edit_all: 'Edit All',
  delete: 'Delete',
  approve: 'Approve',
  export: 'Export',
};

/** A record users own and may only edit if theirs (quotations, costings…). */
const OWNED: Action[] = [
  'view_own',
  'view_all',
  'create',
  'edit_own',
  'edit_all',
  'delete',
  'export',
];
/** An owned record that also routes through the approval engine. */
const OWNED_APPROVABLE: Action[] = [...OWNED, 'approve'];
/** Shared reference data — no meaningful "own". */
const SHARED: Action[] = ['view_all', 'create', 'edit_all', 'delete', 'export'];
/** Read-only screens: dashboards, reports, registers. */
const READ: Action[] = ['view_all', 'export'];

export interface SubmoduleDef {
  key: string;
  label: string;
  path: string;
  actions: Action[];
  phase: number;
  /** Shown in the menu but not yet implemented. */
  note?: string;
  /**
   * Heading this screen sits under in the sidebar.
   *
   * G-OPS carries twenty-three screens spanning sales, delivery and
   * aftermarket; as one flat list nothing said that Approved Plans belongs to
   * delivery and Renewals does not. The grouping belongs here rather than in
   * the web app because the registry is the single source of the menu — a
   * second list in Shell.tsx would be a second thing to keep in step.
   *
   * Purely presentational: it takes no part in permission keys, so
   * allPermissions() is unaffected and the seed grants nothing new. A module
   * that sets none renders flat, exactly as it did before.
   */
  group?: string;
}

export interface ModuleDef {
  key: string;
  label: string;
  blurb: string;
  submodules: SubmoduleDef[];
}

export const REGISTRY: ModuleDef[] = [
  {
    key: 'gops',
    label: 'G-OPS',
    blurb: 'Operations — sales, projects, costing, after market',
    submodules: [
      { key: 'dashboard', group: 'Overview', label: 'Dashboard', path: '/g-ops', actions: READ, phase: 3 },
      { key: 'leads', group: 'Sales', label: 'Leads', path: '/g-ops/leads', actions: OWNED, phase: 3 },
      { key: 'customers', group: 'Sales', label: 'Customers', path: '/g-ops/customers', actions: SHARED, phase: 2 },
      { key: 'calendar', group: 'Sales', label: 'Calendar', path: '/g-ops/calendar', actions: READ, phase: 3 },
      { key: 'quotations', group: 'Sales', label: 'Quotations', path: '/g-ops/quotations', actions: OWNED_APPROVABLE, phase: 3 },
      { key: 'pipeline', group: 'Sales', label: 'Sales Pipeline', path: '/g-ops/pipeline', actions: READ, phase: 3 },
      { key: 'projects', group: 'Delivery', label: 'Projects', path: '/g-ops/projects', actions: OWNED, phase: 4 },
      // Plans live inside the project workspace; the menu entry opens the
      // register across all jobs.
      { key: 'plans', group: 'Delivery', label: 'Approved Plans', path: '/g-ops/plans', actions: OWNED_APPROVABLE, phase: 4, note: 'Managed from a project’s Plans tab' },
      { key: 'budget_monitoring', group: 'Delivery', label: 'Budget Monitoring', path: '/g-ops/budget-monitoring', actions: READ, phase: 4 },
      { key: 'purchase_requests', group: 'Delivery', label: 'Purchase Requests', path: '/g-ops/purchase-requests', actions: OWNED_APPROVABLE, phase: 5 },
      { key: 'budget_requests', group: 'Delivery', label: 'Budget Requests', path: '/g-ops/budget-requests', actions: OWNED_APPROVABLE, phase: 4 },
      { key: 'progress_billing', group: 'Delivery', label: 'Progress & Billing', path: '/g-ops/progress', actions: OWNED_APPROVABLE, phase: 4 },
      { key: 'costing', group: 'Sales', label: 'Costing', path: '/g-ops/costing', actions: OWNED_APPROVABLE, phase: 3 },
      // Aftermarket (Phase 8). The installed base is what turns a finished
      // project into a renewal pipeline — without it nobody can answer "what
      // did we put in that hospital, and when does its warranty run out".
      { key: 'aftermarket', group: 'Aftermarket', label: 'Aftermarket', path: '/g-ops/aftermarket', actions: READ, phase: 8, note: 'Overview and the aftermarket rules' },
      { key: 'installed_base', group: 'Aftermarket', label: 'Installed Base', path: '/g-ops/installed-base', actions: SHARED, phase: 8 },
      { key: 'service_contracts', group: 'Aftermarket', label: 'Service Contracts', path: '/g-ops/service-contracts', actions: OWNED, phase: 8 },
      { key: 'visits', group: 'Aftermarket', label: 'PM Schedule', path: '/g-ops/visits', actions: READ, phase: 8, note: 'Uses the Preventive Maintenance permissions to schedule and report' },
      { key: 'renewals', group: 'Aftermarket', label: 'Renewals', path: '/g-ops/renewals', actions: READ, phase: 8 },
      { key: 'report_templates', group: 'Aftermarket', label: 'Report Templates', path: '/g-ops/report-templates', actions: READ, phase: 8, note: 'Editing uses the Preventive Maintenance create permission' },
      { key: 'commissioning_reports', group: 'Aftermarket', label: 'Commissioning Reports', path: '/g-ops/commissioning', actions: OWNED_APPROVABLE, phase: 8 },
      { key: 'pm_reports', group: 'Aftermarket', label: 'Preventive Maintenance', path: '/g-ops/pm', actions: OWNED_APPROVABLE, phase: 8 },
      { key: 'inspection_reports', group: 'Aftermarket', label: 'Service Inspections', path: '/g-ops/inspections', actions: OWNED_APPROVABLE, phase: 8 },
      { key: 'service_costing', group: 'Aftermarket', label: 'Service Costing', path: '/g-ops/service-costing', actions: OWNED_APPROVABLE, phase: 8 },
    ],
  },
  {
    key: 'ghr',
    label: 'G-HR',
    blurb: 'Human resources — attendance, leave, overtime',
    submodules: [
      { key: 'clock', group: 'My day', label: 'Clock In/Out', path: '/g-hr/clock', actions: ['view_own', 'create'], phase: 6 },
      { key: 'dashboard', group: 'Overview', label: 'Dashboard', path: '/g-hr', actions: READ, phase: 6 },
      // The register behind the dashboard: every clock entry, with how the
      // person was identified. Gated by the dashboard permission — seeing the
      // day's counts and seeing the entries behind them are the same right.
      {
        key: 'attendance', group: 'Records',
        label: 'Attendance',
        path: '/g-hr/attendance',
        actions: READ,
        phase: 6,
        note: 'Uses the Dashboard permission',
      },
      { key: 'leave', group: 'My day', label: 'Leave', path: '/g-hr/leave', actions: OWNED_APPROVABLE, phase: 6 },
      { key: 'overtime', group: 'My day', label: 'Overtime', path: '/g-hr/overtime', actions: OWNED_APPROVABLE, phase: 6 },
      { key: 'employees', group: 'Records', label: 'Employees', path: '/g-hr/employees', actions: SHARED, phase: 2 },
      // Pay data is separated from the employee record on purpose. A project
      // manager needs headcount and assignment; they must not see salaries.
      // Labor cost reaches projects as a burdened rate, never as a wage.
      {
        key: 'employee_rates', group: 'Records',
        label: 'Employee Pay Rates',
        path: '/g-hr/employees',
        actions: ['view_all', 'edit_all'],
        phase: 2,
        note: 'Controls visibility of daily rate, burden and statutory numbers on the employee record',
      },
      { key: 'reports', group: 'Administration', label: 'HR Reports', path: '/g-hr/reports', actions: READ, phase: 6 },
      { key: 'settings', group: 'Administration', label: 'HR Settings', path: '/g-hr/settings', actions: ['view_all', 'edit_all'], phase: 6 },
    ],
  },
  {
    key: 'gfin',
    label: 'G-FIN',
    blurb: 'Finance — receivables, payables, cash',
    submodules: [
      { key: 'dashboard', group: 'Overview', label: 'Executive Dashboard', path: '/g-fin', actions: READ, phase: 7 },
      { key: 'ar', group: 'Money in', label: 'Accounts Receivable', path: '/g-fin/ar', actions: [...SHARED, 'approve'], phase: 7 },
      { key: 'ap', group: 'Money out', label: 'Accounts Payable', path: '/g-fin/ap', actions: [...SHARED, 'approve'], phase: 7 },
      { key: 'expenses', group: 'Money out', label: 'Expenses', path: '/g-fin/expenses', actions: OWNED_APPROVABLE, phase: 7 },
      // Every movement of money, in or out. Recording one is gated by the A/R
      // or A/P create permission depending on direction — seeing the register
      // is its own, lesser right.
      { key: 'payments', group: 'Money in', label: 'Payments', path: '/g-fin/payments', actions: READ, phase: 7 },
      { key: 'cashflow', group: 'Analysis', label: 'Cash Flow', path: '/g-fin/cash-flow', actions: READ, phase: 7 },
      { key: 'budget_vs_actual', group: 'Analysis', label: 'Budget vs Actual', path: '/g-fin/budget-vs-actual', actions: READ, phase: 7 },
      { key: 'reports', group: 'Analysis', label: 'Reports', path: '/g-fin/reports', actions: READ, phase: 7 },
      // Payment terms, supplier withholding and the aging buckets. Finance's
      // own rules — owning them should not require being a system
      // administrator, the same way HR owns the working day.
      {
        key: 'settings', group: 'Administration',
        label: 'Finance Settings',
        path: '/g-fin/settings',
        actions: ['view_all', 'edit_all'],
        phase: 7,
      },
    ],
  },
  {
    key: 'gchain',
    label: 'G-CHAIN',
    blurb: 'Supply chain — procurement, receiving, inventory',
    submodules: [
      { key: 'dashboard', group: 'Overview', label: 'Dashboard', path: '/g-chain', actions: READ, phase: 5 },
      { key: 'purchase_requests', group: 'Procurement', label: 'Purchase Requests', path: '/g-chain/purchase-requests', actions: OWNED_APPROVABLE, phase: 5 },
      { key: 'canvass', group: 'Procurement', label: 'Canvass / RFQ', path: '/g-chain/canvass', actions: OWNED, phase: 5 },
      { key: 'purchase_orders', group: 'Procurement', label: 'Purchase Orders', path: '/g-chain/purchase-orders', actions: OWNED_APPROVABLE, phase: 5 },
      { key: 'receiving', group: 'Warehouse', label: 'Receiving', path: '/g-chain/receiving', actions: SHARED, phase: 5 },
      { key: 'stock_issuance', group: 'Warehouse', label: 'Stock Issuance', path: '/g-chain/stock-issuance', actions: SHARED, phase: 5 },
      { key: 'borrow_slips', group: 'Warehouse', label: 'Borrow Slips', path: '/g-chain/borrow-slips', actions: SHARED, phase: 5 },
      { key: 'inventory', group: 'Warehouse', label: 'Inventory', path: '/g-chain/inventory', actions: SHARED, phase: 5 },
      { key: 'items', group: 'Master data', label: 'Item Master', path: '/g-chain/items', actions: SHARED, phase: 2 },
      { key: 'suppliers', group: 'Master data', label: 'Suppliers', path: '/g-chain/suppliers', actions: SHARED, phase: 2 },
      { key: 'warehouses', group: 'Master data', label: 'Warehouses', path: '/g-chain/warehouses', actions: SHARED, phase: 2 },
      { key: 'reports', group: 'Analysis', label: 'Reports', path: '/g-chain/reports', actions: READ, phase: 5 },
    ],
  },
  {
    // Phase 9. Deliberately a module of its own: these are the questions that
    // cross module boundaries, and no single division's dashboard can answer
    // them. It adds NO tables — every figure here is read off documents the
    // other eight phases already record, which is the only way the numbers can
    // never disagree with the records behind them.
    key: 'insights',
    label: 'Insights',
    blurb: 'Management reporting across every division',
    submodules: [
      { key: 'dashboard', label: 'Company Overview', path: '/insights', actions: READ, phase: 9 },
      { key: 'profitability', label: 'Project Profitability', path: '/insights/profitability', actions: READ, phase: 9 },
      { key: 'pipeline', label: 'Sales Analytics', path: '/insights/pipeline', actions: READ, phase: 9 },
      { key: 'cash', label: 'Cash Forecast', path: '/insights/cash-forecast', actions: READ, phase: 9 },
      { key: 'inventory', label: 'Inventory Analytics', path: '/insights/inventory', actions: READ, phase: 9 },
      { key: 'performance', label: 'Performance', path: '/insights/performance', actions: READ, phase: 9 },
    ],
  },
  {
    key: 'admin',
    label: 'Admin',
    blurb: 'Users, roles, workflows and company configuration',
    submodules: [
      { key: 'users', group: 'People', label: 'Users', path: '/admin/users', actions: SHARED, phase: 1 },
      { key: 'roles', group: 'People', label: 'Roles & Permissions', path: '/admin/roles', actions: SHARED, phase: 1 },
      { key: 'workflows', group: 'Process', label: 'Approval Workflows', path: '/admin/workflows', actions: SHARED, phase: 1 },
      { key: 'company', group: 'Configuration', label: 'Company Settings', path: '/admin/company', actions: ['view_all', 'edit_all'], phase: 1 },
      { key: 'numbering', group: 'Process', label: 'Numbering', path: '/admin/numbering', actions: ['view_all', 'edit_all'], phase: 1 },
      { key: 'categories', group: 'Configuration', label: 'Categories', path: '/admin/categories', actions: SHARED, phase: 2, note: 'Cost categories and item categories' },
      { key: 'templates', group: 'Process', label: 'Document Templates', path: '/admin/templates', actions: SHARED, phase: 1, note: 'PDF layouts ship in Phase 1; service report form templates in Phase 8' },
      { key: 'audit', group: 'Records', label: 'Audit Logs', path: '/admin/audit', actions: READ, phase: 1 },
      { key: 'settings', group: 'Configuration', label: 'System Settings', path: '/admin/settings', actions: ['view_all', 'edit_all'], phase: 1 },
    ],
  },
];

export interface PermissionDef {
  key: string;
  module: string;
  submodule: string;
  action: Action;
  label: string;
}

/** Flattens the registry into the rows the Permission table holds. */
export function allPermissions(): PermissionDef[] {
  const out: PermissionDef[] = [];
  for (const mod of REGISTRY) {
    for (const sub of mod.submodules) {
      for (const action of sub.actions) {
        out.push({
          key: `${mod.key}.${sub.key}.${action}`,
          module: mod.key,
          submodule: sub.key,
          action,
          label: `${mod.label} › ${sub.label} › ${ACTION_LABELS[action]}`,
        });
      }
    }
  }
  return out;
}

/** Every permission key for a submodule — used when granting a whole screen. */
export function permissionsFor(moduleKey: string, submoduleKey?: string): string[] {
  return allPermissions()
    .filter((p) => p.module === moduleKey && (!submoduleKey || p.submodule === submoduleKey))
    .map((p) => p.key);
}

export function findSubmodule(moduleKey: string, submoduleKey: string): SubmoduleDef | undefined {
  return REGISTRY.find((m) => m.key === moduleKey)?.submodules.find((s) => s.key === submoduleKey);
}
