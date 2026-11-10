import { formatMoney } from './ui';

/**
 * "Against the project budget" — the one card for every document that
 * charges a project's budget line before it posts: the budget request
 * (2026-10-23, the owner's call: approvers and finance see where the money is
 * allocated), and since 2026-11-09 the expense claim (a reimbursement or a
 * liquidation) and the cash advance, after the owner's question: "how can we
 * see if the request in Reimbursement appear or allocated already in budget
 * monitoring prior approval to see if there is remaining budget".
 *
 * The figures are Budget Monitoring's own (`projectBudgetByLine()` on the
 * API), with this document's own rows left out, then this document and what
 * is left after it; "Also waiting for approval" is what else is asked on the
 * line and has posted nothing yet — shown, never subtracted. Under it the
 * project's other budget lines, so the approver sees where the rest sits.
 */

export interface BudgetLineFigures {
  id: string;
  code: string;
  name: string;
  budgeted: number;
  committed: number;
  incurred: number;
  consumed: number;
  /** Asked on the line and not yet posted (pending claims, advances out, budget requests not yet released). */
  requested?: number;
  available: number;
}

export interface RequestSource {
  /** `office` (2026-11-10): an office budget line — shared/officeBudget.ts on the API. */
  kind: 'project' | 'sales_order' | 'quotation' | 'costing' | 'office';
  id: string;
  number: string;
  name: string;
  label: string;
  link: string;
}

/** "Project", "Sales order", "Quotation", "Costing". */
export const SOURCE_WORDS: Record<RequestSource['kind'], string> = {
  project: 'Project',
  sales_order: 'Sales order',
  quotation: 'Quotation',
  costing: 'Costing',
  office: 'Office budget',
};

export interface RequestBudget {
  /** What it is checked against: the project's Budget Monitoring, or the record's own cost. */
  source: RequestSource['kind'];
  /** False where the record carries no budget lines — one "whole cost" row. */
  perLine: boolean;
  line: BudgetLineFigures | null;
  lines: BudgetLineFigures[];
  total: { budgeted: number; committed: number; incurred: number; requested?: number; available: number };
  availableBefore: number;
  thisRequest: number;
  availableAfter: number;
  over: boolean;
  overBy: number;
  /** Also waiting on this line, besides this document — shown, never subtracted. */
  requested?: number;
  settled: boolean;
  /** `asked` before anything moved, `released` while cash is out, `settled` once posted, `closed` refused or withdrawn. */
  basis: 'asked' | 'released' | 'settled' | 'closed';
  /** An office budget line's card: the budget it belongs to. */
  office?: { id: string; year: number; name: string };
  /** Over an office line: the other lines of the same budget with room for this document. */
  suggest?: { id: string; code: string; name: string; remaining: number }[];
}

/** What the document is called in the card: "This request", "This claim", "This advance". */
export type BudgetNoun = 'This request' | 'This claim' | 'This advance' | 'This bill';

