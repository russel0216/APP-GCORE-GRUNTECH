import { ReportPage, type ReportKind } from '../../components/ReportPage';
import { usePeople } from '../../components/People';
import { TickPicker } from '../../components/TickPicker';
import { useEffect, useState } from 'react';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { NumberInput } from '../../components/NumberInput';
import { formatDate, formatMoney, useToast } from '../../components/ui';
import { FlowPicture } from '../../components/FlowPicture';
import { SalesMatrix } from './SalesMatrix';
import { topOfFlow, type SankeyInput } from '../../lib/sankey';

/**
 * The Sales Order report (2026-10-23, the owner's call: "create a button
 * report for Sales Order") — the Sales Orders list's Report button opens it.
 * The API is `routes/salesReports.ts` on `shared/reportKit.ts`: orders dated
 * in the range under the list's own visibility, by month, team,
 * salesperson, customer, product group and status, in pesos.
 */

const KINDS: readonly ReportKind[] = [
  { key: 'sales-orders', label: 'Sales orders', list: '/g-ops/sales-orders' },
  // Issued orders with something still to invoice (2026-11-14): by salesperson, team, customer and age.
  { key: 'to-invoice', label: 'Not yet invoiced', list: '/g-ops/sales-orders?status=ISSUED&scope=all' },
];

const STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PENDING_APPROVAL', label: 'Pending approval' },
  { value: 'ISSUED', label: 'Issued' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

/** A box's ticks off the address: `a,b` → ['a', 'b']. */
const listOf = (v: string | null, separator = ',') => (v ? v.split(separator).map((x) => x.trim()).filter(Boolean) : []);

interface Team {
  id: string;
  code: string;
  name: string;
  isActive?: boolean;
}

export function SalesOrderReports() {
  const [teams, setTeams] = useState<Team[]>([]);
  const { people: sellers } = usePeople('gops.sales_orders.create');
  // Whoever booked in the period is listed too, though they have since left
  // or lost the right — their orders are still in the report.
  const [booked, setBooked] = useState<{ id: string; name: string }[]>([]);
  const people = [...sellers, ...booked.filter((b) => !sellers.some((p) => p.id === b.id))];
  // The period's customers (from the flows) and the product groups on the list.
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [groups, setGroups] = useState<string[]>([]);
  const { me } = useAuth();
  const myTeam = me?.user.team ?? null;
  useEffect(() => {
    api
      .get<{ name: string; isActive?: boolean }[]>('/reference/quotation-groups')
      .then((g) => setGroups(g.filter((x) => x.isActive !== false).map((x) => x.name)))
      .catch(() => setGroups([]));
  }, []);
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
      extraKeys={['ownerId', 'teamId', 'customerId', 'group', 'status', 'customers']}
      controlRows
      actionsInCard
      controls={({ params, set }) => (
        <>
          <div className="rep-row">
            <span className="rep-label">Filter by</span>
            <div className="rep-grid">
            {/* Tick several of each (2026-11-13, the owner's call): two customers or two
                salespeople in one report, a row each. In the address a box is `a,b`
                (product groups `X|Y`, a name may hold a comma). */}
            <TickPicker
              search
              label="Personnel"
              none="All personnel"
              noun="salespeople"
              choices={people.map((p) => ({ value: p.id, label: p.name }))}
              value={listOf(params.get('ownerId'))}
              onChange={(v) => set({ ownerId: v.join(',') })}
            />
            <TickPicker
              search
              label="Team"
              none="All teams"
              noun="teams"
              choices={[
                ...(myTeam ? [{ value: myTeam.id, label: `My team — ${myTeam.code}` }] : []),
                ...teams.filter((t) => t.id !== myTeam?.id).map((t) => ({ value: t.id, label: t.code, hint: t.name })),
                { value: 'none', label: 'No team' },
              ]}
              value={listOf(params.get('teamId'))}
              onChange={(v) => set({ teamId: v.join(',') })}
            />
            <TickPicker
              search
              label="Customer"
              none="All customers"
              noun="customers"
              choices={customers.map((c) => ({ value: c.id, label: c.name }))}
              value={listOf(params.get('customerId'))}
              onChange={(v) => set({ customerId: v.join(',') })}
            />
            {/* Product group, status, the flows and the target belong to the main report alone. */}
            {(params.get('kind') ?? 'sales-orders') === 'sales-orders' && <>
            <TickPicker
              search
              label="Product group"
              none="All product groups"
              noun="product groups"
              choices={[...groups.map((g) => ({ value: g, label: g })), { value: 'none', label: 'No group' }]}
              value={listOf(params.get('group'), '|')}
              onChange={(v) => set({ group: v.join('|') })}
            />
            <select aria-label="Status" value={params.get('status') ?? ''} onChange={(e) => set({ status: e.target.value })}>
              <option value="">Every status</option>
              {STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            </>}
            </div>
          </div>
          {(params.get('kind') ?? 'sales-orders') === 'sales-orders' && <>
          <div className="rep-row">
            <span className="rep-label">Show</span>
            <div className="rep-grid">
              <select aria-label="Customers on the customer flow and the customer table" value={params.get('customers') ?? ''} onChange={(e) => set({ customers: e.target.value })}>
                <option value="">All customers</option>
                <option value="10">Top 10 customers</option>
                <option value="25">Top 25 customers</option>
                <option value="50">Top 50 customers</option>
              </select>
            </div>
          </div>
          <TargetBox year={Number((params.get('to') ?? new Date().toISOString()).slice(0, 4))} />
          </>}
        </>
      )}
      below={({ kind, from, to, params }) => (
        // The flows still load on the other report (hidden): they feed the pickers their customers and salespeople.
        <div hidden={kind !== 'sales-orders'}>
        <SalesMatrix year={Number(to.slice(0, 4))} />
        <SalesFlows
          from={from}
          to={to}
          top={Number(params.get('customers')) || 0}
          ownerId={params.get('ownerId') ?? ''}
          teamId={params.get('teamId') ?? ''}
          status={params.get('status') ?? ''}
          customerId={params.get('customerId') ?? ''}
          group={params.get('group') ?? ''}
          onOwners={setBooked}
          onCustomers={setCustomers}
        />
        </div>
      )}
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
    <div className="rep-row">
      <span className="rep-label">{year} target</span>
      <div className="rep-grid">
        <NumberInput kind="money" aria-label={`${year} sales target`} value={amount} disabled={!canEdit} onChange={(e) => setAmount(e.target.value)} />
        {canEdit && (
          <div>
            <button type="button" className="btn btn-sm" onClick={() => void save()}>
              Save target
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

interface Flows {
  from: string;
  to: string;
  total: number;
  filterLine?: string;
  /** Salespeople are ticked: Gruntech and the teams are the whole company's, the last column theirs alone. */
  focused?: boolean;
  owners?: { id: string; name: string }[];
  customers?: { id: string; name: string }[];
  sankey: SankeyInput;
  customerSankey: SankeyInput;
}

/**
 * The two Sankeys as pictures to save for a slide (2026-11-12): the
 * salespeople's and the customers', over the report's own days, each with
 * Download PNG. The customers shown follow the "Print: …" choice.
 */
function SalesFlows({
  from,
  to,
  top,
  ownerId,
  teamId,
  status,
  customerId,
  group,
  onOwners,
  onCustomers,
}: {
  from: string;
  to: string;
  top: number;
  ownerId: string;
  teamId: string;
  status: string;
  customerId: string;
  group: string;
  onOwners: (owners: { id: string; name: string }[]) => void;
  onCustomers: (customers: { id: string; name: string }[]) => void;
}) {
  const [flows, setFlows] = useState<Flows | null>(null);
  useEffect(() => {
    let live = true;
    api
      .get<Flows>(`/sales-reports/flows${qs({ from, to, ownerId: ownerId || undefined, teamId: teamId || undefined, status: status || undefined, customerId: customerId || undefined, group: group || undefined })}`)
      .then((f) => {
        if (!live) return;
        setFlows(f);
        onOwners(f.owners ?? []);
        onCustomers(f.customers ?? []);
      })
      .catch(() => live && setFlows(null));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, ownerId, teamId, status, customerId, group]);
  if (!flows) return null;
  const days = `${formatMoney(flows.total)} before VAT · ${formatDate(flows.from)} to ${formatDate(flows.to)}${flows.filterLine ? ` · ${flows.focused ? `${flows.filterLine} — shown against the whole company` : flows.filterLine}` : ''}`;
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
