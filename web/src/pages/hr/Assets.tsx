import { Icon } from '../../components/Icon';
import { useCallback, useEffect, useId, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, openPdf, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column } from '../../components/DataList';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { Attachments } from '../../components/Attachments';
import { NumberInput } from '../../components/NumberInput';
import { PhotoCard } from '../../components/PhotoCard';
import { Empty, ErrorBox, Field, Loading, Modal, ModalFoot, ProductPicture, StatusBadge, formatDate, formatMoney, useToast, type Tone } from '../../components/ui';
import { Stat } from '../../components/charts';
import { ImportModal, loadImportSpec } from '../../components/ImportModal';

/**
 * G-HR › Records › Asset Management (2026-10-21, the owner's Asset
 * Management tab, beside the Plantilla): the company's tagged property —
 * vehicles, laptops, tools, kits — and who holds each. An asset is one unit
 * with a G-CORE tag; issuing it to an employee and taking it back are its
 * history, and an open issuance is a line on the holder's exit clearance.
 */

type AssetState = 'AVAILABLE' | 'ISSUED' | 'RETURN_PENDING' | 'UNDER_REPAIR' | 'RETIRED';

export const ASSET_TONES: Record<AssetState, Tone> = {
  AVAILABLE: 'ok',
  ISSUED: 'info',
  RETURN_PENDING: 'danger',
  UNDER_REPAIR: 'warn',
  RETIRED: '',
};
export const ASSET_LABEL: Record<AssetState, string> = {
  AVAILABLE: 'Available',
  ISSUED: 'Issued',
  RETURN_PENDING: 'Return pending',
  UNDER_REPAIR: 'Under repair',
  RETIRED: 'Retired',
};

interface Holder {
  issuanceId: string;
  employeeId: string;
  name: string;
  employeeNo: string | null;
  title: string | null;
  team: string | null;
  issuedOn: string;
  conditionOut: string | null;
  remarks: string | null;
  issuedBy: { id: string; name: string };
}

interface AssetRow {
  id: string;
  tag: string;
  brandModel: string;
  /** 1 for a tagged unit; a lot (the Odoo import's "120 swivel clamps") is issued and returned whole. */
  quantity: number;
  /** Its picture — from the Odoo picture import or set on its page. */
  photoId: string | null;
  serialNo: string | null;
  plateNo: string | null;
  description: string | null;
  purchaseDate: string | null;
  cost: number | null;
  status: string;
  state: AssetState;
  notes: string | null;
  retiredReason: string | null;
  details: string;
  assetType: { id: string; name: string };
  createdBy: { id: string; name: string };
  createdAt: string;
  holder: Holder | null;
  returnNotice: string | null;
  canEdit: boolean;
}

interface AssetDetail extends AssetRow {
  seesCost: boolean;
  currency: string;
  history: {
    id: string;
    employeeId: string;
    name: string;
    employeeNo: string | null;
    team: string | null;
    issuedOn: string;
    issuedBy: string;
    conditionOut: string | null;
    remarks: string | null;
    returnedOn: string | null;
    receivedBy: string | null;
    conditionBack: string | null;
    returnNote: string | null;
  }[];
  canIssue: boolean;
  canReturn: boolean;
  canRepair: boolean;
  canRetire: boolean;
  canRestore: boolean;
  canDelete: boolean;
}

interface Summary {
  total: number;
  issued: number;
  available: number;
  returnPending: number;
}

interface AssetType {
  id: string;
  name: string;
  isActive: boolean;
}

function useAssetTypes(activeOnly: boolean) {
  const [rows, setRows] = useState<AssetType[]>([]);
  useEffect(() => {
    api
      .get<AssetType[]>(`/reference/asset-types${activeOnly ? '?active=true' : ''}`)
      .then(setRows)
      .catch(() => setRows([]));
  }, [activeOnly]);
  return rows;
}

const stateBadge = (s: AssetState) => <StatusBadge status={s} extra={ASSET_TONES} label={ASSET_LABEL[s]} />;