export function BudgetCard({ budget: b, lineName, noun = 'This request' }: { budget: RequestBudget; lineName: string; noun?: BudgetNoun }) {
  const others = b.lines.filter((l) => l.id !== b.line?.id && (l.budgeted || l.committed || l.incurred || l.requested));
  const line = b.line;
  const waiting = b.requested ?? 0;
  const what = noun.toLowerCase();
  const office = b.source === 'office';
  return (
    <section className="card">
      <div className="card-head">
        <h3 className="card-title">
          {office ? `Against the office budget${b.office ? ` — ${b.office.name}` : ''}` : b.source === 'project' ? 'Against the project budget' : `Against the ${SOURCE_WORDS[b.source].toLowerCase()}'s cost`}
        </h3>
      </div>
      {b.over && !b.settled && (
        <div className="alert error">
          {noun} takes {lineName} {formatMoney(b.overBy)} over its budget line.
          {office &&
            (b.suggest?.length
              ? ` It may be charged to a line with room instead: ${b.suggest.map((x) => `${x.code} ${x.name} (${formatMoney(x.remaining)} left)`).join('; ')}.`
              : ' No other line of this budget has room for it.')}
        </div>
      )}
      <dl className="kv">
        <dt>Budget line</dt>
        <dd>{lineName}</dd>
        {!b.perLine && line && (
          <>
            <dt>Checked against</dt>
            <dd>{line.name} — the record carries no budget lines</dd>
          </>
        )}
        <dt>Budgeted</dt>
        <dd className="mono">{formatMoney(line?.budgeted ?? 0)}</dd>
        <dt>{office ? 'Cash out, to be accounted for' : 'Already committed'}</dt>
        <dd className="mono">{formatMoney(line?.committed ?? 0)}</dd>
        <dt>{office ? 'Actual to date' : 'Already spent'}</dt>
        <dd className="mono">{formatMoney(line?.incurred ?? 0)}</dd>
        {waiting > 0 && (
          <>
            <dt>Also waiting for approval</dt>
            <dd className="mono faint" title="Other claims, advances and budget requests on this line that have not posted yet — shown, not subtracted">
              {formatMoney(waiting)}
            </dd>
          </>
        )}
        <dt>{b.settled ? 'Available now' : 'Available before'}</dt>
        <dd className="mono">
          <strong>{formatMoney(b.availableBefore)}</strong>
        </dd>
        {!b.settled && (
          <>
            <dt>{b.basis === 'released' ? `${noun} (cash still out)` : noun}</dt>
            <dd className="mono">− {formatMoney(b.thisRequest)}</dd>
            <dt>{b.over ? 'Over by' : 'Available after'}</dt>
            <dd className={`mono${b.over ? ' del-danger' : ''}`}>
              <strong>{formatMoney(b.over ? b.overBy : b.availableAfter)}</strong>
            </dd>
          </>
        )}
      </dl>
      <p className="muted del-lede">
        {b.settled
          ? b.basis === 'closed'
            ? `${noun} takes nothing from the budget.`
            : office
              ? `${noun} takes nothing more from the budget: what it spent is in the line’s actual.`
              : `${noun} takes nothing more from the budget: what it spent is on the ledger as incurred.`
          : office
            ? `The Office Budget monitor’s own figures, with ${what}’s own money left out so it is never counted twice. Available = budget − cash out − actual; what else is waiting for approval is shown and not subtracted.`
            : b.source === 'project'
            ? `Budget Monitoring’s own figures, with ${what}’s own money left out so it is never counted twice. What else is waiting for approval is shown and not subtracted — it may still be returned or refused.`
            : 'The record’s own cost, less what its purchasing and the other budget requests on it already hold — nothing posts to a project until one is built from it, which takes this request over.'}
      </p>
      {others.length > 0 && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Other budget lines</th>
                <th className="right">Budgeted</th>
                <th className="right">{office ? 'Cash out' : 'Committed'}</th>
                <th className="right">{office ? 'Actual' : 'Spent'}</th>
                <th className="right">Waiting</th>
                <th className="right">Available</th>
              </tr>
            </thead>
            <tbody>
              {others.map((l) => (
                <tr key={l.id}>
                  <td>{l.name}</td>
                  <td className="right mono">{formatMoney(l.budgeted)}</td>
                  <td className="right mono">{formatMoney(l.committed)}</td>
                  <td className="right mono">{formatMoney(l.incurred)}</td>
                  <td className="right mono faint">{l.requested ? formatMoney(l.requested) : '—'}</td>
                  <td className={`right mono${l.available < 0 ? ' del-danger' : ''}`}>{formatMoney(l.available)}</td>
                </tr>
              ))}
              <tr>
                <td>
                  <strong>{office ? 'Whole budget' : 'Project'}</strong>
                </td>
                <td className="right mono">{formatMoney(b.total.budgeted)}</td>
                <td className="right mono">{formatMoney(b.total.committed)}</td>
                <td className="right mono">{formatMoney(b.total.incurred)}</td>
                <td className="right mono faint">{b.total.requested ? formatMoney(b.total.requested) : '—'}</td>
                <td className="right mono">
                  <strong>{formatMoney(b.total.available)}</strong>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
