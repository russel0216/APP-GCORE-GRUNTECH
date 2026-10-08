import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, FootCell, type BulkContext, type Column, type FilterDef } from '../../components/DataList';
import { ImportModal, loadImportSpec } from '../../components/ImportModal';
import { Checkbox, ErrorBox, Field, Modal, StatusBadge, formatDate, formatMoney, useToast } from '../../components/ui';
import type { Industry } from './Reference';
import { NumberInput } from '../../components/NumberInput';

export interface CustomerRow {
  id: string;
  code: string;
  name: string;
  legalName: string | null;
  tin: string | null;
  industryId: string | null;
  industry: { id: string; code: string; name: string } | null;
  paymentTerms: string | null;
  creditLimit: number | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  notes: string | null;
  isActive: boolean;
  contactCount: number;
  siteCount: number;
  /** Quotations still in play (open, submitted, in negotiation), and projects — list rows only. */
  openQuoteCount?: number;
  projectCount?: number;
  createdBy: { id: string; name: string } | null;
  createdAt?: string;
}

interface CustomerSummary {
  count?: number;
  inactive?: number;
}

/**
 * The industry list, loaded once per screen. Any authenticated user may read
 * it — the customer form needs it under gops.customers.* alone.
 */
function useIndustries(activeOnly = false): Industry[] | null {
  const [rows, setRows] = useState<Industry[] | null>(null);
  useEffect(() => {
    api
      .get<Industry[]>(`/reference/industries${activeOnly ? '?active=true' : ''}`)
      .then(setRows)
      .catch(() => setRows([]));
  }, [activeOnly]);
  return rows;
}

/** `HI Healthcare Industry`, or a faint "Unclassified" — never a blank cell. */
export function IndustryLabel({ industry }: { industry: CustomerRow['industry'] }) {
  if (!industry) return <span className="faint">Unclassified</span>;
  return (
    <>
      <span className="m-industry-code">{industry.code}</span>
      <span className="muted">{industry.name}</span>
    </>
  );
}

// ── Mass actions: Set industry, active / inactive ───────────────────────────

/**
 * Reclassify the ticked customers, or mark them active or inactive — each the
 * ordinary PATCH /customers/:id, so the audit row and the rules (an industry
 * must be active; a code never moves when the industry does) are the PATCH's.
 * Whatever did not change stays ticked, with why.
 */
