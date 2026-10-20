import { allPermissions, permissionsFor } from '../permissions/registry';
import { ACCESS_SPLIT } from './accessSplit';

/**
 * The seeded roles — the starting grid an install was given, as data
 * (moved out of prisma/seed.ts on 2026-10-18). Since every role was emptied
 * that day for the owner to build his own (shared/rolesClear.ts), the seed
 * makes and fills these only on an install whose roles were never emptied;
 * the verify scripts read them to give a throwaway role the rights a seeded
 * one used to carry (`roleSeedPermissionKeys`, scripts/lib/roles.ts), so no
 * check leans on what the install's own roles hold.
 */
/**
 * Role definitions.
 *
 * `grants` are (module, submodule?) pairs granting every action on that scope;
 * `only` grants specific permission keys. Roles are seeded once and then become
 * the customer's to edit — "Roles should be customizable" — so this is a
 * starting point, not a constraint.
 */
export interface RoleSeed {
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

/**
 * What a project's manager does (2026-10-15, the owner's call: "project
 * manager is the technical manager"): the `project_manager` role keeps these,
 * and the `technical_manager` role holds them too, since that is who manages
 * projects now.
 */
const PROJECT_MANAGER_GRANTS: [string, string?][] = [
  ['gops', 'projects'],
  ['gops', 'plans'],
  ['gops', 'budget_monitoring'],
  ['gops', 'purchase_requests'],
  ['gops', 'budget_requests'],
  ['gops', 'progress_billing'],
  ['gops', 'costing'],
];
const PROJECT_MANAGER_ONLY: string[] = [
  'gops.dashboard.view_all',
  'gops.customers.view_all',
  // Margin on the projects they run.
  'insights.profitability.view_all',
  'insights.profitability.export',
  'gops.installed_base.view_all',
  'gops.visits.view_all',
  'gops.quotations.view_all',
  'gops.job_orders.view_all',
  'gops.service_job_orders.view_all',
  ...VIEW_OWN_SELF('gops', 'cad_job_orders'),
  'gops.cad_job_orders.view_all',
  'gchain.purchase_requests.view_all',
  // A PM raises stock-replenishment requests too, not only direct-to-job
  // ones from the project workspace.
  'gchain.purchase_requests.create',
  'gchain.purchase_requests.edit_own',
  'gchain.purchase_requests.view_own',
  'gchain.purchase_orders.view_all',
  'gchain.inventory.view_all',
  'gfin.budget_vs_actual.view_all',
  ...VIEW_OWN_SELF('gfin', 'expenses'),
  ...VIEW_OWN_SELF('gfin', 'cash_advances'),
  ...VIEW_OWN_SELF('ghr', 'evaluations'),
  ...VIEW_OWN_SELF('ghr', 'meetings'),
];


export const ROLE_SEEDS: RoleSeed[] = [
  {
    key: 'executive',
    name: 'Executive / Management',
    description: 'Sees everything across the business, approves at the top band, changes nothing operationally',
    only: [
      ...allPermissions()
        .filter((p) => ['view_all', 'export', 'approve'].includes(p.action))
        .map((p) => p.key)
        .filter((k) => !k.startsWith('admin.')),
      // The one thing management does operationally: call a meeting.
      'ghr.meetings.create',
      'ghr.meetings.edit_own',
    ],
  },
  {
    key: 'sales',
    name: 'Sales',
    description: 'Works own leads and quotations; sees the shared customer master',
    grants: [['gops', 'leads'], ['gops', 'customers'], ['gops', 'calendar']],
    only: [
      ...VIEW_OWN_SELF('gops', 'quotations'),
      'gops.quotations.view_all',
      // Their own only: the route also requires authorship (canEditRecord),
      // and refuses a won, delivered or pending quotation.
      'gops.quotations.delete',
      ...VIEW_OWN_SELF('gops', 'costing'),
      // Books their own quotations as sales orders, and sees everyone's.
      ...VIEW_OWN_SELF('gops', 'sales_orders'),
      'gops.sales_orders.view_all',
      'gops.sales_orders.delete',
      'gops.dashboard.view_all',
      'gops.pipeline.view_all',
      // The Forecast: their own closing dates, and the team's.
      'gops.forecast.view_all',
      'gops.forecast.export',
      'gops.projects.view_all',
      // A partner's catalogue and price list are what a salesperson sells from.
      'gops.partners.view_all',
      // "Add … as a new supplier" from a quotation line's cost cell
      // (2026-10-13, the owner's call): the supplier is filed by name, the
      // rest filled on its page by procurement later.
      'gchain.suppliers.create',
      // Sales takes the service call and raises the job order for it.
      ...VIEW_OWN_SELF('gops', 'job_orders'),
      ...VIEW_OWN_SELF('gops', 'service_job_orders'),
      // And asks the design team for a drawing (2026-10-09).
      ...VIEW_OWN_SELF('gops', 'cad_job_orders'),
      // Writes the project's Accomplishment Report and raises its billing
      // (2026-10-15, the owner's call: "creator (Project Engineer) or Sales").
      ...VIEW_OWN_SELF('gops', 'progress_billing'),
      // Asks for an approved billing to be invoiced against the project's
      // sales order (2026-10-15) — Back Support approves it.
      ...VIEW_OWN_SELF('gfin', 'invoice_requests'),
      'gfin.invoice_requests.delete',
      // Raises the commission on a fully collected sales order (2026-10-16).
      ...VIEW_OWN_SELF('gfin', 'commissions'),
      ...VIEW_OWN_SELF('gfin', 'expenses'),
      ...VIEW_OWN_SELF('gfin', 'cash_advances'),
      ...VIEW_OWN_SELF('ghr', 'meetings'),
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
      ['gops', 'sales_orders'],
      ['gops', 'pipeline'],
      ['gops', 'forecast'],
      ['gops', 'costing'],
      ['gops', 'partners'],
    ],
    only: [
      'gops.dashboard.view_all',
      'gops.projects.view_all',
      // A supplier not on file, added from a quotation line (2026-10-13).
      'gchain.suppliers.create',
      // The pipeline analytics are their own numbers, seen whole.
      'insights.pipeline.view_all',
      'insights.pipeline.export',
      ...VIEW_OWN_SELF('gops', 'job_orders'),
      ...VIEW_OWN_SELF('gops', 'service_job_orders'),
      'gops.job_orders.view_all',
      'gops.service_job_orders.view_all',
      ...VIEW_OWN_SELF('gops', 'cad_job_orders'),
      'gops.cad_job_orders.view_all',
      'gops.cad_job_orders.export',
      ...VIEW_OWN_SELF('gfin', 'expenses'),
      ...VIEW_OWN_SELF('gfin', 'cash_advances'),
      ...VIEW_OWN_SELF('ghr', 'evaluations'),
      ...VIEW_OWN_SELF('ghr', 'meetings'),
    ],
  },
  {
    // The sales order's second signature (2026-10-08, the owner's route:
    // Sales creates › Team Leader › Back Support / Admin › Cost Controller ›
    // CEO). Reads the order and the quotation behind it; changes nothing.
    // Assign it in Admin › Users — until somebody holds it, sales orders
    // stall at step 2, and audit-workflows.ts says so.
    key: 'back_support',
    name: 'Back Support / Admin',
    description: 'Checks a sales order and a budget request after the team leader; prepares purchase orders',
    only: [
      'gops.dashboard.view_all',
      'gops.sales_orders.view_all',
      // Approves a billing's invoice request (2026-10-15), so reads them all.
      'gfin.invoice_requests.view_all',
      // The routing sheet of 2026-10-13: Back Support prepares purchase
      // orders (from the requisitions and canvasses it reads) and budget
      // requests, and is the second signature on every budget request.
      ...VIEW_OWN_SELF('gchain', 'purchase_orders'),
      'gchain.purchase_requests.view_all',
      'gchain.rfq.view_all',
      'gchain.canvass.view_all',
      'gchain.suppliers.view_all',
      ...VIEW_OWN_SELF('gops', 'budget_requests'),
      'gops.budget_requests.view_all',
      'gops.projects.view_all',
      'gops.quotations.view_all',
      'gops.customers.view_all',
      'gops.partners.view_all',
      ...VIEW_OWN_SELF('gfin', 'expenses'),
      ...VIEW_OWN_SELF('gfin', 'cash_advances'),
      ...VIEW_OWN_SELF('ghr', 'meetings'),
    ],
  },
  {
    // The third signature: checks the cost and the margin, so it holds the
    // right that shows them (gops.costing.view_all — the quotation's and the
    // sales order's cost rule).
    key: 'cost_controller',
    name: 'Cost Controller',
    description: 'Checks the cost and margin of a sales order — the third signature on the sales order route',
    only: [
      'gops.dashboard.view_all',
      'gops.sales_orders.view_all',
      'gops.quotations.view_all',
      'gops.costing.view_all',
      'gops.customers.view_all',
      'gops.partners.view_all',
      'gops.projects.view_all',
      'gops.budget_monitoring.view_all',
      ...VIEW_OWN_SELF('gfin', 'expenses'),
      ...VIEW_OWN_SELF('gfin', 'cash_advances'),
      ...VIEW_OWN_SELF('ghr', 'meetings'),
    ],
  },
  {
    // The costing's reviewer (2026-10-09, the owner's route: an engineer
    // creates › Technical Manager reviews › Team Leader approves › CTG second
    // approval). Reads every costing — the cost and the margin are what they
    // check — and changes nothing. Assign it in Admin › Users; until somebody
    // holds it, costings stall at step 1 and audit-workflows.ts says so.
    key: 'technical_manager',
    name: 'Technical Manager',
    description: 'Manages projects (the project manager is the Technical Manager) and is the first signature on costings, requisitions, job orders and supplier bills',
    grants: PROJECT_MANAGER_GRANTS,
    only: [
      ...PROJECT_MANAGER_ONLY,
      // The first signature on a supplier bill (2026-10-15), so reads them.
      'gfin.ap.view_all',
      'gops.dashboard.view_all',
      'gops.costing.view_all',
      // The routing sheet of 2026-10-13: a Technical Manager prepares
      // costings and purchase requisitions too, and is the first signature on
      // every requisition, so reads them all.
      ...VIEW_OWN_SELF('gops', 'costing'),
      ...VIEW_OWN_SELF('gops', 'purchase_requests'),
      ...VIEW_OWN_SELF('gchain', 'purchase_requests'),
      'gops.purchase_requests.view_all',
      'gchain.purchase_requests.view_all',
      'gops.quotations.view_all',
      'gops.customers.view_all',
      'gops.projects.view_all',
      'gops.plans.view_all',
      // The first signature on every Request for Approval, and a preparer of
      // them too (2026-10-13).
      ...VIEW_OWN_SELF('gops', 'plans'),
      // The first signature on every progress report and billing (2026-10-15).
      'gops.progress_billing.view_all',
      ...VIEW_OWN_SELF('gfin', 'expenses'),
      ...VIEW_OWN_SELF('gfin', 'cash_advances'),
      ...VIEW_OWN_SELF('ghr', 'meetings'),
    ],
  },
  {
    // The design team (2026-10-09, the owner's call: "there is Designer Lead,
    // Designer Support"). The lead dispatches the CAD job orders — assigns and
    // reassigns them, sets priority on any, closes any — which is what
    // "Approve" on CAD J.O. means; both roles do the work on what is assigned
    // to them: progress, revisions, priority. Assign both in Admin › Users.
    key: 'designer_lead',
    name: 'CAD Supervisor',
    description: 'Runs the design team’s queue: assigns CAD job orders, sets priority, submits and closes drawings',
    grants: [['gops', 'cad_job_orders']],
    only: [
      'gops.dashboard.view_all',
      'gops.customers.view_all',
      'gops.projects.view_all',
      'gops.plans.view_all',
      'gops.quotations.view_all',
      'gops.job_orders.view_all',
      'gops.service_job_orders.view_all',
      'gops.partners.view_all',
      ...VIEW_OWN_SELF('gfin', 'expenses'),
      ...VIEW_OWN_SELF('gfin', 'cash_advances'),
      ...VIEW_OWN_SELF('ghr', 'meetings'),
    ],
  },
  {
    key: 'designer',
    name: 'CAD Operator',
    description: 'Draws what the CAD job orders ask for: takes a request, reports progress, submits revisions',
    only: [
      'gops.dashboard.view_all',
      'gops.cad_job_orders.view_own',
      'gops.cad_job_orders.view_all',
      'gops.cad_job_orders.edit_all',
      'gops.cad_job_orders.export',
      'gops.customers.view_all',
      'gops.projects.view_all',
      'gops.plans.view_all',
      'gops.quotations.view_all',
      'gops.job_orders.view_all',
      'gops.service_job_orders.view_all',
      'gops.partners.view_all',
      ...VIEW_OWN_SELF('gfin', 'expenses'),
      ...VIEW_OWN_SELF('gfin', 'cash_advances'),
      ...VIEW_OWN_SELF('ghr', 'meetings'),
    ],
  },
  {
    key: 'project_manager',
    name: 'Project Manager',
    description: 'Runs projects — budget, procurement requests, progress and billing. Technical Managers now hold the same rights; this role is kept for those who already have it',
    grants: PROJECT_MANAGER_GRANTS,
    only: PROJECT_MANAGER_ONLY,
  },
  {
    key: 'project_engineer',
    name: 'Project Engineer',
    description: 'Executes the work: progress reports, purchase requests, requests for approval — and costs the work (the costing route starts with an engineer)',
    only: [
      'gops.projects.view_all',
      'gops.plans.view_all',
      // Sends the project's drawings for approval (2026-10-13).
      ...VIEW_OWN_SELF('gops', 'plans'),
      // The costing route's creator (2026-10-09, the owner's call): an
      // engineer raises and edits their own costings.
      ...VIEW_OWN_SELF('gops', 'costing'),
      ...VIEW_OWN_SELF('gops', 'progress_billing'),
      ...VIEW_OWN_SELF('gops', 'purchase_requests'),
      ...VIEW_OWN_SELF('gchain', 'purchase_requests'),
      // Project cash: the team asks for it, so an engineer raises a budget
      // request on their project and sees their own.
      ...VIEW_OWN_SELF('gops', 'budget_requests'),
      // Asks the design team for a drawing (2026-10-09).
      ...VIEW_OWN_SELF('gops', 'cad_job_orders'),
      'gops.budget_monitoring.view_all',
      'gops.customers.view_all',
      'gchain.inventory.view_all',
      ...VIEW_OWN_SELF('gfin', 'expenses'),
      ...VIEW_OWN_SELF('gfin', 'cash_advances'),
      ...VIEW_OWN_SELF('ghr', 'meetings'),
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
      'gops.service_documents.view_all',
      'gops.service_documents.create',
      'gops.service_documents.edit_own',
      ...VIEW_OWN_SELF('gops', 'service_costing'),
      'gops.customers.view_all',
      'gchain.inventory.view_all',
      ...VIEW_OWN_SELF('gops', 'purchase_requests'),
      ...VIEW_OWN_SELF('gchain', 'purchase_requests'),
      // They are the ones on site, so they are the ones who can say what is
      // actually installed and what its serial number is.
      'gops.aftermarket.view_all',
      'gops.installed_base.view_all',
      'gops.installed_base.create',
      'gops.installed_base.edit_all',
      'gops.visits.view_all',
      'gops.report_templates.view_all',
      'gops.renewals.view_all',
      'gops.partners.view_all',
      // An engineer taking the call raises the job order; the service manager
      // accepts it.
      'gops.job_orders.view_all',
      'gops.service_job_orders.view_all',
      'gops.job_orders.create',
      'gops.service_job_orders.create',
      'gops.job_orders.edit_own',
      'gops.service_job_orders.edit_own',
      ...VIEW_OWN_SELF('gops', 'cad_job_orders'),
      ...VIEW_OWN_SELF('gfin', 'expenses'),
      ...VIEW_OWN_SELF('gfin', 'cash_advances'),
      ...VIEW_OWN_SELF('ghr', 'meetings'),
    ],
  },
  {
    // Runs the aftermarket side: owns the contracts, the schedule and the
    // renewal pipeline, and signs off the reports the engineers write. A
    // separate role from Service Engineer on purpose — nobody approves their
    // own work, and the approval engine refuses it anyway.
    key: 'service_manager',
    name: 'Service Manager',
    description: 'Owns service contracts, the PM schedule and renewals; approves service reports',
    grants: [
      ['gops', 'commissioning_reports'],
      ['gops', 'pm_reports'],
      ['gops', 'inspection_reports'],
      ['gops', 'service_contracts'],
      ['gops', 'service_documents'],
      ['gops', 'installed_base'],
      ['gops', 'service_costing'],
      ['gops', 'job_orders'],
      ['gops', 'service_job_orders'],
    ],
    only: [
      'gops.aftermarket.view_all',
      'gops.visits.view_all',
      'gops.renewals.view_all',
      'gops.report_templates.view_all',
      'gops.customers.view_all',
      'gops.quotations.view_all',
      'gops.costing.view_all',
      'gops.partners.view_all',
      'gchain.inventory.view_all',
      ...VIEW_OWN_SELF('gops', 'purchase_requests'),
      ...VIEW_OWN_SELF('gchain', 'purchase_requests'),
      ...VIEW_OWN_SELF('gfin', 'expenses'),
      ...VIEW_OWN_SELF('gfin', 'cash_advances'),
      ...VIEW_OWN_SELF('ghr', 'evaluations'),
      ...VIEW_OWN_SELF('ghr', 'meetings'),
    ],
  },
  {
    // "Purchasing Officer" on the owner's chart (2026-10-17): the three
    // officers are their teams' Back Support too (that role beside this one).
    key: 'procurement',
    name: 'Purchasing Officer',
    description: 'Canvasses suppliers and issues purchase orders — does not receive and does not pay',
    grants: [
      ['gchain', 'rfq'],
      ['gchain', 'canvass'],
      ['gchain', 'purchase_orders'],
      ['gchain', 'suppliers'],
      ['gchain', 'reports'],
    ],
    only: [
      'insights.inventory.view_all',
      'gchain.dashboard.view_all',
      'gchain.purchase_requests.view_all',
      'gchain.purchase_requests.edit_all',
      'gchain.inventory.view_all',
      'gops.projects.view_all',
      'gops.partners.view_all',
      ...VIEW_OWN_SELF('gfin', 'expenses'),
      ...VIEW_OWN_SELF('gfin', 'cash_advances'),
      ...VIEW_OWN_SELF('ghr', 'meetings'),
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
      ['gchain', 'pullout_slips'],
      ['gchain', 'inventory'],
    ],
    only: [
      'insights.inventory.view_all',
      'insights.inventory.export',
      'gchain.dashboard.view_all',
      'gchain.purchase_orders.view_all',
      'gchain.reports.view_all',
      // The warehouse clears a leaver's tools and borrow slips.
      'ghr.clearances.view_all',
      ...VIEW_OWN_SELF('gfin', 'expenses'),
      ...VIEW_OWN_SELF('gfin', 'cash_advances'),
      ...VIEW_OWN_SELF('ghr', 'meetings'),
    ],
  },
  {
    // "Finance Officer" on the owner's chart (2026-10-17) — the Finance
    // Officer, the clerks and Collection hold it: any of them is "Checking".
    key: 'finance',
    name: 'Finance Officer',
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
      ['gfin', 'cash_advances'],
      // Project cash: every project's budget requests, to release and to chase.
      ['gfin', 'budget_requests'],
      ['gfin', 'budget_liquidations'],
    ],
    only: [
      'insights.dashboard.view_all',
      'insights.profitability.view_all',
      'insights.profitability.export',
      'insights.cash.view_all',
      'insights.cash.export',
      'gops.projects.view_all',
      'gops.progress_billing.view_all',
      // The invoice requests whose approval lands a draft invoice in A/R (2026-10-15).
      'gfin.invoice_requests.view_all',
      // Pays the approved commissions (2026-10-16) — the payout is A/P's right.
      'gfin.commissions.view_all',
      // Finance raises the supplier bill (Phase 7 notes), so it must find the
      // supplier on the bill form (SupplierPicker reads /suppliers/lookup).
      'gchain.suppliers.view_all',
      'gops.customers.view_all',
      // A job order is what a service invoice will be raised against.
      'gops.job_orders.view_all',
      'gops.service_job_orders.view_all',
      'gchain.purchase_orders.view_all',
      'gchain.receiving.view_all',
      // Finance costs labour, so it needs the rates — model §4.4.
      'ghr.employees.view_all',
      'ghr.employee_rates.view_all',
      // Finance clears a leaver's unpaid claims and advances.
      'ghr.clearances.view_all',
      ...VIEW_OWN_SELF('ghr', 'meetings'),
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
      'gfin.invoice_requests.view_all',
      'gfin.ap.view_all',
      'gfin.ap.create',
      'gfin.ap.edit_all',
      'gchain.suppliers.view_all',
      'gfin.expenses.view_all',
      'gfin.cash_advances.view_all',
      'gfin.reports.view_all',
      'gops.projects.view_all',
      'gchain.receiving.view_all',
      ...VIEW_OWN_SELF('ghr', 'meetings'),
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
      ['ghr', 'plantilla'],
      ['ghr', 'clearances'],
      ['ghr', 'evaluations'],
      ['ghr', 'meetings'],
      ['ghr', 'courses'],
      ['ghr', 'training_calendar'],
      ['ghr', 'training_sessions'],
      ['ghr', 'passports'],
      ['ghr', 'people_flow'],
    ],
    only: [
      'ghr.clock.view_own',
      'ghr.passport.view_own',
      'ghr.passport.create',
      ...VIEW_OWN_SELF('gfin', 'expenses'),
      ...VIEW_OWN_SELF('gfin', 'cash_advances'),
    ],
  },
  {
    key: 'supervisor',
    name: 'Supervisor',
    description: 'Approves leave and overtime for their direct reports',
    only: [
      'ghr.clock.view_own',
      'ghr.dashboard.view_all',
      // Their own path, and through the dashboard right their reports'.
      'ghr.people_flow.view_own',
      ...VIEW_OWN_SELF('ghr', 'leave'),
      'ghr.leave.view_all',
      ...VIEW_OWN_SELF('ghr', 'overtime'),
      'ghr.overtime.view_all',
      // First sign-off on a leaver's clearance; writes the evaluations of
      // their own probationers.
      'ghr.clearances.view_all',
      ...VIEW_OWN_SELF('ghr', 'evaluations'),
      ...VIEW_OWN_SELF('ghr', 'meetings'),
      'ghr.training_calendar.view_all',
      'ghr.passports.view_all',
      'ghr.passport.view_own',
      'ghr.passport.create',
      ...VIEW_OWN_SELF('gfin', 'expenses'),
      ...VIEW_OWN_SELF('gfin', 'cash_advances'),
    ],
  },
  {
    key: 'employee',
    name: 'Employee',
    description: 'Clocks in, files leave and overtime, sees their own records',
    only: [
      'ghr.clock.view_own',
      ...VIEW_OWN_SELF('ghr', 'leave'),
      ...VIEW_OWN_SELF('ghr', 'overtime'),
      // A leaver raises their own clearance; an evaluation is read once
      // approved, never written by its subject.
      'ghr.clearances.view_own',
      'ghr.clearances.create',
      'ghr.evaluations.view_own',
      'ghr.people_flow.view_own',
      ...VIEW_OWN_SELF('ghr', 'meetings'),
      'ghr.training_calendar.view_all',
      'ghr.passport.view_own',
      'ghr.passport.create',
      ...VIEW_OWN_SELF('gfin', 'expenses'),
      ...VIEW_OWN_SELF('gfin', 'cash_advances'),
      // Anyone may ask to borrow a tool (2026-10-14); the warehouse releases it.
      ...VIEW_OWN_SELF('gchain', 'borrow_slips'),
      // Anyone may raise a pull-out slip (2026-10-18) — a project's own stock
      // to its site, most often; the requester's supervisor approves it.
      ...VIEW_OWN_SELF('gchain', 'pullout_slips'),
    ],
  },
  {
    // Runs Gruntech Academy sessions. A role of its own because the people
    // who train are engineers and managers first — the right to schedule a
    // session and mark who passed is added to whatever else they hold.
    key: 'trainer',
    name: 'Trainer',
    description: 'Schedules and runs Gruntech Academy sessions, records attendance and results',
    only: [
      'ghr.courses.view_all',
      'ghr.training_calendar.view_all',
      'ghr.training_sessions.view_own',
      'ghr.training_sessions.view_all',
      'ghr.training_sessions.create',
      'ghr.training_sessions.edit_own',
      'ghr.passports.view_all',
      'ghr.passport.view_own',
      'ghr.passport.create',
      'ghr.clock.view_own',
      ...VIEW_OWN_SELF('ghr', 'leave'),
      ...VIEW_OWN_SELF('ghr', 'overtime'),
      ...VIEW_OWN_SELF('ghr', 'meetings'),
    ],
  },
];

