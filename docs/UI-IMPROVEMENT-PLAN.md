# G-CORE — UI/UX improvement plan

Written before any change was made, from an audit of the front end as it stands
at commit `40e3c26`. It records what is actually wrong, with counts, so that
"improve the UI" becomes a list of defects rather than a matter of taste.

**Out of scope, absolutely: the landing page.** `web/src/pages/Home.tsx`, the
`.home-*` and `.module-*` rules, and `web/public/modules/*.gif` are not touched
by any item below. The layout was chosen deliberately and is not up for redesign.

Also out of scope: database structure, API behaviour beyond one additive field,
routes, and business logic.

---

## 1. What is there

| | |
|---|---|
| Framework | React 18 + React Router 6 + Vite 6 + TypeScript |
| Styling | One hand-written stylesheet, `web/src/styles.css`, 1,690 lines |
| UI library | **None.** No Tailwind, no MUI, no component kit |
| Shared components | `Shell`, `DataList`, `CommandPalette`, `ImportModal`, `ui.tsx` |
| Pages | 44 files, 27,005 lines under `web/src/pages/` |
| Design tokens | Colour and radius only — 16 custom properties |

The architecture is sound. `DataList` genuinely is the one list pattern, `ui.tsx`
genuinely is the one set of primitives, and the permission registry genuinely
drives the menu. The problems are not structural. They are that the token layer
stops at colour, so everything above it was decided one file at a time.

## 2. Findings

### 2.1 There is no spacing or type scale — 537 inline styles

`style={{ ... }}` appears **537 times**. Nearly all of it is spacing and type:

```
 83 × marginBottom      61 × width        38 × marginTop
 37 × fontSize          30 × marginTop+marginBottom
```

The values are unconstrained. Margins and padding use **3, 4, 5, 6, 7, 8, 10,
12, 14, 16 and 18px**; gaps use **2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 18, 22 and
26px**; font sizes use **10, 11, 12, 13, 18, 20, 22 and 24px**. Fourteen spacing
values and eight type sizes is not a system, it is the absence of one, and it is
why two cards side by side rarely line up.

### 2.2 `--faint` fails contrast, in 369 places

`--faint: #4d5d55` on `--surface: #0a0c0b` is **2.7:1**. WCAG AA wants 4.5:1 for
text and 3:1 for anything at all. It is used **369 times**, and not for
decoration — it carries document numbers, timestamps and the "and 4 more…"
lines. This is the single highest-leverage defect in the application: one token,
369 fixes.

### 2.3 Keyboard users cannot see where they are

The stylesheet defines focus styling for **inputs only** (`styles.css:174`).
Buttons, links, nav items, the scope switch, sortable table headers, clickable
rows, permission chips and the module strip have **no focus ring at all**. Tab
through the app and the caret vanishes.

Related: `aria-label` appears **4 times** in 27,000 lines; `aria-sort`,
`aria-expanded`, `aria-current` and `aria-live` appear **zero** times. Seven
`<div>`/`<tr>` elements carry an `onClick` with no keyboard equivalent, so
approving from a workflow card or opening a pipeline card is mouse-only.

There is no skip-to-content link, and no `prefers-reduced-motion` block.

### 2.4 The same status-to-colour mapping is written eight times

`statusTone()` / `tone()` is reimplemented in `PurchaseRequests`, `Leave`,
`Overtime`, `Contracts`, `Receivables`, `Leads`, `Quotations` (twice) and
`service/Reports`, plus `STATUS_TONE` in `hr/Dashboard` — nine variants of the
same four rules (`APPROVED→ok`, `REJECTED|CANCELLED→danger`, `DRAFT→neutral`,
else `warn`). `label()`, which turns `ON_HOLD` into `On hold`, is written twice.
They have already drifted: `Leave` treats `DRAFT` as neutral, `Contracts` does
not handle `DRAFT` at all.

### 2.5 The G-OPS sidebar is 23 flat items

G-OPS carries **23 submodules** in one unbroken list, spanning three unrelated
areas of the business — sales (leads → customers → calendar → quotations →
pipeline → costing), delivery (projects → plans → budget → purchase requests →
progress & billing) and aftermarket (installed base → contracts → PM schedule →
renewals → four report types → service costing). G-CHAIN carries 12 the same
way. Nothing tells a user that "Approved Plans" belongs to delivery and
"Renewals" does not.

The registry is the right place to fix this, because the registry drives the
menu (project rule 1). It needs one optional field.

### 2.6 `DataList` — the table that every screen uses

- Sortable `<th>` has no `aria-sort`, no `scope="col"`, and cannot be operated
  from the keyboard.
- The sort indicator is an appended `↑`/`↓`, so the column jumps width when you
  sort it.
- Re-loading after a filter change shows the **stale table with no indication
  anything is happening** — `loading && !data` means the spinner appears on
  first load only.
- The empty state cannot carry an action, so "Nothing here yet" is a dead end
  on every screen instead of offering the button that fixes it.
- Active filters are invisible once set and there is no way to clear them.
- Clickable rows are not keyboard reachable.

### 2.7 `Modal`, `Field`, `Empty`, toasts

- `Field` renders a bare `<label>` with no `htmlFor`, so clicking a label does
  nothing and screen readers do not announce the field name. Used on every form
  in the application.
