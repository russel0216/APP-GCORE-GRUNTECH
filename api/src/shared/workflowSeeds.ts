/**
 * The approval routes the seed creates (moved out of prisma/seed.ts on
 * 2026-11-26), so the verify scripts can run on the SEEDED routes whatever an
 * install's administrator has made of its own (scripts/lib/routes.ts).
 */

export interface WorkflowSeed {
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
  previously?: SeedStep[] | SeedStep[][];
}

export interface SeedStep {
  sequence: number;
  name: string;
  approverType: 'ROLE' | 'USER' | 'SUPERVISOR' | 'HR' | 'PROJECT_MANAGER' | 'PROJECT_MANAGERS';
  /**
   * The role a ROLE step routes to; on a SUPERVISOR step, who decides when the
   * requester has no supervisor; on a PROJECT_MANAGER step, who decides when
   * the project has no manager or the manager raised the document.
   */
  roleKey?: string;
  /** Roles whose holders decide it too (`ApprovalStep.alsoRoleIds`): on a SUPERVISOR step those on the requester's team, on a ROLE step every holder. */
  alsoRoleKeys?: string[];
}

export const WORKFLOWS: WorkflowSeed[] = [
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
    // An attendance correction (2026-10-23): the supervisor who knows the
    // day, then HR, who keeps the register. Approval writes the times.
    documentType: 'attendance_correction',
    name: 'Attendance correction — supervisor then HR',
    steps: [
      { sequence: 1, name: 'Supervisor approval', approverType: 'SUPERVISOR' },
      { sequence: 2, name: 'HR approval', approverType: 'HR' },
    ],
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
    // Since 2026-11-19 the Technical Manager is the PROJECT's (the request's
    // project's Technical Manager, else the one on the team that owns it;
    // with no project, the requester's team's) — `routePurchaseRequestsByProject`.
    documentType: 'purchase_request',
    name: 'Purchase Request — technical manager, team leader',
    preparerSigns: true,
    standIns: true,
    steps: [
      { sequence: 1, name: 'Technical Manager', approverType: 'PROJECT_MANAGER', roleKey: 'technical_manager' },
      { sequence: 2, name: 'Team Leader', approverType: 'SUPERVISOR', roleKey: 'team_leader' },
    ],
  },
  {
    // The WAREHOUSE's purchase request (2026-11-25, the owner's call): the
    // automatic reorder, consumables and local buying go to the Purchasing
    // Manager (Local) alone. Marked by its option label, which a standard
    // pick never lands on — `stockRequestRoute()` asks for it by that label
    // for every stock replenishment (shared/stockRequestRoute.ts).
    documentType: 'purchase_request',
    name: 'Purchase Request — warehouse stock, local (purchasing manager)',
    optionLabel: 'Warehouse stock — local purchase',
    preparerSigns: true,
    standIns: true,
    steps: [{ sequence: 1, name: 'Purchasing Manager (Local)', approverType: 'ROLE', roleKey: 'purchasing_manager' }],
  },
  {
    // … and with the Cost Controller and the CEO / President where a line is
    // an imported brand's (a product group ticked "Imported brand").
    documentType: 'purchase_request',
    name: 'Purchase Request — warehouse stock, imported (purchasing manager, cost controller, CEO)',
    optionLabel: 'Warehouse stock — imported brand',
    preparerSigns: true,
    standIns: true,
    steps: [
      { sequence: 1, name: 'Purchasing Manager (Local)', approverType: 'ROLE', roleKey: 'purchasing_manager' },
      { sequence: 2, name: 'Cost Controller', approverType: 'ROLE', roleKey: 'cost_controller' },
      { sequence: 3, name: 'CEO / President', approverType: 'ROLE', roleKey: 'ceo' },
    ],
  },
  {
    // BUDGET REQUEST (project cash): Team Leader, Admin Back Support (the
    // holders supporting the preparer's team), Finance Manager, and the CEO /
    // President above ₱100,000. The project manager's step of 2026-10-07 is
    // not on the sheet; that route is RETIRED.
    // Since 2026-11-11 the Technical Manager of every project its lines
    // charge agrees after the Team Leader (the owner's call: "make sure the
    // TM … who handles the budget monitoring agree"); passed over when it
    // charges no project. The routes without that step are RETIRED.
    documentType: 'budget_request',
    name: 'Budget Request — team leader, project budget agreed, back support, finance manager',
    maxAmount: 100_000,
    preparerSigns: true,
    standIns: true,
    steps: [
      { sequence: 1, name: 'Team Leader', approverType: 'SUPERVISOR', roleKey: 'team_leader' },
      { sequence: 2, name: 'Project budget agreed', approverType: 'PROJECT_MANAGERS', roleKey: 'technical_manager' },
      { sequence: 3, name: 'Admin Back Support', approverType: 'ROLE', roleKey: 'back_support' },
      { sequence: 4, name: 'Finance Manager', approverType: 'ROLE', roleKey: 'finance_manager' },
    ],
  },
  {
    documentType: 'budget_request',
    name: 'Budget Request — team leader, project budget agreed, back support, finance manager, then CEO / President over ₱100,000',
    minAmount: 100_000.01,
    preparerSigns: true,
    standIns: true,
    steps: [
      { sequence: 1, name: 'Team Leader', approverType: 'SUPERVISOR', roleKey: 'team_leader' },
      { sequence: 2, name: 'Project budget agreed', approverType: 'PROJECT_MANAGERS', roleKey: 'technical_manager' },
      { sequence: 3, name: 'Admin Back Support', approverType: 'ROLE', roleKey: 'back_support' },
      { sequence: 4, name: 'Finance Manager', approverType: 'ROLE', roleKey: 'finance_manager' },
      { sequence: 5, name: 'CEO / President', approverType: 'ROLE', roleKey: 'ceo' },
    ],
  },
  {
    // TRAVEL REQUEST (2026-11-10, the owner's call: "it should be recognized
    // by the team leader also"): the Technical Manager on the preparer's
    // team, the Team Leader, Admin Back Support, the Finance Manager — and
    // the CEO / President above ₱100,000, as for a budget request.
    documentType: 'travel_request',
    name: 'Travel request — technical manager, team leader, back support, finance manager',
    maxAmount: 100_000,
    preparerSigns: true,
    standIns: true,
    steps: [
      { sequence: 1, name: 'Technical Manager', approverType: 'ROLE', roleKey: 'technical_manager' },
      { sequence: 2, name: 'Team Leader', approverType: 'SUPERVISOR', roleKey: 'team_leader' },
      { sequence: 3, name: 'Admin Back Support', approverType: 'ROLE', roleKey: 'back_support' },
      { sequence: 4, name: 'Finance Manager', approverType: 'ROLE', roleKey: 'finance_manager' },
    ],
  },
  {
    documentType: 'travel_request',
    name: 'Travel request — technical manager, team leader, back support, finance manager, then CEO / President over ₱100,000',
    minAmount: 100_000.01,
    preparerSigns: true,
    standIns: true,
    steps: [
      { sequence: 1, name: 'Technical Manager', approverType: 'ROLE', roleKey: 'technical_manager' },
      { sequence: 2, name: 'Team Leader', approverType: 'SUPERVISOR', roleKey: 'team_leader' },
      { sequence: 3, name: 'Admin Back Support', approverType: 'ROLE', roleKey: 'back_support' },
      { sequence: 4, name: 'Finance Manager', approverType: 'ROLE', roleKey: 'finance_manager' },
      { sequence: 5, name: 'CEO / President', approverType: 'ROLE', roleKey: 'ceo' },
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
  // PROGRESS REPORT and PROGRESS BILLING (2026-10-15, the owner's call:
  // "creator (Project Engineer) or Sales › Technical Manager › Team
  // Leader"). Nobody approves one by hand any more. The Technical Manager
  // is the preparer's team's (OWN_TEAM_ROLES), the Team Leader their
  // "Reports to", else their team's leader.
  {
    documentType: 'progress_report',
    name: 'Progress report — technical manager, team leader',
    preparerSigns: true,
    standIns: true,
    steps: [
      { sequence: 1, name: 'Technical Manager', approverType: 'ROLE', roleKey: 'technical_manager' },
      { sequence: 2, name: 'Team Leader', approverType: 'SUPERVISOR', roleKey: 'team_leader' },
    ],
  },
  {
    documentType: 'progress_billing',
    name: 'Progress billing — technical manager, team leader',
    preparerSigns: true,
    standIns: true,
    steps: [
      { sequence: 1, name: 'Technical Manager', approverType: 'ROLE', roleKey: 'technical_manager' },
      { sequence: 2, name: 'Team Leader', approverType: 'SUPERVISOR', roleKey: 'team_leader' },
    ],
  },
  {
    // INVOICE REQUEST (2026-10-15, the owner's call): the project's
    // salesperson or their Team Leader asks for an approved billing to be
    // invoiced against the sales order; Back Support processes it — the one
    // on the requester's team (TEAM_SCOPED_ROLES) — and its approval raises
    // the draft invoice in Accounts Receivable.
    documentType: 'invoice_request',
    name: 'Invoice request — back support',
    standIns: true,
    steps: [{ sequence: 1, name: 'Back Support', approverType: 'ROLE', roleKey: 'back_support' }],
  },
  {
    // CAD J.O. (2026-10-16, the owner's sample: "Initial status: TL Approval"):
    // the requester's Team Leader approves a drawing request before it reaches
    // the designers' queue — their "Reports to", else a Team Leader on their
    // team. A Team Leader's own request is signed at submit.
    documentType: 'cad_job_order',
    name: 'CAD J.O. — team leader',
    preparerSigns: true,
    standIns: true,
    steps: [{ sequence: 1, name: 'Team Leader', approverType: 'SUPERVISOR', roleKey: 'team_leader' }],
  },
  // REQUEST FOR APPROVAL (2026-10-13; the CEO dropped 2026-10-20, the
  // owner's call: "don't add CEO — only the technical manager and team leader
  // or sales on the team who handles the project"): ONE route for any amount —
  // the Technical Manager on the preparer's team (OWN_TEAM_ROLES), then the
  // preparer's Team Leader (team-first). The two banded routes before it are
  // RETIRED below; a request pending on one finishes on it. The costing's two
  // switches: a preparer who holds a step signs it at submit, and a manager
  // may stand in.
  {
    documentType: 'plan_approval',
    name: 'Request for Approval — technical manager, team leader (any amount)',
    preparerSigns: true,
    standIns: true,
    steps: [
      { sequence: 1, name: 'Technical Manager', approverType: 'ROLE', roleKey: 'technical_manager' },
      { sequence: 2, name: 'Team Leader', approverType: 'SUPERVISOR', roleKey: 'team_leader' },
    ],
  },
  // THE KICK-OFF GANTT CHART (2026-10-22, the owner's call: "Prepared By
  // (Project Engineer), Checked By (Technical Manager), Approved By
  // (Customer)"): the Project Engineer submits it, the project's own
  // Technical Manager checks it (the engine's PROJECT_MANAGER step, reading
  // the job), the technical managers on the engineer's team when the project
  // names none. The customer's approval is recorded on the project after.
  {
    documentType: 'gantt_chart',
    name: 'Kick-off Gantt chart — technical manager',
    preparerSigns: true,
    standIns: true,
    steps: [{ sequence: 1, name: 'Technical Manager', approverType: 'PROJECT_MANAGER', roleKey: 'technical_manager' }],
  },
  // A CHANGE TO A PROJECT'S PHASE DATES (2026-11-03, the owner's call: "make
  // sure that it has approval from technical manager"): proposed on the
  // Scope of Work tab, applied when the project's own Technical Manager
  // approves — the engine's PROJECT_MANAGER step, the technical managers on
  // the proposer's team when the project names none or they proposed it.
  {
    documentType: 'schedule_change',
    name: 'Phase date change — technical manager',
    preparerSigns: true,
    standIns: true,
    steps: [{ sequence: 1, name: 'Technical Manager', approverType: 'PROJECT_MANAGER', roleKey: 'technical_manager' }],
  },
  // HIRING (2026-10-21, the owner's Hiring module; his answer left the routes
  // to the plan's defaults, editable in Admin › Approval Workflows). The MAN
  // POWER REQUEST: the requester's Team Leader, the HR Officer, the CEO /
  // President. The EMPLOYMENT CONTRACT, prepared by HR for the request's
  // team (`ApprovalContext.teamId`): that team's Technical Manager and Team
  // Leader, the HR Officer, the CEO / President — the PDF's position
  // supervisor, department head, HR director and company president. The HR
  // step is decided by the HR Officer OR the HR Manager: HR prepares the
  // contract, and nobody approves what they prepared.
  {
    documentType: 'manpower_request',
    name: 'Man Power Request — team leader, HR officer, CEO / President',
    preparerSigns: true,
    standIns: true,
    steps: [
      { sequence: 1, name: 'Team Leader', approverType: 'SUPERVISOR', roleKey: 'team_leader' },
      { sequence: 2, name: 'HR Officer', approverType: 'ROLE', roleKey: 'hr', alsoRoleKeys: ['hr_manager'] },
      { sequence: 3, name: 'CEO / President', approverType: 'ROLE', roleKey: 'ceo' },
    ],
  },
  {
    documentType: 'employment_contract',
    name: 'Employment contract — technical manager, team leader, HR officer, CEO / President',
    standIns: true,
    steps: [
      { sequence: 1, name: 'Technical Manager', approverType: 'ROLE', roleKey: 'technical_manager' },
      { sequence: 2, name: 'Team Leader', approverType: 'ROLE', roleKey: 'team_leader' },
      { sequence: 3, name: 'HR Officer', approverType: 'ROLE', roleKey: 'hr', alsoRoleKeys: ['hr_manager'] },
      { sequence: 4, name: 'CEO / President', approverType: 'ROLE', roleKey: 'ceo' },
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
    // The Service Manager is the preparer's team's (OWN_TEAM_ROLES) and
    // management is the CEO / President (2026-10-17, the owner's chart).
    steps: [
      { sequence: 1, name: 'Service Manager', approverType: 'ROLE', roleKey: 'service_manager' },
      { sequence: 2, name: 'CEO / President', approverType: 'ROLE', roleKey: 'ceo' },
    ],
    previously: [
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
    // The Technical Manager on the preparer's team since 2026-10-15 — the
    // project's manager is its Technical Manager.
    steps: [{ sequence: 1, name: 'Technical Manager', approverType: 'ROLE', roleKey: 'technical_manager' }],
    previously: [{ sequence: 1, name: 'Project Manager', approverType: 'ROLE', roleKey: 'project_manager' }],
  },
  {
    documentType: 'supplier_bill',
    name: 'Supplier bill — P50,000 and above',
    minAmount: 50_000,
    steps: [
      { sequence: 1, name: 'Technical Manager', approverType: 'ROLE', roleKey: 'technical_manager' },
      { sequence: 2, name: 'CEO / President', approverType: 'ROLE', roleKey: 'ceo' },
    ],
    // Two earlier shapes: as first seeded, and as corrected on 2026-10-15.
    previously: [
      [
        { sequence: 1, name: 'Project Manager', approverType: 'ROLE', roleKey: 'project_manager' },
        { sequence: 2, name: 'Management approval', approverType: 'ROLE', roleKey: 'executive' },
      ],
      [
        { sequence: 1, name: 'Technical Manager', approverType: 'ROLE', roleKey: 'technical_manager' },
        { sequence: 2, name: 'Management approval', approverType: 'ROLE', roleKey: 'executive' },
      ],
    ],
  },
  {
    // REIMBURSEMENT (the owner's money-out sheet, 2026-10-15: "Back Support >
    // Finance Staff > Finance Manager > CEO", after the requester's Team
    // Leader): every expense claim and liquidation. "Checking" is Finance
    // staff. The supervisor-then-finance route is RETIRED.
    // Since 2026-11-11 the Technical Manager of every project its lines
    // charge agrees after the Team Leader; passed over for an office-only or
    // overheads claim. The route without that step is RETIRED.
    documentType: 'expense',
    name: 'Reimbursement — team leader, project budget agreed, back support, checking, finance manager, CEO / President',
    preparerSigns: true,
    standIns: true,
    steps: [
      { sequence: 1, name: 'Team Leader', approverType: 'SUPERVISOR', roleKey: 'team_leader' },
      { sequence: 2, name: 'Project budget agreed', approverType: 'PROJECT_MANAGERS', roleKey: 'technical_manager' },
      { sequence: 3, name: 'Back Support', approverType: 'ROLE', roleKey: 'back_support' },
      { sequence: 4, name: 'Checking (Account Payable / Credit and Collection)', approverType: 'ROLE', roleKey: 'finance', alsoRoleKeys: ['credit_collection'] },
      { sequence: 5, name: 'Finance Manager', approverType: 'ROLE', roleKey: 'finance_manager' },
      { sequence: 6, name: 'CEO / President', approverType: 'ROLE', roleKey: 'ceo' },
    ],
  },
  {
    // COMMISSION (2026-10-16, the owner's "Commission Request System":
    // "Workflow Target: Finance Manager / Admin Approval"): the Finance
    // Manager, then the CEO / President; a manager may stand in.
    documentType: 'commission',
    name: 'Commission — finance manager, CEO / President',
    standIns: true,
    steps: [
      { sequence: 1, name: 'Finance Manager', approverType: 'ROLE', roleKey: 'finance_manager' },
      { sequence: 2, name: 'CEO / President', approverType: 'ROLE', roleKey: 'ceo' },
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
      { sequence: 3, name: 'Checking (Account Payable / Credit and Collection)', approverType: 'ROLE', roleKey: 'finance', alsoRoleKeys: ['credit_collection'] },
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
    // The project's manager IS its Technical Manager (2026-10-15, the owner's
    // call): step 1 reads the Technical Manager named on the order, falling
    // back to the Technical Managers on the requester's team.
    name: 'Job order — project manager then team leader',
    // The Technical Manager and the Team Leader of the preparer's team, never
    // the CEO (2026-10-16, the owner's call): the Team Leader step falls back
    // to the team's `team_leader`, and a preparer who holds a step signs it
    // at submit (Brian Jay, UIT's Technical Manager and a Team Leader, signs
    // both of his own); a manager may stand in.
    preparerSigns: true,
    standIns: true,
    steps: [
      { sequence: 1, name: 'Technical Manager', approverType: 'PROJECT_MANAGER', roleKey: 'technical_manager' },
      { sequence: 2, name: 'Team Leader', approverType: 'SUPERVISOR', roleKey: 'team_leader' },
    ],
    previously: [
      { sequence: 1, name: 'Technical Manager', approverType: 'PROJECT_MANAGER', roleKey: 'technical_manager' },
      { sequence: 2, name: 'Team Leader', approverType: 'SUPERVISOR', roleKey: 'sales_manager' },
    ],
  },
  {
    // The Service JO (2026-10-20, the owner's revised Aftermarket UI): the
    // service call on a registered machine, routed to the Aftermarket
    // Manager on the requester's own team (`service_manager`, in
    // OWN_TEAM_ROLES), then the requester's Team Leader. Approval BOOKS THE
    // VISIT, never a project. The preparer signs the steps they hold and a
    // manager may stand in, as on every routing-sheet route.
    documentType: 'service_job_order',
    name: 'Service JO — aftermarket manager then team leader',
    preparerSigns: true,
    standIns: true,
    steps: [
      { sequence: 1, name: 'Aftermarket Manager', approverType: 'ROLE', roleKey: 'service_manager' },
      { sequence: 2, name: 'Team Leader', approverType: 'SUPERVISOR', roleKey: 'team_leader' },
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
      { sequence: 2, name: 'CEO / President', approverType: 'ROLE', roleKey: 'ceo' },
    ],
    previously: [
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
