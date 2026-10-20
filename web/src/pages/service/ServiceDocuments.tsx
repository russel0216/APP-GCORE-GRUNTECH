import { useCallback, useEffect, useId, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { Attachments } from '../../components/Attachments';
import { ErrorBox, Field, Loading, Modal, ModalFoot, StatusBadge, formatDate, useToast } from '../../components/ui';
import { Stat } from '../../components/charts';

/**
 * Service Documents — the technical documents of the Aftermarket side
 * (2026-10-20, the owner's revised Aftermarket UI): a manual, an electrical
 * drawing, a test report, a datasheet, each under a category from Admin ›
 * Categories and filed against a machine on the Installation Base or against
 * a model (an item) — either. The file is the record's Attachments card; a
 * machine's page lists the documents on it and on its model.
 */

export interface DocumentCategory {
  id: string;
  name: string;
  isActive: boolean;
}

export interface ServiceDocumentRow {
  id: string;
  title: string;
  description: string | null;
  version: string | null;
  documentDate: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  category: DocumentCategory;
  asset: { id: string; code: string; name: string; model: string | null; serialNo: string | null; customer: { id: string; name: string } } | null;
  item: { id: string; code: string; name: string; partNumber: string | null; brand: string | null } | null;
  createdBy: { id: string; name: string };
  /** What it is filed against, in words. */
  against: string;
  files: number;
}

interface DocumentDetail extends ServiceDocumentRow {
  canEdit: boolean;
}

interface DocumentSummary {
  documents: number;
  machines: number;
  models: number;
  categories: { id: string; name: string; count: number }[];
}

const AGAINST = [
  { value: 'machine', label: 'A machine' },
  { value: 'model', label: 'A model' },
  { value: 'none', label: 'Nothing yet' },
];

const STATUS = [
  { value: 'all', label: 'Current and withdrawn' },
  { value: 'false', label: 'Withdrawn only' },
];

/** The categories offered, read once; an inactive one a record carries stays named on it. */
function useDocumentCategories(activeOnly = true) {
  const [rows, setRows] = useState<DocumentCategory[]>([]);
  useEffect(() => {
    api
      .get<DocumentCategory[]>(`/reference/service-document-categories${activeOnly ? '?active=true' : ''}`)
      .then(setRows)
      .catch(() => setRows([]));
  }, [activeOnly]);
  return rows;
}

function columns(): Column<ServiceDocumentRow>[] {
  return [
    {
      key: 'title',
      label: 'Document',
      sortKey: 'title',
      render: (r) => (
        <div>
          <div>
            <strong>{r.title}</strong>
          </div>
          {r.description && <div className="faint">{r.description.length > 90 ? `${r.description.slice(0, 90)}…` : r.description}</div>}
        </div>
      ),
    },
    { key: 'category', label: 'Category', render: (r) => r.category.name },
    {
      key: 'against',
      label: 'Filed against',
      render: (r) =>
        r.asset ? (
          <div>
            <div>{r.asset.name}</div>
            <div className="faint">
              {[r.asset.serialNo, r.asset.customer.name].filter(Boolean).join(' · ')}
            </div>
          </div>
        ) : r.item ? (
          <div>
            <div>{r.item.name}</div>
            <div className="faint">{[r.item.brand, r.item.partNumber].filter(Boolean).join(' · ') || 'model'}</div>
          </div>
        ) : (
          <span className="faint">nothing yet</span>
        ),
    },
    { key: 'version', label: 'Version', optional: true, render: (r) => r.version ?? <span className="faint">—</span> },
    { key: 'documentDate', label: 'Dated', sortKey: 'documentDate', render: (r) => (r.documentDate ? formatDate(r.documentDate) : <span className="faint">—</span>) },
    { key: 'files', label: 'Files', align: 'right', render: (r) => <span className="mono">{r.files}</span> },
    { key: 'filedBy', label: 'Filed by', optional: true, render: (r) => r.createdBy.name },
    { key: 'updated', label: 'Updated', sortKey: 'updatedAt', optional: true, render: (r) => formatDate(r.updatedAt) },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.isActive ? 'CURRENT' : 'WITHDRAWN'} extra={{ CURRENT: 'ok', WITHDRAWN: '' }} label={r.isActive ? 'Current' : 'Withdrawn'} /> },
  ];
}

