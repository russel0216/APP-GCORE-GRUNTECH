# docs/notes — what is still here, and why

The Phase 10 package hand-off notes that used to live here (one per area:
academy, calendar, costing, delivery, evaluations, finance, HR audit,
insights, masters, meetings, numbering, plantilla, procurement, sales board,
service, workspace, and the O-series stage notes) were merged into
`docs/BUSINESS-OPERATIONS-MODEL.md` (§4, §5.1, §7–§10, §13–§14) and `CLAUDE.md`
("Phase 10 notes worth carrying forward") on 2026-09-27, and removed on
2026-10-10 once nothing cited them. Read those two; a rule that lives only in
a note is a rule nobody follows.

Seven notes remain because `CLAUDE.md` points at them for detail it does not
repeat:

| Note | What it holds | Cited from |
|---|---|---|
| `S-scoro-schema.md` | The SCORO continuation's groundwork: schema, registry, seed and route stubs (key S) | CLAUDE.md "SCORO migration notes" |
| `C-company-letterhead.md` | Company details, the author's phone, the PDF letterhead and footer (key C) | CLAUDE.md "SCORO migration notes" |
| `Q-scoro-quotations.md` | SCORO-style quotation lines: groups, titles, discount, terms, cost per line (key Q) | CLAUDE.md "SCORO migration notes" |
| `A-scoro-archive.md` | The read-only SCORO archive: import, numbering continuation, "Continue in G-CORE" (key A) | CLAUDE.md "SCORO migration notes" |
| `R-scoro-review.md` | What the 2026-09-27 integration review changed after C, Q and A landed (key R) | CLAUDE.md "SCORO migration notes" |
| `day-boundaries.md` | The 2026-10-02 audit of where "today" was still the UTC date, group by group, and what each fix did | CLAUDE.md "Shared seams" |
| `quotation-editor.md` | Why the quotation editor is a page, not a dialog, and how one save is one transaction | CLAUDE.md "SCORO migration notes" |

The workstation-side SCORO converters these notes describe are in
`tools/scoro/` (its own README). Line numbers inside a note are as they were
on the day it was written; the files have moved on since.

Add a note here only when `CLAUDE.md` will cite it. Otherwise put the rule in
`CLAUDE.md` or the model doc, where it will be read.