function CustomerBulkActions({ ctx, industries }: { ctx: BulkContext<CustomerRow>; industries: Industry[] }) {
  const toast = useToast();
  const [action, setAction] = useState('');
  const [progress, setProgress] = useState<{ done: number; of: number } | null>(null);
  const [refused, setRefused] = useState<{ code: string; why: string }[]>([]);

  const industry = action.startsWith('industry:') ? industries.find((i) => i.id === action.slice(9)) ?? null : null;
  const active = action === 'active' ? true : action === 'inactive' ? false : null;
  const plan = !action
    ? null
    : {
        go: ctx.rows.filter((c) => (industry ? c.industryId !== industry.id : c.isActive !== active)),
        stay: ctx.rows
          .filter((c) => (industry ? c.industryId === industry.id : c.isActive === active))
          .map((c) => ({ row: c, why: industry ? `already ${industry.code}` : `already ${active ? 'active' : 'inactive'}` })),
      };
  const what = industry ? `filed under ${industry.code}` : active ? 'marked active' : 'marked inactive';

  async function apply() {
    if (!plan || !plan.go.length) return;
    const failed: { row: CustomerRow; why: string }[] = [];
    let done = 0;
    setRefused([]);
    for (let i = 0; i < plan.go.length; i++) {
      setProgress({ done: i, of: plan.go.length });
      const row = plan.go[i];
      try {
        await api.patch(`/customers/${row.id}`, industry ? { industryId: industry.id } : { isActive: active });
        done++;
      } catch (err) {
        failed.push({ row, why: err instanceof ApiError ? err.message : 'could not be changed' });
      }
    }
    setProgress(null);
    const left = [...plan.stay, ...failed];
    toast(done > 0 ? 'ok' : 'error', `${done} customer${done === 1 ? '' : 's'} ${what}${left.length ? `; ${left.length} unchanged` : ''}`);
    setRefused(left.map((l) => ({ code: l.row.code, why: l.why })));
    setAction('');
    ctx.reload();
    if (left.length) ctx.keep(left.map((l) => l.row.id));
    else ctx.clear();
  }

  return (
    <>
      <select
        aria-label="Reclassify, or mark active or inactive, the selected customers"
        value={action}
        disabled={!!progress}
        onChange={(e) => {
          setAction(e.target.value);
          setRefused([]);
        }}
      >
        <option value="">Set industry or status…</option>
        <optgroup label="Set industry">
          {industries
            .filter((i) => i.isActive)
            .map((i) => (
              <option key={i.id} value={`industry:${i.id}`}>
                {i.code} — {i.name}
              </option>
            ))}
        </optgroup>
        <optgroup label="Status">
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </optgroup>
      </select>
      {plan && (
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={!plan.go.length || !!progress}
          onClick={() => void apply()}
        >
          {progress
            ? `Working ${progress.done + 1} of ${progress.of}…`
            : plan.go.length
              ? industry
                ? `File ${plan.go.length} under ${industry.code}`
                : `Mark ${plan.go.length} ${active ? 'active' : 'inactive'}`
              : 'Nothing to change'}
        </button>
      )}
      {plan && plan.stay.length > 0 && !progress && (
        <p className="list-bulk-result">
          {plan.stay.length} will stay as they are:{' '}
          {plan.stay
            .slice(0, 6)
            .map((st) => `${st.row.code} (${st.why})`)
            .join(', ')}
          {plan.stay.length > 6 ? `, and ${plan.stay.length - 6} more` : ''}.
        </p>
      )}
      {!plan && refused.length > 0 && (
        <div className="list-bulk-result" role="status">
          Still selected — these did not change:
          <ul>
            {refused.map((r) => (
              <li key={r.code}>
                <span className="mono">{r.code}</span>: {r.why}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/**
 * The customer list, in the quotation list's layout (2026-10-08): the
 * industries as tabs with their counts (and Unclassified while anybody is),
 * one Filters panel, open quotations and projects as columns, the printed
 * list and mass actions. The customer master is shared, so the list opens on
 * All for everyone; Mine is the customers you added.
 */
export function Customers() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const industries = useIndustries();
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState<{ label: string; columns: never[] } | null>(null);
  const [reload, setReload] = useState(0);
  const [people, setPeople] = useState<{ value: string; label: string }[]>([]);
  const mayEdit = can('gops.customers.edit_all');

  useEffect(() => {
    api
      .get<{ id: string; name: string }[]>(`/users/lookup${qs({ holding: 'gops.customers.create' })}`)
      .then((rows) => setPeople(rows.map((p) => ({ value: p.id, label: p.name }))))
      .catch(() => setPeople([]));
  }, []);

  const columns: Column<CustomerRow>[] = [
    { key: 'code', label: 'Code', sortKey: 'code', width: '150px', render: (c) => <span className="mono">{c.code}</span> },
    {
      key: 'name',
      label: 'Customer',
      sortKey: 'name',
      render: (c) => (
        <div>
          <div>{c.name}</div>
          {c.legalName && c.legalName !== c.name && <div className="faint">{c.legalName}</div>}
        </div>
      ),
    },
    { key: 'industry', label: 'Industry', render: (c) => <IndustryLabel industry={c.industry} /> },
    {
      key: 'isActive',
      label: 'Status',
      render: (c) => <StatusBadge status={c.isActive ? 'ACTIVE' : 'INACTIVE'} extra={{ INACTIVE: '' }} />,
    },
    {
      key: 'contacts',
      label: 'Contacts',
      align: 'right',
      render: (c) => (c.contactCount === 0 ? <span className="faint">none</span> : c.contactCount),
    },
    {
      key: 'sites',
      label: 'Sites',
      align: 'right',
      render: (c) => (c.siteCount === 0 ? <span className="faint">none</span> : c.siteCount),
    },
    {
      key: 'openQuotes',
      label: 'Open quotes',
      align: 'right',
      render: (c) => (c.openQuoteCount ? c.openQuoteCount : <span className="faint">—</span>),
    },
    {
      key: 'projects',
      label: 'Projects',
      align: 'right',
      render: (c) => (c.projectCount ? c.projectCount : <span className="faint">—</span>),
    },
    { key: 'phone', label: 'Phone', render: (c) => c.phone ?? '—', optional: true },
    { key: 'email', label: 'Email', render: (c) => c.email ?? '—', optional: true },
    { key: 'paymentTerms', label: 'Terms', render: (c) => c.paymentTerms ?? '—', optional: true },
    {
      key: 'creditLimit',
      label: 'Credit limit',
      align: 'right',
      render: (c) => (c.creditLimit === null ? '—' : formatMoney(c.creditLimit)),
      optional: true,
    },
    { key: 'tin', label: 'TIN', render: (c) => <span className="mono">{c.tin ?? '—'}</span>, optional: true },
    {
      key: 'createdBy',
      label: 'Added by',
      sortKey: 'createdAt',
      render: (c) => (
        <div>
          <div>{c.createdBy?.name ?? '—'}</div>
          {c.createdAt && <div className="faint">{formatDate(c.createdAt)}</div>}
        </div>
      ),
    },
  ];

  const filters: FilterDef[] = [
    {
      key: 'isActive',
      label: 'Status',
      options: [
        { value: 'true', label: 'Active' },
        { value: 'false', label: 'Inactive' },
      ],
    },
    { key: 'createdById', label: 'Added by', options: people },
    { key: 'createdFrom', toKey: 'createdTo', label: 'Added', type: 'dateRange' },
    {
      key: 'openQuote',
      label: 'Open quotation',
      options: [
        { value: 'yes', label: 'Has one in play' },
        { value: 'no', label: 'None in play' },
      ],
    },
    {
      key: 'project',
      label: 'Project',
      options: [
        { value: 'yes', label: 'Has a project' },
        { value: 'no', label: 'No project yet' },
      ],
    },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Customers</h1>
        </div>
      </div>

      <DataList<CustomerRow>
        listKey="customers"
        endpoint="/customers"
        columns={columns}
        rowKey={(c) => c.id}
        scoped
        searchPlaceholder="Search name, code, TIN, or a contact's name…"
        reloadToken={reload}
        onRowClick={(c) => navigate(`/g-ops/customers/${c.id}`)}
        emptyTitle="No customers yet"
        emptyHint="Add the first one, or import a list you already have."
        tabs={{
          key: 'industry',
          label: 'Industries',
          allLabel: 'All customers',
          options: (industries ?? []).filter((i) => i.isActive).map((i) => ({ value: i.code, label: i.name })),
        }}
        filters={filters}
        printPath="/api/customers/pdf"
        selectable
        rowLabel={(c) => `${c.code} ${c.name}`}
        bulkActions={mayEdit ? (ctx) => <CustomerBulkActions ctx={ctx} industries={industries ?? []} /> : undefined}
        menuItems={
          can('gops.customers.create')
            ? [
                {
                  label: 'Import customers…',
                  hint: 'From a spreadsheet, checked before anything is saved',
                  onSelect: () => {
                    void loadImportSpec('customers').then((spec) => {
                      if (spec) setImporting(spec as { label: string; columns: never[] });
                    });
                  },
                },
              ]
            : []
        }
        footer={(raw, total) => {
          const sum = raw as CustomerSummary;
          return {
            code: <FootCell label={`Customer${total === 1 ? '' : 's'}`}>{total}</FootCell>,
            ...(sum.inactive ? { isActive: <FootCell label="Inactive">{sum.inactive}</FootCell> } : {}),
          };
        }}
        actions={
          can('gops.customers.create') ? (
            <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
              + New customer
            </button>
          ) : null
        }
      />

      {creating && (
        <CustomerForm
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            navigate(`/g-ops/customers/${id}`);
          }}
        />
      )}

      {importing && (
        <ImportModal
          entity="customers"
          label={importing.label}
          columns={importing.columns}
          onClose={() => setImporting(null)}
          onImported={() => setReload((r) => r + 1)}
        />
      )}
    </div>
  );
}

// ── Create / edit form ───────────────────────────────────────────────────────

export function CustomerForm({
  customer,
  onClose,
  onSaved,
}: {
  customer?: CustomerRow;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const toast = useToast();
  const allIndustries = useIndustries();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    code: customer?.code ?? '',
    name: customer?.name ?? '',
    legalName: customer?.legalName ?? '',
    tin: customer?.tin ?? '',
    industryId: customer?.industryId ?? '',
    paymentTerms: customer?.paymentTerms ?? '',
    creditLimit: customer?.creditLimit?.toString() ?? '',
    phone: customer?.phone ?? '',
    email: customer?.email ?? '',
    website: customer?.website ?? '',
    notes: customer?.notes ?? '',
    isActive: customer?.isActive ?? true,
  });

  // Show the code the system would assign, without consuming it. The preview
  // only fills the field while it is empty or still holds the last preview —
  // a code somebody typed is theirs and is never overwritten.
  const preview = useRef('');
  useEffect(() => {
    if (customer) return;
    api
      .get<{ code: string }>('/customers/next-code')
      .then((r) =>
        setForm((f) => {
          const untouched = !f.code || f.code === preview.current;
          preview.current = r.code;
          return untouched ? { ...f, code: r.code } : f;
        }),
      )
      .catch(() => {});
  }, [customer]);

  // Offered: the active industries, plus the one this customer already has
  // even if it has since been deactivated — otherwise the select would show a
  // blank and a save would silently reclassify.
  const industries = (allIndustries ?? []).filter((i) => i.isActive || i.id === form.industryId);
  const noIndustries = allIndustries !== null && industries.length === 0;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        code: form.code || undefined,
        name: form.name,
        legalName: form.legalName || null,
        tin: form.tin || null,
        industryId: form.industryId,
        paymentTerms: form.paymentTerms || null,
        creditLimit: form.creditLimit === '' ? null : Number(form.creditLimit),
        phone: form.phone || null,
        email: form.email || null,
        website: form.website || null,
        notes: form.notes || null,
        isActive: form.isActive,
      };
      const saved = customer
        ? await api.patch<{ id: string }>(`/customers/${customer.id}`, payload)
        : await api.post<{ id: string }>('/customers', payload);
      toast('ok', `${form.name} saved`);
      onSaved(saved.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const industryHint = noIndustries
    ? 'No industries are set up yet — an administrator adds them under Admin › Categories.'
    : customer && !customer.industryId
      ? 'Not classified yet — pick the one that fits. GI (General) covers anything else.'
      : 'HI Healthcare · BI Building · UI Utility · GI General · SI Special';

  return (
    <Modal
      wide
      title={customer ? `Modify ${customer.name}` : 'Add customer'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={save}
            disabled={busy || form.name.length < 2 || !form.industryId}
            title={!form.industryId ? 'Choose an industry first' : undefined}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />

      <div className="grid grid-2">
        <Field label="Customer name" required>
          <input
            value={form.name}
            autoFocus
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>
        <Field label="Code" hint="Auto-generated — override it if you have your own scheme">
          <input className="mono" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
        </Field>
        <Field label="Industry" hint={industryHint} required>
          <select
            value={form.industryId}
            disabled={noIndustries}
            onChange={(e) => setForm({ ...form, industryId: e.target.value })}
          >
            <option value="">— choose —</option>
            {industries.map((i) => (
              <option key={i.id} value={i.id}>
                {i.code} — {i.name}
                {i.isActive ? '' : ' (inactive)'}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Registered / legal name" hint="Appears on invoices when it differs">
          <input value={form.legalName} onChange={(e) => setForm({ ...form, legalName: e.target.value })} />
        </Field>
        <Field label="TIN">
          <input value={form.tin} onChange={(e) => setForm({ ...form, tin: e.target.value })} />
        </Field>
        <Field label="Payment terms" hint="e.g. 30 days, or 30% down and balance on turnover">
          <input
            value={form.paymentTerms}
            onChange={(e) => setForm({ ...form, paymentTerms: e.target.value })}
          />
        </Field>
        <Field label="Credit limit">
          <NumberInput
            kind="money"
            value={form.creditLimit}
            onChange={(e) => setForm({ ...form, creditLimit: e.target.value })}
          />
        </Field>
        <Field label="Phone">
          <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </Field>
        <Field label="Email">
          <input
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </Field>
        <Field label="Website">
          <input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
        </Field>
      </div>

      <Field label="Notes">
        <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </Field>

      <Checkbox
        checked={form.isActive}
        onChange={(v) => setForm({ ...form, isActive: v })}
        label="Active — inactive customers stay on past records but cannot be picked for new work"
      />
    </Modal>
  );
}
