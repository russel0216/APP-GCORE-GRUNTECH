# Settings snapshot

The administrators' settings live in the live server's database, not in the
code: Appearance & Layout (card positions, spacing, colours), Admin › PDF
Templates, Company / Finance / HR settings, pipeline stages, roles and their
permissions, who holds which role, approval workflows and numbering patterns.
A push never carries them — and must never overwrite them.

To bring the server's settings into the repository:

1. On the server, in `C:\G-CORE-GRUNTECH\api`:
   `npx tsx scripts/export-settings.ts` — read-only; writes
   `data\settings-snapshot.json`. **Do not commit it on the server**: the
   auto-deploy pulls fast-forward only, and a commit made there stops every
   later deploy.
2. Copy that file off the server and put it here as `snapshot.json`
   (or hand it to whoever maintains the repository), then commit and push.

To apply it to another database (a laptop, a fresh install):

    cd api
    npx tsx scripts/import-settings.ts              # says what would change
    npx tsx scripts/import-settings.ts --apply      # changes it

It never creates or deletes a login, touches a password, moves a numbering
counter, deletes a role or workflow, or removes a step anybody signed.
