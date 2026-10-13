# Plan — the owner's six of 2026-10-13: the provider cell, Hold and Cancel on the board, the costing's target price, its paper's name, the preloaded scope of work and declared scope values

The owner's words, with `SCOPE_OF_WORK_PRELOADED.xlsx` and a screenshot of
the costing's Cost summary: "1. Quotation: on who carries the cost, if the
supplier isn't in the suggestion list, allow typing it or offer add as a
new supplier. 2. Sales pipeline: on the Move button add Hold and Cancel in
the list; remove the This Month Forecast column. 3. Costing: allow setting
a target amount like in the quotation — the percentage is hard to hit the
desired value. 4. Costing printout: rename Material Cost Estimate to
Project costing. 5. Preloaded scope of work from the attached Excel (main
subheadings and tasks), the first thing seen on creating a costing, still
add/remove-able. 6. Costing: the scope of work value editable to declare
the value; assume the costing's materials cost is allocated to purchasing
of materials, and the equipment cost to purchasing of equipment."

Status: **built 2026-10-13** on the defaults below, one commit per item —
see CLAUDE.md (the costing sheet notes, "Hold and Cancel on the Move menu",
the board's dress, the quotation cost cell). Differences from the plan:
the preload's tasks start at one working day each, not zero (a zero-day
task still takes a day in `planTasks`, so "plans nothing" was not on
offer); a fixed price is bounded by the margin's own ±95% rather than
refused below cost (a cost that grows after the price is fixed must still
save); releasing a fixed price prices from its six-decimal margin, which
can move the price by a few centavos; the "This month forecast" TILE (off
by default) stays, only the column went; and the lists' Status filter
gained no "Cancelled" value — the stage filter is unchanged, a cancelled
one reads "Cancelled" on its row. Open question 1 was answered the other way afterwards (the owner's
call, the same day): the purchases are phases of their own — PURCHASE OF
EQUIPMENT (Equipment cost) and PURCHASE OF MATERIALS (Materials cost) —
and Planning & Engineering spreads.

## 1. Quotation — a provider not on the list

**Today.** The cost cell's provider is `ProviderLookup` in
`web/src/pages/sales/editorParts.tsx` (about line 380), one box for a
person or a supplier, reading `GET /quotations/providers?kind=supplier|user&q=`
(`api/src/routes/sales.ts`, about line 1833: active suppliers by name or
code, 50 at most). A name that matches nothing leaves the line with no
provider and the typed text is lost on blur. The customer-facing twin,
`SupplierPicker` (`web/src/components/SupplierPicker.tsx`), already offers
"Add … as a new supplier" to a `gchain.suppliers.create` holder through the
ordinary `POST /suppliers { name }`, says "could not be listed" when the
lookup failed and "no supplier matches" once it answered, and offers the
quick-add only after the lookup answered for what was typed (CLAUDE.md,
rule 20).

**Build.**
- `ProviderLookup` (supplier kind only) takes the picker's three rules:
  "no supplier matches" once the lookup answered; **Add "X" as a new
  supplier** as the last row of the menu for a `gchain.suppliers.create`
  holder, filing it through `POST /suppliers { name }` and picking it (the
  code comes from numbering; everything else is filled on the supplier's
  page later); "could not be listed" when the lookup failed. Both editors
  (quotation and sales order) share the cell, so both get it. Enter on the
  add row adds it; the row is a `button` in the `lookup-menu`, reachable
  with the arrow keys as the others are.
- **A person without the create right keeps the name as a note**: the
  menu's last row reads "Keep "X" as a note on this line", which writes
  `Supplier: X` into the line's `costNote` (the SCORO import's own rule for
  a supplier not on file, `routes/imports/scoroQuotes.ts`), leaves the
  provider empty and says so under the box. Nothing is invented on the
  supplier master by someone who may not add to it.
- **Who holds the right**: today only Procurement and Purchasing Manager.
  Grant `gchain.suppliers.create` to `sales`, `industry_specialist`,
  `team_leader` and `sales_manager` in the seed (the never-offered rule
  carries it to the live install). Without this the owner's "add as a new
  supplier" shows for nobody in sales. Flagged below.
- The API needs no change: `POST /suppliers` already refuses a non-holder.

**Verify.** verify-sales: a holder adds a supplier from the typed name and
the line carries its id; a non-holder's attempt at `POST /suppliers` is a
403 and the note path stores `Supplier: X` in `costNote`.