// The owner's routing sheet (2026-10-11, "APPROVAL ROUTER — SALES ORDER AND
// QUOTATION"): who PREPARED a quotation or a sales order decides its route.
// Three preparer roles; each starts from the nearest existing role's
// permissions and is edited in Admin › Roles from there. The CEO / President
// is its own role (the owner's call), apart from Executive, which stays the
// read-everything management role and the CEO step of every other route.
{
  const like = (key: string) => ROLE_SEEDS.find((r) => r.key === key)!;
  const exec = like('executive');
  ROLE_SEEDS.push(
    {
      key: 'ceo',
      name: 'CEO / President',
      description: 'The Chief Executive Officer / President — prepares quotations needing no approval, and is the CEO step on the quotation and sales order routes',
      only: [
        ...(exec.only ?? []),
        ...VIEW_OWN_SELF('gops', 'quotations'),
        'gops.quotations.edit_all',
        ...VIEW_OWN_SELF('gops', 'sales_orders'),
        'gops.sales_orders.edit_all',
      ],
    },
    {
      key: 'team_leader',
      name: 'Team Leader',
      description: 'Leads a sales team — approves its quotations, sales orders, costings, purchase requisitions and budget requests',
      grants: like('sales_manager').grants,
      only: [
        ...(like('sales_manager').only ?? []),
        // The routing sheet of 2026-10-13: a Team Leader prepares purchase
        // requisitions and budget requests, and is a signature on both, so
        // reads every one.
        ...VIEW_OWN_SELF('gops', 'purchase_requests'),
        ...VIEW_OWN_SELF('gchain', 'purchase_requests'),
        'gops.purchase_requests.view_all',
        'gchain.purchase_requests.view_all',
        ...VIEW_OWN_SELF('gops', 'budget_requests'),
        'gops.budget_requests.view_all',
        // The second signature on every progress report and billing (2026-10-15).
        'gops.progress_billing.view_all',
        // Raises a billing's invoice request for the team's projects, and
        // reads every one (2026-10-15).
        ...VIEW_OWN_SELF('gfin', 'invoice_requests'),
        'gfin.invoice_requests.view_all',
        'gfin.invoice_requests.delete',
        // Raises the team's commissions (2026-10-16).
        ...VIEW_OWN_SELF('gfin', 'commissions'),
      ],
    },
    {
      // "Sales Engineer" on the owner's chart (2026-10-17); the key stays.
      key: 'industry_specialist',
      name: 'Sales Engineer',
      description: 'Prepares quotations, sales orders, purchase requisitions and budget requests — the team leader approves first',
      grants: like('sales').grants,
      only: [
        ...(like('sales').only ?? []),
        ...VIEW_OWN_SELF('gops', 'purchase_requests'),
        ...VIEW_OWN_SELF('gchain', 'purchase_requests'),
        ...VIEW_OWN_SELF('gops', 'budget_requests'),
      ],
    },
  );
}

