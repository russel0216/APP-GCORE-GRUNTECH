# Plan — contact person on the quotation, memory in every box, Attention with number and email (2026-10-12)

The owner's words: "on the quotation creation, allow to add contact person.
if it's not on the database allow also add just like on the attached
picture, if customer can't find in the database. In all of the input, even
description allow memory suggestion of previous input. Show also the contact
person information in the attention of quotation. number and email."

The picture: the New quotation editor, "CAGA" typed in Customer, the
dropdown offering *add "CAGA" as a new customer* — `CustomerPicker`'s
quick-add.

Status: **built 2026-10-12**, on the defaults below. One change from the
plan: the number line reads `{{contact.mobile}}` (mobile, else phone — a new
field) so "Mobile:" names what it prints; `{{contact.phone}}` keeps its
meaning (phone, else mobile). The 409 is pinned in verify-sales over HTTP,
not verify-masters.

## What is there today

- `CustomerContact` (name, position, email, phone, mobile, isPrimary, notes)
  under each customer. `POST /customers/:id/contacts` exists
  (`routes/customers.ts` ~731), behind `gops.customers.edit_all`, audited as
  `customer` UPDATED "Added contact …". The **sales role holds it** (it is
  granted all of `gops.customers`, preset `SHARED`).
- The editors pick a contact with `ContactSelect` (`pages/sales/
  editorParts.tsx` 371): a plain `<select>` of the customer's contacts, and
  **nothing at all when the customer has none** — so a new customer added
  from the picker can never get an Attention line from the editor.
  Used by the quotation editor (two places: create and the Modify page's
  details editor) and the sales order editor.
- Memory suggestions exist only on the line's product: Brand and Product
  type (`GET /quotations/suggest/fields?field=brand|productType`) and Part
  number (`GET /quotations/suggest`, which also fills description, unit and
  price on a pick). Every other box — quote name, delivery, payment terms,
  terms & conditions, the line description, the unit — remembers nothing.
- The PDF fields `contact.email` and `contact.phone` (phone, else mobile)
  are already in the quotation's field catalogue, but the standard layout's
  customer box prints only `Attention: {{contact.nameAndPosition}}`
  (`shared/quotationTemplate.ts` 184; the sales order's
  `shared/salesOrderTemplate.ts` 218 the same).

## 1. Contact person: pick, or add "X" as a new contact

**`ContactPicker`** (`components/ContactPicker.tsx`, a `fieldControl` like
`CustomerPicker`, rule 20) replaces `ContactSelect` in all three places.

- A text box. Focused or typed into, it lists the customer's contacts that
  match (name, position, mobile under it), keyboard as `CustomerPicker`
  (ArrowDown / Enter / Escape, `aria-activedescendant`). Picking one sets
  `contactId`. "— none —" clears it.
- When what is typed matches no contact exactly (case-blind, spaces
  collapsed), the last row offers **add "X" as a new contact** — to a
  `gops.customers.edit_all` holder only, as the customer quick-add is to a
  `create` holder. Choosing it opens a small panel **in the page, under the
  box** (the quotation module has no dialogs): Name (the typed text),
  Position, Mobile, Email — the last two because they are exactly what the
  Attention line will print — then **Add contact** / Cancel. It posts the
  ordinary `POST /customers/:id/contacts` and selects the new contact.
