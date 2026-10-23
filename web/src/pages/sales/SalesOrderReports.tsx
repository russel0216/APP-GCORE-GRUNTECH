import { ReportPage, type ReportKind } from '../../components/ReportPage';
import { PersonSelect, usePeople } from '../../components/People';
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

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
      extraKeys={['ownerId', 'teamId', 'status']}
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
        </>
      )}
    />
  );
}
