import { useEffect, useState, type SelectHTMLAttributes } from 'react';
import { api } from '../lib/api';
import { formatMoney } from './ui';

/**
 * Charging the OFFICE BUDGET (2026-11-10): the one picker of an office
 * budget line for the reimbursement, the budget request, the cash advance
 * and the supplier bill, and the words under it. The lines come from
 * `GET /office-budgets/lines` — the open lines of the open budgets with what
 * is left on each — fetched once a minute at most, whatever the number of
 * forms asking. Over its line, the form is not stopped: it is told, and
 * offered the lines of the same budget that still have room (the owner's
 * call: "suggest to allocate on a different line").
 */

export interface OfficeLineOption {
  id: string;
  code: string;
  name: string;
  budget: number;
  remaining: number;
  requested: number;
}
export interface OfficeBudgetOption {
  id: string;
  year: number;
  name: string;
  lines: OfficeLineOption[];
}

let cache: { at: number; load: Promise<OfficeBudgetOption[]> } | null = null;

export function loadOfficeLines(): Promise<OfficeBudgetOption[]> {
  if (!cache || Date.now() - cache.at > 60_000) {
    cache = {
      at: Date.now(),
      load: api.get<{ budgets: OfficeBudgetOption[] }>('/office-budgets/lines').then(
        (r) => r.budgets,
        () => {
          cache = null;
          return [];
        },
      ),
    };
  }
  return cache.load;
}

export function useOfficeLines(): OfficeBudgetOption[] {
  const [budgets, setBudgets] = useState<OfficeBudgetOption[]>([]);
  useEffect(() => {
    let live = true;
    loadOfficeLines().then((b) => live && setBudgets(b));
    return () => {
      live = false;
    };
  }, []);
  return budgets;
}

/** The line on the form, kept on the list even once it was closed. */
export interface CurrentOfficeLine {
  id: string;
  code: string;
  name: string;
  budget: { id: string; name: string; year: number };
}

export function OfficeLineSelect({
  budgets,
  value,
  onChange,
  current,
  none = '— none —',
  ...rest
}: {
  budgets: OfficeBudgetOption[];
  value: string;
  onChange: (id: string) => void;
  current?: CurrentOfficeLine | null;
  /** The empty choice's words; `null` leaves it out (the line is required). */
  none?: string | null;
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'>) {
  const listed = budgets.some((b) => b.lines.some((l) => l.id === value));
  return (
    <select {...rest} value={value} onChange={(e) => onChange(e.target.value)}>
      {none !== null && <option value="">{none}</option>}
      {current && value === current.id && !listed && (
        <option value={current.id}>
          {current.code} {current.name} — {current.budget.name} (closed)
        </option>
      )}
      {budgets.map((b) => (
        <optgroup key={b.id} label={b.name}>
          {b.lines.map((l) => (
            <option key={l.id} value={l.id}>
              {l.code} {l.name} — {formatMoney(l.remaining)} left
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
(OfficeLineSelect as unknown as { fieldControl: boolean }).fieldControl = true;

/**
 * What the form says under the picker: what is left on the line and after
 * this document, or — over — by how much and where there is room.
 * `own` is what this document already holds of the line (a saved draft's
 * figure is not in "left", so nothing is taken off).
 */
export function OfficeLineAdvice({ budgets, value, amount, onPick }: { budgets: OfficeBudgetOption[]; value: string; amount: number; onPick?: (id: string) => void }) {
  const budget = budgets.find((b) => b.lines.some((l) => l.id === value));
  const line = budget?.lines.find((l) => l.id === value);
  if (!budget || !line) return <>An office budget line instead of a project — the Office Budget monitor counts it there.</>;
  const after = Math.round((line.remaining - amount) * 100) / 100;
  if (after >= 0 || amount <= 0) {
    return (
      <>
        {formatMoney(line.remaining)} left on {line.code} {line.name}
        {amount > 0 && <> → {formatMoney(after)} after this</>}
        {line.requested > 0 && <> · {formatMoney(line.requested)} more is waiting for approval</>}
      </>
    );
  }
  const room = budget.lines
    .filter((l) => l.id !== line.id && l.remaining >= amount)
    .sort((a, b) => b.remaining - a.remaining)
    .slice(0, 4);
  return (
    <span className="del-danger">
      Over {line.code} {line.name} by {formatMoney(-after)} ({formatMoney(line.remaining)} left).{' '}
      {room.length === 0 ? (
        'No other line of this budget has room for it — it may still be sent; the approvers are told.'
      ) : (
        <>
          Room on:{' '}
          {room.map((l, i) => (
            <span key={l.id}>
              {i > 0 && ', '}
              {onPick ? (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => onPick(l.id)}>
                  {l.code} {l.name}
                </button>
              ) : (
                `${l.code} ${l.name}`
              )}{' '}
              ({formatMoney(l.remaining)})
            </span>
          ))}
          . It may still be sent as it is; the approvers are told.
        </>
      )}
    </span>
  );
}
