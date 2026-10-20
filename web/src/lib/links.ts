/**
 * Where a record lives.
 *
 * The audit log, notifications and the approval engine name a record by the
 * `entityType` / `documentType` strings the API writes; this is the one map
 * from those strings to the screen that opens the record. A pure map with no
 * imports, so a report table can link a row without pulling in a page.
 *
 * Returns `null` when no screen exists for the type — the caller then prints
 * the number as text rather than inventing a link that lands on "Not built
 * yet". Every route here must exist in App.tsx (rule 15).
 */

/** Types whose detail page is `<base>/<id>`. */
const DETAIL: Record<string, string> = {
  // Masters
  customer: '/g-ops/customers',
  supplier: '/g-chain/suppliers',
  partner: '/g-ops/partners',
  employee: '/g-hr/employees',
  item: '/g-chain/items',
  user: '/admin/users',
  // Sales
  lead: '/g-ops/leads',
  quotation: '/g-ops/quotations',
  sales_order: '/g-ops/sales-orders',
  costing: '/g-ops/costing',
  // Delivery
  job: '/g-ops/projects',
  project: '/g-ops/projects',
  progress_report: '/g-ops/progress',
  progress_billing: '/g-ops/billings',
  commission: '/g-fin/commissions',
  invoice_request: '/g-fin/invoice-requests',
  // Procurement and warehouse
  purchase_request: '/g-chain/purchase-requests',
  rfq: '/g-chain/rfq',
  canvass: '/g-chain/canvass',
  purchase_order: '/g-chain/purchase-orders',
  receiving: '/g-chain/incoming',
  stock_issue: '/g-chain/outgoing',
  borrow_slip: '/g-chain/borrow-slips',
  pullout_slip: '/g-chain/pullout-slips',
  // Finance
  invoice: '/g-fin/ar',
  supplier_bill: '/g-fin/ap',
  expense: '/g-fin/expenses',
  expense_claim: '/g-fin/expenses',
  cash_advance: '/g-fin/cash-advances',
  // Aftermarket
  installed_asset: '/g-ops/installed-base',
  service_contract: '/g-ops/service-contracts',
  service_report: '/g-ops/service-reports',
  commissioning_report: '/g-ops/service-reports',
  pm_report: '/g-ops/service-reports',
  inspection_report: '/g-ops/service-reports',
  job_order: '/g-ops/job-orders',
  // The Service JO under Aftermarket (2026-10-20) — the same table, its own register.
  service_job_order: '/g-ops/service-job-orders',
  cad_job_order: '/g-ops/cad-job-orders',
  // A project's drawing sent for approval (2026-10-13); the engine files it as plan_approval.
  approved_plan: '/g-ops/plans',
  plan_approval: '/g-ops/plans',
  help_ticket: '/admin/help-tickets',
  // HR
  leave_request: '/g-hr/leave',
  overtime_request: '/g-hr/overtime',
  overtime_prior: '/g-hr/overtime',
  // The enrolment photo is attached to the employee.
  face_enrollment: '/g-hr/employees',
  clearance: '/g-hr/clearances',
  // One person's path (2026-10-13); the audit files HR's ticks under the employee's id.
  people_flow: '/g-hr/people-flow',
  meeting: '/g-hr/meetings',
  evaluation: '/g-hr/evaluations',
  training_session: '/g-hr/academy/sessions',
};

/** Types that open inside a list screen, through a query parameter. */
const QUERY: Record<string, string> = {
  service_visit: '/g-ops/visits?visit=',
  sales_activity: '/g-ops/calendar/activities/',
  activity: '/g-ops/calendar/activities/',
  course: '/g-hr/academy/courses?course=',
};

/** Where a QUERY type's printed list (entityId 'list') or a bare row lands. */
const QUERY_LIST: Record<string, string> = {
  service_visit: '/g-ops/visits',
  sales_activity: '/g-ops/calendar',
  activity: '/g-ops/calendar',
  course: '/g-hr/academy/courses',
};