## 2. Sales pipeline — Hold and Cancel on Move; the forecast column goes

**Today.** The Move menu (`MoveMenu` in `web/src/pages/sales/Pipeline.tsx`,
about line 1438) lists `card.allowedTargets` from `allowedTargets()` in
`api/src/shared/pipeline.ts` (line 177): a LEAD may go to any lead column
including **ON_HOLD** and to LOST ("Mark lost…"); a QUOTATION may go to
OPEN / SUBMITTED / NEGOTIATION, WON (with an approved revision) and LOST.
`QuotationOutcome` has no hold (`OPEN SUBMITTED NEGOTIATION WON LOST`),
and nothing has a cancel: Lost with a reason is the only way out. The
"This month forecast" column is `FORECAST_KEY` in `buildBoard()` (about
line 871) and `FORECAST` in `Pipeline.tsx` (lines 157, 216, 235, 296, 307,
619, 641, 784, 788, 865–869, 1021, 1106, 1229): a read-only column of open
cards closing this month, which the Forecast menu (2026-10-08) now does
properly.

**Build — Hold.**
- **A quotation can be put on hold**: `ON_HOLD` joins `QuotationOutcome`
  (schema + `db push`). `assertOutcomeChange` allows ON_HOLD from any open
  outcome and back to any open outcome (the menu's "Move to Opportunity /
  Negotiation / Closing" is the resume — no second "Resume" verb; the
  Modify page's Status select follows). It is not open: `QUOTATION_OPEN_KEYS`
  stays as it is, so the Forecast, the board's open set, the customer
  list's "Open quotation" filter, Insights' open value and the lead/quote
  "booked" rules do not count it. `quotationStage()` maps it to the
  **On hold** stage (`OUTCOME_STAGE` in `Quotations.tsx` gains it; the
  board's parked `ON_HOLD` column takes quotation cards as it takes leads;
  `quotationStages()` lists On hold for the quotation list's Stage filter
  — CLAUDE.md's "never On hold, which is a quotation's" sentence changes).
  The lead that follows a quotation's outcome goes ON_HOLD with it and
  comes back with it (`leadStatusAfter` or the PATCH's own follow rule —
  read `routes/sales.ts`' PATCH before touching it). The SCORO import's
  status map sends "Hold" to ON_HOLD instead of OPEN. `standsApproved()`
  is untouched; a held quotation's approved revision still stands.
- The Move menu lists **"Put on hold"** for an open lead or quotation (its
  own `allowedTargets` entry — the board drops a card on the parked
  column the same way) and the ordinary stage moves for a held card. The
  stage view already shows On hold as a collapsed band (`collapsed:
  ['ON_HOLD']`).

**Build — Cancel.**
- **Cancel is Lost with a kind**, not a new stage: SCORO's statuses (Admin ›
  Pipeline Stages) have Lost and On hold and nothing else off the board,
  and a seventh stage would reach every stage map, the board, the lists,
  the Forecast's comparison (lost at odds 0) and Sales Analytics. Instead
  `Lead.lostKind` and `Quotation.lostKind` (`LostKind { LOST, CANCELLED }`,
  nullable, set with LOST and cleared when the record leaves it) say
  which. The Move menu lists **"Cancel…"** beside "Mark lost…"; both ask
  the reason in the same confirm bar (`MSG_LOST_REASON` stays the gate);
  the PATCH takes `lostKind` beside `lostReason` and refuses it without
  LOST. The status pill reads "Cancelled" (`statusLabel` from the pair),
  the stage stays Lost, and the lists' Status filter offers Cancelled as a
  value of the same key. **Win rate counts a cancelled one as neither won
  nor lost** (Sales Analytics, the board's Lost tile, Insights' funnel):
  one `lostWhere()` / `cancelledWhere()` pair in `shared/pipeline.ts`,
  used wherever `outcome: 'LOST'` is counted today — grep for it; there are
  several. The Forecast's comparison keeps a cancelled one at odds 0 (it
  did not close).
- The quotation page's ⋯ gets "Cancel quotation…" beside "Mark lost…" (rule
  19: destructive, last, red), the lead page the same; the mass action
  "Change status" on the quotation list gains Cancelled with one reason
  for all.

