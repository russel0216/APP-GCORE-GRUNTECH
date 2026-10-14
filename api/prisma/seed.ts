import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { allPermissions, permissionsFor } from '../src/permissions/registry';
import { DOCUMENT_TYPES } from '../src/shared/numbering';
import { moveCanvassCode } from '../src/shared/canvassCode';
import { backfillPositions } from '../src/shared/plantilla';
import { markUnchangedScoroImports, withdrawStaleQuotationApprovals } from '../src/shared/quotation';
import { linkLegacyBookings } from '../src/shared/salesOrderBooking';
import { closeLegacyBudgetIncreases } from '../src/shared/budgetRequests';
import { migrateCostingMargins } from '../src/shared/costingLegacy';
import { seedOwnerGroups, seedQuotationGroups } from '../src/shared/quotationGroups';
import { seedActivityTypes } from '../src/shared/activityTypes';
import { TEAMS, fillQuotationTeams, retireFirstIndustries } from '../src/shared/team';
import { SUB_INDUSTRIES, seedSubIndustries } from '../src/shared/subIndustries';
import { CAD_DRAWING_TYPES, seedCadDrawingTypes } from '../src/shared/cadDrawingTypes';
import { migrateFaceThreshold } from '../src/shared/faceSamples';
import { removeScoroArchive } from '../src/shared/scoroArchive';
import { backfillCustomerAddresses } from '../src/shared/customerAddress';
import { backfillInvoiceCountering, fillInvoiceCredit } from '../src/shared/receivables';
import { fillBillTerms } from '../src/shared/payables';
import { prisma as sharedPrisma } from '../src/prisma';
import { ADMIN_EMAIL as SEEDED_ADMIN_EMAIL, OLD_ADMIN_EMAIL, moveAdminEmail } from '../src/shared/adminEmail';

