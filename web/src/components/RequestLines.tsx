import { NumberInput } from './NumberInput';
import { formatMoney } from './ui';

/**
 * The breakdown of a cash request — what the money buys, line by line — on
 * the budget request and the cash advance pages (2026-10-19, the owner's
 * call: a full form, not a popup). The request's amount is the sum of its
 * lines; the server's `shared/requestLines.ts` is the same rule.
 */

export interface RequestLine {
  key: string;
  name: string;
  description: string;
  quantity: string;
  unit: string;
  unitCost: string;
}

/** A stored line, as the API sends it. */
export interface RequestItem {
  id: string;
  name: string;
  description: string | null;
  quantity: number;
  unit: string;
  unitCost: number;
  amount: number;
}

let nextKey = 0;
const newKey = () => `rl${++nextKey}`;
export const blankRequestLine = (): RequestLine => ({ key: newKey(), name: '', description: '', quantity: '1', unit: 'pcs', unitCost: '' });

/** Stored lines as the page edits them; none gives one line worth the amount (a request from before the breakdown). */
export function linesFromItems(items: RequestItem[] | undefined, fallbackName: string, fallbackAmount: number): RequestLine[] {
  if (items?.length) {
    return items.map((i) => ({
      key: newKey(),
      name: i.name,
      description: i.description ?? '',
      quantity: String(i.quantity),
      unit: i.unit,
      unitCost: String(i.unitCost),
    }));
  }
  return fallbackAmount > 0 ? [{ ...blankRequestLine(), name: fallbackName, unitCost: String(fallbackAmount) }] : [blankRequestLine()];
}

/**
 * A line's amount, exact: quantity in thousandths × unit cost in centavos ÷
 * 1000, half away from zero — the server's `requestLineAmount()`.
 */
export function requestLineAmount(quantity: number, unitCost: number): number {
  const milli = BigInt(Math.round(quantity * 1000));
  const centavos = BigInt(Math.round(unitCost * 100));
  const product = milli * centavos;
  const sign = product < 0n ? -1n : 1n;
  return Number(((product * sign + 500n) / 1000n) * sign) / 100;
}

export const lineAmount = (l: RequestLine) => requestLineAmount(Number(l.quantity) || 0, Number(l.unitCost) || 0);
export const isBlankLine = (l: RequestLine) => !l.name.trim() && !l.description.trim() && !l.unitCost;
export const linesTotal = (lines: RequestLine[]) =>
  Math.round(lines.filter((l) => !isBlankLine(l)).reduce((s, l) => s + lineAmount(l) * 100, 0)) / 100;
/** What a save compares against, blank lines left out. */
export const linesSnapshot = (lines: RequestLine[]) => lines.filter((l) => !isBlankLine(l)).map(({ key: _key, ...rest }) => rest);

export function lineProblem(l: RequestLine): string | null {
  if (isBlankLine(l)) return null;
  if (!l.name.trim()) return 'Say what the line buys';
  if (!(Number(l.quantity) > 0)) return 'Quantity must be more than zero';
  return null;
}

/** The problems a save would be refused for, worded for the page's alert. */
export function linesProblems(lines: RequestLine[]): string[] {
  const sent = lines.filter((l) => !isBlankLine(l));
  if (!sent.length) return ['Add at least one line'];
  const out: string[] = [];
  if (!(linesTotal(lines) > 0)) out.push('The lines add up to nothing — give them a unit cost');
  sent.forEach((l, i) => {
    const p = lineProblem(l);
    if (p) out.push(`Line ${i + 1}: ${p}`);
  });
  return out;
}

/** The lines as the API takes them. */
export const linesPayload = (lines: RequestLine[]) =>
  lines
    .filter((l) => !isBlankLine(l))
    .map((l) => ({
      name: l.name.trim(),
      description: l.description.trim() || null,
      quantity: Number(l.quantity),
      unit: l.unit.trim() || 'pcs',
      unitCost: Number(l.unitCost) || 0,
    }));