export function ServiceDocuments() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  // `?new=1&assetId=` — how the machine's page starts one.
  const [filing, setFiling] = useState(() => params.get('new') === '1' && can('gops.service_documents.create'));
  const [prefill] = useState(() => ({ assetId: params.get('assetId') ?? undefined, assetName: params.get('assetName') ?? undefined }));
  const categories = useDocumentCategories(false);
  const [summary, setSummary] = useState<DocumentSummary | null>(null);

  function closeFiling() {
    setFiling(false);
    if (params.has('new')) {
      const next = new URLSearchParams(params);
      for (const k of ['new', 'assetId', 'assetName']) next.delete(k);
      setParams(next, { replace: true });
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Service Documents</h1>
        </div>
      </div>

      <DataList<ServiceDocumentRow>
        listKey="service-documents"
        endpoint="/service-documents"
        columns={columns()}
        rowKey={(r) => r.id}
        scoped
        defaultScope="all"
        onRowClick={(r) => navigate(`/g-ops/service-documents/${r.id}`)}
        searchPlaceholder="Search title, machine, serial, model…"
        emptyTitle="No service documents yet"
        emptyHint="File a manual, a drawing or a test report against a machine or a model."
        printPath="/api/service-documents/pdf"
        onSummary={(raw) => setSummary(raw as unknown as DocumentSummary)}
        summary={(raw) => {
          const s = raw as unknown as DocumentSummary;
          const top = [...(s.categories ?? [])].sort((a, b) => b.count - a.count)[0];
          return (
            <>
              <Stat label="Technical documents" value={s.documents ?? 0} sub="Current" />
              <Stat label="Machines documented" value={s.machines ?? 0} sub="On the Installation Base" />
              <Stat label="Models documented" value={s.models ?? 0} sub="Every machine of the model reads them" />
              <Stat label="Largest category" value={top?.count ?? 0} sub={top?.name ?? 'nothing yet'} />
            </>
          );
        }}
        filters={[
          { key: 'categoryId', label: 'Category', options: (summary?.categories ?? categories).map((c) => ({ value: c.id, label: c.name })) },
          { key: 'against', label: 'Filed against', options: AGAINST },
          { key: 'active', label: 'Status', options: STATUS },
          { key: 'from', toKey: 'to', label: 'Dated', type: 'dateRange' },
        ]}
        actions={
          can('gops.service_documents.create') ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setFiling(true)}>
              + New service document
            </button>
          ) : null
        }
      />

      {filing && (
        <ServiceDocumentModal
          prefill={prefill}
          onClose={closeFiling}
          onSaved={(id) => {
            setFiling(false);
            navigate(`/g-ops/service-documents/${id}`);
          }}
        />
      )}
    </div>
  );
}

// ── Filing and editing ──────────────────────────────────────────────────────

interface MachineHit {
  id: string;
  name: string;
  model: string | null;
  serialNo: string | null;
  customer: { name: string };
}
interface ModelHit {
  id: string;
  code: string;
  name: string;
}

