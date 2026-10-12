# Plan — approval router by the owner's sheet, stand-in approvers, one timestamp for a preparer who also signs

Written 2026-10-12 for the next session (Opus 5.5). **Built the same day**
with the defaults below; CLAUDE.md ("The routing sheet of 2026-10-12") is
the record of what holds. Where the build departs from this plan:

- The preparer's signature and the stand-in are switched on PER ROUTE
  (`ApprovalWorkflow.preparerSigns`, `standIns`), seeded on the quotation,
  sales order and costing routes — not engine-wide as D2 said: engine-wide
  would let an HR or finance person sign their own leave or expense claim.
- "Prepared by" takes the submit instant only where the preparer signed a
  step (`preparedAt(slots)`), on the quotation, sales order and costing
  papers — not on every routed document (D3).
- A held step is the ROLE the step names (a SUPERVISOR step's fallback
  role included), so a Team Leader signs the "Team Leader" step of their
  own quotation whoever they report to.

The plan as written follows. Read `CLAUDE.md` first — "Never invent a second
approval path" (rule 2), "A requester can never approve their own document"
(rule 3), "Sign-offs say who really acted" (Paper, 2026-10-10) and "Approval by
who prepared it (2026-10-11)" are the rules this plan changes or bends, and
each bend is named.

## What the owner asked (2026-10-12)

1. **The routing sheet** `APPROVAL_ROUTER_SALES_ORDER_AND_QUOTATION.xlsx`,
   read cell by cell:

   | Quotation — prepared by | Approval 1 | Approval 2 |
   |---|---|---|
   | CEO / President | Team Leader | CEO / President **if more than ₱1,000,000** |
   | Team Leader | Team Leader | CEO / President if more than ₱1,000,000 |
   | Industry Specialist | Team Leader | CEO / President if more than ₱1,000,000 |

   | Sales order — prepared by | 1 | 2 | 3 | 4 |
   |---|---|---|---|---|
   | CEO / President | Team Leader | Admin Back Support | Cost Controller | CEO / President |
   | Team Leader | Team Leader | Admin Back Support | Cost Controller | CEO / President |
   | Industry Specialist | Team Leader | Admin Back Support | Cost Controller | CEO / President |

   **Every row is the same route.** The sheet of 2026-10-11 gave each
   preparer a shorter route (a CEO's quotation needed nobody; a Team
   Leader's went straight to the CEO); the new sheet says ONE route per
   document, and what differs by preparer is handled by point 3.

2. **Stand-in approvers.** "In the event that the approver cannot approve, the
   manager or the person they report to can approve the quotation. Don't show
   them in the approval; they can just access the quotation and approve if
   necessary." — the SUPERVISOR of an eligible approver (`User.supervisorId`
   of that approver) may decide the step, silently: never listed as "Waiting
   on …", never on the PDF as assigned, never in My Work's queue, never
   notified; but `canAct` on the document's own Approval panel is true for
   them and `POST /approvals/:id/act` accepts them.