/** Types with a screen but no per-record URL — the list or the settings page. */
const SCREEN: Record<string, string> = {
  warehouse: '/g-chain/warehouses',
  // The stock-on-hand list's paper audits as EXPORTED under 'inventory'.
  inventory: '/g-chain/inventory',
  cost_category: '/admin/categories',
  item_category: '/admin/categories',
  industry: '/admin/categories',
  sub_industry: '/admin/categories',
  position: '/g-hr/plantilla',
  // A record or certificate lives on its holder's passport; the id here is
  // the record's, not the employee's, so the register is as close as it gets.
  training_record: '/g-hr/academy/passports',
  training_certification: '/g-hr/academy/passports',
  // The passport register's paper audits as EXPORTED under 'training_passport'.
  training_passport: '/g-hr/academy/passports',
  budget_request: '/g-ops/budget-requests',
  // Finance. A payment has its own page since 2026-10-09; a disbursement is
  // the same record seen from the money-out side.
  payment: '/g-fin/payments',
  disbursement: '/g-fin/payments',
  attendance: '/g-hr/attendance',
  report_template: '/g-ops/report-templates',
  number_sequence: '/admin/numbering',
  approval_workflow: '/admin/workflows',
  role: '/admin/roles',
  // The Audit Logs paper audits itself as EXPORTED under 'audit_log'.
  audit_log: '/admin/audit',
  company: '/admin/company',
  // Company Settings › Preview prints the document specimen.
  pdf_specimen: '/admin/company',
  approval: '/my-work',
  approval_request: '/my-work',
  pipeline: '/g-ops/pipeline',
  insights: '/insights',
  // Reference lists edited on Admin › Categories.
  quotation_group: '/admin/categories',
  activity_type: '/admin/categories',
  cad_drawing_type: '/admin/categories',
  costing_template: '/g-ops/costing',
  // A report's paper and CSV audit as EXPORTED under its division's type.
  chain_report: '/g-chain/reports',
  finance_report: '/g-fin/reports',
  hr_report: '/g-hr/reports',
};

/**
 * Where a DETAIL type's printed list (entityId 'list') lands, when the list is
 * not at the detail page's own base — a progress billing's page is
 * `/g-ops/billings/:id`, its register the Progress & Billing list.
 */
const DETAIL_LIST: Record<string, string> = {
  progress_billing: '/g-ops/progress',
};

/**
 * A Setting is keyed by name, and each module owns its own page of them —
 * `hr.rules` is edited under G-HR, `finance.rules` under G-FIN.
 */
function settingLink(id: string): string {
  if (id.startsWith('hr.') || id.startsWith('academy.')) return '/g-hr/settings';
  if (id.startsWith('finance.')) return '/g-fin/settings';
  if (id.startsWith('aftermarket.')) return '/g-ops/aftermarket';
  if (id.startsWith('appearance')) return '/admin/appearance';
  // Each designed paper's layout is edited in Admin › PDF Templates.
  if (id.startsWith('pdfTemplate.')) return '/admin/pdf-templates';
  if (id.startsWith('pipeline.')) return '/admin/pipeline-stages';
  if (id.startsWith('helpTickets.')) return '/admin/help-tickets';
  // The holidays are kept on Company Settings (2026-10-17).
  if (id.startsWith('calendar.')) return '/admin/company';
  return '/admin/settings';
}

export function recordLink(entityType: string, id: string): string | null {
  if (!entityType) return null;
  const type = entityType.toLowerCase();
  if (type === 'setting') return settingLink(id);
  // Who receives the Help box's tickets is set on the register itself.
  if (type === 'help_ticket' && id === 'receivers') return '/admin/help-tickets';
  // A printed list audits as EXPORTED with entityId 'list' (CLAUDE.md, the
  // printed lists): that row opens the list itself, never a record page that
  // would ask the API for a record called "list". The same holds for a type
  // opened through a query parameter (`?visit=list` is a "not found" modal).
  if (type in DETAIL) return id && id !== 'list' ? `${DETAIL[type]}/${encodeURIComponent(id)}` : DETAIL_LIST[type] ?? DETAIL[type];
  if (type in QUERY) return id && id !== 'list' ? `${QUERY[type]}${encodeURIComponent(id)}` : QUERY_LIST[type] ?? null;
  if (type in SCREEN) return SCREEN[type];
  // partner_resource: it lives inside its partner's page and carries no
  // address of its own.
  return null;
}