**Build — the forecast column goes.** Remove `FORECAST_KEY` and
`board.forecast` from `buildBoard()` and the response; remove every
`FORECAST` line in `Pipeline.tsx` (the column, the label, `refusalFor`'s
clause, the "All steps" column order, the card's `inForecast`); drop the
"forecast yellow" tone from `COLUMN_TONE`. verify-pipeline's forecast-column
assertions go; the board's six summary tiles stay. The CSV twin loses
nothing (it never carried the column).

**Verify.** verify-sales: ON_HOLD allowed from each open outcome and back,
refused from WON/LOST; a held quotation is absent from the forecast and
the open sets; `lostKind` refused without LOST; the win rate with one
cancelled, one lost, one won. verify-pipeline: a drop on On hold moves the
quotation and its lead; the board, the list row and the page agree; the
response has no forecast column.

## 3. Costing — a target price that lands exactly

**Today.** "Set the grand total" on the Cost summary (`CostingSheet.tsx`,
line 1122; `applyTarget()` at 651; `priceTo()` at 219) solves the margin
to six decimals that lands NEAREST the typed grand total, writes it into
the Margin box and says where it landed. Because the margin is a share of
the price stored to 0.0001%, the estimate misses the target by a centavo
or more on any sizeable sheet, and a line edited afterwards moves the
price again — which is the owner's complaint. `recalc()` in
`routes/costing.ts` is the only writer of `contractValue` (= cost ÷ (1 −
margin), rounded once, `costingMath.ts`), and `present()` reads the
summary off the stored cost and contract value.

**Build.**
- **`Costing.targetContractValue`** (nullable `Decimal(18,2)`): the price
  the owner typed, net of VAT. While it is set, `recalc()` writes
  `contractValue` = the target EXACTLY and `marginPct` = the margin it
  amounts to (derived, six decimals, stored for display and for the
  budget's expected margin); a line added or changed afterwards keeps the
  price and moves the margin, as a fixed-price bid does. Clearing it goes
  back to pricing from the margin. `costingMath.costingFigures` takes
  `targetContractValue` and the web mirror (`web/src/lib/costingMath.ts`)
  follows, pinned equal by verify-costing's 400 random sheets.
- **The box takes the grand total or the price**: a small toggle under
  "Set the grand total" — "Including VAT" (the default, what the owner
  types today) or "Before VAT". Typed including VAT, the stored target is
  the contract value whose VAT lands nearest (`priceTo`'s five-candidate
  walk, kept), and the hint says "₱130,000.00 — lands on ₱129,999.99
  with VAT" only when it does not land exactly. Apply stores the target
  (the sheet sends `targetContractValue` on save; Enter still applies).
  The Margin box reads the derived margin greyed, with "Fixed price —
  release to price from the margin" and a Release link beside it.
- **Guards**: a target at or under cost is refused with the words the
  margin guard uses ("A margin of −95% …" becomes "That price is below
  cost by … — a loss-making bid is priced on purpose: release the target
  and set a negative margin"); the ±95% bound still applies to the derived
  margin. A FINAL costing refuses it like any edit. The paper's summary
  line says "Margin (x% of the price, fixed price)" when fixed.
- The Costing list's and the project budget's expected margin read the
  stored `marginPct`, so nothing else changes.

**Verify.** verify-costing: a target of ₱130,000.00 including VAT lands the
grand total on ₱130,000.00 exactly (or names the one-centavo case); a line
added afterwards leaves `contractValue` as typed and moves `marginPct`;
release prices from the margin again; a target under cost is a 400; the
mirror agrees on 400 random sheets with and without a target.

## 4. The costing's paper is "Project Costing"

**Today.** `title: 'Material Cost Estimate'` at `routes/costing.ts:1924`;
the file is `Costing <number> - <author> - <date>.pdf` (`paperFileName`,
line 1938); the page's button is "Print".

**Build.** The title becomes **Project Costing** (the document's name in
24pt purple, rule 6) and the file name's kind "Project Costing". The
specimen and the verify-costing paper check follow (they read the title).
The menu label stays Costing; the Prepared by and the route's sign-offs
are unchanged. verify-costing: the paper's first line reads PROJECT
COSTING and the file name starts with it.

## 5. The preloaded scope of work

**The owner's sheet** (`SCOPE_OF_WORK_PRELOADED.xlsx`, Sheet1: A = phase,
B = task), as it will be seeded — one spelling fixed ("Turn orver" →
"Turn over"):

| Phase | Tasks |
|---|---|
| PLANNING & ENGINEERING | Review of costing and design · Kick-off meeting (Gruntech) · Purchase of equipment · Purchase of other materials |
| SITE PREPARATION | Kick-off meeting (Customer) · Site survey · Verification of all specification and location |
| DELIVERY, UNLOADING & PLACEMENT | Equipment delivery · Placement |
| INSTALLATION & INTEGRATION | Installation of equipment · Integration of equipment · All activities related to installation and integration |
| TESTING & COMMISSIONING | Start up and commissioning |
| HAND OVER & CLOSURE | Training for operation and troubleshooting · Turn over of all documents and as-built plan |

**Today.** A new sheet (`/g-ops/costing/new`) starts with no sections
(`useState<SheetSection[]>([])`, `CostingSheet.tsx:278`); a template
(`CostingTemplate.body`) can bring phases, and `/costings/suggest/lists`
feeds the phase and task name datalists.

**Build.**
- **`SCOPE_PRELOAD` in `api/src/shared/scopePreload.ts`**, pure: the six
  phases in the sheet's order with their tasks, each task `durationDays: 0`
  and no `startDay`, the phase's `kind` mapped — TESTING & COMMISSIONING →
  `TESTING_COMMISSIONING`, HAND OVER & CLOSURE → `TURNOVER`, the rest
  `MAIN_WORK` — so the Service and Turnover flows that read `kind` keep
  working. `GET /costings/suggest/lists` sends it as `scopePreload`; the
  web keeps no copy (one list, one place; the editor reads it on `/new`).
- **The new sheet opens on it**: `/new` with no `?template=` starts with
  the six phases and fifteen tasks, values blank, durations 0 — a
  phase with neither a task duration nor its own is unplanned and moves
  nothing (2026-10-09's rule), so the Gantt stays empty until durations are
  typed. Add, remove and rename stay as they are (Remove on the phase,
  the task's own Remove). A template chosen on `/new` REPLACES the preload
  (the template is the owner's own plan); "Add template" on an open sheet
  appends, as today. The lead and customer presets are untouched.
- **"Start from the preload"** is a button beside "Sequence tasks" on a
  sheet with no phases (an old draft, or one emptied by hand), so the
  preload is reachable later without re-creating the costing.
- The task "Purchase of equipment" / "Purchase of other materials" stay
  TASKS under Planning & Engineering, as the sheet has them — see §6 for
  the money.
- Not in this plan: an administrator's editor for the preload. The list is
  code; a change is a commit. Flagged below as optional.

**Verify.** verify-costing: the lists endpoint sends six phases and
fifteen tasks in the sheet's order with the kinds above; a sheet posted
with the preload unchanged saves, plans nothing and builds no task dates;
removing a phase from it saves five.

## 6. Declared scope values, and the materials and equipment money

**Today.** Each phase's Value box (the schedule of values,
`CostingSheet.tsx:1204`) is DISABLED while "Keep the schedule of values
equal to the contract value" is ticked (the default, `spread = true`,
line 1314); on save `spreadSections()` (`routes/costing.ts:112`) spreads
the contract value over every phase in proportion to what is there, or
evenly, remainder on the last. Unticked, every value is typed by hand and
the sheet warns until they add up to the contract value. There is no link
between a phase and a cost bucket; the six buckets (MAT, EQP, LAB, SUB,
IND, CON) are the cost lines' categories.

**Build.**
- **A value typed is a value declared.** `ScopeSection.valueSource`
  (`ScopeValueSource { SPREAD, DECLARED, CATEGORY }`, default SPREAD) and
  `ScopeSection.costCategoryId` (nullable, for CATEGORY). The Value box is
  always enabled; typing in it marks the phase DECLARED (the box shows a
  small "declared" tag with an × that puts it back to SPREAD). The spread
  tick box becomes the rule for the UNDECLARED phases only:
  `spreadSections()` subtracts the declared and category values and
  spreads the remainder over the SPREAD phases (proportionally, else
  evenly, remainder on the last of them); with no SPREAD phase left, the
  sheet must add up by hand as today. Declared values above the contract
  value are refused on save ("The declared phases add up to ₱… against a
  contract value of ₱…") — the SOV must total the contract value (Phase 3
  rule), and a project is still refused until it does.
- **Materials and equipment take their phase's value from the costing**:
  `valueSource: CATEGORY` with the bucket — "Value from: Materials cost /
  Equipment cost / …" (every bucket is offered; the owner named two). The
  value is that bucket's cost **priced at the sheet's margin** (cost ÷
  (1 − margin), the contract value's own rule, rounded once), so the
  phase carries what the customer pays for those goods and the SOV still
  totals the contract value; the box shows the figure greyed with "from
  Materials cost ₱… at the margin" under it. With a fixed price (§3) the
  same ratio applies (contract ÷ total cost). The figure is written on
  save by `spreadSections()` (one writer), so progress reports and billing
  read a stored value as they do now. A bucket named on two phases is
  refused (the money would be counted twice); a bucket with no lines gives
  0 and says so.
- **The preload (§5) links nothing**: the purchase of equipment and
  materials are TASKS on the owner's sheet, and a task holds no value
  (billing is by phase, model §4.2). The owner's sentence reads as a rule
  for the phase that holds them: PLANNING & ENGINEERING would then carry
  both buckets — which is one phase, two buckets, and §6's "one bucket per
  phase" allows it only as a list. Default: `costCategoryIds` is a LIST on
  the phase (a phase may carry several buckets), and the preload links
  PLANNING & ENGINEERING to Materials and Equipment. The alternative, two
  phases "PURCHASE OF EQUIPMENT" and "PURCHASE OF MATERIALS" each with one
  bucket, is cleaner for billing and is the first open question.
- The project's Budget Monitoring is untouched: cost reaches a project
  through `JobCostEntry`, and the SOV is the billing side. Nothing here
  moves budget money; "allocated to purchasing" is the SOV reading, not
  a purchase requisition.

**Verify.** verify-costing: a declared phase keeps its value through a
spread; the remainder lands on the SPREAD phases exactly; a CATEGORY phase
equals the bucket's cost priced at the margin, and the SOV totals the
contract value; declared values over the contract are a 400; a bucket on
two phases is a 400.

## Open questions (defaults in bold)

1. §6 — the purchase of equipment and materials: **tasks under PLANNING &
   ENGINEERING, which carries both buckets** (the owner's sheet as given),
   or two phases of their own, one bucket each?
2. §1 — give `gchain.suppliers.create` to the sales roles so "add as a new
   supplier" shows for them: **yes** (sales, industry_specialist,
   team_leader, sales_manager).
3. §2 — Cancel as **Lost with a kind** (no new stage) or a seventh stage
   "Cancelled" in Admin › Pipeline Stages (every stage map, the Forecast
   and Sales Analytics follow)?
4. §5 — an Admin editor for the preload (a Setting the owner edits on
   Admin › Categories): **not now**; the list is code.
5. §3 — the price box typed **including VAT by default** (today's box),
   with a "Before VAT" toggle.

## Order of work and effort for Opus 5.5

Each item is independent except that §6 reads §3's fixed price (build §3
first) and §5's preload links §6's buckets (build §6 before the preload's
link, or link it in §6's commit). Six commits, one per item, each with its
verify cases and its CLAUDE.md lines; `npx tsx scripts/verify-costing.ts`,
`verify-sales.ts` and `verify-pipeline.ts` green before each push (the API
on 5100 for the last two).

| # | Item | Touches | Effort (Opus 5.5, hands-on) |
|---|---|---|---|
| 4 | Paper title and file name | 1 route line, 1 verify line, specimen | 15 min |
| 2b | Remove the forecast column | `pipeline.ts`, `Pipeline.tsx` (14 sites), verify-pipeline | 1 h |
| 1 | Provider quick-add and note | `editorParts.tsx`, seed roles, verify-sales | 1–1.5 h |
| 5 | Scope preload | new shared file, lists route, `CostingSheet.tsx`, verify-costing | 1.5–2 h |
| 3 | Fixed target price | schema, `costingMath.ts` + mirror, `recalc`, sheet UI, paper, verify-costing | 2.5–3.5 h |
| 6 | Declared and category values | schema, `spreadSections`, sheet UI, verify-costing | 3–4 h |
| 2a | Hold and Cancel | schema (2 enums), `pipeline.ts` rules and counts, PATCH routes, board, menus, pages, lists, SCORO map, Insights, verify-sales + verify-pipeline | 4–6 h |
| | **Total** | | **13–18 h — three to four sessions** |

The one with reach is 2a: every count of `outcome: 'LOST'` and every
stage map has to learn the hold and the kind, and it is the one to build
last, on its own, with a full verify run. 3 and 6 share `spreadSections`
and the mirror and are best built back to back in one session.