const columns: Column<AssetRow>[] = [
  { key: 'tag', label: 'Tag', sortKey: 'tag', optional: true, render: (r) => <span className="mono">{r.tag}</span> },
  {
    key: 'type',
    label: 'Asset type',
    render: (r) => (
      <span className="asset-type-cell">
        <ProductPicture photoId={r.photoId} name={r.brandModel} toneKey={r.assetType.name} className="asset-thumb" />
        <strong>{r.assetType.name}</strong>
      </span>
    ),
  },
  { key: 'brandModel', label: 'Brand & model', sortKey: 'brandModel', render: (r) => (r.quantity > 1 ? `${r.brandModel} (lot of ${r.quantity})` : r.brandModel) },
  {
    key: 'details',
    label: 'Asset details / tag',
    render: (r) => (
      <div>
        <div className="mono">{r.tag}</div>
        {r.details && <div className="faint">{r.details}</div>}
      </div>
    ),
  },
  { key: 'issued', label: 'Date issued', render: (r) => (r.holder ? formatDate(r.holder.issuedOn) : <span className="faint">—</span>) },
  {
    key: 'holder',
    label: 'Issued to (employee & team)',
    render: (r) =>
      r.holder ? (
        <div>
          <strong>{r.holder.name}</strong>
          <div className="faint">{[r.holder.team, r.holder.title].filter(Boolean).join(' · ')}</div>
        </div>
      ) : (
        <span className="faint">—</span>
      ),
  },
  { key: 'status', label: 'Status', sortKey: 'status', render: (r) => stateBadge(r.state) },
  {
    key: 'remarks',
    label: 'Remarks & clearance note',
    render: (r) =>
      r.returnNotice ? <span className="asset-notice"><Icon name="alert" size={14} /> {r.returnNotice}</span> : (r.holder?.remarks ?? r.notes ?? <span className="faint">—</span>),
  },
];

export function Assets() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const types = useAssetTypes(false);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState<{ label: string; columns: never[] } | null>(null);
  const [reload, setReload] = useState(0);
  const mayAdd = can('ghr.assets.create');
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Asset Management</h1>
        </div>
      </div>
      <DataList<AssetRow>
        listKey="company-assets"
        endpoint="/assets"
        printPath="/api/assets/pdf"
        columns={columns}
        rowKey={(r) => r.id}
        scoped
        defaultScope={can('ghr.assets.view_all') ? 'all' : 'mine'}
        selectable
        searchPlaceholder="Search asset, brand, serial / plate, employee…"
        emptyTitle="No assets yet"
        emptyHint="Add the company's vehicles, laptops, tools and kits, then issue each to the person who holds it."
        onRowClick={(r) => navigate(`/g-hr/assets/${r.id}`)}
        reloadToken={reload}
        menuItems={
          mayAdd
            ? [
                {
                  label: 'Import from Odoo…',
                  hint: "Odoo's product export as it comes (.xlsx or .csv) — vehicles, office property and the tools categories, issued to the person each names; checked before anything is saved",
                  onSelect: () => {
                    void loadImportSpec('odoo_assets').then((spec) => {
                      if (spec) setImporting(spec as { label: string; columns: never[] });
                    });
                  },
                },
              ]
            : []
        }
        summary={(raw) => {
          const s = raw as unknown as Summary | undefined;
          return s ? (
            <>
              <Stat label="Total company assets" value={s.total} sub="Vehicles, laptops, tools and kits" />
              <Stat label="Issued assets" value={s.issued} sub="Currently deployed" />
              <Stat label="Available in inventory" value={s.available} sub="Ready for issue" />
              <Stat label="Pending return" value={s.returnPending} sub="Holder is leaving — clearance waits on it" accent={s.returnPending ? 'danger' : undefined} />
            </>
          ) : null;
        }}
        filters={[
          { key: 'view', label: 'View', options: [{ value: 'issued', label: 'Issued assets tracker' }] },
          { key: 'status', label: 'Status', options: (Object.keys(ASSET_LABEL) as AssetState[]).map((s) => ({ value: s, label: ASSET_LABEL[s] })) },
          { key: 'assetTypeId', label: 'Asset type', options: types.map((t) => ({ value: t.id, label: t.name })) },
          { key: 'retired', label: 'Retired', options: [{ value: 'true', label: 'Include retired' }] },
        ]}
        actions={
          mayAdd ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
              + New asset
            </button>
          ) : null
        }
      />
      <section className="alert warn asset-policy">
        <strong>Exit clearance and asset return.</strong> When an employee files for separation, every asset under their name shows here as Pending return and as a line on their clearance, which
        stays open until the asset is taken back. <Link to="/g-hr/clearances">Turnover &amp; Clearance →</Link>
      </section>
      {importing && (
        <ImportModal
          entity="odoo_assets"
          label={importing.label}
          columns={importing.columns}
          onClose={() => setImporting(null)}
          onImported={() => setReload((r) => r + 1)}
        />
      )}
      {adding && (
        <AssetModal
          onClose={() => setAdding(false)}
          onSaved={(id) => {
            setAdding(false);
            navigate(`/g-hr/assets/${id}`);
          }}
        />
      )}
    </div>
  );
}