3. **One timestamp for a preparer who also holds a step.** "If a person holds
   the Team Leader, Technical Manager, they appear the time stamp as one — for
   example the CEO has a SIT team, he may create a quotation or sales order,
   while on the last approval he will also approve. Make the time stamp for
   that as similar throughout the documents." — when the preparer of a
   document is themselves an eligible approver of one of its steps (a Team
   Leader's own quotation: step "Team Leader"; the CEO's own sales order: step
   "CEO / President"; a Technical Manager's own costing: step "Technical
   Manager"), that step is **signed by the engine at submit, with the SAME
   timestamp as "Prepared by"**, and the document waits only on the steps
   held by others. This is engine-wide (every document type), not a sales
   special case.

## The decisions (make them before coding; the owner has already called the first three)

- **D1 — one route per document type.** The four preparer-keyed workflows
  seeded 2026-10-11 are RETIRED (the seed's `RETIRED` list in
  `api/prisma/seed.ts`): "Quotation — prepared by the CEO / President: no
  approval", "Quotation — prepared by a Team Leader: CEO / President", "Sales
  Order — prepared by the CEO / President: back support, cost controller",
  "Sales Order — prepared by a Team Leader: back support, cost controller, CEO
  / President". The general routes already match the sheet exactly and stay:
  "Quotation — Team Leader" (≤ ₱1,000,000), "Quotation — Team Leader, then CEO
  / President over ₱1,000,000", "Sales Order — team leader, back support, cost
  controller, CEO". Keep `ApprovalWorkflow.requesterRoleId`, `pickWorkflow`'s
  preparer logic and the Admin › Approval Workflows "Prepared by" field — they
  are data an administrator may still use; only the seed stops using them.
  The "a role's route with NO steps approves on submit" branch in
  `submitForApproval` stays too (it is how an administrator can still exempt a
  role) but no seeded route exercises it any more.

- **D2 — the self-held step is signed at submit, by the engine, at the
  submit instant.** Rule 3 is untouched for `act()`: nobody may press Approve
  on their own document. What changes is that `submitForApproval` writes an
  `ApprovalAction { action: APPROVED, approverId: requesterId, selfSigned:
  true, actedAt: request.createdAt }` for each step the requester holds, in
  the same transaction as the request. "Holds" = the requester is among
  `approversForStep(step, requesterId)` computed WITHOUT the requester
  exclusions (see the engine change below) — a ROLE step whose role they
  hold, a SUPERVISOR step whose fallback role they hold when they report to
  nobody, a USER step naming them. A PROJECT_MANAGER step is NOT self-held
  (the engine already sends a PM's own request up to the fallback role: the
  owner's 2026-10-07 call, keep it).

- **D3 — "Prepared by" prints the submit instant on a routed document.** The
  owner wants the preparer's two signatures to carry one timestamp "throughout
  the documents". Today "Prepared by" on the quotation prints
  `revision.createdAt` and on the sales order `order.createdAt`; the self-signed
  step will carry `request.createdAt`. Make them one: where a request exists
  for the document, every document's "Prepared by" slot takes
  `request.createdAt` (the latest request's); a draft with no request keeps
  the record's own date. Put this in ONE helper (`preparedAt(documentType,
  documentId, fallback)` in `shared/approvals.ts`) and call it from every
  `*PrintData` / sign-off builder that draws "Prepared by" / "Requested by" /
  "Filed by" — `routes/sales.ts` (quotation and costing), `routes/salesOrders.ts`,
  `routes/jobOrders.ts`, `routes/purchaseRequests.ts`, the expense claim, cash
  advance, budget request, leave, overtime, clearance, evaluation and training
  certificate papers (grep `role: 'Prepared by'`, `'Requested by'`, `'Filed
  by'`). The alternative (stamp the self-signed step with the record's
  `createdAt`) would date a signature before the document was finished; the
  owner's words ("while on the last approval he will also approve") are about
  sending it, so the submit instant is the honest one. Say so in CLAUDE.md.

- **D4 — a stand-in is one level up, and only for a PENDING step.** The
  supervisor (`User.supervisorId`) of each eligible approver of the current
  step may act. Not the supervisor's supervisor: the owner said "the manager
  or the person they report to", one hop. Make the depth a constant
  (`STAND_IN_DEPTH = 1`) so it can be raised without a redesign. A stand-in
  who is the requester is still refused (rule 3). A stand-in acts in their
  own name — the action records `approverId: standIn`, `onBehalfOfId: <the
  approver they stood in for>` (first of the eligible approvers reporting to
  them), the audit summary says "Team Leader — Maria Santos (standing in for
  Juan dela Cruz)", and the PDF prints Maria's name under the step (Paper
  rule: who really acted). Never pre-compute or store stand-ins; derive at
  `act()` / `canAct` time from the eligible list.

- **D5 — the Team Leader of a preparer with no "Reports to" is their TEAM's
  leader.** Today a SUPERVISOR step with no supervisor falls back to EVERY
  holder of the fallback role, so the CEO's quotation (the CEO reports to
  nobody) would go to every Team Leader. Narrow the fallback: holders of the
  fallback role whose `Employee.industryId` equals the requester's team
  (`teamOf(requesterId)`), else every holder (never nobody — the engine's
  rule that a document never stalls for want of an approver). This is the
  same shape as `supportersFor()` for Back Support. Ask the owner only if a
  team leader is expected to approve for other teams; otherwise build it.

## The changes, in order

### 1. Schema (`api/prisma/schema.prisma`) — ½ h

```prisma
model ApprovalAction {
  …
  /// Signed by the engine at submit because the requester holds this step
  /// (2026-10-12): never pressed, dated the submit instant.
  selfSigned   Boolean @default(false)
  /// A stand-in's decision: the eligible approver they stood in for.
  onBehalfOfId String?
  onBehalfOf   User?   @relation("StoodInFor", fields: [onBehalfOfId], references: [id], onDelete: SetNull)
}
```
`prisma db push` on the dev database; add the `User` back-relation. No data
migration.

