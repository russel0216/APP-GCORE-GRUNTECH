# G-CORE user interface style

The style of Gruntech's G-CORE working screens (settled 2026-11-17), written so
another G-Core app can take it on. Give this file to the Claude Code session
working on that app and tell it to read it before touching a screen.

## 1. What to copy

| File | What it holds |
|---|---|
| `web/src/styles.css` | The tokens (spacing, type, heights, radii) and every shared rule |
| `web/src/styles/tabler.css` | The colours and the type system, scoped to `[data-theme='day']` |
| `web/src/styles/dress.css` | The shapes: sidebar, cards, buttons, tabs, the table head band |
| `web/src/components/DataList.tsx` | The one list screen: toolbar, filters, chips, cards, table, pager |
| `web/src/components/ui.tsx` | `StatusBadge`, `RecordHeader`, `ModalFoot`, `Field`, `formatMoney` … |
| `web/src/components/charts.tsx` | `Stat`, `BarList`, `Donut`, `Meter`, `Panel`, the summary cards |
| `web/src/components/Menu.tsx`, `Confirm.tsx`, `NumberInput.tsx` | ⋯ menu, the confirm bar, number boxes |

Import order in `main.tsx`: `styles.css` first, each module's own sheet after
it, and **`tabler.css` then `dress.css` LAST**. The root element carries
`data-theme="day"` on the working screens.

## 2. Colours

| Token | Value | Use |
|---|---|---|
| `--brand-purple` (`--magenta`) | `#A020EF` | What you ACT on: primary button, open tab, links, focus |
| `--brand-green` | `#13BA12` | FILLS only (bars, a solid OK badge) — 2.6:1 on white, never text |
| `--neon`, `--ok` | `#0C8A0B` | The green where it is TEXT (4.6:1) |
| `--bg` | `#F6F8FB` | Page (lavender-grey) |
| `--surface` | `#FFFFFF` | Cards |
| `--line` / `--line-soft` | `#E2E6EE` / `#EDF0F5` | Rules |
| `--text` / `--muted` / `--faint` | `#1F2937` / `#5B6678` / `#6F7A8C` | Text, labels, captions — `--faint` is the dimmest allowed |
| Table head band | `#3A1560` | Every `thead`, light capitals, rounded top corners |
| Sidebar | `--side-bg`, deep purple | Green edge on the open section |

`--danger`, `--warn`, `--info` carry tones; a status is always words too, never
colour alone.

## 3. Type

Inter everywhere (`--body`); Orbitron only on the wordmark.

- **Label** beside or over a value: 13px, 500, `--muted`, sentence case. Never type a label in capitals.
- **Header** over a group (table head, KPI label, nav group): 11px, 600, CAPITALS, 0.04em.
- **Caption**: 12px, `--faint`.
- Scale: `--fs-xs` 11 · `--fs-sm` 12 · `--fs-md` 13 · `--fs-base` 14 · `--fs-lg` 16 · `--fs-xl` 20 · `--fs-2xl` 24.
- Figures in tables right-aligned (`th.right`, `td.num`), tabular figures.

## 4. Sizes — always tokens, never a raw pixel in an inline style

- Spacing `--s-1`…`--s-8`: 4, 8, 12, 16, 20, 24, 32, 40. `--block-gap` 16 between every card, KPI row, toolbar and alert.
- Buttons: page `.btn` 35 tall (`--btn-h`); inside a card `.btn-sm` 29 (`--btn-h-sm`). Pill-shaped; primary is a purple gradient.
- Text box and select: 38 tall (`--field-h`), `--fs-md`.
- Table row: at least 56 (`--row-h`), cells padded 8 × 12, centred vertically; head 41.
- Radius 8 (cards), 6 (small). Cards: white, borderless, round, title on a ruled bar (`.card-head`).

## 5. The list screen (every list looks like this)

```
[+ New …]  [search………]  [Mine · Team · All]  [Filters] [chip ✕][chip ✕]    [Print] [⋯]
┌ stat ┐┌ stat ┐┌ stat ┐┌ stat ┐   ← summary cards, centred, figure at one height, icon in the corner
│ TABLE — purple head band, ruled striped rows, hover tint, PDF column last   │
pager
```

- **No big title on a list.** Keep `<h1 className="visually-hidden">` for screen readers. No paragraph under it.
- **"+ New …" first** on the toolbar, `btn btn-primary btn-sm`. Only one primary.
- **Print visible at the right, then ⋯** (Columns, Save view, Refresh, the screen's own tools). **No Export CSV.**
  In DataList: `printButton` and `exportable={false}`.
- A view switch (List / Cards, List / Month) goes in `actions`, after the New button.
- Filters open in a panel and show as removable chips on the toolbar line.
- No tab strip and no totals row: what a tab filtered is a Filters select; totals are summary cards.
- A page that is not a DataList puts its New button in `<div className="list-toolbar">`.
- **Settings pages and dashboards keep their title.**

## 6. The record page

`RecordHeader`: KIND • NUMBER, status pill, title, one meta line, the amount —
buttons always **[next steps…] [Print] [⋯] [Modify]**, exactly one primary,
Modify right-most, destructive items last in ⋯ in red. Back is drawn by the
shell ("← Back to …"), never by the page. Read-only facts are
`<dl className="kv">` (label column beside the value).

## 7. Forms and dialogs

- A page editor: labels BESIDE values, Save top-right and again at the foot.
- A modal: labels above, footer `ModalFoot` — [Delete] … [Cancel] [Save].
- Nothing destructive without asking, and asking is one confirm bar under the header (`useConfirm`), never `window.confirm`.
- Every number box is `NumberInput` (commas, never `type="number"`).
- Words: "+ New …", "Modify", "Save", "Cancel", "Print", "Delete", "Submit for approval".

## 8. Charts

Only `components/charts.tsx`. Every series shows its own number (readable without
colour); an empty series says "nothing yet".

## 9. Accessibility

Everything clickable is a `<button>` or `<Link>` (never `<div onClick>`);
`:focus-visible` stays; contrast at least 4.5:1 for text.

## Prompt for the new session

> Read docs/UI-STYLE.md. The stylesheets and shared components listed in §1 are
> copied into web/src. Apply this style to every screen: lists per §5, record
> pages per §6, forms per §7. Use the tokens, never raw pixel values.