/** A small typed lookup: the box, the hits under it, the pick. */
function Lookup<T extends { id: string }>({
  id,
  value,
  valueLabel,
  placeholder,
  search,
  label,
  onPick,
  disabled,
}: {
  id?: string;
  value: string;
  valueLabel: string;
  placeholder: string;
  search: (q: string) => Promise<T[]>;
  label: (hit: T) => string;
  onPick: (hit: T | null) => void;
  disabled?: boolean;
}) {
  const [typed, setTyped] = useState('');
  const [hits, setHits] = useState<T[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!typed.trim()) {
      setHits([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      search(typed.trim())
        .then((rows) => {
          if (!live) return;
          setHits(rows);
          setFailed(false);
        })
        .catch(() => {
          if (!live) return;
          setHits([]);
          setFailed(true);
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [typed, search]);
  if (value) {
    // The pick, read-only in the box, and Change beside it (no new CSS: the lookup's own wrapper).
    return (
      <div className="lookup">
        <input id={id} value={valueLabel} readOnly disabled={disabled} />
        <div className="lookup-tick">
          <button type="button" className="btn btn-sm" onClick={() => onPick(null)} disabled={disabled} style={{ pointerEvents: 'auto' }}>
            Change
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="lookup">
      <input id={id} value={typed} placeholder={placeholder} onChange={(e) => setTyped(e.target.value)} disabled={disabled} autoComplete="off" />
      {typed.trim() && (
        <ul className="lookup-menu" role="listbox">
          {failed ? (
            <li className="faint">Could not be listed</li>
          ) : hits.length === 0 ? (
            <li className="faint">No match for “{typed.trim()}”</li>
          ) : (
            hits.map((h) => (
              <li key={h.id}>
                <button type="button" onClick={() => onPick(h)}>
                  {label(h)}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

const machineLabel = (m: MachineHit) => `${m.name}${m.model ? ` · ${m.model}` : ''}${m.serialNo ? ` · ${m.serialNo}` : ''} — ${m.customer.name}`;
const modelLabel = (m: ModelHit) => `${m.name} (${m.code})`;

export function ServiceDocumentModal({
  prefill,
  existing,
  onClose,
  onSaved,
}: {
  prefill?: { assetId?: string; assetName?: string };
  existing?: ServiceDocumentRow;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const toast = useToast();
  const { can } = useAuth();
  const idBase = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const categories = useDocumentCategories(true);
  const [form, setForm] = useState(() => ({
    title: existing?.title ?? '',
    description: existing?.description ?? '',
    categoryId: existing?.category.id ?? '',
    assetId: existing?.asset?.id ?? prefill?.assetId ?? '',
    assetLabel: existing?.asset ? `${existing.asset.name}${existing.asset.serialNo ? ` · ${existing.asset.serialNo}` : ''} — ${existing.asset.customer.name}` : (prefill?.assetName ?? ''),
    itemId: existing?.item?.id ?? '',
    itemLabel: existing?.item ? `${existing.item.name} (${existing.item.code})` : '',
    version: existing?.version ?? '',
    documentDate: existing?.documentDate?.slice(0, 10) ?? '',
  }));
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  // The first offered category, when the form opens on none.
  useEffect(() => {
    if (!form.categoryId && categories.length) set('categoryId', categories[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories]);

  const searchMachines = useCallback(
    (q: string) => api.get<{ rows: MachineHit[] }>(`/installed-assets${qs({ search: q, pageSize: 10 })}`).then((d) => d.rows),
    [],
  );
  const searchModels = useCallback((q: string) => api.get<ModelHit[]>(`/items/lookup${qs({ q })}`), []);
  const mayPickMachine = can('gops.installed_base.view_all') || can('gops.installed_base.view_own');
  const mayPickModel = can('gchain.items.view_all');

  async function save() {
    setBusy(true);
    setError(null);
    const body = {
      title: form.title.trim(),
      description: form.description.trim() || null,
      categoryId: form.categoryId,
      assetId: form.assetId || null,
      itemId: form.itemId || null,
      version: form.version.trim() || null,
      documentDate: form.documentDate || null,
    };
    try {
      if (existing) {
        await api.patch(`/service-documents/${existing.id}`, body);
        toast('ok', 'Service document updated');
        onSaved(existing.id);
      } else {
        const created = await api.post<{ id: string }>('/service-documents', body);
        toast('ok', 'Filed — now add the file');
        onSaved(created.id);
      }
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const incomplete = form.title.trim().length < 2 || !form.categoryId;

  return (
    <Modal
      title={existing ? `Modify service document` : 'New service document'}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy || incomplete}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <Field label="Title" htmlFor={`${idBase}-title`}>
        <input id={`${idBase}-title`} value={form.title} placeholder="Operation and maintenance manual" onChange={(e) => set('title', e.target.value)} autoFocus />
      </Field>
      <div className="grid grid-2">
        <Field label="Category" htmlFor={`${idBase}-category`}>
          <select id={`${idBase}-category`} value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
            {existing && !categories.some((c) => c.id === existing.category.id) && <option value={existing.category.id}>{existing.category.name}</option>}
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Version">
          <input value={form.version} placeholder="Rev. B" onChange={(e) => set('version', e.target.value)} />
        </Field>
        <Field label="Document date" hint="As printed on it">
          <input type="date" value={form.documentDate} onChange={(e) => set('documentDate', e.target.value)} />
        </Field>
      </div>
      <h4 className="svc-subhead">Filed against</h4>
      <div className="grid grid-2">
        <Field label="Machine" htmlFor={`${idBase}-machine`} hint={mayPickMachine ? 'On the Installation Base — this machine alone reads it' : 'You cannot read the Installation Base'}>
          <Lookup<MachineHit>
            id={`${idBase}-machine`}
            value={form.assetId}
            valueLabel={form.assetLabel}
            placeholder="Type a machine, serial no. or customer…"
            search={searchMachines}
            label={machineLabel}
            onPick={(m) => setForm((f) => ({ ...f, assetId: m?.id ?? '', assetLabel: m ? machineLabel(m) : '' }))}
            disabled={!mayPickMachine}
          />
        </Field>
        <Field label="Model" htmlFor={`${idBase}-model`} hint={mayPickModel ? 'An item on the master — every machine of it reads the document' : 'You cannot read the item master'}>
          <Lookup<ModelHit>
            id={`${idBase}-model`}
            value={form.itemId}
            valueLabel={form.itemLabel}
            placeholder="Type a model, code or part no.…"
            search={searchModels}
            label={modelLabel}
            onPick={(m) => setForm((f) => ({ ...f, itemId: m?.id ?? '', itemLabel: m ? modelLabel(m) : '' }))}
            disabled={!mayPickModel}
          />
        </Field>
      </div>
      <Field label="Description" hint="What it covers, which pages matter, who issued it">
        <textarea rows={3} value={form.description} onChange={(e) => set('description', e.target.value)} />
      </Field>
    </Modal>
  );
}

// ── One document ────────────────────────────────────────────────────────────

export function ServiceDocumentDetail() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [row, setRow] = useState<DocumentDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [modifying, setModifying] = useState(false);
  const confirm = useConfirm();

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setRow(await api.get<DocumentDetail>(`/service-documents/${id}`));
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Loading />;
  if (!row) return <ErrorBox error={error ?? new Error('Service document not found')} />;
  const r = row;

  async function withdraw(active: boolean) {
    await api.patch(`/service-documents/${r.id}`, { isActive: active });
    toast('ok', active ? 'Current again' : 'Withdrawn');
    await load();
  }

  async function remove() {
    await api.del(`/service-documents/${r.id}`);
    toast('ok', `"${r.title}" deleted`);
    navigate('/g-ops/service-documents');
  }

  return (
    <div>
      <RecordHeader
        type="Service document"
        title={r.title}
        status={r.isActive ? 'CURRENT' : 'WITHDRAWN'}
        statusExtra={{ CURRENT: 'ok', WITHDRAWN: '' }}
        statusLabel={r.isActive ? 'Current' : 'Withdrawn'}
        meta={
          <>
            {r.category.name} · {r.against} · filed by {r.createdBy.name} on {formatDate(r.createdAt)}
          </>
        }
        more={[
          r.canEdit && {
            label: r.isActive ? 'Withdraw' : 'Make current again',
            confirm: {
              title: r.isActive ? `Withdraw "${r.title}"?` : `Make "${r.title}" current again?`,
              body: r.isActive ? 'It stays on file, marked withdrawn, and leaves the machine’s page.' : 'It is listed on the machine’s page again.',
              confirmLabel: r.isActive ? 'Withdraw' : 'Make current',
              onConfirm: () => withdraw(!r.isActive),
            },
          },
          r.canEdit && {
            label: 'Delete',
            danger: true,
            confirm: {
              title: `Delete "${r.title}"?`,
              body: `The record and its ${r.files} file${r.files === 1 ? '' : 's'} go for good. A document somebody may still need is withdrawn instead.`,
              confirmLabel: 'Delete',
              onConfirm: remove,
            },
          },
        ]}
        modify={r.canEdit ? () => setModifying(true) : undefined}
        confirm={confirm}
      />

      <ErrorBox error={error} />

      <div className="svc-detail-grid">
        <section className="card">
          <h3 className="card-title">The document</h3>
          <dl className="kv">
            <dt>Category</dt>
            <dd>{r.category.name}</dd>
            <dt>Version</dt>
            <dd>{r.version ?? '—'}</dd>
            <dt>Dated</dt>
            <dd>{r.documentDate ? formatDate(r.documentDate) : '—'}</dd>
            <dt>Description</dt>
            <dd>{r.description ?? <span className="faint">—</span>}</dd>
            <dt>Filed</dt>
            <dd>
              {formatDate(r.createdAt)} by {r.createdBy.name}
            </dd>
          </dl>
        </section>
        <section className="card">
          <h3 className="card-title">Filed against</h3>
          <dl className="kv">
            <dt>Machine</dt>
            <dd>
              {r.asset ? (
                <>
                  {can('gops.installed_base.view_all') || can('gops.installed_base.view_own') ? <Link to={`/g-ops/installed-base/${r.asset.id}`}>{r.asset.name}</Link> : r.asset.name}
                  <span className="faint"> {[r.asset.model, r.asset.serialNo].filter(Boolean).join(' · ')}</span>
                  <div className="faint">{r.asset.customer.name}</div>
                </>
              ) : (
                <span className="faint">—</span>
              )}
            </dd>
            <dt>Model</dt>
            <dd>
              {r.item ? (
                <>
                  {can('gchain.items.view_all') ? <Link to={`/g-chain/items/${r.item.id}`}>{r.item.name}</Link> : r.item.name}
                  <span className="faint"> {[r.item.brand, r.item.partNumber, r.item.code].filter(Boolean).join(' · ')}</span>
                  <div className="faint">Every machine of this model reads it</div>
                </>
              ) : (
                <span className="faint">—</span>
              )}
            </dd>
          </dl>
        </section>
      </div>

      <Attachments entityType="service_document" entityId={r.id} title="The file" hint="The PDF, the drawing (DWG, DXF, PDF) or the scan — a CAD file takes the CAD ceiling" canEdit={r.canEdit} />

      {modifying && (
        <ServiceDocumentModal
          existing={r}
          onClose={() => setModifying(false)}
          onSaved={() => {
            setModifying(false);
            void load();
          }}
        />
      )}
    </div>
  );
}
