import { ReportPage, type ReportKind } from '../../components/ReportPage';
import { PersonSelect, usePeople } from '../../components/People';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { NumberInput } from '../../components/NumberInput';
import { formatDate, formatMoney, useToast } from '../../components/ui';
import { FlowPicture } from '../../components/FlowPicture';
import { topOfFlow, type SankeyInput } from '../../lib/sankey';

/**
 * The Sales Order report (2026-10-23, the owner's call: "create a button
 * report for Sales Order") — the Sales Orders list's Report button opens it.
 * The API is `routes/salesReports.ts` on `shared/reportKit.ts`: orders dated
 * in the range under the list's own visibility, by month, team,
 * salesperson, customer, product group and status, in pesos.
 */

const KINDS: readonly ReportKind[] = [{ key: 'sales-orders', label: 'Sales orders', list: '/g-ops/sales-orders' }];

const STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PENDING_APPROVAL', label: 'Pending approval' },
  { value: 'ISSUED', label: 'Issued' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

interface Team {
  id: string;
  code: string;
  name: string;
  isActive?: boolean;
}

export function SalesOrderReports() {
  const [teams, setTeams] = useState<Team[]>([]);
  const { people } = usePeople('gops.sales_orders.create');
  useEffect(() => {
    api
      .get<Team[]>('/reference/industries')
      .then((t) => setTeams(t.filter((x) => x.isActive !== false)))
      .catch(() => setTeams([]));
  }, []);
  return (
    <ReportPage
      title="Sales Order Report"
      endpoint="/sales-reports"
      kinds={KINDS}
      extraKeys={['ownerId', 'teamId', 'status', 'customers']}
      controls={({ params, set }) => (
        <>
          <span className="rep-label">Narrow</span>
          <PersonSelect
            people={people}
            placeholder="— anyone —"
            value={params.get('ownerId') ?? ''}
            onChange={(v) => set({ ownerId: v })}
          />
          <select aria-label="Team" value={params.get('teamId') ?? ''} onChange={(e) => set({ teamId: e.target.value })}>
            <option value="">Every team</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.code} — {t.name}
              </option>
            ))}
            <option value="none">No team</option>
          </select>
          <select aria-label="Status" value={params.get('status') ?? ''} onChange={(e) => set({ status: e.target.value })}>
            <option value="">Every status</option>
            {STATUSES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <select aria-label="Customers on the customer flow, printed and as a picture" value={params.get('customers') ?? ''} onChange={(e) => set({ customers: e.target.value })}>
            <option value="">Customer flow: all customers</option>
            <option value="10">Customer flow: top 10</option>
            <option value="25">Customer flow: top 25</option>
            <option value="50">Customer flow: top 50</option>
          </select>
          <TargetBox year={Number((params.get('to') ?? new Date().toISOString()).slice(0, 4))} />
        </>
      )}
      below={({ from, to, params }) => <SalesFlows from={from} to={to} top={Number(params.get('customers')) || 0} />}
    />
  );
}

/**
 * The year's sales target (2026-11-09) — printed on the one-page Sales Report
 * with the achievement against it. Set by Sales Orders › Edit All.
 */
function TargetBox({ year }: { year: number }) {
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [canEdit, setCanEdit] = useState(false);
  useEffect(() => {
    api
      .get<{ amount: number | null; canEdit: boolean }>(`/sales-reports/target/${year}`)
      .then((r) => {
        setAmount(r.amount ? String(r.amount) : '');
        setCanEdit(r.canEdit);
      })
      .catch(() => setCanEdit(false));
  }, [year]);
  const save = async () => {
    try {
      await api.put(`/sales-reports/target/${year}`, { amount: amount ? Number(amount) : null });
      toast('ok', `${year} target saved`);
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Could not save the target');
    }
  };
  return (
    <>
      <span className="rep-label">{year} target</span>
      <NumberInput kind="money" aria-label={`${year} sales target`} value={amount} disabled={!canEdit} onChange={(e) => setAmount(e.target.value)} />
      {canEdit && (
        <button type="button" className="btn btn-sm" onClick={() => void save()}>
          Save target
        </button>
      )}
    </>
  );
}

interface Flows {
  from: string;
  to: string;
  total: number;
  sankey: SankeyInput;
  customerSankey: SankeyInput;
}

/**
 * The two Sankeys as pictures to save for a slide (2026-11-12): the
 * salespeople's and the customers', over the report's own days, each with
 * Download PNG. The customers shown follow the "Print: …" choice.
 */
function SalesFlows({ from, to, top }: { from: string; to: string; top: number }) {
  const [flows, setFlows] = useState<Flows | null>(null);
  useEffect(() => {
    let live = true;
    api
      .get<Flows>(`/sales-reports/flows?from=${from}&to=${to}`)
      .then((f) => live && setFlows(f))
      .catch(() => live && setFlows(null));
    return () => {
      live = false;
    };
  }, [from, to]);
  if (!flows) return null;
  const days = `${formatMoney(flows.total)} before VAT · ${formatDate(flows.from)} to ${formatDate(flows.to)}`;
  const customers = topOfFlow(flows.customerSankey, top);
  const count = new Set(flows.customerSankey.people.map((p) => p.of ?? p.id)).size;
  return (
    <>
      <FlowPicture input={flows.sankey} mode="side" title="Where the sales come from — Gruntech > team > salesperson" subtitle={days} fileName={`sales-by-salesperson-${flows.from}-to-${flows.to}.png`} />
      <FlowPicture
        input={customers}
        mode={customers.people.length > 26 ? 'down' : 'side'}
        title="Where the sales go — Gruntech > team > customer"
        subtitle={`${days} · ${top ? `top ${Math.min(top, count)} of ${count} customers` : `${count} customers`}`}
        fileName={`sales-by-customer-${flows.from}-to-${flows.to}.png`}
      />
    </>
  );
}
