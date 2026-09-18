# G-CORE — Gap Analysis

What each source got right, what it missed, and what this project adds.
Companion to `BUSINESS-OPERATIONS-MODEL.md`.

Sources:
- **DOCX** — `gcore gruntech.docx`, your requirements
- **PDF** — `G-Core_Improved_Business_Operations_Reference.pdf`, the ChatGPT reference
- **REPOS** — the existing `gasiontech.gcore.tech` apps on the desktop

---

## A. What the PDF got right

The PDF's core judgement is correct and is adopted wholesale:

- **Integrated system, not independent CRUD menus.** This is the right diagnosis of
  what is wrong with the current implementation.
- **One shared data layer** instead of a database per division.
- **Customer master global across all modules**, with a Customer 360 view.
- **One reusable approval engine** for every document type.
- **Central notification centre** with deep links to the record.
- **Granular `Module → Submodule → Action` permissions** with Own/All splits.
- **Centralised PDF engine** and configurable document numbering.
- **Phased build order** starting from foundation, then masters, then modules.

None of this is in the current repos. All of it is in the model.

---

## B. What the PDF missed or under-specified

These are in your DOCX but weakened or absent in the PDF. All have been restored.

| # | Requirement (DOCX) | PDF status | Resolution in the model |
|---|---|---|---|
| 1 | **Face recognition clock in/out**, biometric fallback | Absent | §4.4 — retained; reuse the working implementation in `G-CORE-HR` |
| 2 | **OT prior approval** with estimated hours, then actual filing and variance | Absent | §4.4 — modeled as a two-step control, since its whole purpose is the employee's evidence of authorisation |
| 3 | **OT dual approval** (supervisor **and** HR, separately configurable) before it deducts from a project budget category | One line, no mechanism | §4.4 + §5.1 — OT only posts to the job cost ledger when both approvals exist |
| 4 | **Dinner break default** 17:00–18:00 (−60 min), uncheckable | Absent | §4.4 |
| 5 | **Leave filed with times**, so half-days account correctly | Absent | §4.4 |
| 6 | **Budget Request as a distinct flow** from Purchase Request | Conflated | §5.2 — Budget Request *changes* the budget, Purchase Request *spends* it. Without this split, budget monitoring is meaningless |
| 7 | **Costing is the origin of the contract amount, and must reflect in progress billing** | Treated as two unrelated bullets | §5.3 — the Schedule of Values is the shared backbone from costing to billing to S-curve. This is the single biggest correction |
| 8 | **Aftermarket has its own costing** with a contract budget across the same 5 categories | Absent | §3, §4.5 — a Service Contract is a Job with `type = SERVICE_CONTRACT`, not a parallel structure |
| 9 | **Service report templates customisable by the engineer**, duplicable, template-able | "Centralised PDF engine" only | §4.5 — report templates are versioned data, not code |
| 10 | **Only the author can edit a quotation** (Super Admin edits all) | Implied by Own/All | §2.7 — record ownership made first class |
| 11 | **Sales calendar** — one look at every salesperson's day | Absent | §4.1, §8 — extended into a unified calendar |
| 12 | **Customisable dashboard widgets** | Absent | §9 |
| 13 | **Access customisable down to the individual menu item** per account | General permissions only | §6.3 |
| 14 | **Project/contract creation requires a linked costing** | Absent | §10 invariants |
| 15 | **Progress reports chained first → latest** | Mentioned | §4.2 — made explicit, with construction-management report content |
| 16 | **Borrow Slip** | Listed as an entity only | §4.3 — defined as a non-consuming movement with due dates that must *not* charge job cost by default |

---

## C. What neither document covers — added here

These come from the shape of the business, not from either document.

1. **VAT 12% and EWT 2%** — **adopted.** The customer withholds EWT, so invoiced ≠
   collectible. A/R tracks invoiced / collected / withheld separately, and aging
   must not flag the withheld portion as overdue.
2. **Downpayment / mobilisation recoupment** — **deferred**, schema shape reserved.
   Most contractors bill a downpayment (commonly 30%) and recoup it pro-rata against
   each progress billing. Worth confirming with whoever handles collections before
   Phase 4 ships.
3. **Retention** — **deferred**, schema shape reserved. Typically 10% withheld per
   billing, released at final acceptance. It is a different balance from A/R and ages
   differently. Same timing caveat as above.
4. **Direct-to-job vs stock-replenishment purchase requests** — without this split,
   material bought for a job and then also issued from stock gets counted twice
   (§4.3).
5. **Four cost states, not two** — Budgeted / Committed / Incurred / Consumed. "Budget
   vs actual" alone cannot tell a PM what is still available to spend, because
   approved-but-unreceived POs are invisible (§5.1).
6. **Three S-curves, not one** — Planned vs Actual vs Billed. Actual-vs-billed is
   unbilled work, which is cash you are owed but have not asked for.
7. **Segregation of duties** — requester ≠ approver, procurement ≠ receiving ≠
   payment, costing author ≠ quotation approver (§6.2).
8. **Installed base register** — what turns a completed project into a service
   renewal pipeline. Neither document connects turnover to the service business.
9. **Employee cost rate visibility** — needed for labor costing, but salary data must
   not be exposed to project managers. Burdened rate only (§4.4).

---

## D. What the existing repos tell us

| Repo | Stack | Verdict |
|---|---|---|
| `APP G-CORE/g-core` | Static HTML shell, 4 division cards, no build step | The *shell* is worth keeping as the home screen (you asked to retain it). The *architecture* — a launcher into disconnected apps — is exactly what the model replaces |
| `APP G-HR/G-CORE-HR` | Node + Express + **TypeScript + Prisma + PostgreSQL**, React + Vite, face-api.js, JWT, nodemailer | **The strongest asset.** Working face recognition, auth, approvals. This is the stack the new build should adopt |
| `APP G-OPS/costing-app` | A single `costing.html` + `serve.py` | Useful as a reference for the costing sheet layout and PDF format. Not a foundation |
| `APP INVENTORY/APP-INVENTORY-MANAGEMENT` | Node + Express (plain JS), raw `pg`, vanilla frontend, Docker Compose, PM2 | Working receiving / slips / stock model worth porting. Different stack from HR — which is itself the problem |

**The structural finding:** four apps, four stacks, four databases, four auth systems.
The customer typed into the costing app is not the customer in the HR app or the
supplier in the inventory app. That is precisely why the PDF's "enter once, reuse
everywhere" principle matters, and why G-Core Gruntech must be **one codebase with
one database** rather than a fifth app behind the same launcher.

**Stack recommendation:** follow `G-CORE-HR` — Node + Express + TypeScript + Prisma +
PostgreSQL on the API, React + Vite + TypeScript on the web. It is already in-house,
already proven on this domain, and already solves the hardest single requirement
(face recognition).

---

## E. Deployment risk carried forward

`G-CORE-HR/CLAUDE.md` documents that the production server is shared with
`gasion-vision`, a live hospital oxygen-plant monitoring system, and that careless
restart commands have taken it down **three times**. Neither the DOCX nor the PDF
mentions this. It is now a hard constraint in the model
(`BUSINESS-OPERATIONS-MODEL.md` §12) and must be carried into every deploy script:
own port, own tunnel, own process entry, never a broad `node.exe` kill, never touch
the `Cloudflared` service, never touch PM2.