### 2. Engine (`api/src/shared/approvals.ts`) — the core, 4–5 h

- `approversForStep(step, requesterId, tx, ctx, opts?: { includeRequester?: boolean })`:
  today only PROJECT_MANAGER excludes the requester explicitly; make the
  exclusion explicit everywhere it exists and let `includeRequester: true`
  skip it, so `holdsStep()` can ask "would the requester be an approver here".
  Apply D5 inside the SUPERVISOR fallback (`teamHoldersFirst(holders,
  requesterId, tx)` — reuse the pattern of `supportersFor`).
- `holdsStep(step, requesterId, tx, ctx): Promise<boolean>` — PROJECT_MANAGER
  → false; else `(await approversForStep(…, { includeRequester: true })).includes(requesterId)`.
- `submitForApproval`:
  - after `pickWorkflow`, compute `held = steps.filter(holdsStep)`.
  - **Replace** the "routes step 1 only to you" refusal: a step whose only
    approver is the requester is now simply self-signed. Keep the "routes to
    nobody" refusal for a step with no approver at all and not held.
  - create the request and, in ONE transaction, the self-signed actions
    (`actedAt: request.createdAt`, `selfSigned: true`), then set
    `currentSequence` to the first step NOT self-signed; if every step is
    self-signed, write `status: APPROVED, closedAt: request.createdAt`,
    audit "Approved on submit — every step is the preparer's" and
    `emitSettled`. One audit row per self-signed step: `action: 'APPROVED'`,
    summary "Team Leader — signed by the preparer at submit (holds the role)".
  - the existing no-step branch (D1) stays as is.
- `act()`:
  - eligibility: `eligible.includes(userId) || standIns(eligible).includes(userId) || isSuperAdmin`,
    where `standIns(eligible, tx)` = `user.findMany({ where: { id: { in: eligible } }, select: { supervisorId } })`
    → active supervisors, minus the requester. Record `onBehalfOfId` when
    the actor came in as a stand-in (the first eligible approver whose
    supervisor they are).
  - advancing: `next` becomes the first LATER step with no APPROVED action
    (skip self-signed ones); none left → APPROVED. The conditional
    `updateMany` claim is unchanged.
  - audit summary gains "(standing in for <name>)".