// The routing sheet of 2026-10-13 (APPROVAL_ROUTE.xlsx): two managers the
// purchase order and the budget request route to. Each starts from the role
// whose work it manages — Procurement's, Finance's — and is edited in Admin ›
// Roles from there; Procurement and Finance stay for the staff who are not
// the manager. Assign both in Admin › Users: until somebody holds them,
// purchase orders and budget requests stall at their steps, and
// audit-workflows.ts says so.
{
  const like = (key: string) => ROLE_SEEDS.find((r) => r.key === key)!;
  ROLE_SEEDS.push(
    {
      key: 'purchasing_manager',
      name: 'Purchasing Manager',
      description: 'Approves every purchase order — the first signature; the CEO / President follows above ₱100,000',
      grants: like('procurement').grants,
      only: like('procurement').only,
    },
    {
      key: 'finance_manager',
      name: 'Finance Manager',
      description: 'Approves budget requests after the team leader and back support; the CEO / President follows above ₱100,000',
      grants: like('finance').grants,
      // The first signature on a commission, and its keeper (2026-10-16).
      only: [...(like('finance').only ?? []), ...VIEW_OWN_SELF('gops', 'budget_requests'), 'gfin.commissions.edit_all', 'gfin.commissions.delete'],
    },
    // The warehouse flow (2026-10-14): Incoming and Outgoing go to the
    // warehouse person's "Reports to", else a Warehouse Supervisor — who
    // starts from the Warehouse role's rights (all four registers in full).
    // Assign in Admin › Users; until somebody holds it, a receiving or an
    // issue raised by someone with no "Reports to" cannot be submitted.
    {
      key: 'warehouse_supervisor',
      name: 'Warehouse Supervisor',
      description: 'Approves incoming and outgoing for warehouse staff who report to nobody else; runs the warehouse',
      grants: like('warehouse').grants,
      // The automatic reorder's requisitions are raised in the supervisor's
      // name (2026-10-15): they check, modify and submit their own.
      only: [...(like('warehouse').only ?? []), ...VIEW_OWN_SELF('gchain', 'purchase_requests'), 'gchain.purchase_requests.delete'],
    },
  );
}

