# O6 — employee routes and import split out of the masters files

- `api/src/routes/employees.ts` now owns every `/employees` handler, exporting
  `employeeRoutes`. `masters.ts` re-exports it so the existing mount in
  `index.ts` keeps resolving; the preferred mount imports it directly:
  `import { employeeRoutes } from './routes/employees';`
- `api/src/routes/imports/employees.ts` owns the employees CSV spec and writer,
  exporting `employeesImport: Registered`. `imports.ts` now exports the
  `Registered` interface so other modules (Academy's `courseImport`) can type
  their entry the same way and be wired into `REGISTRY` with one line.
- Behaviour changes carried in with the move (area-hr §6):
  - `EMPLOYMENT_TYPES` gains `TRAINEE` on both the route schema and the import.
  - `periodEndDate` (nullable date) is accepted on create/patch and by the
    import's `Period Ends` column. The schema comment says a TRAINEE should be
    required to carry one; the route does not enforce that yet — decide with
    the Employees screen work.
  - `DELETE /employees/:id` returns 409 when the employee has any clearance,
    evaluation, training record or attendance row — deactivate instead.
  - `GET /employees/lookup?q=&active=true` sits above `/:id`, guarded by
    `requireAny` of the five HR keys, and returns names and posts only
    (`hasUser` in place of the user id). `active` is a plain filter: `true`,
    `false`, or absent for everyone.
