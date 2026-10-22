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
  'view_team',
  'view_all',
  'create',
  'edit_own',
  'edit_team',
  'edit_all',
  'delete',
  'approve',
  'export',
] as const;

export type Action = (typeof ACTIONS)[number];

export const ACTION_LABELS: Record<Action, string> = {
  view_own: 'View Own',
  view_team: 'View Team',
  view_all: 'View All',
  create: 'Create',
  edit_own: 'Manage Own',
  edit_team: 'Manage Team',
  edit_all: 'Manage All',
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
const OWNED: Action[] = ['view_own', 'view_team', 'view_all', 'create', 'edit_own', 'edit_team', 'edit_all', 'delete'];
/** An owned document that is cancelled or closed, never deleted. */
const OWNED_KEPT: Action[] = ['view_own', 'view_team', 'view_all', 'create', 'edit_own', 'edit_team', 'edit_all'];
/**
 * Shared reference data. Since 2026-10-18 (the owner's call: "every screen
 * with Edit All should have Edit Own and View Own") it carries the own pair
 * too: View Own is the records one ADDED (`createdById` — `own` on the entry
 * says what it is), Edit Own changes only those. Same keys as OWNED.
 */
const SHARED: Action[] = ['view_own', 'view_team', 'view_all', 'create', 'edit_own', 'edit_team', 'edit_all', 'delete'];
/** Shared records that are kept once written (a receipt, a login) — with the own pair, as SHARED. */
const SHARED_KEPT: Action[] = ['view_own', 'view_team', 'view_all', 'create', 'edit_own', 'edit_team', 'edit_all'];
/** Registers and calendars: reading is the whole right. */
const READ: Action[] = ['view_all'];
/** Dashboards and reports, whose CSV and PDF are a right of their own. */
const REPORT: Action[] = ['view_all', 'export'];
/**
 * A settings page, with the own pair since 2026-10-18. Where the page keeps
 * no record anybody owns, "own" opens and saves the page as "all" does — the
 * entry's `own` says so on Admin › Roles.
 */
const SETTINGS: Action[] = ['view_own', 'view_team', 'view_all', 'edit_own', 'edit_team', 'edit_all'];

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
   * owner's call for the project registers (2026-10-06), each a tab inside
   * the project and a link from the Projects page, and for the three
   * duplicate entries of 2026-10-10 (C3), each opening a screen another label
   * already opens. Hide a screen this way, never by deleting its entry, which
   * would drop its permission keys.
   */
  hidden?: boolean;
  /**
   * What View Own and Edit Own mean on this screen (2026-10-18), shown on
   * Admin › Roles beside the two boxes — "records you added", "your own
   * employee record", "the page itself (it keeps no records of anybody's)".
   */
  own?: string;
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
      { key: 'customers', own: 'customers you added', group: 'Sales', label: 'Customers', path: '/g-ops/customers', actions: SHARED, phase: 2 },
      { key: 'partners', own: 'partners you added (as a supplier)', group: 'Sales', label: 'Partners', path: '/g-ops/partners', actions: SHARED, phase: 3,
        note: 'Principals whose equipment Gruntech sells and services: catalogues, price lists, software. One supplier record, seen from Sales.' },
      { key: 'calendar', group: 'Sales', label: 'Calendar', path: '/g-ops/calendar', actions: OWNED, phase: 3,
        note: 'Create books an activity; Edit Own and Delete cover the ones you are on (booked for, invited or booked by you); Edit All anyone’s' },
      // Project Management (2026-10-06, the owner's order): Costing, Job
      // Orders, Projects — the way the old gasiontech G-CORE arranged it. The
      // registers that follow are hidden (rule: hidden, never deleted): each
      // is a tab inside the project, and a link from the Projects page.
      { key: 'costing', group: 'Project Management', label: 'Costing', path: '/g-ops/costing', actions: OWNED, phase: 3 },
      { key: 'projects', group: 'Project Management', label: 'Projects', path: '/g-ops/projects', actions: OWNED, phase: 4 },
      { key: 'job_orders', group: 'Project Management', label: 'Job Orders', path: '/g-ops/job-orders', actions: OWNED, phase: 8, note: 'The project work order: sales raises it on a quotation, the Technical Manager and the team leader approve, and approval builds the project' },
      // The design team's queue (2026-10-09, the owner's call): a request for a
      // drawing, with files, revisions and a comment thread. No approval
      // route — "Approve" here is the Designer Lead's right to dispatch:
      // assign and reassign requests, set priority on any, close any.
      { key: 'cad_job_orders', group: 'Project Management', label: 'CAD J.O.', path: '/g-ops/cad-job-orders', actions: ['view_own', 'view_team', 'view_all', 'create', 'edit_own', 'edit_team', 'edit_all', 'delete', 'export', 'approve'], phase: 9,
        note: 'Requests to the design team: files, revisions (R0, R1…), progress, priority and a comment thread. Edit All = the design team (progress, revisions, priority on what is assigned to them); Approve = the Designer Lead (assigns, reassigns, closes any).' },
      { key: 'plans', group: 'Project Management', label: 'Request for Approval', path: '/g-ops/plans', actions: OWNED, phase: 4, hidden: true, note: 'Raised from a project’s Request for Approval tab; decided through the approval engine' },
      { key: 'budget_monitoring', group: 'Project Management', label: 'Budget Monitoring', path: '/g-ops/budget-monitoring', actions: READ, phase: 4, hidden: true },
      { key: 'purchase_requests', group: 'Project Management', label: 'Purchase Requests', path: '/g-ops/purchase-requests', actions: ['view_own', 'view_team', 'view_all', 'edit_own', 'edit_team', 'edit_all'], phase: 5, hidden: true },
      { key: 'budget_requests', group: 'Project Management', label: 'Budget Requests', path: '/g-ops/budget-requests', actions: OWNED, phase: 4, hidden: true },
      { key: 'progress_billing', group: 'Project Management', label: 'Progress & Billing', path: '/g-ops/progress', actions: OWNED, phase: 4, hidden: true },
      // Aftermarket (Phase 8). The installed base is what turns a finished
      // project into a renewal pipeline — without it nobody can answer "what
      // did we put in that hospital, and when does its warranty run out".
      // The owner's revised Aftermarket UI (2026-10-20): the overview's cards,
      // then Installation Base · Service Schedule · Service Contract, in that
      // order (Service JO and Service Documents follow in later pushes).
      // Renewals is folded into the contract list's card and filter and the
      // installation base's warranty filter — hidden, its route and keys kept.
      { key: 'aftermarket', group: 'Aftermarket', label: 'Aftermarket', path: '/g-ops/aftermarket', actions: READ, phase: 8, note: 'Overview and the aftermarket rules' },
      { key: 'installed_base', own: 'machines you registered', group: 'Aftermarket', label: 'Installation Base', path: '/g-ops/installed-base', actions: SHARED_KEPT, phase: 8 },
      { key: 'service_job_orders', own: 'service JOs you raised or are sent on', group: 'Aftermarket', label: 'Service JO', path: '/g-ops/service-job-orders', actions: OWNED, phase: 8, note: 'The service call on a registered machine: the Aftermarket Manager and the team leader approve, and approval books the visit' },
      { key: 'visits', own: 'visits assigned to you', group: 'Aftermarket', label: 'Service Schedule', path: '/g-ops/visits', actions: SHARED_KEPT, phase: 8, note: 'Every visit on one calendar; Create books a call-out, Edit All moves, assigns or cancels a visit' },
      { key: 'service_contracts', group: 'Aftermarket', label: 'Service Contract', path: '/g-ops/service-contracts', actions: OWNED_KEPT, phase: 8 },
      { key: 'service_documents', own: 'documents you filed', group: 'Aftermarket', label: 'Service Documents', path: '/g-ops/service-documents', actions: SHARED_KEPT, phase: 8, note: 'Manuals, drawings, test reports and datasheets filed against a machine or a model' },
      { key: 'renewals', group: 'Aftermarket', label: 'Renewals', path: '/g-ops/renewals', actions: READ, phase: 8, hidden: true },
      { key: 'report_templates', own: 'templates you made', group: 'Service reports', label: 'Report Templates', path: '/g-ops/report-templates', actions: SHARED_KEPT, phase: 8, note: 'Create starts or duplicates a template; Edit All publishes a new version' },
      { key: 'commissioning_reports', group: 'Service reports', label: 'Commissioning Reports', path: '/g-ops/commissioning', actions: OWNED_KEPT, phase: 8 },
      { key: 'pm_reports', group: 'Service reports', label: 'Preventive Maintenance', path: '/g-ops/pm', actions: OWNED_KEPT, phase: 8 },
      { key: 'inspection_reports', group: 'Service reports', label: 'Service Inspections', path: '/g-ops/inspections', actions: OWNED_KEPT, phase: 8 },
      { key: 'service_costing', group: 'Aftermarket', label: 'Service Costing', path: '/g-ops/service-costing', actions: ['view_own', 'view_team', 'view_all', 'edit_own', 'edit_team', 'edit_all'], phase: 8, hidden: true },
    ],
  },
  {
    key: 'gchain',
    label: 'G-CHAIN',
    blurb: 'Supply chain — procurement, receiving, inventory',
    submodules: [
      { key: 'dashboard', group: 'Overview', label: 'Dashboard', path: '/g-chain', actions: REPORT, phase: 5 },
      { key: 'purchase_requests', group: 'Procurement', label: 'Purchase Requests', path: '/g-chain/purchase-requests', actions: OWNED, phase: 5 },
      // The Request for Quotation (2026-10-14, the owner's call: "separate the
      // RFQ and Canvass"): raised from an approved request, printed one paper
      // per supplier, its quotes recorded; the canvass compares them.
      { key: 'rfq', group: 'Procurement', label: 'RFQ', path: '/g-chain/rfq', actions: OWNED, phase: 5 },
      { key: 'canvass', group: 'Procurement', label: 'Canvass', path: '/g-chain/canvass', actions: OWNED, phase: 5 },
      { key: 'purchase_orders', group: 'Procurement', label: 'Purchase Orders', path: '/g-chain/purchase-orders', actions: OWNED, phase: 5 },
      // The warehouse flow (2026-10-18, the owner's call): Incoming › Inventory
      // › Pull-out Slips › Borrow Slips › Outgoing. Incoming and Outgoing keep
      // the keys of Receiving and Stock Issuance, so no right moves.
      { key: 'receiving', own: 'incoming reports you received', group: 'Warehouse', label: 'Incoming', path: '/g-chain/incoming', actions: [...SHARED_KEPT, 'delete'], phase: 5 },
      { key: 'inventory', own: 'the whole shelf to read (it is the company’s); placing in a bin the stock of items you added', group: 'Warehouse', label: 'Inventory', path: '/g-chain/inventory', actions: SETTINGS, phase: 5 },
      { key: 'pullout_slips', group: 'Warehouse', label: 'Pull-out Slips', path: '/g-chain/pullout-slips', actions: [...OWNED_KEPT, 'delete'], phase: 5,
        note: 'Anyone may raise one (Create, View Own, Edit Own); View All and Edit All are the warehouse’s' },
      { key: 'borrow_slips', group: 'Warehouse', label: 'Borrow Slips', path: '/g-chain/borrow-slips', actions: [...OWNED_KEPT, 'delete'], phase: 5 },
      { key: 'stock_issuance', own: 'outgoing slips you issued', group: 'Warehouse', label: 'Outgoing', path: '/g-chain/outgoing', actions: SHARED, phase: 5 },
      { key: 'items', own: 'items you added', group: 'Master data', label: 'Item Master', path: '/g-chain/items', actions: SHARED, phase: 2 },
      { key: 'suppliers', own: 'suppliers you added', group: 'Master data', label: 'Suppliers', path: '/g-chain/suppliers', actions: SHARED, phase: 2 },
      { key: 'warehouses', own: 'warehouses you added', group: 'Master data', label: 'Warehouses', path: '/g-chain/warehouses', actions: SHARED, phase: 2 },
      { key: 'reports', group: 'Analysis', label: 'Reports', path: '/g-chain/reports', actions: READ, phase: 5 },
      // The standard terms for goods and for services, and the budget guard (2026-10-21).
      {
        key: 'settings', own: 'the page itself — it keeps no record of anybody’s', group: 'Administration',
        label: 'Procurement Settings',
        path: '/g-chain/settings',
        actions: SETTINGS,
        phase: 5,
      },
    ],
  },
  {
    key: 'gfin',
    label: 'G-FIN',
    blurb: 'Finance — receivables, payables, cash',
    submodules: [
      { key: 'dashboard', group: 'Overview', label: 'Executive Dashboard', path: '/g-fin', actions: REPORT, phase: 7 },
      // A progress billing asked to be invoiced: the project's salesperson or
      // their Team Leader raises it, Back Support approves it, and the approval
      // raises the draft invoice (2026-10-15).
      { key: 'invoice_requests', group: 'Money in', label: 'Invoice Requests', path: '/g-fin/invoice-requests', actions: OWNED, phase: 7 },
      { key: 'ar', own: 'invoices you raised', group: 'Money in', label: 'Accounts Receivable', path: '/g-fin/ar', actions: SHARED, phase: 7 },
      { key: 'ap', own: 'supplier bills you entered', group: 'Money out', label: 'Accounts Payable', path: '/g-fin/ap', actions: SHARED, phase: 7 },
      { key: 'expenses', group: 'Money out', label: 'Reimbursements', path: '/g-fin/expenses', actions: OWNED, phase: 7 },
      { key: 'cash_advances', group: 'Money out', label: 'Cash Advances', path: '/g-fin/cash-advances', actions: OWNED_KEPT, phase: 7 },
      // A sales order's commission, raised once it is fully collected, split
      // among the people who earned it; Finance Manager then CEO / President
      // approve it, finance pays it (2026-10-16).
      { key: 'commissions', group: 'Money out', label: 'Commissions', path: '/g-fin/commissions', actions: OWNED, phase: 7 },
      // Project cash: the budget requests finance releases and the teams
      // liquidate. Raised on the project (gops.budget_requests); this is
      // finance's window on every one of them — awaiting release, out with a
      // team, overdue, done.
      { key: 'budget_requests', group: 'Money out', label: 'Budget Requests', path: '/g-fin/budget-requests', actions: READ, phase: 7, note: 'Every project’s budget requests: approved ones to release, released ones awaiting liquidation. Releasing is the A/P create right.' },
      // The owner's module 5 (2026-10-15): the requests whose cash went out —
      // released, spent, returned — with the actual entry and the refund.
      { key: 'budget_liquidations', group: 'Money out', label: 'Budget Liquidations', path: '/g-fin/budget-liquidations', actions: READ, phase: 7 },
      // Money out, and money a person pays back — a cash advance's repayment,
      // a salary or commission deduction, unspent budget returned (2026-10-20,
      // the owner's call: those are never a collection).
      { key: 'payments_out', group: 'Money out', label: 'Payments & Repayments', path: '/g-fin/payments-out', actions: READ, phase: 7 },
      // Money in from customers. Recording one is gated by the A/R create
      // permission — seeing the register is its own, lesser right; its holder
      // also opens every payment (the A/R and A/P readers do too).
      { key: 'payments', group: 'Money in', label: 'Collections', path: '/g-fin/payments', actions: READ, phase: 7 },
      { key: 'cashflow', group: 'Analysis', label: 'Cash Flow', path: '/g-fin/cash-flow', actions: READ, phase: 7 },
      { key: 'budget_vs_actual', group: 'Analysis', label: 'Budget vs Actual', path: '/g-fin/budget-vs-actual', actions: READ, phase: 7 },
      // The office's own budget by year and cost category, apart from any
      // project's (2026-10-20): spent is read off the claims and bills that
      // name no project.
      {
        key: 'operations_budget', own: 'the page itself — it keeps no record of anybody’s', group: 'Analysis',
        label: 'Operations Budget',
        path: '/g-fin/operations-budget',
        actions: SETTINGS,
        phase: 7,
      },
      { key: 'reports', group: 'Analysis', label: 'Reports', path: '/g-fin/reports', actions: READ, phase: 7 },
      // Payment terms, supplier withholding and the aging buckets. Finance's
      // own rules — owning them should not require being a system
      // administrator, the same way HR owns the working day.
      {
        key: 'settings', own: 'the page itself — it keeps no record of anybody’s', group: 'Administration',
        label: 'Finance Settings',
        path: '/g-fin/settings',
        actions: SETTINGS,
        phase: 7,
      },
    ],
  },
  {
    key: 'ghr',
    label: 'G-HR',
    blurb: 'Human resources — attendance, leave, overtime',
    submodules: [
      { key: 'dashboard', group: 'Overview', label: 'Dashboard', path: '/g-hr', actions: REPORT, phase: 6 },
      { key: 'clock', group: 'My day', label: 'Clock In/Out', path: '/g-hr/clock', actions: ['view_own'], phase: 6 },
      // The signed-in employee's own records (2026-10-20, the owner's G-HR
      // Records spec): the cutoff's daily time record, leave balances, own
      // overtime, the 201 file and their place on the Plantilla — one page,
      // one key, the Clock's pattern (everyone reads their own).
      { key: 'my_records', group: 'Records', label: 'My Records', path: '/g-hr/my-records', actions: ['view_own'], phase: 10 },
      // Memos (2026-10-20, the Records spec): HR issues a memorandum to
      // everyone, teams, positions or named people; each recipient reads it
      // and acknowledges it once. Own is the memos one issued — a memo
      // addressed to someone opens for them with no right at all.
      { key: 'memos', own: 'memos you issued', group: 'Records', label: 'Memos', path: '/g-hr/memos', actions: SHARED_KEPT, phase: 10, note: 'Create issues a memo; anyone a memo is addressed to reads and acknowledges it without a right' },
      // The register behind the dashboard: every clock entry, with how the
      // person was identified. Gated by the dashboard permission — seeing the
      // day's counts and seeing the entries behind them are the same right.
      {
        key: 'attendance', own: "your own attendance and your direct reports'", group: 'Records',
        label: 'Attendance',
        path: '/g-hr/attendance',
        actions: SETTINGS,
        phase: 6,
        note: 'View All reads the register (the Dashboard permission does too); Edit All corrects an entry',
      },
      { key: 'leave', group: 'My day', label: 'Leave', path: '/g-hr/leave', actions: OWNED_KEPT, phase: 6 },
      { key: 'overtime', group: 'My day', label: 'Overtime', path: '/g-hr/overtime', actions: OWNED_KEPT, phase: 6 },
      // An internal meeting with invitees. Sits in 'My day' because it is a
      // thing that happens to a person's day, not an HR control. The Meet link
      // is pasted from the organiser's own Google account — G-Core holds no
      // Google credentials and sends no email (shared/calendar-links.ts).
      { key: 'meetings', group: 'My day', label: 'Meetings', path: '/g-hr/meetings', actions: OWNED, phase: 6 },
      { key: 'employees', own: 'your own employee record', group: 'Records', label: 'Employees', path: '/g-hr/employees', actions: SHARED, phase: 2 },
      // Pay data is separated from the employee record on purpose. A project
      // manager needs headcount and assignment; they must not see salaries.
      // Labor cost reaches projects as a burdened rate, never as a wage.
      {
        key: 'employee_rates', own: 'your own pay rate', group: 'Records',
        label: 'Employee Pay Rates',
        path: '/g-hr/employees',
        actions: SETTINGS,
        phase: 2,
        note: 'Controls visibility of daily rate, burden and statutory numbers on the employee record', hidden: true },
      // The authorised staffing pattern: positions by role level, how many of
      // each are approved, who fills them and what is vacant. Filled/vacant are
      // counted off active employees, never stored.
      { key: 'plantilla', own: 'positions you added', group: 'Records', label: 'Plantilla', path: '/g-hr/plantilla', actions: SHARED, phase: 6 },
      // The company's tagged property — vehicles, laptops, tools, kits — and
      // who holds each (2026-10-21, the owner's Asset Management tab, beside
      // the Plantilla). Create adds an asset; Edit issues and takes back.
      { key: 'assets', own: 'the assets you added, and those issued to you', group: 'Records', label: 'Asset Management', path: '/g-hr/assets', actions: SHARED_KEPT, phase: 10, note: 'Create adds an asset; Edit All issues, takes back and retires any; View Own reads what you added and what is issued to you' },
      // HIRING (2026-10-21, the owner's Hiring module): its own section
      // between Records and People — the Man Power Request a hiring manager
      // raises, the candidates gathered against it, the entrance exams and
      // their scores, and the employment contract routed and printed for
      // the wet signature.
      { key: 'manpower_requests', own: 'the requests you raised', group: 'Hiring', label: 'Man Power Request', path: '/g-hr/hiring/mpr', actions: OWNED, phase: 10, note: 'Create raises a request for people (routed Team Leader › HR Officer › CEO / President); View Own reads your own' },
      { key: 'candidates', own: 'the candidates you added', group: 'Hiring', label: 'Candidates', path: '/g-hr/hiring/candidates', actions: SHARED_KEPT, phase: 10, note: 'Create adds an applicant; Edit moves them along and records exam scores' },
      { key: 'entrance_exams', own: 'the catalogue (it keeps no record of anybody)', group: 'Hiring', label: 'Entrance Exam', path: '/g-hr/hiring/exams', actions: SETTINGS, phase: 10, note: 'View reads the catalogue and the score analytics; Edit changes the catalogue' },
      { key: 'employment_contracts', own: 'the contracts you prepared', group: 'Hiring', label: 'Contracts & Approvals', path: '/g-hr/hiring/contracts', actions: OWNED, phase: 10, note: 'Create prepares a contract (routed Technical Manager › Team Leader › HR Officer › CEO / President of the hiring team); printed for the wet signature' },
      // Pay data and evaluations are the two things on an employee a colleague
      // must not see; both live behind their own key rather than under employees.
      // One person's path from pre-boarding to the clearance certificate
      // (2026-10-13, the owner's PEOPLE_FLOW file). HR ticks; the person
      // reads their own; a supervisor with the dashboard right their direct
      // reports' — shared/peopleFlow.ts.
      { key: 'people_flow', own: 'your own path', group: 'People', label: 'People Flow', path: '/g-hr/people-flow', actions: ['view_own', 'view_team', 'view_all', 'edit_own', 'edit_team', 'edit_all'], phase: 10, note: 'Edit All ticks the checklist; View Own reads your own path' },
      { key: 'evaluations', group: 'People', label: 'Evaluations', path: '/g-hr/evaluations', actions: OWNED_KEPT, phase: 6, note: 'Probationary and trainee evaluations — the evaluator owns the record; the person evaluated reads it once approved' },
      // Turnover of accountabilities before someone leaves, cleared by the area
      // that owns each item and signed off through the approval engine. The
      // screen opens with the 12-month turnover figures so the label is true.
      { key: 'clearances', group: 'People', label: 'Turnover & Clearance', path: '/g-hr/clearances', actions: OWNED_KEPT, phase: 6 },
      // Gruntech Academy.
      { key: 'courses', own: 'courses you added', group: 'Academy', label: 'Courses', path: '/g-hr/academy/courses', actions: SHARED, phase: 6, note: 'Course master, and which positions must hold each course' },
      { key: 'training_calendar', group: 'Academy', label: 'Training Calendar', path: '/g-hr/academy/calendar', actions: READ, phase: 6 },
      { key: 'training_sessions', group: 'Academy', label: 'Training Sessions', path: '/g-hr/academy/sessions', actions: OWNED, phase: 6, note: 'Create is the Trainer right — schedule, enrol and complete a session; Edit Own covers sessions you train' },
      { key: 'passport', group: 'Academy', label: 'My Training Passport', path: '/g-hr/academy/passport', actions: ['view_own', 'create'], phase: 6, note: 'Create lets an employee enter an external certification for HR to verify' },
      { key: 'passports', own: 'your own passport', group: 'Academy', label: 'Training Passports', path: '/g-hr/academy/passports', actions: ['view_own', 'view_team', 'view_all', 'create', 'edit_own', 'edit_team', 'edit_all', 'delete', 'approve'], phase: 6, note: 'Every employee’s passport; verify external certifications; record training directly' },
      { key: 'reports', group: 'Administration', label: 'HR Reports', path: '/g-hr/reports', actions: REPORT, phase: 6 },
      { key: 'settings', own: 'the page itself — it keeps no record of anybody’s', group: 'Administration', label: 'HR Settings', path: '/g-hr/settings', actions: SETTINGS, phase: 6 },
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
      { key: 'users', own: 'your own login', group: 'People', label: 'Users', path: '/admin/users', actions: SHARED_KEPT, phase: 1 },
      { key: 'roles', own: 'roles you made', group: 'People', label: 'Roles & Permissions', path: '/admin/roles', actions: SHARED, phase: 1 },
      { key: 'workflows', own: 'approval routes you made', group: 'Process', label: 'Approval Workflows', path: '/admin/workflows', actions: SHARED, phase: 1 },
      { key: 'company', own: 'the page itself — it keeps no record of anybody’s', group: 'Configuration', label: 'Company Settings', path: '/admin/company', actions: SETTINGS, phase: 1 },
      { key: 'numbering', own: 'the page itself — it keeps no record of anybody’s', group: 'Process', label: 'Numbering', path: '/admin/numbering', actions: SETTINGS, phase: 1 },
      { key: 'categories', own: 'entries you added', group: 'Configuration', label: 'Categories', path: '/admin/categories', actions: SHARED, phase: 2, note: 'Cost, item and industry categories' },
      { key: 'templates', own: 'the page itself — it keeps no record of anybody’s', group: 'Process', label: 'Document Templates', path: '/admin/templates', actions: ['view_own', 'view_all'], phase: 1,
        note: 'Service report form templates (Phase 8). The quotation’s PDF layout is under PDF Templates.', hidden: true },
      { key: 'pdf_templates', own: 'the page itself — it keeps no record of anybody’s', group: 'Process', label: 'PDF Templates', path: '/admin/pdf-templates', actions: SETTINGS, phase: 1,
        note: 'Lay out the quotation and sales order PDFs: place the boxes and choose what each one prints' },
      { key: 'pipeline_stages', own: 'the page itself — it keeps no record of anybody’s', group: 'Process', label: 'Pipeline Stages', path: '/admin/pipeline-stages', actions: SETTINGS, phase: 3,
        note: 'The sales pipeline’s stages, as SCORO’s statuses: name, odds, colour and which are on the board' },
      { key: 'audit', group: 'Records', label: 'Audit Logs', path: '/admin/audit', actions: READ, phase: 1 },
      { key: 'help_tickets', own: 'tickets you raised', group: 'Records', label: 'Help Tickets', path: '/admin/help-tickets', actions: SETTINGS, phase: 10,
        note: 'What people raised from the Help box: improvements, faults and questions, with their screenshots' },
      { key: 'settings', own: 'the page itself — it keeps no record of anybody’s', group: 'Configuration', label: 'System Settings', path: '/admin/settings', actions: ['view_own', 'view_all'] /* read-only: no Edit box does anything (2026-10-18) */, phase: 1 },
      { key: 'appearance', own: 'the page itself — it keeps no record of anybody’s', group: 'Configuration', label: 'Appearance & Layout', path: '/admin/appearance', actions: SETTINGS, phase: 1, note: 'Spacing, type, colour and layout of every screen' },
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