const prisma = new PrismaClient();

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? SEEDED_ADMIN_EMAIL;
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
      // And asks the design team for a drawing (2026-10-09).
      ...VIEW_OWN_SELF('gops', 'cad_job_orders'),
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
      'gops.job_orders.view_all',
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
    description: 'Reviews a costing and a purchase requisition before the team leader — the first signature on both routes',
    only: [
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
    name: 'Designer Lead',
    description: 'Runs the design team’s queue: assigns CAD job orders, sets priority, submits and closes drawings',
    grants: [['gops', 'cad_job_orders']],
    only: [
      'gops.dashboard.view_all',
      'gops.customers.view_all',
      'gops.projects.view_all',
      'gops.plans.view_all',
      'gops.quotations.view_all',
      'gops.job_orders.view_all',
      'gops.partners.view_all',
      ...VIEW_OWN_SELF('gfin', 'expenses'),
      ...VIEW_OWN_SELF('gfin', 'cash_advances'),
      ...VIEW_OWN_SELF('ghr', 'meetings'),
    ],
  },
  {
    key: 'designer',
    name: 'Designer Support',
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
      'gops.partners.view_all',
      ...VIEW_OWN_SELF('gfin', 'expenses'),
      ...VIEW_OWN_SELF('gfin', 'cash_advances'),
      ...VIEW_OWN_SELF('ghr', 'meetings'),
    ],
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
      // Margin on the projects they run.
      'insights.profitability.view_all',
      'insights.profitability.export',
      'gops.installed_base.view_all',
      'gops.visits.view_all',
      'gops.quotations.view_all',
      'gops.job_orders.view_all',
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
    ],
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
      'gops.job_orders.create',
      'gops.job_orders.edit_own',
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
      ['gops', 'installed_base'],
      ['gops', 'service_costing'],
      ['gops', 'job_orders'],
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
    key: 'procurement',
    name: 'Procurement',
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
      // Finance raises the supplier bill (Phase 7 notes), so it must find the
      // supplier on the bill form (SupplierPicker reads /suppliers/lookup).
      'gchain.suppliers.view_all',
      'gops.customers.view_all',
      // A job order is what a service invoice will be raised against.
      'gops.job_orders.view_all',
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
  const like = (key: string) => ROLES.find((r) => r.key === key)!;
  const exec = like('executive');
  ROLES.push(
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
      ],
    },
    {
      key: 'industry_specialist',
      name: 'Industry Specialist',
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
  const like = (key: string) => ROLES.find((r) => r.key === key)!;
  ROLES.push(
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
      only: [...(like('finance').only ?? []), ...VIEW_OWN_SELF('gops', 'budget_requests')],
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
      only: [...like('warehouse').only, ...VIEW_OWN_SELF('gchain', 'purchase_requests'), 'gchain.purchase_requests.delete'],
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
interface WorkflowSeed {
  documentType: string;
  name: string;
  minAmount?: number;
  maxAmount?: number;
  /** An optional route the submitter may tick (ApprovalWorkflow.optionLabel). */
  optionLabel?: string;
  /** The route for documents prepared by a holder of this role (ApprovalWorkflow.requesterRoleId). */
  requesterRoleKey?: string;
  /** The preparer signs at submit the steps they hold (ApprovalWorkflow.preparerSigns). */
  preparerSigns?: boolean;
  /** An approver's manager may decide a step in their place (ApprovalWorkflow.standIns). */
  standIns?: boolean;
  steps: SeedStep[];
  /**
   * The steps this workflow was seeded with before a correction. A workflow
   * that has routed documents is normally left alone, but one whose steps are
   * STILL exactly these was never edited by anybody, so the correction is
   * applied to it in place — step rows updated by sequence, never deleted, so
   * past decisions keep their step and an open request stays at its step.
   */
  previously?: SeedStep[];
}

interface SeedStep {
  sequence: number;
  name: string;
  approverType: 'ROLE' | 'USER' | 'SUPERVISOR' | 'HR' | 'PROJECT_MANAGER';
  /**
   * The role a ROLE step routes to; on a SUPERVISOR step, who decides when the
   * requester has no supervisor; on a PROJECT_MANAGER step, who decides when
   * the project has no manager or the manager raised the document.
   */
  roleKey?: string;
  /** SUPERVISOR only: roles whose holders on the requester's team decide it too (`ApprovalStep.alsoRoleIds`). */
  alsoRoleKeys?: string[];
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
  // ── The routing sheet of 2026-10-13 (APPROVAL_ROUTE.xlsx) ──────────────
  // One route per document whoever prepared it, as the quotation's and the
  // sales order's: the preparer signs the steps they hold at submit, an
  // approver signs every later step they hold with their one Approve (one
  // timestamp per person), and an approver's manager may stand in.
  {
    // PURCHASE REQUISITION: Technical Manager, then Team Leader — prepared by
    // a Project Engineer, an Industry Specialist, a Technical Manager or a
    // Team Leader. No amount band: the budget guard still refuses an
    // over-budget direct-to-job request. The two banded routes are RETIRED.
    documentType: 'purchase_request',
    name: 'Purchase Request — technical manager, team leader',
    preparerSigns: true,
    standIns: true,
    steps: [
      { sequence: 1, name: 'Technical Manager', approverType: 'ROLE', roleKey: 'technical_manager' },
      { sequence: 2, name: 'Team Leader', approverType: 'SUPERVISOR', roleKey: 'team_leader' },
    ],
  },
  {
    // BUDGET REQUEST (project cash): Team Leader, Admin Back Support (the
    // holders supporting the preparer's team), Finance Manager, and the CEO /
    // President above ₱100,000. The project manager's step of 2026-10-07 is
    // not on the sheet; that route is RETIRED.
    documentType: 'budget_request',
    name: 'Budget Request — team leader, back support, finance manager',
    maxAmount: 100_000,
    preparerSigns: true,
    standIns: true,
    steps: [
      { sequence: 1, name: 'Team Leader', approverType: 'SUPERVISOR', roleKey: 'team_leader' },
      { sequence: 2, name: 'Admin Back Support', approverType: 'ROLE', roleKey: 'back_support' },
      { sequence: 3, name: 'Finance Manager', approverType: 'ROLE', roleKey: 'finance_manager' },
    ],
  },
  {
    documentType: 'budget_request',
    name: 'Budget Request — team leader, back support, finance manager, then CEO / President over ₱100,000',
    minAmount: 100_000.01,
    preparerSigns: true,
    standIns: true,
    steps: [
      { sequence: 1, name: 'Team Leader', approverType: 'SUPERVISOR', roleKey: 'team_leader' },
      { sequence: 2, name: 'Admin Back Support', approverType: 'ROLE', roleKey: 'back_support' },
      { sequence: 3, name: 'Finance Manager', approverType: 'ROLE', roleKey: 'finance_manager' },
      { sequence: 4, name: 'CEO / President', approverType: 'ROLE', roleKey: 'ceo' },
    ],
  },
  {
    // COSTING (the sheet of 2026-10-13): Technical Manager, then Team Leader —
    // prepared by a Project Engineer or a Technical Manager. The three-step
    // route with the CEO (CTG) is RETIRED: the step count changed, which
    // `previously` cannot update in place; a costing pending on it finishes
    // on it. To go without costing approval, DEACTIVATE this workflow — a
    // deleted seeded workflow is recreated on the next seed.
    documentType: 'costing',
    name: 'Costing — technical manager, team leader',
    preparerSigns: true,
    standIns: true,
    steps: [
      { sequence: 1, name: 'Technical Manager', approverType: 'ROLE', roleKey: 'technical_manager' },
      { sequence: 2, name: 'Team Leader', approverType: 'SUPERVISOR', roleKey: 'team_leader' },
    ],
  },
  // REQUEST FOR APPROVAL (2026-10-13, the owner's call: "Internal Approval
  // (Technical Manager, Team Leader and CEO more than 1 million Project
  // Costing)"): a project's drawing or document, decided by the Technical
  // Manager, then the preparer's Team Leader, and the CEO / President too
  // when the PROJECT's contract value is above ₱1,000,000 (the amount the
  // submit snapshots). The costing's two switches: a preparer who holds a
  // step signs it at submit, and a manager may stand in.
  {
    documentType: 'plan_approval',
    name: 'Request for Approval — technical manager, team leader',
    maxAmount: 1_000_000,
    preparerSigns: true,
    standIns: true,
    steps: [
      { sequence: 1, name: 'Technical Manager', approverType: 'ROLE', roleKey: 'technical_manager' },
      { sequence: 2, name: 'Team Leader', approverType: 'SUPERVISOR', roleKey: 'team_leader' },
    ],
  },
  {
    documentType: 'plan_approval',
    name: 'Request for Approval — technical manager, team leader, then CEO / President over ₱1,000,000',
    minAmount: 1_000_000.01,
    preparerSigns: true,
    standIns: true,
    steps: [
      { sequence: 1, name: 'Technical Manager', approverType: 'ROLE', roleKey: 'technical_manager' },
      { sequence: 2, name: 'Team Leader', approverType: 'SUPERVISOR', roleKey: 'team_leader' },
      { sequence: 3, name: 'CEO / President', approverType: 'ROLE', roleKey: 'ceo' },
    ],
  },
  // ── The owner's routing sheet (2026-10-12) ─────────────────────────────
  // ONE route per document, whoever prepared it. QUOTATION: the Team Leader
  // ("Reports to", else a Team Leader on the preparer's own team, else any),
  // and the CEO / President too above ₱1,000,000. SALES ORDER: Team Leader,
  // Admin Back Support, Cost Controller, CEO / President. A preparer holding
  // a step's role signs it at submit (`preparerSigns` — the Team Leader's own
  // quotation, the CEO's own sales order), dated the submit instant, and an
  // approver's manager may stand in (`standIns`). The routes keyed to the
  // preparer's role (2026-10-11) are RETIRED below.
  {
    documentType: 'quotation',
    name: 'Quotation — Team Leader',
    maxAmount: 1_000_000,
    preparerSigns: true,
    standIns: true,
    steps: [{ sequence: 1, name: 'Team Leader', approverType: 'SUPERVISOR', roleKey: 'team_leader' }],
  },
  {
    documentType: 'quotation',
    name: 'Quotation — Team Leader, then CEO / President over ₱1,000,000',
    minAmount: 1_000_000.01,
    preparerSigns: true,
    standIns: true,
    steps: [
      { sequence: 1, name: 'Team Leader', approverType: 'SUPERVISOR', roleKey: 'team_leader' },
      { sequence: 2, name: 'CEO / President', approverType: 'ROLE', roleKey: 'ceo' },
    ],
  },
  {
    // A sales order books a quotation's work in operations. Its route
    // (2026-10-08, the owner's call): Sales creates, then the Team Leader —
    // the salesperson's own "Reports to", the sales managers when none is
    // set, the quotation's rule — then Back Support / Admin, then the Cost
    // Controller, then the CEO. Four signatures and no option: the CEO is a
    // fixed step now, so "Add the CEO as approver" is gone. The two earlier
    // routes ("Sales Order — sales manager" and "… with the CEO") are
    // RETIRED below, history kept — the step count changed, which
    // `previously` cannot update in place.
    documentType: 'sales_order',
    name: 'Sales Order — team leader, back support, cost controller, CEO',
    preparerSigns: true,
    standIns: true,
    // Since the routing sheet (2026-10-11) the general route — an Industry
    // Specialist's, or anyone's not keyed above: the Team Leader falls back
    // to the Team Leader role, the last step is the CEO / President role.
    // Step 2 is "Back Support" since 2026-10-12 (the owner's slide); the
    // route as it stood before — "Admin Back Support" — is `previously`.
    steps: [
      { sequence: 1, name: 'Team Leader', approverType: 'SUPERVISOR', roleKey: 'team_leader' },
      { sequence: 2, name: 'Back Support', approverType: 'ROLE', roleKey: 'back_support' },
      { sequence: 3, name: 'Cost Controller', approverType: 'ROLE', roleKey: 'cost_controller' },
      { sequence: 4, name: 'CEO / President', approverType: 'ROLE', roleKey: 'ceo' },
    ],
    previously: [
      { sequence: 1, name: 'Team Leader', approverType: 'SUPERVISOR', roleKey: 'team_leader' },
      { sequence: 2, name: 'Admin Back Support', approverType: 'ROLE', roleKey: 'back_support' },
      { sequence: 3, name: 'Cost Controller', approverType: 'ROLE', roleKey: 'cost_controller' },
      { sequence: 4, name: 'CEO / President', approverType: 'ROLE', roleKey: 'ceo' },
    ],
  },
  {
    // PURCHASE ORDER (the sheet of 2026-10-13): the Purchasing Manager, and
    // the CEO / President too above ₱100,000 — prepared by Admin Back Support
    // or a Purchasing Manager, whose own order is signed at step 1 when it is
    // submitted. "Purchase Order — project manager then finance" is RETIRED.
    documentType: 'purchase_order',
    name: 'Purchase Order — purchasing manager',
    maxAmount: 100_000,
    preparerSigns: true,
    standIns: true,
    steps: [{ sequence: 1, name: 'Purchasing Manager', approverType: 'ROLE', roleKey: 'purchasing_manager' }],
  },
  {
    documentType: 'purchase_order',
    name: 'Purchase Order — purchasing manager, then CEO / President over ₱100,000',
    minAmount: 100_000.01,
    preparerSigns: true,
    standIns: true,
    steps: [
      { sequence: 1, name: 'Purchasing Manager', approverType: 'ROLE', roleKey: 'purchasing_manager' },
      { sequence: 2, name: 'CEO / President', approverType: 'ROLE', roleKey: 'ceo' },
    ],
  },
  // ── The warehouse flow (2026-10-14, the owner's call) ──────────────────
  // "Incoming — the warehouse receives this, approval of his/her report to";
  // "Outgoing — the warehouse issues this, approval of his/her report to".
  // One SUPERVISOR step each: the receiver's or issuer's "Reports to", else
  // a Warehouse Supervisor (on their team first). The approval posts the
  // stock and the job cost; nothing moves while it waits.
  {
    // The owner's route for Incoming (2026-10-14: "WAREHOUSE — creator ›
    // back support › purchasing manager"), with or without a purchase
    // order. Back Support is the one supporting the preparer's team.
    documentType: 'receiving',
    name: 'Incoming — back support, purchasing manager',
    preparerSigns: true,
    standIns: true,
    steps: [
      { sequence: 1, name: 'Back Support', approverType: 'ROLE', roleKey: 'back_support' },
      { sequence: 2, name: 'Purchasing Manager', approverType: 'ROLE', roleKey: 'purchasing_manager' },
    ],
  },
  {
    documentType: 'stock_issue',
    name: "Outgoing — the issuer's supervisor",
    steps: [{ sequence: 1, name: 'Supervisor', approverType: 'SUPERVISOR', roleKey: 'warehouse_supervisor' }],
  },
  {
    // Anyone may ask to borrow (2026-10-14, the owner's call): the Team
    // Leader / Technical Manager they report to or on their team, then the
    // warehouse's own sign-off before it releases. A person holding both
    // signs once.
    documentType: 'borrow_slip',
    name: 'Borrow slip — team leader, warehouse',
    preparerSigns: true,
    steps: [
      { sequence: 1, name: 'Team Leader / Technical Manager', approverType: 'SUPERVISOR', roleKey: 'team_leader', alsoRoleKeys: ['technical_manager'] },
      { sequence: 2, name: 'Warehouse Supervisor', approverType: 'ROLE', roleKey: 'warehouse_supervisor' },
    ],
  },
  {
    // Stock out against an issued sales order or an approved request
    // (2026-10-14): the warehouse prepares it, its reports-to approves.
    documentType: 'pullout_slip',
    name: "Pull-out slip — the warehouse's supervisor",
    steps: [{ sequence: 1, name: 'Supervisor', approverType: 'SUPERVISOR', roleKey: 'warehouse_supervisor' }],
  },
  {
    // A service report is written on site by the engineer who did the work, so
    // the check is the service manager who has to stand behind it, and — for a
    // commissioning report, which starts a warranty running — management too.
    documentType: 'commissioning_report',
    name: 'Commissioning report — service manager then management',
    steps: [
      { sequence: 1, name: 'Service Manager', approverType: 'ROLE', roleKey: 'service_manager' },
      { sequence: 2, name: 'Management approval', approverType: 'ROLE', roleKey: 'executive' },
    ],
  },
  {
    documentType: 'pm_report',
    name: 'PM report — service manager',
    steps: [{ sequence: 1, name: 'Service Manager', approverType: 'ROLE', roleKey: 'service_manager' }],
  },
  {
    documentType: 'inspection_report',
    name: 'Inspection report — service manager',
    steps: [{ sequence: 1, name: 'Service Manager', approverType: 'ROLE', roleKey: 'service_manager' }],
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
    // REIMBURSEMENT (the owner's money-out sheet, 2026-10-15: "Back Support >
    // Finance Staff > Finance Manager > CEO", after the requester's Team
    // Leader): every expense claim and liquidation. "Checking" is Finance
    // staff. The supervisor-then-finance route is RETIRED.
    documentType: 'expense',
    name: 'Reimbursement — team leader, back support, checking, finance manager, CEO / President',
    preparerSigns: true,
    standIns: true,
    steps: [
      { sequence: 1, name: 'Team Leader', approverType: 'SUPERVISOR', roleKey: 'team_leader' },
      { sequence: 2, name: 'Back Support', approverType: 'ROLE', roleKey: 'back_support' },
      { sequence: 3, name: 'Checking (Finance Staff)', approverType: 'ROLE', roleKey: 'finance' },
      { sequence: 4, name: 'Finance Manager', approverType: 'ROLE', roleKey: 'finance_manager' },
      { sequence: 5, name: 'CEO / President', approverType: 'ROLE', roleKey: 'ceo' },
    ],
  },
  {
    // CASH ADVANCE, money lent to an employee (the same sheet): the same five
    // signatures; finance releases it, the employee repays it.
    documentType: 'cash_advance',
    name: 'Cash advance — team leader, back support, checking, finance manager, CEO / President',
    preparerSigns: true,
    standIns: true,
    steps: [
      { sequence: 1, name: 'Team Leader', approverType: 'SUPERVISOR', roleKey: 'team_leader' },
      { sequence: 2, name: 'Back Support', approverType: 'ROLE', roleKey: 'back_support' },
      { sequence: 3, name: 'Checking (Finance Staff)', approverType: 'ROLE', roleKey: 'finance' },
      { sequence: 4, name: 'Finance Manager', approverType: 'ROLE', roleKey: 'finance_manager' },
      { sequence: 5, name: 'CEO / President', approverType: 'ROLE', roleKey: 'ceo' },
    ],
  },
  {
    documentType: 'job_order',
    // The project work order's route (2026-10-09, the owner's call: "creator
    // sales › project manager › team leader"): the Project Manager named ON
    // THE ORDER (the engine's PROJECT_MANAGER step, reading the request's own
    // projectManagerId; the project managers' role when none is named or the
    // PM raised it), then the salesperson's Team Leader — their "Reports to",
    // the sales managers when none is set. "Job order — service manager" is
    // RETIRED below.
    name: 'Job order — project manager then team leader',
    steps: [
      { sequence: 1, name: 'Project Manager', approverType: 'PROJECT_MANAGER', roleKey: 'project_manager' },
      { sequence: 2, name: 'Team Leader', approverType: 'SUPERVISOR', roleKey: 'sales_manager' },
    ],
  },
  {
    // The requester is the LEAVER's own login whenever one exists, so step 1 is
    // their supervisor and the engine's self-approval rule keeps them off their
    // own form. HR raises it only for a login-less employee — then step 1 is
    // HR's supervisor, which is why the HR step wants two holders.
    documentType: 'clearance',
    name: 'Clearance — supervisor, finance, then HR',
    steps: [
      { sequence: 1, name: 'Supervisor sign-off', approverType: 'SUPERVISOR' },
      { sequence: 2, name: 'Finance — no outstanding accountabilities', approverType: 'ROLE', roleKey: 'finance' },
      { sequence: 3, name: 'HR clearance', approverType: 'HR' },
    ],
  },
  {
    // The supervisor WRITES the evaluation, so their submission is their
    // sign-off and step 1 must not be SUPERVISOR (it would resolve to the
    // requester's own manager, or — for an HR-raised evaluation of an
    // unsupervised employee — back to the requester: the budget-request fault).
    documentType: 'evaluation',
    name: 'Employee evaluation — HR then management',
    steps: [
      { sequence: 1, name: 'HR review', approverType: 'HR' },
      { sequence: 2, name: 'Management approval', approverType: 'ROLE', roleKey: 'executive' },
    ],
  },
  {
    // An employee raises it; HR verifies. Never SUPERVISOR — a supervisor's own
    // certificate would route to their manager, who is not who checks these.
    documentType: 'training_certification',
    name: 'Training certification — HR verification',
    steps: [{ sequence: 1, name: 'HR verification', approverType: 'HR' }],
  },
];

async function main() {
  console.log('Seeding G-CORE…\n');

  // ── Company ────────────────────────────────────────────────────────────────
  await prisma.company.upsert({
    where: { id: 'company' },
    // The company record as it stood in SCORO (Settings > Company data and
    // logo), so a fresh database prints the letterhead Gruntech already issues.
    // Create only: `update` stays empty, so an existing database keeps
    // whatever an administrator typed in Settings.
    create: {
      id: 'company',
      name: 'GRUNTECHNOLOGY CORPORATION',
      legalName: 'GRUNTECHNOLOGY CORPORATION',
      address: '2 Rajah Soliman Street, Parang',
      city: 'Marikina City 1809',
      country: 'Philippines',
      tin: '008-847-780-000',
      regNo: 'CS201416452',
      phone: '(02) 8 655 4063',
      fax: '(02) 9 794 6560',
      email: 'customercare@gruntechnology.com',
      website: 'http://www.gruntechnology.com/',
      bankName: 'Bank of Philippine Islands',
      bankBranch: 'Marikina',
      bankAccount: '9731 0004 22',
      documentTagline: 'INDUSTRIAL UTILITY SOLUTIONS  WWW.GRUNTECHNOLOGY.COM',
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
  // A "CTG" role was seeded for the costing route's last step for a few
  // minutes on 2026-10-09 before the owner said CTG is the CEO: that step is
  // the executive role, and the role goes — unless somebody was given it.
  {
    const ctg = await prisma.role.findUnique({ where: { key: 'ctg' }, include: { _count: { select: { users: true } } } });
    if (ctg && ctg._count.users === 0) {
      await prisma.role.delete({ where: { id: ctg.id } });
      console.log('  · Removed the unused "CTG" role — the costing route\'s last step is the CEO (executive)');
    }
  }

  // ── Numbering ──────────────────────────────────────────────────────────────
  // A type's own default (the quotation's per-salesperson monthly pattern)
  // applies only to a fresh database: `update` is the label alone, so a
  // pattern an administrator configured is never overwritten.
  const STOCK_NUMBERING = {
    pattern: '{PREFIX}-{TYPE}-{YYYY}-{SEQ}',
    padding: 4,
    period: 'YEAR',
    scope: 'GLOBAL',
  } as const;
  const ownDefault: string[] = [];
  for (const dt of DOCUMENT_TYPES) {
    if (dt.defaults) ownDefault.push(dt.type);
    await prisma.numberSequence.upsert({
      where: { documentType_periodKey: { documentType: dt.type, periodKey: '' } },
      create: {
        documentType: dt.type,
        label: dt.label,
        typeCode: dt.code,
        ...(dt.defaults ?? STOCK_NUMBERING),
        periodKey: '',
        lastNumber: 0,
      },
      update: { label: dt.label },
    });
  }
  console.log(
    `  ✓ Numbering (${DOCUMENT_TYPES.length} document types${
      ownDefault.length ? `; own default on ${ownDefault.join(', ')}` : ''
    })`,
  );
  // The RFQ took the canvass's code on 2026-10-14; a stored canvass template
  // still on it moves to CVS, once.
  if ((await moveCanvassCode()).moved) console.log('  · Canvass numbering code moved from RFQ to CVS');

  // Quotation.expectedClosing arrived after quotations existed. Copy the lead's
  // date onto any quotation still without one — nulls only, so a date a
  // salesperson set is never overwritten and every later run is a no-op.
  const backfilled = await prisma.$executeRawUnsafe(
    `UPDATE "Quotation" q SET "expectedClosing" = l."expectedClosing"
       FROM "Lead" l
      WHERE q."leadId" = l.id AND q."expectedClosing" IS NULL AND l."expectedClosing" IS NOT NULL`,
  );
  if (backfilled) console.log(`  · Copied the lead's expected closing onto ${backfilled} quotation(s)`);

  // ── Approval workflows ─────────────────────────────────────────────────────
  const roleByKey = new Map(
    (await prisma.role.findMany({ select: { id: true, key: true } })).map((r) => [r.key, r.id]),
  );
  const alsoRoles = (st: SeedStep) => (st.alsoRoleKeys ?? []).map((k) => roleByKey.get(k)).filter((id): id is string => !!id);

  // Seeded workflows that were superseded by a corrected version. Left in place
  // but deactivated, so they stop matching new documents while any history
  // routed through them stays readable. Deleting them would orphan that.
  const RETIRED = [
    // The money-out routes of 2026-10-15: reimbursements and cash advances
    // take five signatures; a claim or advance pending on the old two-step
    // route finishes on it.
    'Expense claim — supervisor then finance',
    'Cash advance — supervisor then finance',
    // Incoming routes to Back Support, then the Purchasing Manager
    // (2026-10-14); a report pending on the supervisor's route finishes on it.
    "Incoming — the receiver's supervisor",
    'Budget Request — management',
    // A budget request stopped changing the budget and became project cash
    // (2026-10-07); its route now opens with the project's manager.
    'Budget Request — finance then management',
    'Purchase Order — procurement then finance',
    // The sales order's route became four signatures (2026-10-08): the two
    // routes before it — one step, and the CEO as an option — stop matching
    // new orders; an order already pending on one finishes on it.
    'Sales Order — sales manager',
    'Sales Order — with the CEO',
    // The costing's one-step management approval gave way to the owner's
    // three-signature route (2026-10-09).
    'Costing — management approval',
    // The job order became a project work order routed to its own project
    // manager, then the team leader (2026-10-09).
    'Job order — service manager',
    // The owner's routing sheet (2026-10-11): the quotation routes by who
    // prepared it, the CEO a fixed step over ₱1,000,000 rather than an option.
    'Quotation — sales manager',
    'Quotation — over ₱1,000,000, with the CEO',
    // The routing sheet of 2026-10-12: one route per document whoever
    // prepared it; what the preparer holds, they sign at submit.
    'Quotation — prepared by the CEO / President: no approval',
    'Quotation — prepared by a Team Leader: CEO / President',
    'Sales Order — prepared by the CEO / President: back support, cost controller',
    'Sales Order — prepared by a Team Leader: back support, cost controller, CEO / President',
    // The routing sheet of 2026-10-13 (APPROVAL_ROUTE.xlsx): the costing
    // loses its CEO step, the purchase requisition its amount bands, the
    // purchase order and the budget request their project manager and
    // finance steps.
    'Costing — technical manager, team leader, CTG',
    'Purchase Request — up to ₱50,000',
    'Purchase Request — ₱50,000 and above',
    'Purchase Order — project manager then finance',
    'Budget Request — project manager then finance',
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

    // In use, but still exactly as first seeded: nobody edited it, so the
    // correction reaches it — in place, step by step (see `previously`).
    if (already && already._count.requests > 0 && seed.previously) {
      const current = await prisma.approvalStep.findMany({
        where: { workflowId: already.id },
        orderBy: { sequence: 'asc' },
      });
      const same = (a: typeof current, b: SeedStep[]) =>
        a.length === b.length &&
        b.every(
          (s, i) =>
            a[i].sequence === s.sequence &&
            a[i].name === s.name &&
            a[i].approverType === s.approverType &&
            a[i].userId === null &&
            a[i].roleId === (s.roleKey ? (roleByKey.get(s.roleKey) ?? null) : null),
        );
      if (same(current, seed.previously) && seed.steps.length === current.length) {
        await prisma.$transaction(
          seed.steps.map((s, i) =>
            prisma.approvalStep.update({
              where: { id: current[i].id },
              data: {
                sequence: s.sequence,
                name: s.name,
                approverType: s.approverType,
                roleId: s.roleKey ? (roleByKey.get(s.roleKey) ?? null) : null,
              },
            }),
          ),
        );
        console.log(`  · Updated "${seed.name}" to its corrected route (it was still as first seeded)`);
      }
      continue;
    }

    if (already) {
      // An unused seeded workflow is refreshed, so a corrected routing reaches
      // an existing database. One that has already routed documents is left
      // alone: it is in use, and the customer may have edited it deliberately.
      if (already._count.requests === 0) {
        await prisma.$transaction(async (tx) => {
          await tx.approvalWorkflow.update({
            where: { id: already.id },
            data: { requesterRoleId: seed.requesterRoleKey ? (roleByKey.get(seed.requesterRoleKey) ?? null) : null },
          });
          await tx.approvalStep.deleteMany({ where: { workflowId: already.id } });
          await tx.approvalStep.createMany({
            data: seed.steps.map((s) => ({
              workflowId: already.id,
              sequence: s.sequence,
              name: s.name,
              approverType: s.approverType,
              roleId: s.roleKey ? (roleByKey.get(s.roleKey) ?? null) : null,
              alsoRoleIds: alsoRoles(s),
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
        optionLabel: seed.optionLabel ?? null,
        requesterRoleId: seed.requesterRoleKey ? (roleByKey.get(seed.requesterRoleKey) ?? null) : null,
        preparerSigns: seed.preparerSigns ?? false,
        standIns: seed.standIns ?? false,
        steps: {
          create: seed.steps.map((s) => ({
            sequence: s.sequence,
            name: s.name,
            approverType: s.approverType,
            roleId: s.roleKey ? (roleByKey.get(s.roleKey) ?? null) : null,
            alsoRoleIds: alsoRoles(s),
          })),
        },
      },
    });
  }
  console.log(`  ✓ Approval workflows (${WORKFLOWS.length})`);

  // The preparer's signature and the stand-in (2026-10-12) reach the seeded
  // routes ONCE, marked by a setting: an administrator who later unticks
  // either on a route keeps it unticked.
  {
    const MARK = 'seed.preparerSignsApplied';
    if (!(await prisma.setting.findUnique({ where: { key: MARK } }))) {
      let flagged = 0;
      for (const seed of WORKFLOWS.filter((w) => w.preparerSigns || w.standIns)) {
        const { count } = await prisma.approvalWorkflow.updateMany({
          where: { documentType: seed.documentType, name: seed.name },
          data: { preparerSigns: seed.preparerSigns ?? false, standIns: seed.standIns ?? false },
        });
        flagged += count;
      }
      await prisma.setting.create({
        data: { key: MARK, value: { at: new Date().toISOString(), flagged }, description: 'seed: the preparer signs / stand-ins were applied to the seeded routes once' },
      });
      if (flagged) console.log(`  · The preparer signs the steps they hold on ${flagged} route(s); managers may stand in`);
    }
  }

  // Raising a quotation revision once superseded the last one without
  // withdrawing its approval request, which then sat in the approver's queue
  // for good. Any still open is withdrawn — CANCELLED, never deleted. One
  // definition, shared with the API; a second run withdraws nothing.
  {
    const withdrawn = await withdrawStaleQuotationApprovals();
    // Orders made before progress booking link up to the quotation lines they book.
    const legacy = await linkLegacyBookings();
    if (legacy.linked || legacy.summarised) console.log(`Linked ${legacy.linked} sales order line(s) and ${legacy.summarised} summarised line(s) to their quotation lines`);
    // Budget requests approved as budget INCREASES (the rule before
    // 2026-10-07) are closed, so they do not read as cash finance still owes.
    const closedIncreases = await closeLegacyBudgetIncreases();
    if (closedIncreases) console.log(`  · Closed ${closedIncreases} budget request(s) approved as budget increases under the old rule`);
    // Costings priced with a markup, a contingency % or a discount (the rule
    // before 2026-10-09) carry over to the margin rule; the contract value
    // never moves.
    const margins = await migrateCostingMargins();
    if (margins.costings) {
      console.log(`  · Carried ${margins.costings} costing(s) over to the margin rule (${margins.contingencyLines} contingency line(s) written)`);
    }
    if (withdrawn.length) {
      console.log(
        `  · Withdrew ${withdrawn.length} approval request(s) left open on quotation revisions no longer awaiting approval: ${withdrawn.join(', ')}`,
      );
    }
  }

  // A plan registered before 2026-10-13 waited "for approval" with no route
  // behind it; it is a draft Request for Approval now, for its requester to
  // send. A second run moves none.
  {
    const { count } = await prisma.approvedPlan.updateMany({ where: { status: 'FOR_APPROVAL' }, data: { status: 'DRAFT' } });
    if (count) console.log(`  · ${count} plan(s) registered before Requests for Approval are drafts now, for their requesters to send`);
  }

  // The Quotation Groups master (Admin › Categories) starts from the groups
  // the quotation lines already use; a second run adds none.
  {
    const added = await seedQuotationGroups();
    if (added) console.log(`  · Added ${added} quotation group(s) from the lines that use them`);
    // The owner's twelve, with what each covers and its brand; blanks filled, nothing overwritten.
    const owned = await seedOwnerGroups();
    if (owned) console.log(`  · Seeded ${owned} of the owner's quotation group(s)`);
  }

  // The SCORO archive is gone (2026-10-10, the owner's call: "remove also
  // scoro data" — SCORO's quotations and invoices will arrive again later as
  // real quotations and sales orders). Its rows and PDFs are removed here,
  // audited once; the LegacyQuote table itself was dropped on 2026-10-11, the
  // push after the one that emptied it.
  {
    const archive = await removeScoroArchive();
    // The step still stamps its setting on an install that never had an
    // archive; only a removal that removed something is worth a line.
    if (archive && archive.pdfs + archive.views > 0) {
      console.log(`  · Removed the SCORO archive's leavings: ${archive.pdfs} PDF(s), ${archive.views} saved view(s)`);
    }
  }

  // The customer's own address (2026-10-11): once, every customer without
  // one takes its first site's, so quotations print what they printed before.
  {
    const filled = await backfillCustomerAddresses();
    if (filled) console.log(`  · Gave ${filled} customer(s) their first site's address as their own`);
  }

  // Quotations imported from SCORO before the "as imported, unchanged" mark
  // existed (2026-10-11) take it where nobody has changed them since: they
  // need no approval until a change is saved. A second run marks none.
  {
    const marked = await markUnchangedScoroImports();
    if (marked) console.log(`  · Marked ${marked} SCORO-imported quotation revision(s) as unchanged since import`);
  }

  // Old quotations take their author's team (2026-10-12): only those with no
  // team, only from an author who has one. A second run fills none.
  {
    const filled = await fillQuotationTeams();
    if (filled) console.log(`  · Set the team of ${filled} older quotation(s) to their author's team`);
  }

  // Accounts Receivable per the owner's sample (2026-10-15): invoices issued
  // before countering existed are taken as countered on their invoice date
  // (once), and every invoice with no salesperson takes its source's.
  {
    const countered = await backfillInvoiceCountering();
    if (countered) console.log(`  · Took ${countered} older invoice(s) as countered on their invoice date`);
    const credited = await fillInvoiceCredit();
    if (credited) console.log(`  · Credited ${credited} invoice(s) to their salesperson and team`);
    // Accounts Payable: delivery, terms and purchaser from what is on file.
    const bills = await fillBillTerms();
    if (bills) console.log(`  · Gave ${bills} supplier bill(s) their delivery date, terms and purchaser`);
  }

  // Activity types as data (2026-10-08): the six built-ins under the enum's
  // own keys, and every older activity given its typeKey once.
  {
    const types = await seedActivityTypes();
    if (types.created) console.log(`  · Seeded ${types.created} activity type(s)`);
    if (types.backfilled) console.log(`  · Gave ${types.backfilled} activit${types.backfilled === 1 ? 'y' : 'ies'} its type key`);
  }

  // The register's common equipment types (the owner's list, CAPSLOCK), in
  // this order; anything typed on a registration since sorts after them.
  // createMany + skipDuplicates: a second run adds none, renames none.
  {
    const COMMON = ['COMPRESSOR', 'DRYER', 'FILTER', 'GENERATOR', 'PUMPS', 'VFD', 'INSTRUMENT', 'FIRE PUMP', 'OTHERS'];
    const made = await prisma.equipmentType.createMany({
      data: COMMON.map((name, i) => ({ name, key: name, sortOrder: i })),
      skipDuplicates: true,
    });
    if (made.count) console.log(`  · Seeded ${made.count} equipment type(s)`);
  }

  // Costing.finalAt arrived after costings were already final. Their last
  // update is the best date on file; set once, and a second run finds none.
  {
    const dated = await prisma.$executeRaw`UPDATE "Costing" SET "finalAt" = "updatedAt" WHERE "status" = 'FINAL' AND "finalAt" IS NULL`;
    if (dated) console.log(`  · Dated ${dated} final costing(s) from their last update`);
  }

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

  // ── Plantilla ──────────────────────────────────────────────────────────────
  // One definition, shared with the API: every employee whose free-text
  // position names nothing in the plantilla is linked to a Position of that
  // title. Idempotent — a second run links nobody and prints nothing.
  {
    const { linked, positions } = await backfillPositions();
    if (linked) console.log(`  · Plantilla: linked ${linked} employee(s) to ${positions} position(s)`);
  }

  // ── Cost categories ────────────────────────────────────────────────────────
  // The five buckets every costing, budget and cost-ledger row is grouped by
  // (model §5.1). Marked isSystem so they cannot be deleted out from under the
  // ledger; the labels stay editable.
  // Contingency is the SIXTH bucket (2026-10-09, the owner's call): a
  // contingency is a cost line the estimate prices like any other, not a
  // percentage in the summary's foot.
  for (const [i, c] of [
    { code: 'MAT', name: 'Materials' },
    { code: 'EQP', name: 'Equipment' },
    { code: 'LAB', name: 'Labor' },
    { code: 'SUB', name: 'Subcontractor' },
    { code: 'IND', name: 'Indirect Cost' },
    { code: 'CON', name: 'Contingency' },
  ].entries()) {
    await prisma.costCategory.upsert({
      where: { code: c.code },
      create: { ...c, sortOrder: i, isSystem: true },
      update: { isSystem: true },
    });
  }
  console.log('  ✓ Cost categories (6)');

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
  // The inventory's eight (2026-10-15, the owner's inventory screen), in his
  // order, each with what it covers — a head start, renamed freely; a
  // category on file is never overwritten, only a blank description filled.
  const INVENTORY_CATEGORIES = [
    { code: 'PMP', name: 'Pumps & Motors', description: 'UL/FM Fire, Booster, Submersible' },
    { code: 'CTL', name: 'Industrial Controls', description: 'VFDs, HMI, Starters, Switchgear' },
    { code: 'INS', name: 'Instruments', description: 'Analyzers, Gauges, Flowmeters' },
    { code: 'PRT', name: 'Parts & Hardware', description: 'Impellers, Seals, Fittings, Kits' },
    { code: 'CNS', name: 'Consumables', description: 'Lubricants, Desiccants, Oils' },
    { code: 'FLT', name: 'Filters & Separation', description: 'CO2 Polishing, Water & Air Elements' },
    { code: 'DRY', name: 'Dryers & Treatment', description: 'Refrigerated, Desiccant Skids' },
    { code: 'PIP', name: 'Piping & Valves', description: 'Aluminum Air Loops, Check Valves' },
  ];
  for (const [n, c] of INVENTORY_CATEGORIES.entries()) {
    const found = await prisma.itemCategory.findUnique({ where: { code: c.code } });
    if (!found) await prisma.itemCategory.create({ data: { ...c, sortOrder: n + 1 } });
    else if (!found.description) await prisma.itemCategory.update({ where: { id: found.id }, data: { description: c.description, ...(found.sortOrder ? {} : { sortOrder: n + 1 }) } });
  }
  // The first starting tree goes after them, so the eight lead the screen; an
  // order an administrator set is kept.
  for (const [n, code] of ['PIPE', 'VALV', 'ELEC', 'COMP', 'GASE', 'FAB', 'CONS', 'TOOL', 'SAFE'].entries()) {
    await prisma.itemCategory.updateMany({ where: { code, sortOrder: 0 }, data: { sortOrder: 100 + n } });
  }
  console.log('  ✓ Inventory categories (8)');

  // ── Teams (the Industry master) ────────────────────────────────────────────
  // The owner's five sales teams (2026-10-08): a person's team is the Industry
  // row on their employee record (shared/team.ts). Same contract as the cost
  // categories: system rows cannot be deleted, the labels stay editable. The
  // five industries seeded before them retire once, their people moving to
  // the team that took them over (`retireFirstIndustries`).
  for (const [i, team] of TEAMS.entries()) {
    await prisma.industry.upsert({
      where: { code: team.code },
      create: { ...team, sortOrder: i, isSystem: true },
      update: { isSystem: true },
    });
  }
  console.log(`  ✓ Teams (${TEAMS.length})`);
  const retiredIndustries = await retireFirstIndustries();
  if (retiredIndustries) {
    console.log(`  ✓ Retired the first industries (${retiredIndustries.retired} switched off, ${retiredIndustries.moved} record(s) moved to their teams)`);
  }

  // ── Sub-industries ─────────────────────────────────────────────────────────
  // Where a customer sits in the market — the owner's eleven, typed in by
  // hand on the customer and optional. System rows: undeletable, renamable.
  const subIndustriesAdded = await seedSubIndustries();
  console.log(`  ✓ Sub-industries (${SUB_INDUSTRIES.length}${subIndustriesAdded ? `, ${subIndustriesAdded} added` : ''})`);

  // What a CAD job order asks for (2026-10-09): the seven, system rows.
  const drawingTypesAdded = await seedCadDrawingTypes();
  console.log(`  ✓ Drawing types (${CAD_DRAWING_TYPES.length}${drawingTypesAdded ? `, ${drawingTypesAdded} added` : ''})`);

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
  // for ordinary-day overtime; the face threshold is the face engine's 0.55
  // (shared/face.ts FACE_ENGINE — face-api's own 0.6 was the old engine's).
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
        faceThreshold: 0.55,
        // Probation: the statutory six months, evaluated at the third and
        // fifth, with HR told two weeks ahead. Ratings are out of five.
        probationMonths: 6,
        evaluationMilestoneMonths: [3, 5],
        evaluationNoticeDays: 14,
        ratingScale: 5,
        ratingLabels: ['Unsatisfactory', 'Needs improvement', 'Meets expectations', 'Exceeds expectations', 'Outstanding'],
      },
    },
    update: {},
  });
  // An install seeded before the new face engine stored 0.6; it moves to 0.55
  // once (marked in seed.faceEngineMigrated). Any other value is HR's choice.
  const faceThreshold = await migrateFaceThreshold();
  console.log(
    faceThreshold?.changed
      ? '  ✓ HR rules (face threshold 0.6 → 0.55 for the new face engine)'
      : '  ✓ HR rules',
  );

  // ── Clearance checklist ────────────────────────────────────────────────────
  // The company-property lines on a leaver's clearance. The rest of the
  // checklist is built from records the system already holds (open borrow
  // slips, unpaid claims, pending filings) and needs no seed.
  await prisma.setting.upsert({
    where: { key: 'hr.clearanceChecklist' },
    create: {
      key: 'hr.clearanceChecklist',
      description: 'Company property and accountabilities a leaver turns over, by the area that clears each',
      value: [
        { area: 'ADMIN', description: 'Laptop, charger and peripherals returned' },
        { area: 'ADMIN', description: 'Company mobile phone and SIM returned' },
        { area: 'HR', description: 'Company ID and access cards surrendered' },
        { area: 'HR', description: 'Uniforms and PPE returned' },
        { area: 'WAREHOUSE', description: 'Tools and test instruments returned to the warehouse' },
        { area: 'SUPERVISOR', description: 'Keys, site passes and vehicle handed over' },
        { area: 'FINANCE', description: 'Documents, files and work in progress turned over; no unliquidated advances' },
      ],
    },
    update: {},
  });
  console.log('  ✓ Clearance checklist');

  // ── Evaluation criteria ────────────────────────────────────────────────────
  // What a probationer or trainee is rated on. An evaluation SNAPSHOTS these
  // lines when it is created, so editing the list later never rewrites a
  // rating already given.
  await prisma.setting.upsert({
    where: { key: 'hr.evaluationCriteria' },
    create: {
      key: 'hr.evaluationCriteria',
      description: 'Criteria a probationary or trainee evaluation is scored on, with weights',
      value: [
        { key: 'QUAL', name: 'Quality of work', description: 'Accuracy, thoroughness and adherence to standards', appliesTo: 'BOTH', weight: 1, sortOrder: 1, isActive: true },
        { key: 'PROD', name: 'Productivity', description: 'Output against what the role expects, and meeting deadlines', appliesTo: 'BOTH', weight: 1, sortOrder: 2, isActive: true },
        { key: 'KNOW', name: 'Job knowledge', description: 'Technical skill and understanding of the work', appliesTo: 'BOTH', weight: 1, sortOrder: 3, isActive: true },
        { key: 'ATT', name: 'Attendance and punctuality', description: 'Reliability in reporting for work and on time', appliesTo: 'BOTH', weight: 1, sortOrder: 4, isActive: true },
        { key: 'TEAM', name: 'Teamwork', description: 'Cooperation with colleagues, supervisors and customers', appliesTo: 'BOTH', weight: 1, sortOrder: 5, isActive: true },
        { key: 'INIT', name: 'Initiative', description: 'Acting without being told and taking ownership', appliesTo: 'BOTH', weight: 1, sortOrder: 6, isActive: true },
        { key: 'LEARN', name: 'Learning progress', description: 'How far the trainee has come against the training plan', appliesTo: 'TRAINEE', weight: 1, sortOrder: 7, isActive: true },
      ],
    },
    update: {},
  });
  console.log('  ✓ Evaluation criteria');

  // ── Academy rules ──────────────────────────────────────────────────────────
  await prisma.setting.upsert({
    where: { key: 'academy.rules' },
    create: {
      key: 'academy.rules',
      description: 'Certification expiry warning, self-enrolment and the course categories',
      value: {
        expiryWarningDays: 60,
        allowSelfEnrolment: true,
        categories: ['Safety', 'Technical', 'Quality', 'Compliance', 'Soft skills'],
      },
    },
    update: {},
  });
  console.log('  ✓ Academy rules');

  // ── Finance rules ──────────────────────────────────────────────────────────
  // Supplier withholding follows the usual BIR schedule — 1% on goods, 2% on
  // services — but defaults to zero on each bill, because withholding when you
  // should not have underpays a supplier and is awkward to unwind. These are
  // the SUGGESTIONS the bill screen offers, not an automatic deduction.
  await prisma.setting.upsert({
    where: { key: 'finance.rules' },
    create: {
      key: 'finance.rules',
      description: 'Payment terms, supplier withholding rates, aging buckets, cash-advance and budget-request rules',
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

  // ── Aftermarket rules ──────────────────────────────────────────────────────
  await prisma.setting.upsert({
    where: { key: 'aftermarket.rules' },
    create: {
      key: 'aftermarket.rules',
      description: 'Warranty length, PM frequency and how far ahead expiry is flagged',
      value: {
        expiryWarningDays: 90,
        defaultWarrantyMonths: 12,
        defaultFrequencyMonths: 3,
        missedAfterDays: 14,
      },
    },
    update: {},
  });
  console.log('  ✓ Aftermarket rules');

  // ── Report templates ───────────────────────────────────────────────────────
  // Starting forms for an industrial gas contractor, versioned from the first
  // day. A template that has been used is never edited in place — editing
  // publishes v2 and leaves v1 exactly as it was signed (model §4.5). These are
  // a head start for a service engineer to customise, not a constraint.
  const TEMPLATES: {
    key: string;
    kind: 'COMMISSIONING' | 'PREVENTIVE_MAINTENANCE' | 'INSPECTION';
    name: string;
    description: string;
    sections: unknown[];
  }[] = [
    {
      key: 'commissioning-oxygen-plant',
      kind: 'COMMISSIONING',
      name: 'Oxygen plant commissioning',
      description: 'Handover check for a PSA oxygen generation plant',
      sections: [
        {
          key: 'installation',
          title: 'Installation',
          allowPhotos: true,
          fields: [
            { key: 'foundation', label: 'Foundation and anchoring', type: 'pass_fail', required: true },
            { key: 'piping', label: 'Piping and supports', type: 'pass_fail', required: true },
            { key: 'electrical', label: 'Electrical termination', type: 'pass_fail', required: true },
            { key: 'labels', label: 'Labelling and signage', type: 'pass_fail' },
          ],
        },
        {
          key: 'performance',
          title: 'Performance test',
          allowPhotos: true,
          fields: [
            { key: 'purity', label: 'Oxygen purity', type: 'number', unit: '%', required: true },
            { key: 'flow', label: 'Flow rate', type: 'number', unit: 'LPM', required: true },
            { key: 'pressure', label: 'Outlet pressure', type: 'number', unit: 'bar', required: true },
            { key: 'dewpoint', label: 'Dew point', type: 'number', unit: '°C' },
            { key: 'noise', label: 'Noise level', type: 'number', unit: 'dB' },
            { key: 'runHours', label: 'Continuous run test', type: 'number', unit: 'hours', required: true },
          ],
        },
        {
          key: 'safety',
          title: 'Safety and alarms',
          fields: [
            { key: 'lowPurity', label: 'Low-purity alarm tested', type: 'boolean', required: true },
            { key: 'lowPressure', label: 'Low-pressure alarm tested', type: 'boolean', required: true },
            { key: 'emergencyStop', label: 'Emergency stop tested', type: 'boolean', required: true },
            { key: 'reliefValve', label: 'Relief valve setting', type: 'number', unit: 'bar' },
          ],
        },
        {
          key: 'handover',
          title: 'Handover',
          fields: [
            { key: 'manuals', label: 'Manuals handed over', type: 'boolean', required: true },
            { key: 'training', label: 'Operator training given', type: 'boolean', required: true },
            { key: 'trainedNames', label: 'Who was trained', type: 'text' },
            { key: 'spares', label: 'Spares left on site', type: 'note' },
          ],
        },
      ],
    },
    {
      key: 'pm-oxygen-plant',
      kind: 'PREVENTIVE_MAINTENANCE',
      name: 'Oxygen plant preventive maintenance',
      description: 'Routine quarterly service of a PSA plant and its compressor',
      sections: [
        {
          key: 'readings',
          title: 'Operating readings',
          fields: [
            { key: 'hours', label: 'Running hours', type: 'number', unit: 'h', required: true },
            { key: 'purity', label: 'Oxygen purity', type: 'number', unit: '%', required: true },
            { key: 'pressure', label: 'Outlet pressure', type: 'number', unit: 'bar', required: true },
            { key: 'dewpoint', label: 'Dew point', type: 'number', unit: '°C' },
          ],
        },
        {
          key: 'compressor',
          title: 'Compressor',
          allowPhotos: true,
          fields: [
            { key: 'oilLevel', label: 'Oil level', type: 'pass_fail', required: true },
            { key: 'oilChanged', label: 'Oil changed', type: 'boolean' },
            { key: 'airFilter', label: 'Air filter', type: 'select', options: ['Clean', 'Cleaned', 'Replaced'], required: true },
            { key: 'beltCondition', label: 'Belt / coupling', type: 'pass_fail' },
            { key: 'leaks', label: 'Air leaks found', type: 'note' },
          ],
        },
        {
          key: 'dryer',
          title: 'Dryer and filtration',
          fields: [
            { key: 'drain', label: 'Auto drain working', type: 'pass_fail', required: true },
            { key: 'prefilter', label: 'Pre-filter', type: 'select', options: ['Clean', 'Cleaned', 'Replaced'] },
            { key: 'postfilter', label: 'Post-filter', type: 'select', options: ['Clean', 'Cleaned', 'Replaced'] },
          ],
        },
        {
          key: 'safety',
          title: 'Safety checks',
          fields: [
            { key: 'alarms', label: 'Alarms tested', type: 'boolean', required: true },
            { key: 'gauges', label: 'Gauges within calibration', type: 'pass_fail' },
            { key: 'housekeeping', label: 'Plant room housekeeping', type: 'pass_fail' },
          ],
        },
      ],
    },
    {
      key: 'inspection-general',
      kind: 'INSPECTION',
      name: 'General service inspection',
      description: 'Site inspection or breakdown call-out',
      sections: [
        {
          key: 'call',
          title: 'The call',
          fields: [
            { key: 'reported', label: 'Reported fault', type: 'note', required: true },
            { key: 'reportedBy', label: 'Reported by', type: 'text' },
            { key: 'downtime', label: 'Equipment down since', type: 'date' },
          ],
        },
        {
          key: 'findings',
          title: 'What was found',
          allowPhotos: true,
          fields: [
            { key: 'cause', label: 'Cause', type: 'note', required: true },
            { key: 'condition', label: 'Overall condition', type: 'select', options: ['Good', 'Fair', 'Poor', 'Unsafe'], required: true },
            { key: 'partsUsed', label: 'Parts used', type: 'note' },
          ],
        },
        {
          key: 'outcome',
          title: 'Outcome',
          fields: [
            { key: 'resolved', label: 'Resolved on this visit', type: 'boolean', required: true },
            { key: 'returnNeeded', label: 'Return visit needed', type: 'boolean' },
            { key: 'partsToOrder', label: 'Parts to order', type: 'note' },
          ],
        },
      ],
    },
  ];

  for (const t of TEMPLATES) {
    const existing = await prisma.reportTemplate.findFirst({ where: { key: t.key } });
    if (existing) continue;
    await prisma.reportTemplate.create({
      data: {
        key: t.key,
        version: 1,
        kind: t.kind,
        name: t.name,
        description: t.description,
        sections: t.sections as never,
      },
    });
  }
  console.log(`  ✓ Report templates (${TEMPLATES.length})`);

  // ── Super admin ────────────────────────────────────────────────────────────
  // Made only on a database with no super admin at all — never because the
  // configured address is not on file (it may have moved, below), which
  // would leave a second super admin behind on the known starting password.
  const existingAdmin =
    (await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } })) ??
    (await prisma.user.findFirst({ where: { isSuperAdmin: true }, orderBy: { createdAt: 'asc' } }));
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
    console.log(`  ✓ Super admin already exists: ${existingAdmin.email}`);
  }
  // Once: the seeded admin signs in as gcore@gruntechnology.com (2026-10-13).
  const adminMove = await moveAdminEmail([OLD_ADMIN_EMAIL, process.env.SEED_ADMIN_EMAIL ?? OLD_ADMIN_EMAIL]);
  if (adminMove.moved) console.log(`  ✓ Super admin's sign-in email moved: ${adminMove.from} → ${adminMove.to}`);
  else if (adminMove.reason === 'taken') console.log(`  ⚠  ${adminMove.to} is already another login's email — the admin's address was left as it is`);

  console.log('Seed complete.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  // backfillPositions() runs on the API's own client, so close that one too.
  .finally(() => Promise.all([prisma.$disconnect(), sharedPrisma.$disconnect()]));
