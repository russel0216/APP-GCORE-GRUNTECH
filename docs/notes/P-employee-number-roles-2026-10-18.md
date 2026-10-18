# Plan — The employee number ruling, the roles cleared, the chart as the roles to come (2026-10-18)

The owner's ask: "Update the ruling for employee number — the existing number
is manual, `GTC-0001-14` (Carter Gasiong) — particularly in quotation
numbering. Delete all roles, I will create the roles later. Analyse the
attached organisational chart for the roles I will create. Delete all existing
employee numbers in the user. Plan first." A plan before any change, as asked.

## 1. The employee number: what G-CORE does today, and what `GTC-0001-14` needs

**Today.** `Employee.employeeNo` is required and unique; the login mirrors it
(`User.employeeNo`, unique, written by `syncLoginFromEmployee`). A new
employee with no number typed takes `nextNumber('employee')` under the stock
pattern `{PREFIX}-{TYPE}-{YYYY}-{SEQ}` → `GT-EMP-2026-0009`. The live
numbers are a mix: `GT-EMP-0001`, `GT-EMP-002`, `GT-EMP-095`,
`GT-EMP-2026-0013`, and sixteen logins with none.

**The quotation's `{EMP}`** (`employeeToken()` in `shared/numbering.ts`) is
*the last run of digits in the employee number, padded to three*:
`GT-EMP-2026-0009` → `009`; `GT-EMP-095` → `095`. The quotation pattern is
`{EMP}{YY}{MM}{SEQ}` (YEAR, per OWNER) — SCORO's `0012609059` is employee
001's 59th quotation of 2026. **Under the owner's real number the rule reads
the wrong part**: `GTC-0001-14` → `014`, and Carter's quotations would issue
as `0142610…` instead of `0012610…`.

**The ruling to build** (the reading of `GTC-0001-14` as `GTC` · the person's
sequence `0001` · the year hired `14` — §5 Q1 confirms it):

- **The employee pattern becomes `GTC-{SEQ}-{YY}`**, padding 4, period NONE
  (one running count, never restarting), where `{YY}` is the year HIRED —
  `nextNumber('employee', tx, { at: dateHired })` already takes the date
  through `NumberContext.at`; a person with no hire date takes the year of
  creation. Set by a once-only seed step (`seed.employeeNumbering20261018`:
  only while the stored pattern is still the stock one — an administrator's
  own pattern stays, as every numbering rule does). Admin › Numbering shows
  it and can change it.
- **`{EMP}` is the employee number's `{SEQ}`, read through the employee
  pattern** — `parseNumber(employeeTemplate, …)`, the inverse of the pattern,
  the quotation's own parser — padded to three: `GTC-0001-14` → `001`,
  `GTC-0061-26` → `061`, `GTC-1234-26` → `1234` (never truncated). A number
  that does not fit the pattern (an old `GT-EMP-095`) falls back to today's
  rule, the last run of digits — so nothing already issued changes series.
- **A typed employee number moves the employee series**, the quotation's
  rule of 2026-10-10: saving `GTC-0057-19` by hand puts the counter at 57
  (`setCounter('employee', …, { mode: 'raise' })` — raise only, never lower,
  because the owner will type sixty numbers in no particular order), so the
  next automatic number is `GTC-0058-26`, never a duplicate.