// ── Add and modify ──────────────────────────────────────────────────────────

function AssetModal({ existing, seesCost, onClose, onSaved }: { existing?: AssetDetail; seesCost?: boolean; onClose: () => void; onSaved: (id: string) => void }) {
  const toast = useToast();
  const { can } = useAuth();
  const idBase = useId();
  const types = useAssetTypes(true);
  const mayCost = seesCost ?? can('ghr.assets.edit_all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState(() => ({
    assetTypeId: existing?.assetType.id ?? '',
    brandModel: existing?.brandModel ?? '',
    serialNo: existing?.serialNo ?? '',
    plateNo: existing?.plateNo ?? '',
    description: existing?.description ?? '',
    purchaseDate: existing?.purchaseDate?.slice(0, 10) ?? '',
    cost: existing?.cost != null ? String(existing.cost) : '',
    notes: existing?.notes ?? '',
  }));
  const set = <K extends keyof typeof form>(k: K, v: string) => setForm((f) => ({ ...f, [k]: v }));
  useEffect(() => {
    if (!form.assetTypeId && types.length) set('assetTypeId', types[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types]);

  async function save() {
    setBusy(true);
    setError(null);
    const body = {
      assetTypeId: form.assetTypeId,
      brandModel: form.brandModel.trim(),
      serialNo: form.serialNo.trim() || null,
      plateNo: form.plateNo.trim() || null,
      description: form.description.trim() || null,
      purchaseDate: form.purchaseDate || null,
      notes: form.notes.trim() || null,
      ...(mayCost ? { cost: form.cost ? Number(form.cost) : null } : {}),
    };
    try {
      if (existing) {
        await api.patch(`/assets/${existing.id}`, body);
        toast('ok', 'Asset saved');
        onSaved(existing.id);
      } else {
        const created = await api.post<{ id: string; tag: string }>('/assets', body);
        toast('ok', `Added — tag ${created.tag}`);
        onSaved(created.id);
      }
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={existing ? `Modify asset ${existing.tag}` : 'New asset'}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy || !form.assetTypeId || form.brandModel.trim().length < 2}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      {!existing && <p className="faint">G-CORE gives it its tag (GT-TAG-…) when saved.</p>}
      <div className="grid grid-2">
        <Field label="Asset type" htmlFor={`${idBase}-type`}>
          <select id={`${idBase}-type`} value={form.assetTypeId} onChange={(e) => set('assetTypeId', e.target.value)}>
            {existing && !types.some((t) => t.id === existing.assetType.id) && <option value={existing.assetType.id}>{existing.assetType.name}</option>}
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Brand & model" htmlFor={`${idBase}-model`}>
          <input id={`${idBase}-model`} value={form.brandModel} placeholder="Toyota Hilux 2.4L (2023)" onChange={(e) => set('brandModel', e.target.value)} autoFocus />
        </Field>
        <Field label="Serial no.">
          <input value={form.serialNo} onChange={(e) => set('serialNo', e.target.value)} />
        </Field>
        <Field label="Plate no." hint="A vehicle's">
          <input value={form.plateNo} onChange={(e) => set('plateNo', e.target.value)} />
        </Field>
        <Field label="Purchase date">
          <input type="date" value={form.purchaseDate} onChange={(e) => set('purchaseDate', e.target.value)} />
        </Field>
        {mayCost && (
          <Field label="Cost" hint="Seen only by whoever may edit every asset">
            <NumberInput kind="money" value={form.cost} onChange={(e) => set('cost', e.target.value)} />
          </Field>
        )}
      </div>
      <Field label="Description" hint="Specifications, accessories that go with it">
        <textarea rows={2} value={form.description} onChange={(e) => set('description', e.target.value)} />
      </Field>
      <Field label="Notes">
        <textarea rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
      </Field>
    </Modal>
  );
}

// ── Issue and take back ─────────────────────────────────────────────────────

interface EmployeeHit {
  id: string;
  employeeNo: string | null;
  firstName: string;
  lastName: string;
  position: string | null;
  industry: { code: string } | null;
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function IssueModal({ asset, onClose, onDone }: { asset: AssetDetail; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const idBase = useId();
  const [term, setTerm] = useState('');
  const [found, setFound] = useState<EmployeeHit[]>([]);
  const [picked, setPicked] = useState<EmployeeHit | null>(null);
  const [issuedOn, setIssuedOn] = useState(today());
  const [conditionOut, setConditionOut] = useState('Good');
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (picked) return;
    const t = setTimeout(() => {
      api
        .get<EmployeeHit[]>(`/employees/lookup${qs({ q: term || undefined, active: 'true' })}`)
        .then(setFound)
        .catch(setError);
    }, 250);
    return () => clearTimeout(t);
  }, [term, picked]);
  async function issue() {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/assets/${asset.id}/issue`, { employeeId: picked.id, issuedOn, conditionOut: conditionOut.trim() || null, remarks: remarks.trim() || null });
      toast('ok', `${asset.tag} issued to ${picked.firstName} ${picked.lastName}`);
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Issue ${asset.tag}`}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button type="button" className="btn btn-primary" disabled={busy || !picked} onClick={() => void issue()}>
            {busy ? 'Issuing…' : 'Issue'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <Field label="Issue to" htmlFor={`${idBase}-who`} hint="An active employee">
        {picked ? (
          <div className="asset-picked">
            <strong>
              {picked.firstName} {picked.lastName}
            </strong>
            <span className="faint"> {[picked.employeeNo, picked.industry?.code, picked.position].filter(Boolean).join(' · ')}</span>
            <button type="button" className="btn btn-sm" onClick={() => setPicked(null)}>
              Change
            </button>
          </div>
        ) : (
          <>
            <input id={`${idBase}-who`} value={term} placeholder="Type a name or employee no.…" onChange={(e) => setTerm(e.target.value)} autoFocus autoComplete="off" />
            <ul className="asset-hits">
              {found.slice(0, 8).map((e) => (
                <li key={e.id}>
                  <button type="button" className="btn btn-sm" onClick={() => setPicked(e)}>
                    {e.firstName} {e.lastName}
                    <span className="faint"> {[e.employeeNo, e.industry?.code, e.position].filter(Boolean).join(' · ')}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </Field>
      <div className="grid grid-2">
        <Field label="Date issued">
          <input type="date" value={issuedOn} max={today()} onChange={(e) => setIssuedOn(e.target.value)} />
        </Field>
        <Field label="Condition">
          <input value={conditionOut} onChange={(e) => setConditionOut(e.target.value)} />
        </Field>
      </div>
      <Field label="Remarks" hint="What it is for, what goes with it">
        <textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
      </Field>
    </Modal>
  );
}

function ReturnModal({ asset, onClose, onDone }: { asset: AssetDetail; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [returnedOn, setReturnedOn] = useState(today());
  const [conditionBack, setConditionBack] = useState('Good');
  const [returnNote, setReturnNote] = useState('');
  const [toRepair, setToRepair] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function take() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/assets/${asset.id}/return`, { returnedOn, conditionBack: conditionBack.trim() || null, returnNote: returnNote.trim() || null, toRepair });
      toast('ok', `${asset.tag} taken back${asset.holder ? ` from ${asset.holder.name}` : ''}`);
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Take back ${asset.tag}`}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void take()}>
            {busy ? 'Saving…' : 'Returned & verified'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <p>
        From <strong>{asset.holder?.name}</strong>, issued {asset.holder ? formatDate(asset.holder.issuedOn) : ''}. Taking it back clears the line on their clearance.
      </p>
      <div className="grid grid-2">
        <Field label="Date returned">
          <input type="date" value={returnedOn} max={today()} onChange={(e) => setReturnedOn(e.target.value)} />
        </Field>
        <Field label="Condition">
          <input value={conditionBack} onChange={(e) => setConditionBack(e.target.value)} />
        </Field>
      </div>
      <Field label="Note" hint="Damage, missing parts, what was checked">
        <textarea rows={2} value={returnNote} onChange={(e) => setReturnNote(e.target.value)} />
      </Field>
      <label className="check">
        <input type="checkbox" checked={toRepair} onChange={(e) => setToRepair(e.target.checked)} /> Send it to repair rather than back to the shelf
      </label>
    </Modal>
  );
}

// ── One asset ───────────────────────────────────────────────────────────────

export function AssetPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [row, setRow] = useState<AssetDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [modifying, setModifying] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [returning, setReturning] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setRow(await api.get<AssetDetail>(`/assets/${id}`));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (error && !row) return <ErrorBox error={error} />;
  if (!row) return <Loading />;
  const r = row;

  async function post(path: string, body: object, ok: string) {
    await api.post(`/assets/${r.id}/${path}`, body);
    toast('ok', ok);
    await load();
  }
  const slip = (issuanceId: string) => openPdf(`/api/assets/${r.id}/issuances/${issuanceId}/pdf`, setError);

  return (
    <div>
      <RecordHeader
        type="Asset"
        code={r.tag}
        title={`${r.assetType.name} — ${r.brandModel}`}
        status={r.state}
        statusExtra={ASSET_TONES}
        statusLabel={ASSET_LABEL[r.state]}
        meta={<>{r.holder ? `Issued to ${r.holder.name}${r.holder.team ? ` (${r.holder.team})` : ''} since ${formatDate(r.holder.issuedOn)}` : `Added by ${r.createdBy.name} on ${formatDate(r.createdAt)}`}</>}
        actions={
          <>
            {r.canIssue && (
              <button type="button" className="btn btn-primary" onClick={() => setIssuing(true)}>
                Issue to employee
              </button>
            )}
            {r.canReturn && (
              <button type="button" className="btn btn-primary" onClick={() => setReturning(true)}>
                Take back
              </button>
            )}
          </>
        }
        print={r.holder ? `/api/assets/${r.id}/issuances/${r.holder.issuanceId}/pdf` : undefined}
        more={[
          r.canRepair && {
            label: r.status === 'UNDER_REPAIR' ? 'Back from repair' : 'Send to repair',
            confirm: {
              title: r.status === 'UNDER_REPAIR' ? `${r.tag} back from repair?` : `Send ${r.tag} to repair?`,
              body: r.status === 'UNDER_REPAIR' ? 'It is available to issue again.' : 'It is not offered for issue until it is back.',
              confirmLabel: r.status === 'UNDER_REPAIR' ? 'Back from repair' : 'Send to repair',
              tone: 'primary' as const,
              onConfirm: () => post('repair', { back: r.status === 'UNDER_REPAIR' }, r.status === 'UNDER_REPAIR' ? 'Available again' : 'Sent to repair'),
            },
          },
          r.canRestore && {
            label: 'Restore',
            confirm: { title: `Restore ${r.tag}?`, body: 'It is available to issue again.', confirmLabel: 'Restore', tone: 'primary' as const, onConfirm: () => post('retire', { restore: true }, 'Restored') },
          },
          r.canRetire && {
            label: 'Retire',
            danger: true,
            confirm: {
              title: `Retire ${r.tag}?`,
              body: 'It stays on file with its history and is never offered for issue again.',
              confirmLabel: 'Retire',
              reason: 'required' as const,
              minReason: 3,
              onConfirm: (reason: string) => post('retire', { reason }, 'Retired'),
            },
          },
          r.canDelete && {
            label: 'Delete',
            danger: true,
            confirm: {
              title: `Delete ${r.tag}?`,
              body: 'It was never issued, so nothing is lost but the record and its files.',
              confirmLabel: 'Delete',
              onConfirm: async () => {
                await api.del(`/assets/${r.id}`);
                toast('ok', `${r.tag} deleted`);
                navigate('/g-hr/assets');
              },
            },
          },
        ]}
        modify={r.canEdit ? () => setModifying(true) : undefined}
        confirm={confirm}
      />
      <ErrorBox error={error} />

      <div className="stack">
        {r.returnNotice && <div className="alert danger"><Icon name="alert" size={16} /> {r.returnNotice}</div>}
        <PhotoCard
          path={`/assets/${r.id}/photo`}
          label="Asset photo"
          shownOn="The register and this page show"
          name={r.brandModel}
          photoId={r.photoId}
          toneKey={r.assetType.name}
          canEdit={r.canEdit}
          onChanged={(photoId) => setRow({ ...r, photoId })}
          onError={setError}
        />
        <div className="grid grid-2">
          <section className="card">
            <h3 className="card-title">The asset</h3>
            <dl className="kv">
              <dt>Tag</dt>
              <dd className="mono">{r.tag}</dd>
              <dt>Asset type</dt>
              <dd>{r.assetType.name}</dd>
              <dt>Brand & model</dt>
              <dd>{r.brandModel}</dd>
              {r.quantity > 1 && (
                <>
                  <dt>Quantity</dt>
                  <dd>A lot of {r.quantity} — issued and returned whole</dd>
                </>
              )}
              <dt>Serial no.</dt>
              <dd>{r.serialNo ?? '—'}</dd>
              <dt>Plate no.</dt>
              <dd>{r.plateNo ?? '—'}</dd>
              <dt>Purchase date</dt>
              <dd>{r.purchaseDate ? formatDate(r.purchaseDate) : '—'}</dd>
              {r.seesCost && (
                <>
                  <dt>Cost</dt>
                  <dd>{r.cost != null ? formatMoney(r.cost, r.currency) : '—'}</dd>
                </>
              )}
              <dt>Description</dt>
              <dd>{r.description ?? '—'}</dd>
              {r.retiredReason && (
                <>
                  <dt>Retired because</dt>
                  <dd>{r.retiredReason}</dd>
                </>
              )}
            </dl>
          </section>
          <section className="card">
            <h3 className="card-title">Held by</h3>
            {r.holder ? (
              <dl className="kv">
                <dt>Employee</dt>
                <dd>
                  <strong>{r.holder.name}</strong>
                  <div className="faint">{[r.holder.employeeNo, r.holder.team, r.holder.title].filter(Boolean).join(' · ')}</div>
                </dd>
                <dt>Since</dt>
                <dd>{formatDate(r.holder.issuedOn)}</dd>
                <dt>Issued by</dt>
                <dd>{r.holder.issuedBy.name}</dd>
                <dt>Condition</dt>
                <dd>{r.holder.conditionOut ?? '—'}</dd>
                <dt>Remarks</dt>
                <dd>{r.holder.remarks ?? '—'}</dd>
              </dl>
            ) : (
              <Empty title="Not issued" hint={r.canIssue ? 'Issue it to the employee who will hold it.' : undefined} />
            )}
          </section>
        </div>

        <section className="card">
          <h3 className="card-title">Issuance history</h3>
          {r.history.length === 0 ? (
            <Empty title="Never issued" />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Issued</th>
                    <th>Returned</th>
                    <th>Condition</th>
                    <th>Slip</th>
                  </tr>
                </thead>
                <tbody>
                  {r.history.map((h) => (
                    <tr key={h.id}>
                      <td>
                        <strong>{h.name}</strong>
                        <div className="faint">{[h.employeeNo, h.team].filter(Boolean).join(' · ')}</div>
                      </td>
                      <td>
                        {formatDate(h.issuedOn)}
                        <div className="faint">by {h.issuedBy}</div>
                      </td>
                      <td>
                        {h.returnedOn ? (
                          <>
                            {formatDate(h.returnedOn)}
                            <div className="faint">received by {h.receivedBy}</div>
                          </>
                        ) : (
                          <StatusBadge status="ISSUED" extra={ASSET_TONES} label="Still out" />
                        )}
                      </td>
                      <td>
                        {h.conditionOut ?? '—'}
                        {h.returnedOn && <div className="faint">back: {h.conditionBack ?? '—'}</div>}
                        {h.returnNote && <div className="faint">{h.returnNote}</div>}
                      </td>
                      <td>
                        <button type="button" className="btn btn-sm" onClick={() => slip(h.id)}>
                          Print
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <Attachments entityType="company_asset" entityId={r.id} title="Files" hint="The receipt, a vehicle's OR/CR, photos" canEdit={r.canEdit} />
      </div>

      {modifying && (
        <AssetModal
          existing={r}
          seesCost={r.seesCost}
          onClose={() => setModifying(false)}
          onSaved={() => {
            setModifying(false);
            void load();
          }}
        />
      )}
      {issuing && (
        <IssueModal
          asset={r}
          onClose={() => setIssuing(false)}
          onDone={() => {
            setIssuing(false);
            void load();
          }}
        />
      )}
      {returning && (
        <ReturnModal
          asset={r}
          onClose={() => setReturning(false)}
          onDone={() => {
            setReturning(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

// ── An employee's assets (their record's tab) ───────────────────────────────

interface HeldRow {
  id: string;
  issuedOn: string;
  returnedOn: string | null;
  conditionOut: string | null;
  conditionBack: string | null;
  receivedBy: { name: string } | null;
  asset: { id: string; tag: string; brandModel: string; details: string; assetType: { name: string } };
}

export function EmployeeAssets({ employeeId }: { employeeId: string }) {
  const [data, setData] = useState<{ rows: HeldRow[]; holding: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api
      .get<{ rows: HeldRow[]; holding: number }>(`/assets/employee/${employeeId}`)
      .then(setData)
      .catch(setError);
  }, [employeeId]);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  if (!data.rows.length) return <Empty title="No company property issued" />;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Asset</th>
            <th>Issued</th>
            <th>Returned</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((h) => (
            <tr key={h.id}>
              <td>
                <Link to={`/g-hr/assets/${h.asset.id}`}>
                  {h.asset.assetType.name} — {h.asset.brandModel}
                </Link>
                <div className="faint">{[h.asset.tag, h.asset.details].filter(Boolean).join(' · ')}</div>
              </td>
              <td>
                {formatDate(h.issuedOn)}
                {h.conditionOut && <div className="faint">{h.conditionOut}</div>}
              </td>
              <td>{h.returnedOn ? `${formatDate(h.returnedOn)}${h.receivedBy ? ` — ${h.receivedBy.name}` : ''}` : <StatusBadge status="ISSUED" extra={ASSET_TONES} label="Still holds it" />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
