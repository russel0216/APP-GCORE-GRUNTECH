import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { allPermissions, permissionsFor } from '../src/permissions/registry';
import { DOCUMENT_TYPES } from '../src/shared/numbering';
import { backfillPositions } from '../src/shared/plantilla';
import { prisma as sharedPrisma } from '../src/prisma';

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
      'gops.quotations.export',
      // Their own only: the route also requires authorship (canEditRecord),
      // and refuses a won, delivered or pending quotation.
      'gops.quotations.delete',
      // The SCORO history they are continuing from. Read-only.
      'gops.quote_archive.view_all',
      ...VIEW_OWN_SELF('gops', 'costing'),
      'gops.costing.export',
      'gops.dashboard.view_all',
      'gops.pipeline.view_all',
      'gops.projects.view_all',
      // A partner's catalogue and price list are what a salesperson sells from.
      'gops.partners.view_all',
      'gops.partners.export',
      // Sales takes the service call and raises the job order for it.
      ...VIEW_OWN_SELF('gops', 'job_orders'),
      'gops.job_orders.export',
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
      ['gops', 'pipeline'],
      ['gops', 'costing'],
      ['gops', 'partners'],
    ],
    only: [
      'gops.dashboard.view_all',
      'gops.projects.view_all',
      'gops.projects.export',
      // The SCORO archive, seen and exported whole. Not create: the import is
      // an administrator's job, done once.
      'gops.quote_archive.view_all',
      'gops.quote_archive.export',
      // The pipeline analytics are their own numbers, seen whole.
      'insights.pipeline.view_all',
      'insights.pipeline.export',
      ...VIEW_OWN_SELF('gops', 'job_orders'),
      'gops.job_orders.view_all',
      'gops.job_orders.export',
      ...VIEW_OWN_SELF('gfin', 'expenses'),
      ...VIEW_OWN_SELF('gfin', 'cash_advances'),
      ...VIEW_OWN_SELF('ghr', 'evaluations'),
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
      'gops.quote_archive.view_all',
      'gops.job_orders.view_all',
      'gchain.purchase_requests.view_all',
      // A PM raises stock-replenishment requests too, not only direct-to-job
      // ones from the project workspace.
      'gchain.purchase_requests.create',
      'gchain.purchase_requests.edit_own',
      'gchain.purchase_requests.view_own',
      'gchain.purchase_orders.view_all',
      'gchain.inventory.view_all',
      'gfin.budget_vs_actual.view_all',
      'ghr.overtime.approve',
      ...VIEW_OWN_SELF('gfin', 'expenses'),
      ...VIEW_OWN_SELF('gfin', 'cash_advances'),
      ...VIEW_OWN_SELF('ghr', 'evaluations'),
      ...VIEW_OWN_SELF('ghr', 'meetings'),
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
      ...VIEW_OWN_SELF('gchain', 'purchase_requests'),
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
      'gops.visits.export',
      'gops.renewals.view_all',
      'gops.renewals.export',
      'gops.report_templates.view_all',
      'gops.customers.view_all',
      'gops.quotations.view_all',
      'gops.costing.view_all',
      'gops.partners.view_all',
      'gops.partners.export',
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
      ['gchain', 'inventory'],
    ],
    only: [
      'insights.inventory.view_all',
      'insights.inventory.export',
      'gchain.dashboard.view_all',
      'gchain.purchase_orders.view_all',
      'gchain.reports.view_all',
      'gchain.reports.export',
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
    ],
    only: [
      'insights.dashboard.view_all',
      'insights.profitability.view_all',
      'insights.profitability.export',
      'insights.cash.view_all',
      'insights.cash.export',
      'gops.projects.view_all',
      'gops.progress_billing.view_all',
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
      'gfin.ar.export',
      'gfin.ap.view_all',
      'gfin.ap.create',
      'gfin.ap.edit_all',
      'gfin.ap.export',
      'gfin.expenses.view_all',
      'gfin.cash_advances.view_all',
      'gfin.reports.view_all',
      'gfin.reports.export',
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
    ],
    only: [
      'ghr.clock.view_own',
      'ghr.clock.create',
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
      'ghr.clock.create',
      'ghr.dashboard.view_all',
      ...VIEW_OWN_SELF('ghr', 'leave'),
      'ghr.leave.view_all',
      'ghr.leave.approve',
      ...VIEW_OWN_SELF('ghr', 'overtime'),
      'ghr.overtime.view_all',
      'ghr.overtime.approve',
      // First sign-off on a leaver's clearance; writes the evaluations of
      // their own probationers.
      'ghr.clearances.view_all',
      'ghr.clearances.approve',
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
      'ghr.clock.create',
      ...VIEW_OWN_SELF('ghr', 'leave'),
      ...VIEW_OWN_SELF('ghr', 'overtime'),
      // A leaver raises their own clearance; an evaluation is read once
      // approved, never written by its subject.
      'ghr.clearances.view_own',
      'ghr.clearances.create',
      'ghr.evaluations.view_own',
      ...VIEW_OWN_SELF('ghr', 'meetings'),
      'ghr.training_calendar.view_all',
      'ghr.passport.view_own',
      'ghr.passport.create',
      ...VIEW_OWN_SELF('gfin', 'expenses'),
      ...VIEW_OWN_SELF('gfin', 'cash_advances'),
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
      'ghr.training_sessions.export',
      'ghr.passports.view_all',
      'ghr.passport.view_own',
      'ghr.passport.create',
      'ghr.clock.view_own',
      'ghr.clock.create',
      ...VIEW_OWN_SELF('ghr', 'leave'),
      ...VIEW_OWN_SELF('ghr', 'overtime'),
      ...VIEW_OWN_SELF('ghr', 'meetings'),
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
  /** An optional route the submitter may tick (ApprovalWorkflow.optionLabel). */
  optionLabel?: string;
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
    // The margin a costing sets is what the company commits to on every
    // quotation and project built from it, so management signs it off. Sales
    // and project managers raise costings; routing to either would leave a
    // one-person team approving their own. To go without costing approval,
    // DEACTIVATE this workflow (Admin › Approval Workflows) rather than
    // deleting it — a deleted seeded workflow is recreated on the next seed,
    // a deactivated one is left alone, and the page returns to "Mark final".
    documentType: 'costing',
    name: 'Costing — management approval',
    steps: [{ sequence: 1, name: 'Management approval', approverType: 'ROLE', roleKey: 'executive' }],
  },
  {
    documentType: 'quotation',
    name: 'Quotation — sales manager',
    steps: [{ sequence: 1, name: 'Sales Manager', approverType: 'ROLE', roleKey: 'sales_manager' }],
  },
  {
    // An OPTION, not a rule: a quotation over ₱1,000,000 may also go to the
    // CEO when whoever submits it ticks "Add the CEO as approver". The sales
    // manager still decides first. Routed to the executive role; point the CEO
    // step at one person in Admin › Approval Workflows if several hold it.
    documentType: 'quotation',
    name: 'Quotation — over ₱1,000,000, with the CEO',
    minAmount: 1_000_000.01,
    optionLabel: 'Add the CEO as approver',
    steps: [
      { sequence: 1, name: 'Sales Manager', approverType: 'ROLE', roleKey: 'sales_manager' },
      { sequence: 2, name: 'CEO approval', approverType: 'ROLE', roleKey: 'executive' },
    ],
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
    documentType: 'expense',
    name: 'Expense claim — supervisor then finance',
    steps: [
      { sequence: 1, name: 'Supervisor approval', approverType: 'SUPERVISOR' },
      { sequence: 2, name: 'Finance approval', approverType: 'ROLE', roleKey: 'finance' },
    ],
  },
  {
    documentType: 'cash_advance',
    // Finance approves because finance releases the cash and must have said
    // yes before the voucher exists. Not routed to the requester's own role.
    name: 'Cash advance — supervisor then finance',
    steps: [
      { sequence: 1, name: 'Supervisor approval', approverType: 'SUPERVISOR' },
      { sequence: 2, name: 'Finance approval', approverType: 'ROLE', roleKey: 'finance' },
    ],
  },
  {
    documentType: 'job_order',
    // Raised by sales or an engineer taking the call; accepted by the person who
    // owns the schedule and stands behind the charging decision.
    name: 'Job order — service manager',
    steps: [{ sequence: 1, name: 'Service Manager', approverType: 'ROLE', roleKey: 'service_manager' }],
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
        optionLabel: seed.optionLabel ?? null,
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

  // ── Industries ─────────────────────────────────────────────────────────────
  // The owner's five customer classifications. Same contract as the cost
  // categories: system rows cannot be deleted, the labels stay editable.
  for (const [i, ind] of [
    { code: 'HI', name: 'Healthcare Industry' },
    { code: 'BI', name: 'Building Industry' },
    { code: 'UI', name: 'Utility Industry' },
    { code: 'GI', name: 'General Industry' },
    { code: 'SI', name: 'Special Industry' },
  ].entries()) {
    await prisma.industry.upsert({
      where: { code: ind.code },
      create: { ...ind, sortOrder: i, isSystem: true },
      update: { isSystem: true },
    });
  }
  console.log('  ✓ Industries (5)');

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
  console.log('  ✓ HR rules');

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
  // backfillPositions() runs on the API's own client, so close that one too.
  .finally(() => Promise.all([prisma.$disconnect(), sharedPrisma.$disconnect()]));