// The owner's organisation chart (2026-10-17, organizational_chart_executive_3
// and ROLE.xlsx): three roles the chart names that G-CORE had no word for.
{
  const like = (key: string) => ROLE_SEEDS.find((r) => r.key === key)!;
  ROLE_SEEDS.push(
    {
      // Carter signs the importation orders, Dina the local ones: a step
      // naming Purchasing Manager goes to this twin on an order with no VAT
      // (IMPORTATION_ROLES in shared/approvals.ts).
      key: 'purchasing_manager_import',
      name: 'Purchasing Manager (Importation)',
      description: 'Approves importation purchase orders and their incoming reports (no VAT) — the local Purchasing Manager signs the rest',
      grants: like('purchasing_manager').grants,
      only: like('purchasing_manager').only,
    },
    {
      // Between the Project Engineer and the crew: reads the project, reports
      // its progress, asks for materials, drawings and project cash.
      key: 'project_lead',
      name: 'Project Lead',
      description: 'Leads the crew on site — reads the project, reports progress, raises purchase requests, drawing requests and budget requests of their own',
      only: [
        'gops.projects.view_all',
        'gops.budget_monitoring.view_all',
        'gops.customers.view_all',
        'gchain.inventory.view_all',
        ...VIEW_OWN_SELF('gops', 'progress_billing'),
        ...VIEW_OWN_SELF('gops', 'purchase_requests'),
        ...VIEW_OWN_SELF('gchain', 'purchase_requests'),
        ...VIEW_OWN_SELF('gops', 'budget_requests'),
        ...VIEW_OWN_SELF('gops', 'cad_job_orders'),
        ...VIEW_OWN_SELF('gfin', 'expenses'),
        ...VIEW_OWN_SELF('gfin', 'cash_advances'),
        ...VIEW_OWN_SELF('ghr', 'meetings'),
      ],
    },
    {
      // Marketing Manager and Assistant: the sales side to read, leads of
      // their own, the calendar. Nothing to approve.
      key: 'marketing',
      name: 'Marketing',
      description: 'Reads the pipeline and the customers, records leads and activities — no approvals',
      grants: [['gops', 'calendar']],
      only: [
        'gops.dashboard.view_all',
        'gops.pipeline.view_all',
        'gops.forecast.view_all',
        ...VIEW_OWN_SELF('gops', 'leads'),
        'gops.leads.view_all',
        'gops.customers.view_all',
        'gops.customers.create',
        'gops.quotations.view_all',
        'gops.partners.view_all',
        ...VIEW_OWN_SELF('gfin', 'expenses'),
        ...VIEW_OWN_SELF('gfin', 'cash_advances'),
        ...VIEW_OWN_SELF('ghr', 'meetings'),
      ],
    },
  );
}

/**
 * Default approval workflows.
 *
 * Purchase Requests are banded by amount — the configurable threshold from the
 * requirements. Overtime deliberately has TWO steps: the supervisor who
 * directed the work, then HR. Cost only posts to a project when both exist
 * (model §4.4), and that rule lives in the workflow shape rather than in code.
 */

/**
 * The permission keys a seeded role's definition grants: its `grants` scopes
 * and its `only` keys — plus the boxes the once-only Access split of
 * 2026-10-18 gave every role holding the right they replace
 * (shared/accessSplit.ts), so the definition reads as the install's roles
 * did after that step.
 */
export function roleSeedPermissionKeys(key: string): string[] {
  const seed = ROLE_SEEDS.find((r) => r.key === key);
  if (!seed) return [];
  const keys = new Set<string>(seed.only ?? []);
  for (const [mod, sub] of seed.grants ?? []) for (const k of permissionsFor(mod, sub)) keys.add(k);
  for (const { from, to } of ACCESS_SPLIT) if (keys.has(from)) for (const k of to) keys.add(k);
  return [...keys];
}

