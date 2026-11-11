import type { OfficeBudgetOption } from './OfficeLine';

/**
 * WHERE ONE LINE IS CHARGED (2026-11-11, the owner's call: a credit card's
 * statement of account spread over several projects and the office). The
 * reimbursement's receipts and the budget request's items each take a place
 * — a project and its budget line, or an office budget line — defaulting to
 * the document's own ("Charge to"), changed line by line. The API keeps the
 * document whole when every line lands in one place (`collapse()` in
 * api/src/shared/lineCharges.ts), so the page always sends each line's place.
 */

export interface LineCharge {
  jobId: string;
  costCategoryId: string;
  officeBudgetLineId: string;
}

export const NO_CHARGE: LineCharge = { jobId: '', costCategoryId: '', officeBudgetLineId: '' };

export const chargeKey = (c: LineCharge) => (c.officeBudgetLineId ? `o:${c.officeBudgetLineId}` : c.jobId ? `p:${c.jobId}:${c.costCategoryId}` : 'none');

/** The place as the API takes it: nulls, never empty strings. */
export const chargeBody = (c: LineCharge) => ({
  jobId: c.jobId || null,
  costCategoryId: c.jobId ? c.costCategoryId || null : null,
  officeBudgetLineId: c.jobId ? null : c.officeBudgetLineId || null,
});

/** A line's own place, as the API sent it back. */
export function chargeOf(l: { job?: { id: string } | null; costCategory?: { id: string } | null; officeBudgetLine?: { id: string } | null }): LineCharge {
  return { jobId: l.job?.id ?? '', costCategoryId: l.costCategory?.id ?? '', officeBudgetLineId: l.officeBudgetLine?.id ?? '' };
}

export interface ChargeChoices {
  jobs: { id: string; number: string; name: string }[];
  categories: { id: string; name: string }[];
  officeBudgets: OfficeBudgetOption[];
  /** A place a line already carries that the lists no longer offer (a closed line, a project since finished). */
  kept?: { value: string; label: string }[];
  /** Overheads (no budget) allowed — a reimbursement; never on a budget request's split line. */
  allowNone?: boolean;
}

/** "GT-PRJ-… · Materials" or "Office · 214 TRAVEL EXPENSE" — what a line says when it is not being changed. */
export function chargeLabel(c: LineCharge, choices: ChargeChoices): string {
  if (c.officeBudgetLineId) {
    for (const b of choices.officeBudgets) {
      const l = b.lines.find((x) => x.id === c.officeBudgetLineId);
      if (l) return `Office · ${l.code} ${l.name}`;
    }
    return choices.kept?.find((k) => k.value === `o:${c.officeBudgetLineId}`)?.label ?? 'Office budget line';
  }
  if (c.jobId) {
    const job = choices.jobs.find((j) => j.id === c.jobId);
    const cat = choices.categories.find((x) => x.id === c.costCategoryId);
    return `${job ? job.number : (choices.kept?.find((k) => k.value === `p:${c.jobId}`)?.label ?? 'Project')}${cat ? ` · ${cat.name}` : ''}`;
  }
  return 'Overheads';
}

/** The two boxes of a line's place: where (projects, then office lines) and, for a project, its budget line. */
export function ChargeCell({
  value,
  onChange,
  choices,
  isDefault,
  label,
  invalid,
}: {
  value: LineCharge;
  onChange: (c: LineCharge) => void;
  choices: ChargeChoices;
  /** Shown under it: the line takes the document's own place. */
  isDefault?: boolean;
  label: string;
  invalid?: boolean;
}) {
  const where = value.officeBudgetLineId ? `o:${value.officeBudgetLineId}` : value.jobId ? `p:${value.jobId}` : '';
  const keptHere = (choices.kept ?? []).filter(
    (k) => k.value === where && !choices.jobs.some((j) => `p:${j.id}` === k.value) && !choices.officeBudgets.some((b) => b.lines.some((l) => `o:${l.id}` === k.value)),
  );
  return (
    <div className="fin-line-stack line-charge">
      <select
        aria-label={`${label} charged to`}
        aria-invalid={invalid || undefined}
        value={where}
        onChange={(e) => {
          const v = e.target.value;
          if (v.startsWith('p:')) onChange({ jobId: v.slice(2), costCategoryId: value.jobId === v.slice(2) ? value.costCategoryId : '', officeBudgetLineId: '' });
          else if (v.startsWith('o:')) onChange({ jobId: '', costCategoryId: '', officeBudgetLineId: v.slice(2) });
          else onChange(NO_CHARGE);
        }}
      >
        <option value="">{choices.allowNone ? '— overheads (no budget) —' : '— choose where —'}</option>
        {keptHere.map((k) => (
          <option key={k.value} value={k.value}>
            {k.label}
          </option>
        ))}
        {choices.jobs.length > 0 && (
          <optgroup label="Projects">
            {choices.jobs.map((j) => (
              <option key={j.id} value={`p:${j.id}`}>
                {j.number} — {j.name}
              </option>
            ))}
          </optgroup>
        )}
        {choices.officeBudgets.map((b) => (
          <optgroup key={b.id} label={`Office · ${b.name}`}>
            {b.lines.map((l) => (
              <option key={l.id} value={`o:${l.id}`}>
                {l.code} {l.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {value.jobId && (
        <select
          aria-label={`${label} budget line`}
          aria-invalid={(invalid && !value.costCategoryId) || undefined}
          value={value.costCategoryId}
          onChange={(e) => onChange({ ...value, costCategoryId: e.target.value })}
        >
          <option value="">— budget line —</option>
          {choices.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      )}
      {isDefault && <span className="pill pill-default">default</span>}
    </div>
  );
}
