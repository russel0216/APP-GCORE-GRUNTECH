# Plan — The organisation chart of 2026-10-17 and the approval routes on it

The owner's `organizational_chart_executive_3.pptx` and `ROLE.xlsx` (61 people,
five teams, five departments), with his rule: "on approval their manager should
not appear as OR … if they are absent, the purchasing manager can approve a
request, but don't show them initially; the requestor can raise a follow-up to
the purchasing manager." A plan before any change, as asked.

## 1. What the chart says, in G-CORE's terms

| Chart title | G-CORE role (key) | Note |
|---|---|---|
| CEO / President | `ceo` (+ `executive`) | Carter alone |
| Team Leader | `team_leader` | Renerose (KAT), Ricardo (HIT), Carter (SIT), Brian Jay (UIT), Salvador (GIB) |
| Technical Manager | `technical_manager` | the same four men as Team Leader, KAT has none |
| Sales Manager | `sales_manager` | the same four; KAT has none |
| Service Manager | `service_manager` | the same four; KAT has none |
| Sales Engineer | `industry_specialist` → **renamed "Sales Engineer"** (key kept) | Camille, Ivan, Erica, Jerald, Rodolfo, Daniel |
| Project Engineer | `project_engineer` | Rolando, Rodrigo, Jonel, Renielle, Marlon |
| Project Lead | **new `project_lead`** | Reagan, Rey, Jobby, Arnel — supervises the crew; an employee's rights plus the project screens, progress reports and purchase requests of their own |
| Welder / Electrician / Project Support / Service Technician | `employee` | a POSITION on the employee record, not a role; the plantilla keeps the title |
| Service Engineer | `service_engineer` | Emil |
| Purchasing Manager (Local) | `purchasing_manager` | Dina |
| Purchasing Manager (Importation) | **new `purchasing_manager_import`** | Carter — see §3 |
| Purchasing Officer | `procurement` → **renamed "Purchasing Officer"** + `back_support` | Mylin (UIT), Joy (GIB), Wenchie (HIT) — they ARE the teams' Back Support |
| Finance Manager | `finance_manager` | Dina |
| Finance Officer | `finance` → **renamed "Finance Officer"** | Princess — the "Checking (Finance Staff)" step |
| Finance Clerk | **new `finance_clerk`** | Erwenn Ann, Christine Anne — Finance's screens, NOT on the Checking step |
| Collection | **new `collection`** | Noel — A/R, collections and the finance reports only |
| Warehouse Officer | `warehouse` + `warehouse_supervisor` | Jeric — the only warehouse person, so he is his own supervisor's fallback |
| Accounting Manager | `accounting` | Karen — also Marketing Manager and KAT's Back Support |
| Accounting Officer / Clerk | `accounting` | Marielle, Samantha |
| Marketing Manager / Assistant | **new `marketing`** | Karen, Rodrigo Gimenez — leads, customers, calendar, pipeline to read |
| Human Resources Officer | `hr` | Filipina — the ONE HR holder (overtime's second step, clearances, evaluations) |
| CAD Supervisor | `designer_lead` → **renamed "CAD Supervisor"** | John Paul |
| CAD Operator | `designer` → **renamed "CAD Operator"** | Jovenn |
| Cost Controller | `cost_controller` | Ayesa |

Everyone also holds `employee` (clock, leave, overtime, borrow slips), and
`supervisor` goes to everyone with at least one direct report (the HR dashboard
of their reports' attendance, leave and overtime).

**Teams** (`Employee.industryId`): the five sales teams as the sheet names them.
Department staff (Supply Chain & Finance, Accounting, Marketing, Design, Cost
Control) take a DEPARTMENT (`Employee.departmentId`, the five departments
seeded) and NO team; the Back Support teams are "Supports teams" ticks:
Dina → SIT, Karen → KAT, Mylin → UIT, Joy → GIB, Wenchie → HIT.

**Reports to** (`User.supervisorId`): the sheet's REPORTS TO column, resolved to
the person holding that title on the same team — Team Leaders to Carter;
Project Engineers to their team's Technical Manager; Sales Engineers to their
Team Leader; Purchasing Officers, Finance Officer, Clerks, Collection and the
Warehouse Officer to Dina; HR Officer to Karen (the sheet, not Dina as today);
Accounting Officer to Karen, Accounting Clerk to Marielle; Marketing Assistant
to Karen; CAD Operator to John Paul; Cost Controller, CAD Supervisor, Karen,
Dina to Carter. Four lines are AMBIGUOUS on the sheet (§5 Q4).

## 2. What is on the live server today (deploy/settings/snapshot.json)

- 32 logins for 61 people on the chart. Missing: all four Project Leads, the
  twelve Welders / Electricians / Project Support, the four Service
  Technicians, Erwenn Ann, Christine Anne, Noel, Marielle, Samantha, Jerald
  Ventura has one. Two logins are NOT on the chart: Jhon Russel Balicas (SIT,
  Technical Manager, Supervisor…) and Julian Gasiong (inactive).
- Roles were handed out wholesale: most logins hold `accounting`, `finance`,
  `hr`, `procurement`, `project_manager`, `warehouse`… Fourteen people hold
  `hr`, so an HR step today goes to fourteen names. Dina and Karen hold
  twenty roles each.
- Reports to is mostly right already (Team Leaders → Carter, Sales Engineers →
  their Team Leader, department staff → Dina). Filipina reports to Dina (the
  sheet says Karen). Mylin, Joy, Wenchie, Marlon, Rodrigo Catuday, Rolando,
  Emil, Ayesa, John Paul have NO team.
- Supports teams: Mylin UIT, Joy GIB, Wenchie HIT, Dina SIT, Karen KAT —
  already as the chart has them.

## 3. Where "A or B" comes from today, and what removes it

A step lists everybody who may decide it (`namedApprovers`) — never a
stand-in, so the OR is never the manager-as-cover. It is two or more people
HOLDING the step's role for that requester:

| Step | Today | After |
|---|---|---|
| Purchasing Manager (PO, Incoming) | "Carter or Dina" — both hold `purchasing_manager` | Local vs Importation: a purchase order or incoming report with NO VAT (the importation tick off, `vatRate` 0) goes to the Importation manager (Carter), everything else to the Local one (Dina). The step stays one ROLE step; the engine reads the document's importation flag (`ApprovalContext.importation`) and picks the role. |
| Checking (Finance Staff) (reimbursement, cash advance) | four `finance` holders | Princess alone (`finance`); the clerks and Collection on their own roles |
| HR (overtime, clearance, evaluation, training) | fourteen holders | Filipina alone |
| Service Manager (service reports) | four holders | the requester's own team's (`service_manager` joins `OWN_TEAM_ROLES`) |
| Management approval (`executive`: commissioning report, supplier bill ≥ ₱50k, evaluation) | whoever holds Executive | the CEO / President (`ceo`), corrected in place through `previously` |
| Team Leader / Technical Manager / Back Support | one per team already | unchanged |

Nothing on the chart needs a step to name two people; after the reset every
step names ONE person, and the OR disappears without changing `namedApprovers`.

## 4. Absent approver: the hidden stand-in and the requester's follow-up

Already built (2026-10-12): on a route with `standIns`, the "Reports to" of
the step's approver may decide it — not listed, not queued, not told — and
the decision says "standing in for …". That is the owner's "the purchasing
manager can approve, but don't show them". What is missing is the
requester's move.

**Follow up** — the requester, on a PENDING request whose route has
`standIns`, presses "Follow up" in the Approval panel (asked in the confirm
bar, an optional note). `POST /approvals/:id/follow-up { note }`:
- only the requester (a super admin too); only while PENDING; a 400 naming
  the approver when none of the step's approvers has a "Reports to";
- goes to the "Reports to" of EVERY approver of the open step (distinct,
  active, never the requester); once per step per 24 hours (a 409 saying
  when it may be sent again);
- writes an `ApprovalFollowUp` row (request, sequence, by, to, note, at),
  one audit row (`approval` / FOLLOWED_UP), a bell `approval.follow_up`
  ("Follow-up: Mylin Sarcillas has not acted on PO GT-PO-… — you may decide
  it") and an email where SMTP is set, to each manager; the approver is
  told too ("… followed up to Dina Gasiong");
- from then on the manager SEES it: My Work's queue lists a request
  followed up to them (marked "Followed up to you by …"), and the Approval
  panel on the document offers them Approve / Return / Reject (it already
  does, through `deciderFor`); the panel shows "Followed up to Dina
  Gasiong on … — “note”" to everyone; `GET /approvals/history` carries
  `followUps`. Nothing else lists the manager: the route preview, the
  paper's "Pending" names and the audit of who was assigned stay the
  approver's. A follow-up never moves the request: the approver may still
  act, and whoever acts first claims it as today.
- A SUPERVISOR step (leave, overtime) has no `standIns` today; the follow-up
  button shows only where the route has it.

## 5. The owner's answers (2026-10-17)

1. Reset to the chart. 2. Employee records only. 3. Split Local /
Importation. 4. The first named (Reagan & Rey → Rolando; HIT's crew →
Reagan; Arnel → Renielle). 5. **Always the Team Leader** — a "Team Leader"
step goes to the team's Team Leader whoever the requester reports to.
6. **Any of the four** finance staff is Checking (no Finance Clerk /
Collection roles). 7. Rename all five. 8. The seed step, once.

Built as `shared/orgChart.ts` (the chart as data, `applyOrgChart()`,
`grantSupervisorRole()`), `scripts/org-chart.ts` (the dry run), the engine's
`TEAM_FIRST_ROLES`, `IMPORTATION_ROLES` and `followUp()`, the seed's three
new roles and five renames, and CLAUDE.md's "The organisation chart of
2026-10-17" section.

## 5a. The questions as asked

1. **Roles reset.** Apply the chart's mapping (§1) to every login — every
   role not in it removed (Dina keeps 3 of 20, Karen 4 of 20, Carter 8 of 18)?
   Or only ADD what the chart names and leave what people hold?
   Recommendation: reset — the ORs in §3 come from the extra roles.
2. **People with no login** (29 on the chart): create their EMPLOYEE record
   (position, team or department, Reports to as HR facts) with no login, for
   you to invite from the employee record when you have their email? Or
   invite them now at `<firstname><lastname>@gruntechnology.com`?
   Recommendation: employee records only; the two people not on the chart
   (Jhon Russel Balicas, Julian Gasiong) left as they are.
3. **Purchasing Manager, Local vs Importation**: a separate role for Carter
   and the no-VAT order goes to him (§3), yes?
4. **Four ambiguous "Reports to"** on the sheet: HIT's Project Leads report
   to "Project Engineer" — Rolando or Rodrigo (Reagan → ?, Rey → ?); HIT's
   crew report to "Project Lead" — Reagan or Rey (nine people); UIT's Arnel
   (Project Lead) → Renielle or Marlon? If you do not say, I set the FIRST
   named on the chart and list them for you to change on Admin › Users.
5. **"Team Leader" steps for the crew**: a welder's reimbursement or borrow
   slip goes to their "Reports to" — their Project Lead — not the Team
   Leader. The sheet's hierarchy suggests that is wanted ("approval of
   his/her report to"); confirm, or I route "Team Leader" steps to the
   team's Team Leader role whoever the requester reports to.
6. **Checking (Finance Staff)** is Princess (Finance Officer) alone, the
   clerks and Noel off that step — yes?
7. **Renames**: Industry Specialist → "Sales Engineer", Procurement →
   "Purchasing Officer", Finance → "Finance Officer", Designer Lead → "CAD
   Supervisor", Designer Support → "CAD Operator" (keys unchanged, nothing
   else moves) — yes?
8. **How to apply the people data**: a once-only seed step
   (`seed.orgChart20261017`, so the next push applies it on deploy, with
   `npx tsx scripts/org-chart.ts` as a dry run that prints every change
   first) — or the script alone, run by you on the server after a dry run?
   Recommendation: the seed step, marked once, so later edits in Admin ›
   Users are never overwritten.

## 6. The pushes

**Push A — code** (`api/prisma/seed.ts`, `shared/approvals.ts`, routes,
`ApprovalStepper.tsx`, My Work, `audit-workflows.ts`, verify-foundation,
verify-sales, verify-chain, CLAUDE.md):
- the new roles and the renames (§1); `supervisor` auto-granted to anyone
  with a report (the seed, every deploy, never revoked by hand);
- `OWN_TEAM_ROLES` += `service_manager`; Management approval → `ceo`
  through `previously`; the importation rule on the Purchasing Manager step;
- the follow-up (§4): schema, engine, route, bell, mail, My Work, panel,
  history; verify-foundation pins the once-a-day rule, the hidden-until-
  followed-up rule and the stand-in's decision after one.

**Push B — data**: the org-chart step: departments seeded; each person's
roles, Reports to, team, Supports teams, department and position set by
email; employee records for the 29; audited (`user` / `employee` UPDATED
rows naming what moved), marked once; `audit-workflows.ts` run after it to
prove every step has a holder.

Verify: foundation, sales, chain, finance, delivery, hr, workspace,
accounts, aftermarket; `audit-workflows.ts` clean on the local data.
