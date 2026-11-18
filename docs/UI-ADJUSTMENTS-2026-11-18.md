# UI adjustments of 2026-11-18 — summary for another G-Core

What changed in Gruntech's G-CORE in commit `4f2aebf`, written so the same
adjustments can be made in Gas Ion Tech's G-Core. Read it together with
`docs/UI-STYLE.md` (colours, type, sizes).

## 1. One layout for every list screen

Applied to Sales, Project Management, Aftermarket, G-CHAIN, G-FIN, G-HR and Admin.

| Before | After |
|---|---|
| A big title over every list | No visible title. Keep `<h1 className="visually-hidden">` for screen readers |
| A paragraph under the title | Removed |
| "+ New …" in the page head, top right | First thing on the toolbar line, `btn btn-primary btn-sm` |
| Print and Export CSV inside the ⋯ menu | **Print** is a visible button at the right, then ⋯. **No Export CSV** |
| A List / Cards or List / Month switch in the page head | On the toolbar, right after the New button |
| Stat cards left-aligned | Centred, figure at one height, icon in the corner |

The toolbar line reads:

```
[+ New …] [search] [Mine · Team · All] [Filters] [chips…]          [Print] [⋯]
```

Rules that go with it:

- A page that is not a list component puts its New button in
  `<div className="list-toolbar">`.
- **Settings pages, dashboards and every overview keep their big title**
  (G-OPS Overview, G-CHAIN Overview, G-FIN Overview, Aftermarket Overview,
  HR Dashboard, Company Settings, Numbering, PDF Templates …).
- The Projects list no longer shows a row of links to registers that are
  already tabs inside a project.

In this codebase the list component is `web/src/components/DataList.tsx`; the
two props are `printButton` and `exportable={false}`.

## 2. Pickers you type in

Wherever a form picks a RECORD, the plain dropdown became a box you type in.

- Click it to see the whole list; type to narrow it (capitals and extra spaces
  ignored); arrow keys and Enter pick; Escape puts the earlier choice back.
- Used for: people, projects, warehouses, sales orders, quotations, costings,
  sites, contacts, machines, contracts, courses, employees, candidates,
  positions, roles, sub-industries, invoices, office budget lines.
- **Left as ordinary dropdowns:** short fixed lists — status, type, year,
  currency, tax, team, budget line.
- Fields that take several answers stay tick-box lists.

The component is `web/src/components/SearchSelect.tsx`. It is a drop-in for a
native `<select>`: the same `<option>` / `<optgroup>` children, the same
`value`, and `onChange` receives `{ target: { value } }`, so existing handlers
work unchanged. Converting a dropdown is renaming the tag and adding the
import. The person picker (`PersonSelect` in `components/People.tsx`) renders
through it, which converted every person field at once.

## 3. "+ New …" in a popup, when nothing matches

If the record is not on the list, the list ends with "+ New …". It opens the
record's own full New form as a popup over the page, with the typed name
already filled in. On Save the new record is picked and the person stays on
the page they were on.

| Picker | Where | Opens |
|---|---|---|
| Customer | every customer picker | the full New customer form |
| Supplier | every supplier picker | the full New supplier form |
| Warehouse | purchase request, purchase order, Incoming, Outgoing, pull-out slip, borrow slip | the New warehouse form |
| Contact person | activity form, job order, Service JO (once a customer is chosen) | the New contact form |
| Item | purchase request and purchase order lines | the New item form |

- The line shows only to someone allowed to create that kind of record.
- Not offered where it makes no sense: lines that list only what a shelf
  holds, and Incoming lines (a typed item is filed at save there).
- Projects, quotations and sales orders have no popup — their New forms are
  full pages.

Files: `web/src/components/CreatePopup.tsx` (the popup, lazy-loaded),
`CustomerPicker.tsx`, `SupplierPicker.tsx`. Each New form gained a
`presetName` prop and reports what it saved (`onSaved(id, name)`).

## 4. Files to copy or mirror

| File | What it is |
|---|---|
| `web/src/components/SearchSelect.tsx` | The select you type in |
| `web/src/components/CreatePopup.tsx` | "+ New …" popup for warehouse, contact, item |
| `web/src/components/CustomerPicker.tsx`, `SupplierPicker.tsx` | Pickers that open the full New form |
| `web/src/components/People.tsx` | `PersonSelect` on `SearchSelect` |
| `web/src/components/DataList.tsx` | `printButton`, `exportable`, the toolbar order |
| `web/src/styles.css` (end of file) | `.search-select` rules; `.list-toolbar` |
| `web/src/styles/tabler.css`, `dress.css` | The dress (see `docs/UI-STYLE.md`) |
| `api/src/shared/listLayoutNudges.ts` | One-time removal of saved layout nudges made for the old layout — only needed if the other app has the Modify-layout feature |

`CreatePopup.tsx` imports this app's own forms (`pages/masters/Customers`,
`Suppliers`, `Items`, `Reference`, `Customer360`). In another app, point those
imports at that app's New forms.

## 5. Status

- Type-checks pass. The pickers and popups were not checked in a browser
  before the push — test a purchase request form first.
- Known thing to look for: inside a line table that scrolls sideways, the
  suggestion list may be cut off at the table edge.

## Prompt for the Claude Code session on the other G-Core

> Read docs/UI-STYLE.md and docs/UI-ADJUSTMENTS-2026-11-18.md. Apply the same
> adjustments here: (1) the list layout of section 1 on every list screen,
> keeping titles on overviews, dashboards and settings pages; (2) replace the
> record dropdowns in forms with SearchSelect, leaving short fixed lists as
> they are; (3) add "+ New …" popups for customer, supplier, warehouse,
> contact and item, pointing CreatePopup at this app's own New forms. Work one
> module at a time on localhost and do not commit until I say so.