- With no customer chosen the box is disabled ("Choose the customer
  first"). With a customer that has no contacts the box still shows, so a
  customer just added through "add as a new customer" can take its first
  contact straight away.
- Under the box, once a contact is chosen, one faint line says what will
  print: `0917 555 0142 · juan@sample.ph` (or "No number or email on file —
  the Attention line will print the name only").
- `allowCreate={false}` where a form should not file contacts (none of the
  three today).

**Server**: `POST /customers/:id/contacts` refuses a contact whose name
(trimmed, single-spaced, case-blind) the customer already has — 409 "Juan
Dela Cruz is already a contact of CAGA — pick them from the list" — so a
double click or two people at once cannot file the same person twice. The
same check guards the Customers page's own Add contact.

## 2. Memory in every box

One endpoint, one component.

**`GET /quotations/suggest/fields?field=&q=`** grows from two fields to a
whitelist (anything else a 400 naming the choices, `choice()`):

| field | where it reads | narrowed by |
|---|---|---|
| `brand`, `productType` | as today | `brand` for a type |
| `subject` (quote name) | `Quotation.subject` | — |
| `delivery`, `paymentTerms` | `Quotation` | — |
| `terms` (terms & conditions) | `QuotationRevision.terms` | — |
| `description` | `QuotationItem.description` (priced lines) | the line's `brand`, `productType`, `partNumber` when typed — that product's descriptions first, then any |
| `unit` | `QuotationItem.unit` | — |
| `lostReason` | `Quotation.lostReason` | — |

Same rules as today's two: only from quotations the caller may read (their
own without `gops.quotations.view_all`), values only (never a figure, never
a cost), deduplicated case-blind and space-blind, **newest first** (the
order a person remembers; today's alphabetical order stays for Brand and
Product type), 20 at most, a long text sent whole with the list showing its
first line. Declared above `/:id`, as today.

The sales order editor gets the same through **`GET /sales-orders/suggest/
fields`** for its own boxes (`comment`, `paymentMethod`, the line
`description` and `unit`), reading sales orders AND quotation lines (an
order's lines come from quotations), under the order list's visibility.

**`MemoryInput` / `MemoryTextarea`** (`components/MemoryInput.tsx`, both
`fieldControl`s) generalise the dropdown `ProductCells` already draws:
debounced fetch (200 ms) as the person types two characters or more, the
list under the box, ArrowDown to enter it, Enter to take, Escape to close,
a pick REPLACES the box's text (and is still editable). A textarea's list
opens on typing or on Alt+ArrowDown, and shows each text's first line with
the rest in its title. The browser's own autocomplete stays off on them.
`ProductCells`' Brand and Product type move onto it, so there is one
dropdown in the app, not two. Part number keeps its own (a pick fills the
whole line).

Boxes that take it — quotation editor: Quote name, Delivery, Payment terms,
Terms & conditions, and per line Description and Unit; the Modify page's
details editor: Quote name; Lost reason in the confirm bar. Sales order
editor: Comment, Payment method, line Description and Unit. Not taken:
numbers, dates, money, PR number and PO number (one per document —
suggesting another's is a mistake waiting to happen).

## 3. Attention: name, number and email on the paper

The standard quotation layout's customer box becomes:

```
**{{customer.name}}**
{{customer.address}}
{{customer.phone}}
Attention: {{contact.nameAndPosition}}
Mobile: {{contact.phone}} | Email: {{contact.email}}
```

`resolveTemplate` drops a part whose field is empty and a line whose parts
all went, so a contact with no email prints only the number, and no contact
prints neither line. The box's height grows by one line (47 → 59); a
`first` box that grows pushes the line table down, so nothing collides.
`contact.phone` keeps its meaning (phone, else mobile); the label reads
"Mobile" because that is what a sales contact gives. The sales order's
standard customer box takes the same line. `{{contact.mobile}}` is added to
the catalogue for a layout that wants both numbers.

**A layout an administrator saved keeps its own boxes** (the rule of every
layout change): Admin › PDF Templates › "Put the standard back", or add
`{{contact.phone}}` / `{{contact.email}}` to the customer box by hand — both
fields are already listed there. The seed never edits a saved layout.

## Verify

- **verify-sales**: the standard quotation PDF of a quotation whose contact
  has a mobile and an email prints both on the line under Attention; with
  no email only "Mobile: …"; with no contact neither line; the sales order
  paper the same. `/suggest/fields` for each new field returns the
  caller's own text and, for a `view_own` caller, never another author's;
  an unknown field is a 400; descriptions under a typed brand come first;
  newest first; case-blind dedupe.
- **verify-masters** (customers): a second contact of the same name on one
  customer is a 409, the first still created and audited.
- **verify-foundation**: none needed beyond the template field catalogue
  (`unknownFields()` accepts `contact.mobile`).
- Browser: type a new customer, add it, type a contact name, add it with a
  mobile and email, save, print — the Attention line shows both.

## Questions, with the defaults the build takes

1. **Who may add a contact from the editor?** Default: holders of
   `gops.customers.edit_all` — the right the Customers page already asks;
   sales hold it. (Alternative: anyone who may write a quotation.)
2. **Ask number and email when adding?** Default: yes, both optional, in
   the panel under the box.
3. **Whose earlier texts are suggested?** Default: every quotation the
   person may read (sales read all quotations, so the whole team's
   wording); only their own for a `view_own`-only reader.
4. **The sales order too?** Default: yes — the same contact picker, the
   same memory boxes, the same Attention line.
5. **The label on paper** — "Mobile: … | Email: …". Default as written;
   "Tel:" if the owner prefers.

## Effort (Opus 5.5)

Medium — one push, about two to three hours of agent time:
`ContactPicker` + the duplicate guard (~40 min), the suggest endpoints and
`MemoryInput` across both editors (~70 min), the two layouts and the field
(~15 min), verify cases, CLAUDE.md, a browser check (~40 min). No schema
change, no migration, no new permission key.
