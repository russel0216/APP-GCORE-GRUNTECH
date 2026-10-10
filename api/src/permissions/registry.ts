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
 * `phase` is the build phase from docs/BUSINESS-OPERATIONS-MODEL.md §11 that
 * brought the screen; every phase has shipped.
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

// An entry lists only the actions something checks. A box on Admin › Roles
// that nothing reads is a promise the app does not keep: approval goes to
// the workflow's roles (shared/approvals.ts), never to an "approve" key, and a
// numbered document is cancelled, not deleted. verify-foundation fails on an
// action no route or screen checks.

/** A record users own and may only edit if theirs (quotations, costings…). */
const OWNED: Action[] = ['view_own', 'view_all', 'create', 'edit_own', 'edit_all', 'delete'];
/** An owned document that is cancelled or closed, never deleted. */
const OWNED_KEPT: Action[] = ['view_own', 'view_all', 'create', 'edit_own', 'edit_all'];
/** Shared reference data — no meaningful "own". */
const SHARED: Action[] = ['view_all', 'create', 'edit_all', 'delete'];
/** Shared records that are kept once written (a receipt, a login). */
const SHARED_KEPT: Action[] = ['view_all', 'create', 'edit_all'];
/** Registers and calendars: reading is the whole right. */
const READ: Action[] = ['view_all'];
/** Dashboards and reports, whose CSV and PDF are a right of their own. */
const REPORT: Action[] = ['view_all', 'export'];
/** A settings page. */
const SETTINGS: Action[] = ['view_all', 'edit_all'];

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
  /**
   * Kept off the sidebar, the strip and Ctrl+K's screen list, but still a
   * screen: its route, permissions and every link to it work as before. The
   * owner's call for the SCORO Archive (2026-10-04) — reached from a
   * customer, a continued quotation or a search hit, not browsed — and for
   * the project registers (2026-10-06), each a tab inside the project.
   */
  hidden?: boolean;
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
      { key: 'dashboard', group: 'Overview', label: 'Dashboard', path: '/g-ops', actions: REPORT, phase: 3 },
      // The Sales strip, in the order of the sales flow (2026-10-08, the
      // owner's call): pipeline, leads, quotations, sales orders, then the
      // masters and the calendar. The registry's order is the strip's order.
      { key: 'pipeline', group: 'Sales', label: 'Sales Pipeline', path: '/g-ops/pipeline', actions: REPORT, phase: 3 },
      // The Forecast (2026-10-08, the owner's call): every open quotation by
      // its expected closing date, weekly, monthly, quarterly or annually.
      { key: 'forecast', group: 'Sales', label: 'Forecast', path: '/g-ops/forecast', actions: REPORT, phase: 3,
        note: 'Consolidated expected closing dates of the open quotations — weekly, monthly, quarterly, annually' },
      { key: 'leads', group: 'Sales', label: 'Leads', path: '/g-ops/leads', actions: OWNED, phase: 3 },
      { key: 'quotations', group: 'Sales', label: 'Quotations', path: '/g-ops/quotations', actions: OWNED, phase: 3 },
      { key: 'sales_orders', group: 'Sales', label: 'Sales Orders', path: '/g-ops/sales-orders', actions: OWNED, phase: 9,
        note: 'Books a quotation in operations — SCORO\'s "Create invoice"' },
      { key: 'customers', group: 'Sales', label: 'Customers', path: '/g-ops/customers', actions: SHARED, phase: 2 },
      { key: 'partners', group: 'Sales', label: 'Partners', path: '/g-ops/partners', actions: SHARED, phase: 3,
        note: 'Principals whose equipment Gruntech sells and services: catalogues, price lists, software. One supplier record, seen from Sales.' },
      { key: 'calendar', group: 'Sales', label: 'Calendar', path: '/g-ops/calendar', actions: READ, phase: 3 },
      // The SCORO history, read-only. Continuing an open SCORO quote raises a live
      // quotation under the quotations permission; 'create' here is the admin import.
      { key: 'quote_archive', group: 'Sales', label: 'SCORO Archive', path: '/g-ops/quote-archive', actions: ['view_all', 'export', 'create'], phase: 3, hidden: true,
        note: 'Read-only SCORO quotation history. Create = run the SCORO import; continuing a quote uses the Quotations create permission.' },
      // Project Management (2026-10-06, the owner's order): Costing, Job
      // Orders, Projects — the way the old gasiontech G-CORE arranged it. The
      // registers that follow are hidden (rule: hidden, never deleted): each
      // is a tab inside the project, and a link from the Projects page.
      { key: 'costing', group: 'Project Management', label: 'Costing', path: '/g-ops/costing', actions: OWNED, phase: 3 },
      { key: 'job_orders', group: 'Project Management', label: 'Job Orders', path: '/g-ops/job-orders', actions: OWNED_KEPT, phase: 8, note: 'The project work order: sales raises it on a quotation, the project manager and the team leader approve, and approval builds the project' },
      // The design team's queue (2026-10-09, the owner's call): a request for a
      // drawing, with files, revisions and a comment thread. No approval
      // route — "Approve" here is the Designer Lead's right to dispatch:
      // assign and reassign requests, set priority on any, close any.
      { key: 'cad_job_orders', group: 'Project Management', label: 'CAD J.O.', path: '/g-ops/cad-job-orders', actions: ['view_own', 'view_all', 'create', 'edit_own', 'edit_all', 'export', 'approve'], phase: 9,
        note: 'Requests to the design team: files, revisions (R0, R1…), progress, priority and a comment thread. Edit All = the design team (progress, revisions, priority on what is assigned to them); Approve = the Designer Lead (assigns, reassigns, closes any).' },
      { key: 'projects', group: 'Project Management', label: 'Projects', path: '/g-ops/projects', actions: OWNED_KEPT, phase: 4 },
      { key: 'plans', group: 'Project Management', label: 'Approved Plans', path: '/g-ops/plans', actions: OWNED, phase: 4, hidden: true, note: 'Managed from a project’s Approved Plans tab' },
      { key: 'budget_monitoring', group: 'Project Management', label: 'Budget Monitoring', path: '/g-ops/budget-monitoring', actions: READ, phase: 4, hidden: true },
      { key: 'purchase_requests', group: 'Project Management', label: 'Purchase Requests', path: '/g-ops/purchase-requests', actions: ['view_own', 'view_all', 'edit_own', 'edit_all'], phase: 5, hidden: true },
      { key: 'budget_requests', group: 'Project Management', label: 'Budget Requests', path: '/g-ops/budget-requests', actions: OWNED, phase: 4, hidden: true },
      { key: 'progress_billing', group: 'Project Management', label: 'Progress & Billing', path: '/g-ops/progress', actions: ['view_own', 'view_all', 'create', 'edit_own', 'edit_all', 'delete', 'approve'], phase: 4, hidden: true },
      // Aftermarket (Phase 8). The installed base is what turns a finished
      // project into a renewal pipeline — without it nobody can answer "what
      // did we put in that hospital, and when does its warranty run out".
      { key: 'aftermarket', group: 'Aftermarket', label: 'Aftermarket', path: '/g-ops/aftermarket', actions: READ, phase: 8, note: 'Overview and the aftermarket rules' },
      { key: 'installed_base', group: 'Aftermarket', label: 'Installed Base', path: '/g-ops/installed-base', actions: SHARED_KEPT, phase: 8 },
      { key: 'service_contracts', group: 'Aftermarket', label: 'Service Contracts', path: '/g-ops/service-contracts', actions: OWNED_KEPT, phase: 8 },
      { key: 'visits', group: 'Aftermarket', label: 'Service Schedule', path: '/g-ops/visits', actions: READ, phase: 8, note: 'Every visit on one calendar; scheduling and reporting use the Preventive Maintenance permissions' },
      { key: 'renewals', group: 'Aftermarket', label: 'Renewals', path: '/g-ops/renewals', actions: READ, phase: 8 },
      { key: 'report_templates', group: 'Service reports', label: 'Report Templates', path: '/g-ops/report-templates', actions: READ, phase: 8, note: 'Editing uses the Preventive Maintenance create permission' },
      { key: 'commissioning_reports', group: 'Service reports', label: 'Commissioning Reports', path: '/g-ops/commissioning', actions: OWNED_KEPT, phase: 8 },
      { key: 'pm_reports', group: 'Service reports', label: 'Preventive Maintenance', path: '/g-ops/pm', actions: OWNED_KEPT, phase: 8 },
      { key: 'inspection_reports', group: 'Service reports', label: 'Service Inspections', path: '/g-ops/inspections', actions: OWNED_KEPT, phase: 8 },
      { key: 'service_costing', group: 'Aftermarket', label: 'Service Costing', path: '/g-ops/service-costing', actions: ['view_own', 'view_all', 'edit_own', 'edit_all'], phase: 8, hidden: true },
    ],
  },
  {
    key: 'ghr',
    label: 'G-HR',
    blurb: 'Human resources — attendance, leave, overtime',
    submodules: [
      { key: 'dashboard', group: 'Overview', label: 'Dashboard', path: '/g-hr', actions: REPORT, phase: 6 },
      { key: 'clock', group: 'My day', label: 'Clock In/Out', path: '/g-hr/clock', actions: ['view_own'], phase: 6 },
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
      { key: 'leave', group: 'My day', label: 'Leave', path: '/g-hr/leave', actions: OWNED_KEPT, phase: 6 },
      { key: 'overtime', group: 'My day', label: 'Overtime', path: '/g-hr/overtime', actions: OWNED_KEPT, phase: 6 },
      // An internal meeting with invitees. Sits in 'My day' because it is a
      // thing that happens to a person's day, not an HR control. The Meet link
      // is pasted from the organiser's own Google account — G-Core holds no
      // Google credentials and sends no email (shared/calendar-links.ts).
      { key: 'meetings', group: 'My day', label: 'Meetings', path: '/g-hr/meetings', actions: OWNED, phase: 6 },
      { key: 'employees', group: 'Records', label: 'Employees', path: '/g-hr/employees', actions: SHARED, phase: 2 },
      // Pay data is separated from the employee record on purpose. A project
      // manager needs headcount and assignment; they must not see salaries.
      // Labor cost reaches projects as a burdened rate, never as a wage.
      {
        key: 'employee_rates', group: 'Records',
        label: 'Employee Pay Rates',
        path: '/g-hr/employees',
        actions: SETTINGS,
        phase: 2,
        note: 'Controls visibility of daily rate, burden and statutory numbers on the employee record', hidden: true },
      // The authorised staffing pattern: positions per department, how many of
      // each are approved, who fills them and what is vacant. Filled/vacant are
      // counted off active employees, never stored.
      { key: 'plantilla', group: 'Records', label: 'Plantilla', path: '/g-hr/plantilla', actions: SHARED, phase: 6 },
      // Pay data and evaluations are the two things on an employee a colleague
      // must not see; both live behind their own key rather than under employees.
      { key: 'evaluations', group: 'People', label: 'Evaluations', path: '/g-hr/evaluations', actions: OWNED_KEPT, phase: 6, note: 'Probationary and trainee evaluations — the evaluator owns the record; the person evaluated reads it once approved' },
      // Turnover of accountabilities before someone leaves, cleared by the area
      // that owns each item and signed off through the approval engine. The
      // screen opens with the 12-month turnover figures so the label is true.
      { key: 'clearances', group: 'People', label: 'Turnover & Clearance', path: '/g-hr/clearances', actions: OWNED_KEPT, phase: 6 },
      // Gruntech Academy.
      { key: 'courses', group: 'Academy', label: 'Courses', path: '/g-hr/academy/courses', actions: SHARED, phase: 6, note: 'Course master, and which departments and positions must hold each course' },
      { key: 'training_calendar', group: 'Academy', label: 'Training Calendar', path: '/g-hr/academy/calendar', actions: READ, phase: 6 },
      { key: 'training_sessions', group: 'Academy', label: 'Training Sessions', path: '/g-hr/academy/sessions', actions: OWNED, phase: 6, note: 'Create is the Trainer right — schedule, enrol and complete a session; Edit Own covers sessions you train' },
      { key: 'passport', group: 'Academy', label: 'My Training Passport', path: '/g-hr/academy/passport', actions: ['view_own', 'create'], phase: 6, note: 'Create lets an employee enter an external certification for HR to verify' },
      { key: 'passports', group: 'Academy', label: 'Training Passports', path: '/g-hr/academy/passports', actions: ['view_all', 'create', 'edit_all', 'delete', 'approve'], phase: 6, note: 'Every employee’s passport; verify external certifications; record training directly' },
      { key: 'reports', group: 'Administration', label: 'HR Reports', path: '/g-hr/reports', actions: REPORT, phase: 6 },
      { key: 'settings', group: 'Administration', label: 'HR Settings', path: '/g-hr/settings', actions: SETTINGS, phase: 6 },
    ],
  },
  {
    key: 'gfin',
    label: 'G-FIN',
    blurb: 'Finance — receivables, payables, cash',
    submodules: [
      { key: 'dashboard', group: 'Overview', label: 'Executive Dashboard', path: '/g-fin', actions: REPORT, phase: 7 },
      { key: 'ar', group: 'Money in', label: 'Accounts Receivable', path: '/g-fin/ar', actions: SHARED, phase: 7 },
      { key: 'ap', group: 'Money out', label: 'Accounts Payable', path: '/g-fin/ap', actions: SHARED, phase: 7 },
      { key: 'expenses', group: 'Money out', label: 'Expenses', path: '/g-fin/expenses', actions: OWNED_KEPT, phase: 7 },
      { key: 'cash_advances', group: 'Money out', label: 'Cash Advances', path: '/g-fin/cash-advances', actions: OWNED_KEPT, phase: 7 },
      // Project cash: the budget requests finance releases and the teams
      // liquidate. Raised on the project (gops.budget_requests); this is
      // finance's window on every one of them — awaiting release, out with a
      // team, overdue, done.
      { key: 'budget_requests', group: 'Money out', label: 'Budget Requests', path: '/g-fin/budget-requests', actions: READ, phase: 7, note: 'Every project’s budget requests: approved ones to release, released ones awaiting liquidation. Releasing is the A/P create right.' },
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
        actions: SETTINGS,
        phase: 7,
      },
    ],
  },
  {
    key: 'gchain',
    label: 'G-CHAIN',
    blurb: 'Supply chain — procurement, receiving, inventory',
    submodules: [
      { key: 'dashboard', group: 'Overview', label: 'Dashboard', path: '/g-chain', actions: REPORT, phase: 5 },
      { key: 'purchase_requests', group: 'Procurement', label: 'Purchase Requests', path: '/g-chain/purchase-requests', actions: OWNED, phase: 5 },
      { key: 'canvass', group: 'Procurement', label: 'Canvass / RFQ', path: '/g-chain/canvass', actions: OWNED_KEPT, phase: 5 },
      { key: 'purchase_orders', group: 'Procurement', label: 'Purchase Orders', path: '/g-chain/purchase-orders', actions: OWNED, phase: 5 },
      { key: 'receiving', group: 'Warehouse', label: 'Receiving', path: '/g-chain/receiving', actions: SHARED_KEPT, phase: 5 },
      { key: 'stock_issuance', group: 'Warehouse', label: 'Stock Issuance', path: '/g-chain/stock-issuance', actions: SHARED, phase: 5 },
      { key: 'borrow_slips', group: 'Warehouse', label: 'Borrow Slips', path: '/g-chain/borrow-slips', actions: SHARED_KEPT, phase: 5 },
      { key: 'inventory', group: 'Warehouse', label: 'Inventory', path: '/g-chain/inventory', actions: ['view_all', 'edit_all'], phase: 5 },
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
      { key: 'dashboard', label: 'Company Overview', path: '/insights', actions: REPORT, phase: 9 },
      { key: 'profitability', label: 'Project Profitability', path: '/insights/profitability', actions: REPORT, phase: 9 },
      { key: 'pipeline', label: 'Sales Analytics', path: '/insights/pipeline', actions: REPORT, phase: 9 },
      { key: 'cash', label: 'Cash Forecast', path: '/insights/cash-forecast', actions: REPORT, phase: 9 },
      { key: 'inventory', label: 'Inventory Analytics', path: '/insights/inventory', actions: REPORT, phase: 9 },
      { key: 'performance', label: 'Performance', path: '/insights/performance', actions: REPORT, phase: 9 },
    ],
  },
  {
    key: 'admin',
    label: 'Admin',
    blurb: 'Users, roles, workflows and company configuration',
    submodules: [
      { key: 'users', group: 'People', label: 'Users', path: '/admin/users', actions: SHARED_KEPT, phase: 1 },
      { key: 'roles', group: 'People', label: 'Roles & Permissions', path: '/admin/roles', actions: SHARED, phase: 1 },
      { key: 'workflows', group: 'Process', label: 'Approval Workflows', path: '/admin/workflows', actions: SHARED, phase: 1 },
      { key: 'company', group: 'Configuration', label: 'Company Settings', path: '/admin/company', actions: SETTINGS, phase: 1 },
      { key: 'numbering', group: 'Process', label: 'Numbering', path: '/admin/numbering', actions: SETTINGS, phase: 1 },
      { key: 'categories', group: 'Configuration', label: 'Categories', path: '/admin/categories', actions: SHARED, phase: 2, note: 'Cost, item and industry categories' },
      { key: 'templates', group: 'Process', label: 'Document Templates', path: '/admin/templates', actions: SETTINGS, phase: 1,
        note: 'Service report form templates (Phase 8). The quotation’s PDF layout is under PDF Templates.', hidden: true },
      { key: 'pdf_templates', group: 'Process', label: 'PDF Templates', path: '/admin/pdf-templates', actions: SETTINGS, phase: 1,
        note: 'Lay out the quotation and sales order PDFs: place the boxes and choose what each one prints' },
      { key: 'pipeline_stages', group: 'Process', label: 'Pipeline Stages', path: '/admin/pipeline-stages', actions: SETTINGS, phase: 3,
        note: 'The sales pipeline’s stages, as SCORO’s statuses: name, odds, colour and which are on the board' },
      { key: 'audit', group: 'Records', label: 'Audit Logs', path: '/admin/audit', actions: READ, phase: 1 },
      { key: 'settings', group: 'Configuration', label: 'System Settings', path: '/admin/settings', actions: SETTINGS, phase: 1 },
      { key: 'appearance', group: 'Configuration', label: 'Appearance & Layout', path: '/admin/appearance', actions: SETTINGS, phase: 1, note: 'Spacing, type, colour and layout of every screen' },
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
