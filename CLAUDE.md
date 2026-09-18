# G-CORE — notes for AI agents

Integrated business operations platform for Gruntechnology Corp
(`gruntech.gcore.tech`). Node + Express + TypeScript + Prisma + PostgreSQL API,
React + Vite + TypeScript web app, one database.

## Read first

`docs/BUSINESS-OPERATIONS-MODEL.md` is the specification, not background
reading. Before adding a table, screen, form or workflow, check whether an
existing business entity already carries the concept (model §2.9). The whole
point of this rebuild is that the previous implementation was four apps with
four databases and four copies of "customer".

## The rules that are easy to break

1. **The permission registry drives the menu.** `api/src/permissions/registry.ts`
   generates both the `Permission` rows and the navigation. Adding a screen means
   adding a registry entry — never hard-code a menu item, and never check a
   permission string that the registry does not define.
2. **Never invent a second approval path.** Every document type routes through
   `api/src/shared/approvals.ts`. Call `submitForApproval(...)`, subscribe with
   `onApprovalSettled(...)`. Do not write per-module routing, notification or
   history.
3. **A requester can never approve their own document.** Enforced in `act()`,
   before the eligibility check, and for super admins too.
4. **Cost posts only when every step has approved.** Overtime is the live
   example: supervisor *and* HR. Subscribe to the settled event; never post on an
   intermediate approval.
5. **Numbers come from `nextNumber(documentType, tx)`.** Never format a document
   number by hand. Pass the caller's transaction so a rollback does not burn a
   number.
6. **Every printable document goes through `renderDocument(...)`.** Uniform PDFs
   across all menus is an explicit requirement. A module supplies sections; it
   never draws a header, signature block or page number.
7. **Record ownership is real.** Use `canEditRecord(user, module, sub, ownerId)`.
   "Only the author can edit the quotation, super admin can edit all."
8. **Audit through `audit(...)`**, and keep `redact()` in front of anything
   holding a password hash or a cost rate.
9. **Every list screen uses `web/src/components/DataList.tsx`.** Same toolbar,
   same scope switch, same export, everywhere.
10. **Money is `Decimal` in Prisma**, converted with `Number()` only at the API
    boundary. Never do arithmetic on a float and store it back.

## Verification

```bash
cd api && npx tsx scripts/verify-foundation.ts
```

40 assertions across permission resolution, numbering concurrency, the approval
engine, the overtime two-step rule, amount bands, the audit trail and the PDF
engine. It creates its own users and cleans up. Run it after touching anything in
`api/src/shared/` or `api/src/permissions/`. Add cases when you add a shared
service — the services have no click-path to test them, which is exactly why this
script exists.

## Local development

```bash
docker compose up -d
```

Postgres is on host port **5433**, not 5432, so it cannot collide with an
existing local install. Then `cd api && npm run dev` and `cd web && npm run dev`.

Seeded admin: `admin@gruntech.com` / `ChangeMe!2026`.

Re-running `npm run seed` is safe. It refreshes permissions from the registry and
removes stale ones, but **does not** overwrite role permissions that already
exist — those belong to the customer once set.

## Decided, do not relitigate

- **Single tenant.** Gruntech only. Gas Ion keeps its own deployment. Company
  details still live in Settings because configurable PDF branding is a stated
  requirement — that is not tenancy work.
- **G-FIN is operations-driven only** — AR, AP, expenses, payments, cash flow,
  budget vs actual. No general ledger, payroll, fixed assets or tax filing.
- **Billing is VAT 12% + EWT 2%**, rates configurable. Downpayment recoupment and
  retention are deferred, with nullable columns reserved on `Job` and
  `ProgressBilling` so either can be switched on without migrating history.
- **EWT is withheld at source.** Invoiced ≠ collectible. A/R aging must never
  report withheld EWT as overdue.

## Deployment — the hard constraint

The production server is **shared with a safety-critical system**
(`gasion-vision`, live hospital oxygen-plant monitoring). Careless restarts have
taken it down three times.

- **Never** kill Node by image name (`taskkill /F /IM node.exe`,
  `Get-Process node | Stop-Process`). A `//FI "WINDOWTITLE eq ..."` filter does
  not make it safe — background processes have no window title, so the filter
  matches nothing and any `||` fallback runs the unfiltered kill.
- **Never** stop or reconfigure the `Cloudflared` Windows service.
- **Never** run `pm2 kill` / `pm2 delete all` / `pm2 startup` on that host.
- Restart only by PID, by port, or via G-Core's own service entry.

In production the API serves `web/dist`, so there is one origin and one tunnel.

## Known advisory

`npm audit` flags `deepmerge-ts` (high) reached through the Prisma **CLI**'s
config loader — a dev-time dependency that only parses our own schema, not in the
server's runtime path. Prisma 7 drops it but adds an unused `mysql2` advisory, so
the tree is pinned to Prisma 6.19.3. Re-evaluate when Prisma 7 stabilises.

## Build order

Phase 1 (foundation) is done. Next is Phase 2 (masters: customers, contacts,
sites, suppliers, employees, items), then Phase 3 (sales). Full sequence with
acceptance criteria in `docs/BUSINESS-OPERATIONS-MODEL.md` §11. Screens from
later phases already appear in the menu tagged with their phase and are
permission-configurable — that is deliberate, not a stub left behind.
