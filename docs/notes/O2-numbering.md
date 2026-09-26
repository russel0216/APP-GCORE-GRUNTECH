# O2 — numbering service and foundation tests

- `nextNumber(documentType, tx, ctx)` — the third argument is a `NumberContext`
  (`{ at?, ownerId?, employeeNo? }`), no longer a bare `Date`. No caller passed
  a Date, so nothing changed at the call sites.
- The template row is the `periodKey ''` row, looked up first. The unfiltered
  `findFirst` it replaces could return a year's counter row instead.
- `periodKey` is decided before any write: `2026`, `2026-09`, or `2026-09@007`
  for an OWNER counter. Counter rows are created flat by upsert so Prisma emits
  a native `INSERT … ON CONFLICT`.
- An OWNER counter whose pattern has no `{EMP}` is refused with a 400 before
  anything is written; the admin PUT validation should refuse it earlier.
- `{EMP}` is the last run of digits in the employee number padded to three;
  `000` for an unlinked author. `Employee.employeeNo` wins over `User.employeeNo`.
- `previewNext()` resolves the author whenever the caller names one, so a form
  can say "not linked to an employee" even on a GLOBAL pattern.
- `verify-foundation.ts` numbering cases use a throwaway `__verify___owner`
  type carrying the quotation's house scheme, so they do not depend on how the
  real quotation template is configured on a given database. The new document
  types are issued inside a rolled-back transaction.
