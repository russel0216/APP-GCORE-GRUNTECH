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
      { key: 'dashboard', label: 'Dashboard', path: '/g-ops', actions: READ, phase: 3 },
      { key: 'leads', label: 'Leads', path: '/g-ops/leads', actions: OWNED, phase: 3 },
      { key: 'customers', label: 'Customers', path: '/g-ops/customers', actions: SHARED, phase: 2 },
      { key: 'calendar', label: 'Calendar', path: '/g-ops/calendar', actions: READ, phase: 3 },
      { key: 'quotations', label: 'Quotations', path: '/g-ops/quotations', actions: OWNED_APPROVABLE, phase: 3 },
      { key: 'pipeline', label: 'Sales Pipeline', path: '/g-ops/pipeline', actions: READ, phase: 3 },
      { key: 'projects', label: 'Projects', path: '/g-ops/projects', actions: OWNED, phase: 4 },
      // Plans live inside the project workspace; the menu entry opens the
      // register across all jobs.
      { key: 'plans', label: 'Approved Plans', path: '/g-ops/plans', actions: OWNED_APPROVABLE, phase: 4, note: 'Managed from a project’s Plans tab' },
      { key: 'budget_monitoring', label: 'Budget Monitoring', path: '/g-ops/budget-monitoring', actions: READ, phase: 4 },
      { key: 'purchase_requests', label: 'Purchase Requests', path: '/g-ops/purchase-requests', actions: OWNED_APPROVABLE, phase: 5 },
      { key: 'budget_requests', label: 'Budget Requests', path: '/g-ops/budget-requests', actions: OWNED_APPROVABLE, phase: 4 },
      { key: 'progress_billing', label: 'Progress & Billing', path: '/g-ops/progress', actions: OWNED_APPROVABLE, phase: 4 },
      { key: 'costing', label: 'Costing', path: '/g-ops/costing', actions: OWNED_APPROVABLE, phase: 3 },
      { key: 'service_contracts', label: 'Service Contracts', path: '/g-ops/service-contracts', actions: OWNED, phase: 8 },
      { key: 'commissioning_reports', label: 'Commissioning Reports', path: '/g-ops/commissioning', actions: OWNED_APPROVABLE, phase: 8 },
      { key: 'pm_reports', label: 'Preventive Maintenance', path: '/g-ops/pm', actions: OWNED_APPROVABLE, phase: 8 },
      { key: 'inspection_reports', label: 'Service Inspections', path: '/g-ops/inspections', actions: OWNED_APPROVABLE, phase: 8 },
      { key: 'service_costing', label: 'Service Costing', path: '/g-ops/service-costing', actions: OWNED_APPROVABLE, phase: 8 },
    ],
  },
  {
    key: 'ghr',
    label: 'G-HR',
    blurb: 'Human resources — attendance, leave, overtime',
    submodules: [
      { key: 'clock', label: 'Clock In/Out', path: '/g-hr/clock', actions: ['view_own', 'create'], phase: 6 },
      { key: 'dashboard', label: 'Dashboard', path: '/g-hr', actions: READ, phase: 6 },
      // The register behind the dashboard: every clock entry, with how the
      // person was identified. Gated by the dashboard permission — seeing the
      // day's counts and seeing the entries behind them are the same right.
      {
        key: 'attendance',
        label: 'Attendance',
        path: '/g-hr/attendance',
        actions: READ,
        phase: 6,
        note: 'Uses the Dashboard permission',
      },
      { key: 'leave', label: 'Leave', path: '/g-hr/leave', actions: OWNED_APPROVABLE, phase: 6 },
      { key: 'overtime', label: 'Overtime', path: '/g-hr/overtime', actions: OWNED_APPROVABLE, phase: 6 },
      { key: 'employees', label: 'Employees', path: '/g-hr/employees', actions: SHARED, phase: 2 },
      // Pay data is separated from the employee record on purpose. A project
      // manager needs headcount and assignment; they must not see salaries.
      // Labor cost reaches projects as a burdened rate, never as a wage.
      {
        key: 'employee_rates',
        label: 'Employee Pay Rates',
        path: '/g-hr/employees',
        actions: ['view_all', 'edit_all'],
        phase: 2,
        note: 'Controls visibility of daily rate, burden and statutory numbers on the employee record',
      },
      { key: 'reports', label: 'HR Reports', path: '/g-hr/reports', actions: READ, phase: 6 },
      { key: 'settings', label: 'HR Settings', path: '/g-hr/settings', actions: ['view_all', 'edit_all'], phase: 6 },
    ],
  },
  {
    key: 'gfin',
    label: 'G-FIN',
    blurb: 'Finance — receivables, payables, cash',
    submodules: [
      { key: 'dashboard', label: 'Executive Dashboard', path: '/g-fin', actions: READ, phase: 7 },
      { key: 'ar', label: 'Accounts Receivable', path: '/g-fin/ar', actions: [...SHARED, 'approve'], phase: 7 },
      { key: 'ap', label: 'Accounts Payable', path: '/g-fin/ap', actions: [...SHARED, 'approve'], phase: 7 },
      { key: 'expenses', label: 'Expenses', path: '/g-fin/expenses', actions: OWNED_APPROVABLE, phase: 7 },
      // Every movement of money, in or out. Recording one is gated by the A/R
      // or A/P create permission depending on direction — seeing the register
      // is its own, lesser right.
      { key: 'payments', label: 'Payments', path: '/g-fin/payments', actions: READ, phase: 7 },
      { key: 'cashflow', label: 'Cash Flow', path: '/g-fin/cash-flow', actions: READ, phase: 7 },
      { key: 'budget_vs_actual', label: 'Budget vs Actual', path: '/g-fin/budget-vs-actual', actions: READ, phase: 7 },
      { key: 'reports', label: 'Reports', path: '/g-fin/reports', actions: READ, phase: 7 },
      // Payment terms, supplier withholding and the aging buckets. Finance's
      // own rules — owning them should not require being a system
      // administrator, the same way HR owns the working day.
      {
        key: 'settings',
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
      { key: 'dashboard', label: 'Dashboard', path: '/g-chain', actions: READ, phase: 5 },
      { key: 'purchase_requests', label: 'Purchase Requests', path: '/g-chain/purchase-requests', actions: OWNED_APPROVABLE, phase: 5 },
      { key: 'canvass', label: 'Canvass / RFQ', path: '/g-chain/canvass', actions: OWNED, phase: 5 },
      { key: 'purchase_orders', label: 'Purchase Orders', path: '/g-chain/purchase-orders', actions: OWNED_APPROVABLE, phase: 5 },
      { key: 'receiving', label: 'Receiving', path: '/g-chain/receiving', actions: SHARED, phase: 5 },
      { key: 'stock_issuance', label: 'Stock Issuance', path: '/g-chain/stock-issuance', actions: SHARED, phase: 5 },
      { key: 'borrow_slips', label: 'Borrow Slips', path: '/g-chain/borrow-slips', actions: SHARED, phase: 5 },
      { key: 'inventory', label: 'Inventory', path: '/g-chain/inventory', actions: SHARED, phase: 5 },
      { key: 'items', label: 'Item Master', path: '/g-chain/items', actions: SHARED, phase: 2 },
      { key: 'suppliers', label: 'Suppliers', path: '/g-chain/suppliers', actions: SHARED, phase: 2 },
      { key: 'warehouses', label: 'Warehouses', path: '/g-chain/warehouses', actions: SHARED, phase: 2 },
      { key: 'reports', label: 'Reports', path: '/g-chain/reports', actions: READ, phase: 5 },
    ],
  },
  {
    key: 'admin',
    label: 'Admin',
    blurb: 'Users, roles, workflows and company configuration',
    submodules: [
      { key: 'users', label: 'Users', path: '/admin/users', actions: SHARED, phase: 1 },
      { key: 'roles', label: 'Roles & Permissions', path: '/admin/roles', actions: SHARED, phase: 1 },
      { key: 'workflows', label: 'Approval Workflows', path: '/admin/workflows', actions: SHARED, phase: 1 },
      { key: 'company', label: 'Company Settings', path: '/admin/company', actions: ['view_all', 'edit_all'], phase: 1 },
      { key: 'numbering', label: 'Numbering', path: '/admin/numbering', actions: ['view_all', 'edit_all'], phase: 1 },
      { key: 'categories', label: 'Categories', path: '/admin/categories', actions: SHARED, phase: 2, note: 'Cost categories and item categories' },
      { key: 'templates', label: 'Document Templates', path: '/admin/templates', actions: SHARED, phase: 1, note: 'PDF layouts ship in Phase 1; service report form templates in Phase 8' },
      { key: 'audit', label: 'Audit Logs', path: '/admin/audit', actions: READ, phase: 1 },
      { key: 'settings', label: 'System Settings', path: '/admin/settings', actions: ['view_all', 'edit_all'], phase: 1 },
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
