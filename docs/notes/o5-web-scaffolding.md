# O5 — web routes, stubs, shared components and CSS scaffolding

What this package laid down for the fan-out packages, and the contracts they
build against.

## Routes (web/src/App.tsx)

- `/g-ops/partners`, `/g-ops/partners/:id` — `gops.partners.view_all`.
- `/g-ops/purchase-requests/:id` — same four-permission `GuardAny` as the
  list; `/g-chain/purchase-requests/:id` widened to the same four keys.
- `/g-hr/leave/:id` — leave view_all/view_own, renders `Leave`.
- `/g-hr/plantilla`, `/g-hr/clearances(/:id)`, `/g-hr/meetings(/:id)`,
  `/g-hr/evaluations(/:id)`, `/g-hr/academy/{courses,calendar,sessions(/:id),
  passport,passports(/:employeeId)}` — guards per area-hr §6, all before the
  `/g-hr/*` catch-all.
- `/g-fin/cash-advances(/:id)` — `gfin.cash_advances` view_all/view_own.
- `/g-ops/job-orders(/:id)` — `gops.job_orders` view_all/view_own.
- `/g-ops/visits` now renders `ServiceSchedule` (bridges to `PmSchedule`
  until SVC replaces it).
- `/admin/templates` renders `ReportTemplates` under `admin.templates.view_all`.

## Stubs

Every stub exports exactly the names App.tsx imports and renders
`ComingSoon`. Until SHELL fixes `Misc.tsx` to read `useLocation().pathname`,
a stub at a concrete route prints "Not built yet" — expected.

## Shared components

- `PeoplePicker` — pure UI over `{ id, name, sub?, group? }[]`.
- `MeetLink` — Join/Copy/Create-in-Google/paste box; `onSave(googleUrl)`.
- `SettingListCard` — `GET/PUT /hr-settings/lists/:key`. Reads `{ rows }` or
  a bare array, sends `{ rows }`. If the orchestrator's route answers a
  different shape, change `SettingListCard.tsx` in one place.
- `RecordHeader` — `statusExtra` forwarded to `StatusBadge`.
- `Icon` — `'book'` glyph; `SECTION_ICONS.Academy = 'book'`.
- `lib/api.ts` — `openPdf(path, onError)` takes the FULL `/api/...` path
  (as its two former copies did); `downloadBlob(path, filename)` takes an
  API-relative path like every `api.*` call.
- `lib/links.ts` — `recordLink(entityType, id)`; null for types with no
  screen of their own (`partner_resource`, `training_record`,
  `training_certification`).

## CSS

`styles.css` gained `.people-picker`, `.meet-link`, the `.cal-item` button
reset and token font sizes in `.cal-head`/`.cal-item`. One stylesheet per
package lives under `web/src/styles/` and is imported from `main.tsx` after
`styles.css`; `calendar.css` seeds the `.mcal-*` grid and the week-view
corrections, `pipeline.css` seeds the board states. Class names in the two
seeded files are the contract for P5 and P3; the rest are one-line headers.