- `pendingFor()` — unchanged (stand-ins are not queued: the owner's "don't
  show them").
- `namedApprovers()` / `historyFor()` — unchanged (never list stand-ins);
  but `historyFor` must mark self-signed steps as taken (it already reads
  `actions`, so it does) and return `selfSigned` / `onBehalfOf` on actions
  for the panel.
- `approvalSlots()`: a self-signed step prints the preparer's name, contact
  lines and `actedAt` (= submit instant); a stand-in's step prints the
  stand-in's name. Add `preparedAt()` (D3).
- `routePreview()` / the draft branch of `approvalSlots`: mark steps the
  requester holds (`heldByRequester: true`) so a draft's PDF prints the
  preparer's name there with "Signs at submit" instead of "Pending", and the
  page's "Submit for approval sends it to …" line says "you sign the Team
  Leader step yourself; then the CEO / President".
- `cancelOpenRequest` — unchanged.

### 3. Route handlers — 1 h

- `api/src/routes/workspace.ts` `GET /approvals/history/…`: `canAct` =
  eligible OR stand-in OR super admin, never the requester. Factor the test
  into `mayAct(request, step, userId)` in `shared/approvals.ts` and have
  `act()` call the same function, so the panel and the route cannot disagree.
- Record visibility for a stand-in: a Team Leader's supervisor is the CEO or
  a sales manager, who hold `gops.quotations.view_all` / `sales_orders.view_all`
  already; check the costing (Technical Manager's supervisor) and the HR
  documents. Where a stand-in could lack the read right, add one narrow door:
  `GET /quotations/:id` (and the order's, the costing's) admits a user for
  whom `mayAct()` is true on the document's open request. Do not widen list
  visibility.

### 4. Seed (`api/prisma/seed.ts`) — ½ h

- Add the four preparer-keyed names to `RETIRED` (D1). Leave their
  definitions out of `WORKFLOWS` (a retired name must not be re-created).
- `audit-workflows.ts`: knows `quotation` / `sales_order` typical requesters;
  add `team_leader`, `industry_specialist`, `ceo` to them, and stop reporting
  "step routes to the role that raises it" for a step the preparer may
  self-sign (it is no longer a fault).

### 5. Web — 1–1½ h

- `web/src/components/ApprovalStepper.tsx` (`DocumentApproval`): a self-signed
  step reads "Signed at submit — <name>, <when>" (not "Approved"); a stand-in's
  action reads "<name>, standing in for <approver>". The Approve / Return /
  Reject buttons already key on `canAct`, so a stand-in gets them with no
  further change; nothing lists stand-ins.
- Quotation page / sales order page route card: show "You sign <step> at
  submit" where the preview marks a held step.
- No menu, registry or permission change.

### 6. Paper — covered by §2 and D3; verify in §7

`pdf.ts` and `pdfDesign.ts` already print `person.at ? formatDateTime(at) : 'Pending'`;
the self-signed slot's `at` makes both engines print the same instant as
"Prepared by" with no engine change. The sales order's one-row approvals table
(`drawSignoffTable`) prints name + timestamp only — the owner's "time stamp
… similar throughout the documents" is satisfied once `preparedAt()` feeds
"Prepared by".

### 7. Verify scripts — 2–3 h (the owner's rule: engine changes need cases)

- `verify-foundation.ts` (engine, no API): a 2-step workflow whose step 1 role
  the requester holds → request created with step 1 APPROVED, `selfSigned`,
  `actedAt === request.createdAt`, `currentSequence === 2`; both steps held →
  APPROVED on submit and the subscriber fired once; a stand-in (approver's
  supervisor) may `act()`, a stranger may not, the requester may not even as a
  stand-in; `pendingFor(standIn)` is empty; `approvalSlots` names the stand-in
  with `onBehalfOf` recorded; `act()` skips a self-signed later step and
  settles; D5: the SUPERVISOR fallback narrows to the requester's team.
- `verify-sales.ts`: rewrite the block around lines 3490–3530 ("A Team
  Leader's own quotation goes to the CEO / President alone", "the CEO's
  quotation needs no approval"): now the TL's ≤ ₱1M quotation is APPROVED on
  submit with "Team Leader" self-signed; the CEO's > ₱1M quotation waits on
  the Team Leader (of the CEO's team) with the CEO step already signed and
  the PDF printing the CEO's name twice with ONE timestamp (assert the two
  `formatDateTime` strings are equal); a sales order prepared by the CEO
  waits on TL → Back Support → Cost Controller and settles on the Cost
  Controller's signature. Keep the existing "three signatures book nothing"
  case. Update the CLAUDE.md assertion counts.
- `verify-costing.ts`: a Technical Manager's own costing self-signs step 1;
  "CTG cannot sign out of turn" still holds for `act()`.

### 8. CLAUDE.md — ½ h

Replace "Approval by who prepared it (2026-10-11)" with the new rule set
(the sheet's three tables, D1–D5, the file names), amend rule 3 ("… through
`act()`; the engine signs at submit the steps the preparer holds, dated the
submit instant"), and the Paper section ("Prepared by is the submit instant
where a request exists"). Add the retired names to the seed note.

## Effort

| Part | Hours (Opus 5.5, one session) | Reasoning effort |
|---|---|---|
| 1 Schema + 4 Seed | 1 | medium |
| 2 Engine | 4–5 | **high** (`submitForApproval` / `act()` transactions and the skip-forward; keep the conditional claims intact) |
| 3 Routes + stand-in read door | 1 | medium |
| 5 Web | 1–1½ | medium |
| 7 Verify | 2–3 | high (the single-timestamp and stand-in cases are the proof the owner will look at on the PDF) |
| 8 Docs | ½ | low |
| **Total** | **10–12 h** — two pushes: (a) D1 + D5 + engine + verify, (b) stand-ins + web + docs | |

Run before each push: `cd api && npx tsc --noEmit && npx tsx scripts/verify-foundation.ts && npx tsx scripts/verify-sales.ts && npx tsx scripts/verify-costing.ts` (the HTTP scripts need the API on :5100), then `npx tsx scripts/audit-workflows.ts`.

## Open questions for the owner (ask before part 2 if unsure; defaults given)

1. Stand-in depth: one level up only (default), or the whole reporting chain?
2. Should the stand-in's decision print as "<stand-in> for <approver>" on the
   PDF, or the stand-in's name alone (default: the stand-in's name alone;
   the audit row and the panel say whom they stood in for)?
3. D5: a preparer with no "Reports to" — their own team's Team Leader
   (default), or any Team Leader?