- **A person with no employee number cannot be issued a quotation number**
  — the save is refused naming them ("Set an employee number on Carter
  Gasiong's employee record first — the quotation number carries it")
  rather than issuing `000…`, which would put everybody without a number
  into one shared series. Today an UNLINKED login gets `000`; that stays
  for a login with no employee record at all. (§5 Q3 may soften this.)
- The quotation's `parseNumber` bound for `{EMP}` ("three digits, or wider
  not starting with 0") is unchanged: `0012610060` still reads as employee
  001's series.
- verify-numbering pins the four readings above, the hire-year token, the
  raise-only counter and the refusal; verify-sales pins Carter's `001`
  quotation number from `GTC-0001-14`.

## 2. "Delete all existing employee numbers in the user"

`Employee.employeeNo` is NOT NULL today, so a true clearing needs the column
nullable (`String? @unique` — a `db push` the server runs unattended; a
nullable unique index is fine in Postgres). Then, once (a seed step,
`seed.employeeNumbersCleared20261018`, audited per person with the old
number in `before`):

- every `Employee.employeeNo` and every `User.employeeNo` set to null — the
  login mirrors the employee, so both go, or the next sync writes the old
  one back;
- the employee counter is NOT lowered (never is); the new pattern starts its
  own count at the highest typed number through the raise rule above.

**Where the numbers are typed afterwards.** The employee record is the one
writer (2026-10-16, "the employee owns identity") and Admin › Users shows
the number read-only with "Open employee record". The owner said "in the
user": the plan makes the **Employee No. box on Admin › Users write through
to the employee** — as the Team select already does — so the sixty numbers
can be typed from the Users list without opening each record; HR ›
Employees keeps its box. A number already on another person is a 409
naming them, as today. Until a person has a number: "—" on both lists, an
**Employee number: none** filter and a summary card on HR › Employees and
Admin › Users, and the quotation refusal of §1.

Carter's own `GTC-0001-14` is cleared with the rest and typed back (or kept
— §5 Q3).

## 3. "Delete all roles, I will create the roles later"

**What stands in the way of a plain delete.** 25 of the 26 roles are
seeded (`isSystem`): the seed recreates any missing one on every deploy, and
`DELETE /roles/:id` refuses a seeded role and any role an approval route
names. Every one of the 47 routes' ROLE steps and SUPERVISOR fallbacks
names a role (`team_leader` on 20 routes, `ceo` on 8, `technical_manager`
on 9, `back_support`, `finance`, `finance_manager`, `cost_controller`,
`purchasing_manager`, `warehouse_supervisor`, `service_manager`,
`executive`); four retired routes carry "Prepared by" (`requesterRoleId`,
Restrict). And the engine gives nine KEYS a meaning of their own, whatever
the role is called:

| key | what the engine does with it |
|---|---|
| `team_leader` | a "Team Leader" step goes to the holder on the requester's own team first (`TEAM_FIRST_ROLES`) |
| `technical_manager`, `service_manager` | a step goes to the holder on the requester's team (`OWN_TEAM_ROLES`) |
| `back_support` | to the holders supporting the requester's team (`TEAM_SCOPED_ROLES`, "Supports teams") |
| `purchasing_manager` → `purchasing_manager_import` | an importation order goes to the twin (`IMPORTATION_ROLES`) |
| `employee` | given to every new login (`createLogin`); holds the clock, leave, overtime, borrow and pull-out own-scope |
| `supervisor` | given on every deploy to anyone with a direct report (`grantSupervisorRole`) |
| `hr` | the engine's HR approver type reads its holders (overtime, clearance, evaluation, training) |
| `ceo`, `executive` | the CEO / President and Management steps; `audit-workflows.ts`'s fallbacks |

The super admin (`gcore@gruntechnology.com`, `isSuperAdmin` on the login,
no role) keeps every door whatever happens to the roles.

**Two ways to give the owner a clean slate** (§5 Q2):

