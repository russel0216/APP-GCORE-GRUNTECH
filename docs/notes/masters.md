# Masters package (P2) — notes worth carrying forward

Items 4 (customers by industry) and 10 (Partners), item 6's customer
`next-code`, Customer 360 completion, Supplier 360, and DataList's URL state.
Verify: `npx tsx scripts/verify-masters.ts` (54, Prisma-only) and
`npx tsx scripts/verify-partners.ts` (82, needs the API running — it fails
loudly rather than skipping the HTTP half).

## Industry

- **Industry is a reference row, not free text and not an enum.** Same shape as
  `CostCategory`: the five seeded rows (HI, BI, UI, GI, SI) are `isSystem`,
  cannot be deleted and cannot be recoded (reports group by the code); labels
  are editable and an administrator may add more under Admin › Categories
  (`admin.categories.*`). A non-system industry that customers carry refuses
  delete — deactivate it instead. `onDelete: Restrict` is only the backstop;
  keep the route check.
- **Required on every new customer, never nullable through the API.** Zod has
  `industryId: z.string().min(1)`; `.partial()` makes it optional on PATCH, and
  it is deliberately not `.nullable()`, so a classified customer can never be
  unclassified again. Both POST and PATCH refuse an inactive industry. The DB
  column stays nullable only for rows from before the list existed; the list
  filter `industry=none` ("Unclassified") is how they are found.
- **Reclassifying never regenerates the customer code.** Identifiers do not move
  under the quotations and invoices that print them; the audit row records it.
  The industry is NOT in the customer code (that was cut; an `{INDUSTRY}` token
  would be a separate decision).
- `GET /reference/industries[?active=true]` is readable by any signed-in user —
  the customer form and the lead quick-add need it under `gops.customers.*` /
  `gops.leads.*` alone. Writes are `admin.categories.*`.
- The customer CSV import's Industry column is required and matches the code
  or the full name, case-insensitive; the error lists every active code.
- A lead's industry is its customer's. Unlinked leads report as Unclassified;
  do not add `industryId` to Lead (a second copy that would drift).

## Partners

- **A partner IS a supplier with `isPartner`.** Item.preferredSupplierId,
  canvasses, POs, bills and payments already point at Supplier; a Partner table
  would be the same company twice. Partner codes are supplier codes
  (`nextNumber('supplier')`) — there is no `partner` document type.
- **One owner for the flag.** `isPartner` is set and cleared only through
  `/api/partners` (`gops.partners.create` / `.delete`), never by
  `PATCH /suppliers/:id` — so "who made this a partner" is auditable in one
  place. Procurement may still correct `brand` and `partnerSince`.
- **Removing a partner keeps the supplier and its resources**; re-flagging
  brings them back. Resource-level Delete is the purge. `DELETE /suppliers/:id`
  refuses while `isPartner` is true, because the cascade would drop catalogues
  that G-CHAIN never shows.
- **Resources** (`PartnerResource`) are metadata — kind, title, validity — over
  EITHER one file in the one attachment service (`entityType
  'partner_resource'`, `entityId` = the resource id) OR an http(s) link, or both.
  One file per resource; a new upload replaces the old. The route refuses a
  resource with neither.
- **Links are http(s) only** — `safeHttpUrl()` on the server, and the client only
  ever turns an http(s) string into an `href`. That is what keeps `javascript:`
  out of a link a salesperson clicks. Do not relax it for "convenience" schemes.
- **The price list is prices, never costs.** `Item.listPrice` (+ currency and
  as-of date) is a PRICE a salesperson may see; `standardCost`/`lastCost` stay
  behind `gchain.items`. `partnerPriceList()` uses a strict `select` — never
  `include` — and verify-partners asserts the bytes of
  `GET /partners/:id/price-list` contain neither cost field. Switching it to
  `include` reintroduces the leak.
- The price list is "items whose preferred supplier is this partner". An item
  two partners both price can sit under only one; a per-supplier price table is
  the follow-up if that ever matters (deliberately not built: a second place an
  item's price lives).
- The items import matches Preferred Supplier on name OR brand, and REFUSES a
  value matching more than one supplier (a principal and its distributor
  sharing a brand) rather than picking one silently.
- The partner CSV import (`partners`, `gops.partners.create`) flags an existing
  supplier matched by name or brand, else creates one; link columns upsert one
  resource per kind by title, so a re-import never duplicates.
- Search: `partner` and `partner_resource` providers behind
  `gops.partners.view_all`; a removed partner's resources are not findable.
- Known, not fixed here: the generic attachment routes (`workspace.ts`) do not
  gate by entity type, so anyone signed in who knows an attachment id can fetch
  a dealer price-list PDF. Partner routes gate the listing, not the bytes.

## Customer 360 and Supplier 360

- **A window onto the modules, never a way around them.** Every collection is
  loaded only when the caller holds the list permission of the screen it comes
  from, and arrives as `[]` otherwise: leads (`gops.leads.view_all`, or
  `view_own` → only leads assigned to the caller), installed base
  (`gops.installed_base.view_all`), service reports (any of the three report
  `view_all` keys), payments (`gfin.payments.view_all` or `gfin.ar.view_all`),
  job orders (`gops.job_orders.view_all`); on the supplier page POs
  (`gchain.purchase_orders.view_all`), receiving (`gchain.receiving.view_all`),
  bills (`gfin.ap.view_all`), payments (`gfin.payments.view_all` or
  `gfin.ap.view_all`). `take: 50`, `Number()` at the boundary. Add a new
  collection the same way — never unconditionally.
- Leads ARE the opportunities; `opportunities`/`documents` stubs are gone.
- The 360 header's handoffs link to `?new=1&customerId=<id>` on Leads,
  Quotations, Costing and Job Orders; each owning screen reads its own params.
- The activity log on the customer page is `ActivityLog customerId=…`, shown
  only with `gops.calendar.view_all` (the `/activities` guard). The audit trail
  is demoted to "History".
- `/g-chain/items/:id` opens that item (it used to render the bare list).

## DataList state lives in the URL

- `?q=`, `?scope=`, `?page=` and `?<key>=` for every key the screen DECLARES in
  `filters` are read on mount and written back with `replace`. Undeclared keys
  (`new`, `customerId`, `visit`, `payment`, `tab`…) are preserved untouched, so
  a list never eats another screen's deep-link parameter. The API query still
  uses `search=`; only the browser URL says `q=`.
- URL wins over `initialFilters`; a value EQUAL to the route preset is not
  written, so a preset menu entry keeps the path the registry declares.
- A link to `/g-fin/ar?overdue=true` is only true if that DataList declares an
  `overdue` filter. Link authors: link to declared keys only.
- A page that mounts two DataLists at once passes `urlState={false}` on one of
  them, or they share `?page=`.
- `openAttachment({ id, fileName, mimeType })` in `components/Attachments.tsx`
  is the one way to open a stored file outside the Attachments card (bearer
  token → blob); do not write a second copy.
