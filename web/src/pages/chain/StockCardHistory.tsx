import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Stat } from '../../components/charts';
import { Empty, formatDate, formatDateTime, formatMoney } from '../../components/ui';
import { label } from './PurchaseRequests';

/**
 * The two movement cards of the stock card (2026-11-25, the owner's call:
 * "view the product movement once I click the product"): G-CORE's own
 * movements, each with its slip or report as a link and where the goods came
 * from and went; and, under it, where the product moved in Odoo before
 * G-CORE — history only, never part of the stock.
 */

export interface StockMovement {
  id: string;
  type: string;
  quantity: number;
  unitCost: number;
  balanceAfter: number;
  sourceType: string;
  sourceNumber: string | null;
  occurredAt: string;
  warehouse: { name: string };
  createdBy: { name: string } | null;
  link?: string | null;
  from?: string | null;
  to?: string | null;
}

const qty = (n: number) => n.toLocaleString('en-PH', { maximumFractionDigits: 3 });

/** "A → B", a side nobody recorded left as a dash. */
export function FromTo({ from, to }: { from?: string | null; to?: string | null }) {
  if (!from && !to) return <span className="faint">—</span>;
  return (
    <>
      {from ?? '—'} <span className="faint">→</span> {to ?? '—'}
    </>
  );
}

export function StockMovements({
  movements,
  total,
  showingAll,
  onShowAll,
}: {
  movements: StockMovement[];
  /** Every movement on file; more than are listed while only the newest are shown. */
  total?: number;
  showingAll?: boolean;
  onShowAll?: () => void;
}) {
  const more = total != null && total > movements.length;
  return (
    <div className="card">
      <div className="card-head">
        <h3 className="card-title">Movements in G-CORE</h3>
        {more && onShowAll && !showingAll && (
          <button type="button" className="btn btn-sm" onClick={onShowAll}>
            Show all {total}
          </button>
        )}
      </div>
      {movements.length === 0 ? (
        <Empty title="No movements yet" />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th className="proc-col-when">When</th>
                <th>Type</th>
                <th>Reference</th>
                <th>From → to</th>
                <th className="right">In / out</th>
                <th className="right">Unit cost</th>
                <th className="right">Balance</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {movements.map((m) => (
                <tr key={m.id}>
                  <td className="muted">{formatDateTime(m.occurredAt)}</td>
                  <td>
                    <span className={`badge ${m.quantity > 0 ? 'ok' : m.type === 'BORROW' ? 'warn' : ''}`}>{label(m.type)}</span>
                  </td>
                  <td className="mono">
                    {m.link ? <Link to={m.link}>{m.sourceNumber ?? label(m.sourceType)}</Link> : <span className="faint">{m.sourceNumber ?? label(m.sourceType)}</span>}
                  </td>
                  <td>
                    <FromTo from={m.from ?? (m.quantity > 0 ? null : m.warehouse.name)} to={m.to ?? (m.quantity > 0 ? m.warehouse.name : null)} />
                  </td>
                  <td className={`right mono ${m.quantity > 0 ? 'proc-best' : 'proc-over'}`}>
                    {m.quantity > 0 ? '+' : ''}
                    {qty(m.quantity)}
                  </td>
                  <td className="right mono">{formatMoney(m.unitCost)}</td>
                  <td className="right mono">{qty(m.balanceAfter)}</td>
                  <td className="faint">{m.createdBy?.name ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {more && <p className="faint card-foot">The newest {movements.length} of {total} are listed.</p>}
    </div>
  );
}

export interface OdooHistory {
  total: number;
  received: number;
  delivered: number;
  first: string | null;
  last: string | null;
  rows: {
    id: string;
    occurredAt: string;
    reference: string;
    kind: string;
    kindLabel: string;
    direction: number;
    from: string;
    to: string;
    contact: string | null;
    quantity: number;
    unit: string | null;
    by: string | null;
  }[];
}

const FIRST_SHOWN = 20;

export function OdooHistoryCard({ history, unit }: { history: OdooHistory | null | undefined; unit: string }) {
  const [all, setAll] = useState(false);
  if (!history || !history.total) return null;
  const rows = all ? history.rows : history.rows.slice(0, FIRST_SHOWN);
  return (
    <div className="card">
      <div className="card-head">
        <h3 className="card-title">Movement history from Odoo</h3>
        {history.rows.length > FIRST_SHOWN && (
          <button type="button" className="btn btn-sm" onClick={() => setAll((v) => !v)}>
            {all ? `Show the newest ${FIRST_SHOWN}` : `Show all ${history.rows.length}`}
          </button>
        )}
      </div>
      <p className="faint">
        Where this product moved in Odoo before G-CORE, {formatDate(history.first)} to {formatDate(history.last)}. A record only — it is not part of the stock above and
        made no slip in G-CORE.
      </p>
      <div className="kpi-grid proc-stats">
        <Stat label="Received in Odoo" value={`${qty(history.received)} ${unit}`} />
        <Stat label="Delivered in Odoo" value={`${qty(history.delivered)} ${unit}`} />
        <Stat label="Moves on file" value={qty(history.total)} />
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th className="proc-col-when">When</th>
              <th>Type</th>
              <th>Reference</th>
              <th>From → to</th>
              <th>Customer / supplier</th>
              <th className="right">Quantity</th>
              <th>By</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id}>
                <td className="muted">{formatDateTime(m.occurredAt)}</td>
                <td>
                  <span className={`badge ${m.direction > 0 ? 'ok' : ''}`}>{m.kindLabel}</span>
                </td>
                <td className="mono">{m.reference}</td>
                <td>
                  <FromTo from={m.from} to={m.to} />
                </td>
                <td>{m.contact ?? <span className="faint">—</span>}</td>
                <td className={`right mono ${m.direction > 0 ? 'proc-best' : m.direction < 0 ? 'proc-over' : ''}`}>
                  {m.direction > 0 ? '+' : m.direction < 0 ? '−' : ''}
                  {qty(m.quantity)}
                </td>
                <td className="faint">{m.by ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {history.total > history.rows.length && (
        <p className="faint card-foot">
          The newest {history.rows.length} of {qty(history.total)} moves are listed; the totals count them all.
        </p>
      )}
    </div>
  );
}