- **A. Delete the rows** (the ask as worded). One seed step
  (`seed.rolesCleared20261018`): every `UserRole`, `RolePermission`,
  `UserSupportTeam` stays where it is keyed by user, then every `Role` row
  deleted; steps' `roleId` go null (SetNull), the four retired routes'
  "Prepared by" cleared first (Restrict). The seed's role loop then runs
  **only on an install with no roles at all** (the super-admin rule), so
  the deletion holds; `createLogin` and `grantSupervisorRole` do nothing
  while no `employee` / `supervisor` role exists; `applyOrgChart` is
  already spent. **Consequences**: every step on every route routes to
  NOBODY until the owner creates a role and picks it on the step in
  Admin › Approval Workflows (about 90 step pickers over 47 routes — a
  "Re-point this role on every route" shortcut would be built with it:
  Admin › Roles › Modify › "Stands in for the old <key> on the approval
  routes"); the nine engine keys apply only to roles created with EXACTLY
  those keys (the New role form takes the key; the plan lists them on the
  form as "keys the approval engine recognises"); nobody but the super
  admin can open a screen until roles exist and are assigned.
- **B. Empty the roles, keep the rows** (recommended). The same clean
  Access grid — every permission off every role, every role off every
  person, "Supports teams" kept — but the 26 rows stay, so the 47 routes
  keep their steps, the engine keys keep their meaning, `employee` and
  `supervisor` keep being granted (empty, until the owner ticks their
  boxes), and the owner renames, fills or deletes (a role he does not
  want: `isSystem` lifted on all of them, so Delete works; the seed stops
  recreating them, as in A). Also one seed step, audited. He creates new
  roles beside them as he likes.

Either way **the seed stops offering permissions to roles** (the
never-offered rule in `seed.offeredRolePermissions` — a role the owner
emptied must not be refilled by the next deploy), and
`deploy/settings/snapshot.json` is re-exported after he is done so the
repository carries his roles.

## 4. The chart, read for the roles to come

The attached deck is the chart of 2026-10-17 (`shared/orgChart.ts` holds it
as data; it was applied once). Sixty people, five teams, five departments,
**27 distinct titles**. Read as the roles the owner will create:

| Title on the chart | Holders | What the role must open (the Access boxes it needs) | Engine key to reuse |
|---|---|---|---|
| CEO / President | Carter | everything to read; quotation, sales order, costing, PO, budget request, commission, evaluation, bill and plan steps | `ceo` (+ `executive`) |
| Team Leader | Renerose, Ricardo, Carter, Brian Jay, Salvador | sales (quotations, orders, leads, forecast, calendar), costing and project reading, the Team Leader step on 20 routes | `team_leader` |
| Technical Manager | Ricardo, Carter, Brian Jay, Salvador | projects, costing, progress, plans, purchase requisitions, job orders, supplier bills to read; the TM steps | `technical_manager` |
| Sales Manager | the same four | sales view all, pipeline, leads, customers | `sales_manager` |
| Service Manager | the same four | service schedule, reports, installed base; the service-report steps | `service_manager` |
| Purchasing Manager (Local) | Dina | purchase requests, RFQ, canvass, POs, suppliers, incoming; the PO and Incoming steps | `purchasing_manager` |
| Purchasing Manager (Importation) | Carter | the same, for importation orders | `purchasing_manager_import` |
| Purchasing Officer (= Back Support of HIT/UIT/GIB) | Wenchie, Mylin, Joy | purchasing own-scope; the Back Support step (sales order, budget request, reimbursement, cash advance, invoice request, incoming) | `procurement` + `back_support` |
| Finance Manager (= SIT Back Support) | Dina | G-FIN all; the Finance Manager step | `finance_manager` (+ `back_support`) |
| Finance Officer / Finance Clerk / Collection | Princess / Erwenn Ann, Christine Anne / Noel | A/R, A/P, payments, budget requests, liquidations; "Checking" step (any of the four, the owner's call) | `finance` |
| Accounting Manager (= KAT Back Support) / Officer / Clerk | Karen / Marielle / Samantha | finance and reports to read | `accounting` (+ `back_support` for Karen) |
| Marketing Manager / Assistant | Karen / Rodrigo Gimenez | leads, customers, calendar, pipeline to read; no approvals | `marketing` |
| Human Resources Officer | Filipina | G-HR all; the HR step | `hr` |
| Warehouse Officer | Jeric | inventory, incoming, outgoing, borrow, pull-out; his own supervisor's fallback | `warehouse` + `warehouse_supervisor` |
| CAD Supervisor / CAD Operator | John Paul / Jovenn | CAD J.O. (dispatch / drawing) | `designer_lead` / `designer` |
| Cost Controller | Ayesa | costing view all; the Cost Controller step on the sales order and the PR "Checked by" | `cost_controller` |
| Sales Engineer | Camille, Ivan, Erica, Jerald, Rodolfo, Daniel | quotations, leads, orders, calendar own-scope; invoice and commission requests on their deals | `industry_specialist` |
| Project Engineer | Rolando, Rodrigo C., Renielle, Marlon, Jonel | project tabs, progress reports, requisitions, budget and plan requests of their own | `project_engineer` |
| Project Lead | Reagan, Rey, Arnel, Jobby | the project to read, progress and requisitions of their own | `project_lead` |
| Service Engineer | Emil | service reports, visits, installed base | `service_engineer` |
| Welder · Electrician · Project Support · Service Technician | 12 + 4 | the clock, leave, overtime, borrow and pull-out slips — the `employee` role's; a POSITION, not a role | `employee` |

Reporting lines the chart draws (unchanged from 2026-10-17): Team Leaders →
Carter; Project Engineers → their TM; Project Leads → a Project Engineer;
crew → a Project Lead; Sales Engineers → their Sales Manager (KAT's → the
Team Leader); Service Engineer → Service Manager, technicians → the Service
Engineer; the purchasing officers, finance staff and warehouse → Dina; HR,
accounting staff and marketing → Karen; CAD Operator → John Paul; Dina,
Karen, John Paul, Ayesa → Carter. "Reports to", teams, departments and
"Supports teams" are on the logins already and are NOT touched by any of
this — only roles and employee numbers move.

**Offered with it**: once the roles exist, `npx tsx scripts/org-chart.ts
--roles-by-name --apply` assigns each person the chart's titles matched to
the owner's roles BY NAME (dry run first, listing every assignment and every
title with no role of that name), so sixty assignments are not sixty clicks.

## 5. The questions

1. **The number's parts.** `GTC-0001-14` = `GTC` · sequence `0001` · year
   hired 2014 — so `{EMP}` is `001` and Carter's next quotation is
   `0012610…`; a new hire this year is `GTC-0061-26`. Yes? (If `14` means
   something else, say what, and whether it is typed or derived.)
2. **Roles**: A (delete the 26 rows; every route step re-picked by you;
   engine keys only on roles made with those exact keys) or B (empty them
   and lift the built-in mark, so routes and keys keep working and you fill,
   rename or delete each)? Recommendation: B.
3. **Employee numbers**: clear BOTH the employee's and the login's number
   on everyone, Carter's included (you type `GTC-0001-14` back), and type
   them on Admin › Users (writing through to the employee)? And while a
   person has none: refuse their quotation number (recommended) or issue
   `000…`?
4. **The chart**: after you create the roles, apply the chart's titles to
   people by role NAME through the script (dry run first) — or you assign
   by hand in Admin › Users?

## 6. Built (2026-10-18, one push)

The owner's answers: 1 yes (sequence + year hired); 2 B (empty, keep the
rows); 3 clear all, refuse without a number; 4 the script by role name.
`shared/numbering.ts` (`EMPLOYEE_NUMBERING`, `employeeToken` through the
pattern, `employeeDigits`, `authorNumber`, `missingNumber` on the preview,
the refusal at issue), `shared/employeeNumbers.ts` (the pattern once, the
clearing once), `shared/rolesClear.ts` (the roles emptied once,
`ENGINE_ROLE_KEYS`, the Delete guard), `shared/roleSeeds.ts` (the role
definitions out of the seed, `roleSeedPermissionKeys`),
`shared/orgChart.ts` (`applyChartRolesByName`, `scripts/org-chart.ts
--roles-by-name`), the schema's nullable `Employee.employeeNo`, the
write-through on `PATCH /users/:id`, the `?number=` filters and cards,
`scripts/lib/roles.ts` for the verify scripts, and CLAUDE.md's Numbering,
Roles and Verification sections.

## 6a. The pushes as planned

**Push 1 — numbering** (`shared/numbering.ts`, `routes/employees.ts`,
`routes/users.ts`, `prisma/seed.ts`, `Numbering.tsx`, `Users.tsx`,
`Employees.tsx`, verify-numbering, verify-sales, verify-accounts,
CLAUDE.md): the pattern, the `{EMP}` reading through it, the hire-year
token, the raise-only counter from a typed number, the refusal without a
number, the write-through box, the clearing step (schema nullable).

**Push 2 — roles** (`prisma/seed.ts`, `routes/users.ts`, `shared/accounts.ts`,
`shared/orgChart.ts`, `scripts/org-chart.ts`, `Roles.tsx`, `Workflows.tsx`,
`audit-workflows.ts`, verify-foundation, verify-workspace, verify-accounts,
CLAUDE.md): the clearing step, the seed's "roles only on an empty install"
rule, the engine-key list on the New role form, the re-point shortcut (A
only), the roles-by-name application.

Verify: numbering, sales, accounts, foundation, workspace, hr; the full
suite before the last push; `audit-workflows.ts` after the roles step says
every step with no holder — which, until the owner's roles are assigned, is
all of them.
