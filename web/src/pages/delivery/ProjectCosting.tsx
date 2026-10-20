import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, openPdf } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ErrorBox, Loading, StatusBadge, formatDate, formatMoney, useToast } from '../../components/ui';
import { Stat } from '../../components/charts';

/**
 * A project's Costing tab (2026-10-15, the owner's call: "move the Costing
 * in Project, a menu beside Overview"). The costing the project was built
 * from, read through its own route — the costing's readers see its lines,
 * its summary and its scope of work with each phase's weight; anyone else
 * sees the two figures the project already carries. The costing list keeps
 * the costing too, saying it is converted.
 */

interface CostingLine {
  id: string;
  code: string | null;
  name: string | null;
  description: string;
  unit: string | null;
  quantity: number;
  unitCost: number;
  amount: number;
  isHeading: boolean;
  costCategory: { id: string; name: string } | null;
}

interface CostingSection {
  id: string;
  name: string;
  value: number;
  planDays: number;
  startDate: string | null;
  endDate: string | null;
}

interface CostingView {
  id: string;
  number: string;
  title: string;
  status: string;
  totalCost: number;
  contractValue: number;
  marginAmount: number;
  grossMarginPct: number;
  vatRate: number;
  vatAmount: number;
  grandTotal: number;
  finalAt: string | null;
  owner: { id: string; name: string };
  lines: CostingLine[];
  scopeSections: CostingSection[];
  scopeTotal: number;
  planDays: number;
}

export function ProjectCostingCard({
  costing,
}: {
  costing: { id: string; number: string; title: string; totalCost: number; contractValue: number } | null;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const reads = can('gops.costing.view_all') || can('gops.costing.view_own');
  const [view, setView] = useState<CostingView | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!costing || !reads) return;
    let live = true;
    api
      .get<CostingView>(`/costings/${costing.id}`)
      .then((v) => live && setView(v))
      .catch((err) => live && setError(err));
    return () => {
      live = false;
    };
  }, [costing, reads]);

  if (!costing) {
    return (
      <div className="card">
        <p className="muted">This project was not built from a costing.</p>
      </div>
    );
  }

  const margin = costing.contractValue - costing.totalCost;
  if (!reads || error) {
    return (
      <div className="stack">
        <ErrorBox error={error} />
        <div className="kpi-grid">
          <Stat label="Costing" value={costing.number} hint={costing.title} />
          <Stat label="Estimated cost" value={formatMoney(costing.totalCost)} figure />
          <Stat label="Contract value" value={formatMoney(costing.contractValue)} figure />
          <Stat
            label="Margin"
            value={formatMoney(margin)}
            figure
            hint={costing.contractValue > 0 ? `${((margin / costing.contractValue) * 100).toFixed(2)}% of the price` : undefined}
          />
        </div>
      </div>
    );
  }
  if (!view) return <Loading />;

  // The lines under their buckets, in the sheet's order.
  const groups: { name: string; lines: CostingLine[]; total: number }[] = [];
  for (const line of view.lines) {
    const name = line.costCategory?.name ?? 'Other';
    let group = groups.find((g) => g.name === name);
    if (!group) groups.push((group = { name, lines: [], total: 0 }));
    group.lines.push(line);
    if (!line.isHeading) group.total += line.amount;
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h3 className="card-title">
            <Link className="mono" to={`/g-ops/costing/${view.id}`}>
              {view.number}
            </Link>{' '}
            {view.title}
          </h3>
          <div className="pr-card-actions">
            <StatusBadge status={view.status} />
            <button type="button" className="btn btn-sm" onClick={() => openPdf(`/api/costings/${view.id}/pdf`, () => toast('error', 'The PDF could not be opened'))}>
              Print
            </button>
            <Link className="btn btn-sm" to={`/g-ops/costing/${view.id}`}>
              Open costing
            </Link>
          </div>
        </div>
        <p className="faint del-note">
          Prepared by {view.owner.name}
          {view.finalAt ? ` · final ${formatDate(view.finalAt)}` : ''} · the project's budget and schedule of values were taken from it.
        </p>
      </div>

      <div className="kpi-grid">
        <Stat label="Estimated cost" value={formatMoney(view.totalCost)} figure />
        <Stat label="Margin" value={formatMoney(view.marginAmount)} figure hint={`${(view.grossMarginPct * 100).toFixed(2)}% of the price`} />
        <Stat label="Contract value" value={formatMoney(view.contractValue)} figure hint="before VAT" />
        <Stat label="Grand total" value={formatMoney(view.grandTotal)} figure hint={`with VAT ${formatMoney(view.vatAmount)}`} />
      </div>

      <div className="card">
        <h3 className="card-title">Cost lines</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Code</th>
                <th>Line</th>
                <th className="right">Quantity</th>
                <th>Unit</th>
                <th className="right">Unit cost</th>
                <th className="right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <GroupRows key={g.name} group={g} />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3 className="card-title">Scope of work</h3>
        <p className="muted del-lede">Each phase's value and its weight — the share of the contract a progress report weighs it by.</p>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Phase</th>
                <th className="right">Working days</th>
                <th>Dates</th>
                <th className="right">Value</th>
                <th className="right">Weight</th>
              </tr>
            </thead>
            <tbody>
              {view.scopeSections.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td className="right mono">{s.planDays || '—'}</td>
                  <td>{s.startDate ? `${formatDate(s.startDate)} – ${formatDate(s.endDate)}` : <span className="faint">no start date</span>}</td>
                  <td className="right mono">{formatMoney(s.value)}</td>
                  <td className="right mono">{view.scopeTotal > 0 ? `${((s.value / view.scopeTotal) * 100).toFixed(2)}%` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function GroupRows({ group }: { group: { name: string; lines: CostingLine[]; total: number } }) {
  return (
    <>
      <tr className="pc-group">
        <td colSpan={5}>
          <strong>{group.name}</strong>
        </td>
        <td className="right mono">
          <strong>{formatMoney(group.total)}</strong>
        </td>
      </tr>
      {group.lines.map((l) =>
        l.isHeading ? (
          <tr key={l.id}>
            <td />
            <td colSpan={5} className="pc-subhead">
              {l.name ?? l.description}
            </td>
          </tr>
        ) : (
          <tr key={l.id}>
            <td className="mono">{l.code ?? ''}</td>
            <td>
              <div>
                <strong>{l.name ?? l.description}</strong>
              </div>
              {l.name && l.description !== l.name && <div className="faint">{l.description}</div>}
            </td>
            <td className="right mono">{l.quantity.toLocaleString('en-PH', { maximumFractionDigits: 3 })}</td>
            <td>{l.unit ?? ''}</td>
            <td className="right mono">{formatMoney(l.unitCost)}</td>
            <td className="right mono">{formatMoney(l.amount)}</td>
          </tr>
        ),
      )}
    </>
  );
}