/** The Breakdown card: one row per line, + Add line in its head. */
export function RequestLinesCard({
  id,
  lines,
  onChange,
  attempted,
  hint,
}: {
  id: string;
  lines: RequestLine[];
  onChange: (next: RequestLine[]) => void;
  attempted: boolean;
  hint: string;
}) {
  const setLine = (key: string, patch: Partial<RequestLine>) => onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const removeLine = (key: string) => {
    const rest = lines.filter((l) => l.key !== key);
    onChange(rest.length ? rest : [blankRequestLine()]);
  };
  return (
    <section className="card" aria-labelledby={id}>
      <div className="card-head">
        <h2 id={id} className="card-title">Breakdown</h2>
        <button type="button" className="btn btn-sm" onClick={() => onChange([...lines.filter((l) => !isBlankLine(l)), blankRequestLine()])}>
          + Add line
        </button>
      </div>
      <div className="table-wrap qe-table-wrap">
        <table className="data prq-lines">
          <colgroup>
            <col className="prq-col-no" />
            <col />
            <col className="prq-col-unit" />
            <col className="prq-col-qty" />
            <col className="prq-col-cost" />
            <col className="prq-col-amount" />
            <col className="prq-col-remove" />
          </colgroup>
          <thead>
            <tr>
              <th>#</th>
              <th>Item and description</th>
              <th>Unit</th>
              <th className="right">Qty</th>
              <th className="right">Unit cost</th>
              <th className="right">Amount</th>
              <th aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const problem = attempted ? lineProblem(l) : null;
              return (
                <tr key={l.key}>
                  <td className="mono">{i + 1}</td>
                  <td>
                    <input
                      className="prq-name"
                      aria-label={`Line ${i + 1} item`}
                      aria-invalid={problem === 'Say what the line buys' || undefined}
                      value={l.name}
                      maxLength={300}
                      placeholder="What it buys"
                      onChange={(e) => setLine(l.key, { name: e.target.value })}
                    />
                    <input
                      className="prq-desc"
                      aria-label={`Line ${i + 1} description`}
                      value={l.description}
                      maxLength={2000}
                      placeholder="Description (optional)"
                      onChange={(e) => setLine(l.key, { description: e.target.value })}
                    />
                    {problem && <div className="field-error">{problem}</div>}
                  </td>
                  <td>
                    <input aria-label={`Line ${i + 1} unit`} value={l.unit} maxLength={40} onChange={(e) => setLine(l.key, { unit: e.target.value })} />
                  </td>
                  <td>
                    <NumberInput
                      kind="quantity"
                      aria-label={`Line ${i + 1} quantity`}
                      aria-invalid={problem === 'Quantity must be more than zero' || undefined}
                      value={l.quantity}
                      onChange={(e) => setLine(l.key, { quantity: e.target.value })}
                    />
                  </td>
                  <td>
                    <NumberInput kind="money" aria-label={`Line ${i + 1} unit cost`} value={l.unitCost} min={0} onChange={(e) => setLine(l.key, { unitCost: e.target.value })} />
                  </td>
                  <td className="right mono">{formatMoney(lineAmount(l))}</td>
                  <td>
                    <button type="button" className="btn btn-sm btn-icon" aria-label={`Remove line ${i + 1}`} title="Remove" onClick={() => removeLine(l.key)}>
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="prq-hint">{hint}</p>
    </section>
  );
}

/** The Breakdown card on a record page: the lines read-only, with their total. */
export function RequestItemsCard({ items, total }: { items: RequestItem[]; total: number }) {
  if (!items.length) return null;
  return (
    <div className="card">
      <h3 className="card-title">Breakdown</h3>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>#</th>
              <th>Item and description</th>
              <th className="right">Qty</th>
              <th>Unit</th>
              <th className="right">Unit cost</th>
              <th className="right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i, n) => (
              <tr key={i.id}>
                <td className="mono">{n + 1}</td>
                <td>
                  <strong>{i.name}</strong>
                  {i.description && <div className="faint">{i.description}</div>}
                </td>
                <td className="right mono">{i.quantity.toLocaleString('en-PH', { maximumFractionDigits: 3 })}</td>
                <td>{i.unit}</td>
                <td className="right mono">{formatMoney(i.unitCost)}</td>
                <td className="right mono">{formatMoney(i.amount)}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={5} className="right">
                <strong>Total</strong>
              </td>
              <td className="right mono">
                <strong>{formatMoney(total)}</strong>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
