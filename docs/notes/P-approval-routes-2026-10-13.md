# Plan — the owner's approval routing sheet of 2026-10-13, and one signature per person (2026-10-13)

The owner's words, with `APPROVAL_ROUTE.xlsx`: "1. Plan this approval route;
if roles are not yet created, create them. 2. Quotation and sales order
already have a route — suggest improvements if needed. 3. One employee
sometimes has multiple roles (consider it). 4. The time stamp of the same
employee (with multiple roles) in an approval route: make it uniform, just
like on the quotation and sales order."

Status: **planned, not built.**

## The sheet, document by document, against what runs today

| Document | The sheet (2026-10-13) | Today | Change |
|---|---|---|---|
| Quotation | Team Leader; CEO / President above ₱1,000,000 — whoever prepared it | The same two seeded routes | None to the route |
| Sales order | Team Leader › Admin Back Support › Cost Controller › CEO / President | The same route | None to the route |
| Costing | Technical Manager › Team Leader (prepared by a Project Engineer or a Technical Manager) | Technical Manager › Team Leader › **CEO (CTG)** | **The CEO step goes** |
| Purchase requisition | Technical Manager › Team Leader (prepared by PE, IS, TM, TL) | Project Manager (≤ ₱50,000); Project Manager › Finance › Executive (≥ ₱50,000) | **Replaced**, no amount band |
| Purchase order | Purchasing Manager; CEO / President above ₱100,000 (prepared by Admin Back Support or a Purchasing Manager) | Project Manager › Finance | **Replaced**, banded at ₱100,000 |
| Budget request | Team Leader › Admin Back Support › Finance Manager; CEO / President above ₱100,000 (prepared by PE, IS, Back Support, TL, Finance Manager) | Project Manager (the project's) › Finance | **Replaced**, banded at ₱100,000; **the project manager's step goes** |

Every row of a block names the same approvals whoever prepared it, so each
document is ONE route (two where an amount band adds the CEO), exactly as
the routing sheet of 2026-10-12 settled the quotation and the sales order:
a preparer who holds a step's role signs it at submit (`preparerSigns`), an
approver's manager may stand in (`standIns`), and a Team Leader step is the
preparer's "Reports to", else a Team Leader on the preparer's team, else
any Team Leader (`leadersFor`).

## 1. The routes and the roles

**Two roles are new**, seeded like the three of 2026-10-11 (each starting
from the nearest existing role's rights, to be edited in Admin › Roles):

- `purchasing_manager` **Purchasing Manager** — the Procurement role's
  rights (canvass, purchase orders, suppliers, reports, every purchase
  request). The Procurement role stays for buyers who are not the manager.
- `finance_manager` **Finance Manager** — the Finance role's rights. The
  Finance role stays for the staff who release cash and key in bills.

**Rights the sheet's preparers do not hold today**, added to the seeded
roles so the people on the sheet can raise what it says they prepare (the
never-offered rule carries them to the live install):

- Industry Specialist, Team Leader, Technical Manager: raise purchase
  requests (`gops` / `gchain` `purchase_requests` own scope) and budget
  requests (`gops.budget_requests` own scope; Industry Specialist and Team
  Leader).
- Back Support / Admin: raise purchase orders (`gchain.purchase_orders` own
  scope, `gchain.suppliers.view_all`, `gchain.purchase_requests.view_all`,
  `gchain.canvass.view_all`) and budget requests (own scope,
  `gops.projects.view_all`).
- Finance Manager: budget requests own scope (it is the third step and a
  preparer on the sheet).
- Technical Manager: the costing it reviews it may also prepare (it does,
  since 2026-10-12).

**The seeded workflows** (`prisma/seed.ts`), each with `preparerSigns` and
`standIns` on:

- `costing`: **"Costing — technical manager, team leader"** — Technical
  Manager (ROLE), Team Leader (SUPERVISOR, fallback `team_leader`). The
  three-step route of 2026-10-09 is RETIRED (deactivated, history kept — the
  step count changed, which `previously` cannot update in place; a costing
  pending on it finishes on it).
- `purchase_request`: **"Purchase Request — technical manager, team
  leader"** — the same two steps, no band. The two banded routes are
  RETIRED. A direct-to-job request still meets the budget guard
  (`procurement.blockOverBudget`); approval still commits the estimate.
- `purchase_order`: **"Purchase Order — purchasing manager"** (≤ ₱100,000)
  and **"Purchase Order — purchasing manager, then CEO / President over
  ₱100,000"** (from ₱100,000.01) — Purchasing Manager (ROLE), then CEO /
  President (ROLE `ceo`). "Purchase Order — project manager then finance"
  is RETIRED. A Purchasing Manager's own order signs step 1 at submit.
- `budget_request`: **"Budget Request — team leader, back support, finance
  manager"** (≤ ₱100,000) and **"… then CEO / President over ₱100,000"** —
  Team Leader (SUPERVISOR, fallback `team_leader`), Admin Back Support
  (ROLE `back_support`, team-scoped through `supportersFor` as on the
  sales order), Finance Manager (ROLE `finance_manager`), CEO / President.
  "Budget Request — project manager then finance" is RETIRED. Release
  stays finance's (the A/P create right, one voucher), liquidation the
  requester's, unchanged.
- The quotation and the sales order: unchanged.

`audit-workflows.ts` learns the new typical requesters (Industry
Specialists, Team Leaders and Technical Managers raise purchase requests;
Back Support and Purchasing Managers raise purchase orders; Back Support,
Team Leaders and Finance Managers raise budget requests) and reports the
two new roles while nobody holds them. **Assign Purchasing Manager and
Finance Manager in Admin › Users** — until somebody holds them, purchase
orders and budget requests stall at those steps.

## 2. The quotation and sales order routes — what to improve

Both already match the sheet. Three improvements, none to the route itself:

- **One signature per person on them too** (part 4 below): a Team Leader
  who is also the CEO / President, approving an Industry Specialist's
  ₱1,200,000 quotation, presses Approve once and both steps carry one
  timestamp. Today they are asked twice and the two stamps differ.
- **The CEO's own quotation**: the sheet sends it to the Team Leader, and
  the engine does — the CEO signs their own CEO step at submit, and the
  Team Leader decides. That is the sheet's row and stays; it is worth the
  owner knowing that a CEO who also holds Team Leader would sign BOTH at
  submit and the quotation would need nobody (the preparer's rule since
  2026-10-12). verify-sales already pins it.
- **The ₱1,000,000 edge**: "more than 1 million" is ₱1,000,000.01 and up;
  exactly ₱1,000,000.00 goes to the Team Leader alone. The same reading is
  used for the ₱100,000 bands below. Say so once in Admin › Approval
  Workflows' band labels rather than change it.

## 3. One employee with several roles

The engine already reads every role a person holds, at every point that
matters — nothing is keyed to "the" role:

- **At submit**, `heldSequences()` signs every step whose role the
  preparer holds, whichever and however many (a Team Leader who is also
  Cost Controller signs steps 1 and 3 of their own sales order).
- **Eligibility** (`approversForStep`, `deciderFor`) is per step, by any
  role held; a person on two steps is eligible on both.
- **The team fallback** (`leadersFor`) and the Back Support scope
  (`supportersFor`) read the person's team, not their role.

What is missing is part 4: the same person asked twice.

## 4. One signature per person — the approver's turn (the timestamp rule)

Today, when the same person is the approver of two steps — a Technical
Manager who is also the Team Leader on a Project Engineer's costing, a
Team Leader who is also Finance Manager on a budget request — they are
asked at step 1, then asked again at step 2, and the paper prints two
timestamps minutes or days apart. The preparer's rule of 2026-10-12 already
answers this at submit ("they appear the time stamp as one"); the same
rule is applied to an approver's Approve:

- **On Approve, the engine signs every LATER unsigned step the decider may
  decide in their own right** — an eligible approver of that step, never as
  a stand-in, never the requester — in the same transaction, each
  `ApprovalAction { action: APPROVED, coSignedWith: <the step pressed>,
  actedAt: <the same instant> }`, one APPROVED audit row each ("Team
  Leader — Maria Santos, signed with Technical Manager (holds both)").
  `currentSequence` moves to the first step still unsigned; none left and
  the request is APPROVED and settled through the same subscribers. A
  stand-in signs only the step they stood in for.
- **Every later held step, in turn or out of it** — the preparer's rule
  (the CEO's own sales order signs step 4 at submit while 1–3 wait). The
  alternative, consecutive steps only, would leave a Team Leader who is
  also Finance Manager asked twice on a budget request because Back
  Support sits between; the owner's words were "make it uniform".
- **One switch**: it runs on the routes with `preparerSigns`, which Admin ›
  Approval Workflows relabels **"One signature per person — the preparer
  at submit, an approver at their step"**. It never runs on leave,
  overtime, claims, advances, clearances, evaluations or supplier bills: a
  supervisor who is also HR must still be asked as HR.
- **Nobody is told about a step they just signed**: `notifyCurrentStep`
  goes to the first step still open; a bell or a queue row for a co-signed
  step is never raised.
- **The paper and the panel**: `ApprovalSlot.coSigned` beside `selfSigned`;
  the slot's `at` is the same instant, so the quotation's, the sales
  order's, the costing's, the purchase request's, the purchase order's and
  the budget request's sign-offs print one timestamp for one person; the
  Approval panel reads "Maria Santos · signed with Technical Manager · 13
  Oct 2026 09:14". `preparedAt(slots)` is unchanged.
- **Prepared by on the three papers that do not yet read it**: the
  purchase request's "Requested by", the purchase order's and the budget
  request's "Prepared by" print `preparedAt(slots) ?? createdAt`, as the
  quotation, the sales order and the costing do, so a Purchasing Manager's
  own order and a Team Leader's own budget request carry the one stamp.

Schema: `ApprovalAction.coSignedWith Int?` (the sequence of the step whose
Approve carried it). No new permission.

## Files

- `api/prisma/schema.prisma` (`ApprovalAction.coSignedWith`);
  `api/prisma/seed.ts` (two roles, the rights above, five new workflows,
  four RETIRED names, the `seed.preparerSignsApplied` set extended to the
  new routes); `api/scripts/audit-workflows.ts`.
- `api/src/shared/approvals.ts`: `act()` co-signs; `approvalSlots` /
  `historyFor` carry `coSigned`; `routeBrief` unchanged.
- `api/src/routes/procurement.ts` (PR and PO papers' first slot),
  `api/src/routes/budgetRequests.ts` and `cashRequestSections` (the
  `raisedAt` it is handed), `api/src/routes/admin.ts` (the switch's
  label), `web/src/pages/admin/Workflows.tsx` (the label),
  `web/src/components/DocumentApproval.tsx` ("signed with …").
- Checks: verify-foundation (an approver holding two later steps signs
  both at one instant; a stand-in signs one; a non-`preparerSigns` route
  asks twice; the request settles when the co-signed step was the last;
  nobody is told of a co-signed step); verify-costing (the two-step route;
  "one of two leaves it pending"); verify-chain (the PR route, the PO
  bands at ₱100,000 and ₱100,000.01, the Purchasing Manager's own order
  signed at submit, the Back Support preparer); verify-delivery (the budget
  request's four steps, the band, the Team Leader fallback for an engineer
  with no "Reports to"); verify-sales (a Team Leader-and-CEO signing a
  ₱1.2M quotation once). CLAUDE.md: the routing sheet section, the costing,
  procurement and budget request notes; this note marked built.

## Questions, with the defaults the build takes

1. **The costing's CEO (CTG) step goes**, as the sheet shows two
   approvals. Alternative: keep it as a third step.
2. **The budget request's project manager step goes** — the sheet's four
   approvals do not name the project's manager, though a budget request is
   the project's cash. Alternative: keep the project manager as step 1
   before the Team Leader (five steps above ₱100,000).
3. **Purchase requests lose the Finance and Executive steps and the
   ₱50,000 band**; the budget guard still refuses an over-budget direct-to-
   job request. Alternative: keep the ₱50,000 band with the CEO above it.
4. **Co-signing takes every later held step**, in turn or out of it (the
   preparer's rule). Alternative: consecutive steps only.
5. **One switch** (`preparerSigns`, relabelled) covers the preparer and the
   approver. Alternative: a second switch per route.
6. **"More than" is strict**: ₱100,000.00 stays on the shorter route.
7. **New roles start from Procurement's and Finance's rights**; the owner
   trims them in Admin › Roles.

## Effort (Fable 5.1)

Medium — one push, about four hours: the roles, rights and five routes
with their retirements (~45 min), co-signing in `act()` with the slots,
panel and the three papers' first stamp (~75 min), the checks across five
scripts (~75 min), `audit-workflows`, CLAUDE.md and the label (~25 min).
One schema column, no new permission.
