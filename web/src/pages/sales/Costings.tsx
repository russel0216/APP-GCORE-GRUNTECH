import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { ErrorBox, Field, Modal, formatDate, formatMoney, useToast } from '../../components/ui';

export interface CostingRow {
  id: string;
  number: string;
  title: string;
  status: 'DRAFT' | 'FINAL';
  contractValue: number;
  totalCost: number;
  grossProfit: number;
  grossMarginPct: number;
  durationDays: number | null;
  createdAt: string;
  customer: { id: string; name: string } | null;
  owner: { id: string; name: string };
  lineCount?: number;
  sectionCount?: number;
}

export function Costings() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [reload, setReload] = useState(0);

  const columns: Column<CostingRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', width: '160px', render: (c) => <span className="mono">{c.number}</span> },
    {
      key: 'title',
      label: 'Costing',
      sortKey: 'title',
      render: (c) => (
        <div>
          <div>{c.title}</div>
          <div className="faint">{c.customer?.name ?? 'No customer linked'}</div>
        </div>
      ),
    },
    {
      key: 'contractValue',
      label: 'Contract value',
      sortKey: 'contractValue',
      align: 'right',
      render: (c) => <span className="mono">{formatMoney(c.contractValue)}</span>,
    },
    { key: 'totalCost', label: 'Est. cost', align: 'right', render: (c) => <span className="mono">{formatMoney(c.totalCost)}</span> },
    {
      key: 'margin',
      label: 'Margin',
      align: 'right',
      render: (c) => <MarginBadge pct={c.grossMarginPct} />,
    },
    { key: 'owner', label: 'Prepared by', render: (c) => c.owner.name },
    { key: 'createdAt', label: 'Date', sortKey: 'createdAt', render: (c) => formatDate(c.createdAt) },
    {
      key: 'status',
      label: 'Status',
      render: (c) => (
        <span className={`badge ${c.status === 'FINAL' ? 'ok' : 'warn'}`}>
          {c.status === 'FINAL' ? 'Final' : 'Draft'}
        </span>
      ),
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Costing</h1>
          <p>
            Where the contract amount comes from. The scope of work you enter here becomes the
            Schedule of Values — the same sections that progress reports, progress billing and the
            S-curve are measured against later.
          </p>
        </div>
      </div>

      <DataList<CostingRow>
        listKey="costings"
        endpoint="/costings"
        columns={columns}
        rowKey={(c) => c.id}
        scoped
        searchPlaceholder="Search number, title, customer…"
        reloadToken={reload}
        onRowClick={(c) => navigate(`/g-ops/costing/${c.id}`)}
        emptyTitle="No costings yet"
        emptyHint="A costing is the first thing you make when a job looks real."
        filters={[
          {
            key: 'status',
            label: 'Status',
            options: [
              { value: 'DRAFT', label: 'Draft' },
              { value: 'FINAL', label: 'Final' },
            ],
          },
        ]}
        actions={
          can('gops.costing.create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
              + New costing
            </button>
          ) : null
        }
      />

      {creating && (
        <CostingForm
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            setReload((r) => r + 1);
            navigate(`/g-ops/costing/${id}`);
          }}
        />
      )}
    </div>
  );
}

export function MarginBadge({ pct }: { pct: number }) {
  const value = `${(pct * 100).toFixed(1)}%`;
  // Below 10% a job is barely worth the risk; below zero it is losing money.
  const tone = pct < 0 ? 'danger' : pct < 0.1 ? 'warn' : 'ok';
  return <span className={`badge ${tone}`}>{value}</span>;
}

export function CostingForm({
  costing,
  onClose,
  onSaved,
}: {
  costing?: CostingRow;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [customers, setCustomers] = useState<{ id: string; name: string; code: string }[]>([]);
  const [sites, setSites] = useState<{ id: string; name: string }[]>([]);
  const [form, setForm] = useState({
    title: costing?.title ?? '',
    customerId: costing?.customer?.id ?? '',
    siteId: '',
    markupPct: '15',
    durationDays: costing?.durationDays?.toString() ?? '',
  });

  useEffect(() => {
    api.get<typeof customers>('/customers/lookup').then(setCustomers).catch(() => {});
  }, []);

  useEffect(() => {
    if (!form.customerId) {
      setSites([]);
      return;
    }
    api
      .get<{ sites: { id: string; name: string }[] }>(`/customers/${form.customerId}`)
      .then((c) => setSites(c.sites))
      .catch(() => setSites([]));
  }, [form.customerId]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        title: form.title,
        customerId: form.customerId || null,
        siteId: form.siteId || null,
        markupPct: Number(form.markupPct) / 100,
        durationDays: form.durationDays === '' ? null : Number(form.durationDays),
      };
      const saved = costing
        ? await api.patch<{ id: string }>(`/costings/${costing.id}`, payload)
        : await api.post<{ id: string }>('/costings', payload);
      toast('ok', `${form.title} saved`);
      onSaved(saved.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={costing ? `Modify ${costing.number}` : 'New costing'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || form.title.length < 2}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <Field label="Title" hint="What the job is — e.g. Oxygen plant expansion, Phase 1">
        <input value={form.title} autoFocus onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </Field>
      <Field label="Customer">
        <select
          value={form.customerId}
          onChange={(e) => setForm({ ...form, customerId: e.target.value, siteId: '' })}
        >
          <option value="">— not linked yet —</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      {sites.length > 0 && (
        <Field label="Site">
          <select value={form.siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value })}>
            <option value="">— none —</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="grid grid-2">
        <Field label="Markup %" hint="Applied to total cost to reach the contract amount">
          <input
            type="number"
            step="0.1"
            value={form.markupPct}
            onChange={(e) => setForm({ ...form, markupPct: e.target.value })}
          />
        </Field>
        <Field label="Duration (days)">
          <input
            type="number"
            value={form.durationDays}
            onChange={(e) => setForm({ ...form, durationDays: e.target.value })}
          />
        </Field>
      </div>
    </Modal>
  );
}