- `Field` has no invalid state. Validation feedback only ever appears in a
  page-level `ErrorBox`, so on a long form the message is off-screen from the
  field it is about.
- `Modal` does not trap focus, does not move focus into itself, does not restore
  focus on close, has no `aria-labelledby`, and does not lock body scroll — so
  the page behind it scrolls under your cursor.
- Toasts have only `ok` and `error`, no dismiss control, and no `role="status"`,
  so they are never announced.

### 2.8 Responsive coverage is one breakpoint

Three `@media` rules, effectively one breakpoint at 860px. At 375px the topbar
still carries brand + module badge + Insights + Admin + search + bell + avatar +
a full-width "Sign out", and `.page-head` is a non-wrapping flex row, so titles
and their action buttons collide. `.btn-sm` is ~26px tall against a 44px touch
target guideline, and it is what the entire `DataList` toolbar is built from.

### 2.9 Dead CSS

`.division-grid`, `.division-card` and its four children, and `.hr-status` —
**zero** references in any `.tsx`. Left over from the pre-GIF landing page.
`.alert.warn` is defined 400 lines away from `.alert.ok`, in the G-HR section.

### 2.10 Does the UI follow the business?

Mostly yes, and this part needs care rather than change. The approval chain,
the four-state cost ledger, the revision lifecycle and the document numbering
are all represented honestly on screen. Two gaps worth closing with UI only:

- A document's **approval position is not visible at a glance** in lists. Status
  says `PENDING`, but not "waiting on HR, step 2 of 2", which is the thing the
  requester actually wants to know.
- **Empty states do not teach the workflow.** A user landing on Purchase
  Requests with nothing there is told "Nothing here yet" rather than being
  offered the action and told what the screen is for.

---

## 3. The plan

Ordered so that each step is verifiable on its own, and so the shared layers
come first — a fix in `styles.css` or `ui.tsx` reaches all 44 pages, and is a
far smaller risk than 44 edits.

### Step 1 — Finish the token layer (`styles.css`)

Add spacing (`--s-1`…`--s-8`, a 4px-based scale), type (`--fs-xs`…`--fs-2xl`),
elevation (`--shadow-sm|md|lg`) and focus (`--focus-ring`) tokens, and rewrite
the shared rules in terms of them. Raise `--faint` to meet 4.5:1.
*Why:* removes the 14-value spacing lottery at source and fixes 369 contrast
failures with one line.

### Step 2 — Focus, motion and dead weight (`styles.css`)

A global `:focus-visible` ring on every interactive element; a
`prefers-reduced-motion` block; delete `.division-*` and `.hr-status`; move
`.alert.warn` beside its siblings.
*Why:* keyboard operability is currently absent, and it is a stylesheet fix.

### Step 3 — Component states (`ui.tsx`)

`Field` gains `htmlFor` wiring, `required` and `error`; `Modal` gains a focus
trap, focus restore, `aria-labelledby` and scroll lock; `Empty` gains an
`action` slot; toasts gain `info`/`warn`, a dismiss control and `role="status"`.
Add the canonical `StatusBadge`, `statusTone()` and `humanise()`.
*Why:* every form and dialog in the application inherits it.

### Step 4 — Retire the nine duplicate tone helpers

Point the eight pages and `hr/Dashboard` at `StatusBadge`, keeping each page's
domain-specific cases as overrides rather than losing them.
*Why:* they have already drifted; the next one will drift further.

### Step 5 — `DataList`

`aria-sort` and keyboard-operable headers, a fixed-width sort indicator, a
refreshing state that does not lie, an active-filter count with Clear, an
`emptyAction`, keyboard-reachable rows, and a toolbar that survives 375px.
*Why:* it is the screen the business spends its day on.

### Step 6 — Navigation

Add an optional `group?: string` to `SubmoduleDef` and carry it through
`menuFor()`; group the sidebar and the mobile strip by it, in registry order,
with no grouping rendered when a module has none. Add a skip link. Make the
notification drawer keyboard-operable and dismissible.
*Why:* 23 flat items is the worst navigation problem in the app, and the
registry is where the menu is decided.
*Note:* additive only. No permission key changes, so `allPermissions()` is
byte-for-byte identical and the seed grants nothing new.

### Step 7 — Keyboard-reachable click targets

The seven `<div onClick>` / `<tr onClick>` cases.

### Step 8 — Verify

`npm run build` in `web/`, the 473 assertions in `api/scripts/verify-*.ts`, then
walk every major route in a browser at 1440, 768 and 375px, reading the console.

---

## 4. What this plan deliberately does not do

- **No redesign of the landing page.** Stated at the top, repeated here.
- **No new dependencies.** No Tailwind, no component library, no icon package.
  The stylesheet stays hand-written because that is what this codebase is.
- **No rewrite of the 44 page files.** Their markup is consistent with the class
  vocabulary; the vocabulary itself is what needed fixing. Pages are edited only
  where they duplicate a shared concern or break keyboard access.
- **No change to the dark neon identity.** Black, neon green, magenta, Orbitron
  for display and Inter for data. The goal is to apply it consistently, not to
  replace it.
- **No behavioural change to any workflow, approval path, calculation or route.**
