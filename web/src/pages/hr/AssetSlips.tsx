import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { Attachments } from '../../components/Attachments';
import { TickPicker } from '../../components/TickPicker';
import { Empty, ErrorBox, Field, Loading, Modal, ModalFoot, StatusBadge, formatDate, formatDateTime, useToast } from '../../components/ui';

/**
 * Several assets on one slip, acknowledged by the holder (2026-11-13, the
 * owner's call: "issuance of tools can be list — they have to acknowledge, and
 * a PDF document stored on asset management linking to who acknowledged it").
 * HR ticks the available assets and the person; each asset is issued with its
 * own record (returned one by one, as before) and the slip groups them. The
 * holder opens the slip from their bell and presses Acknowledge receipt once;
 * the slip's PDF, their name with the date and time as the signature, is then
 * filed on the slip.
 */

export interface Slip {
  id: string;
  number: string;
  issuedOn: string;
  conditionOut: string | null;
  remarks: string | null;
  createdAt: string;
  issuedBy: { id: string; name: string };
  employee: { id: string; name: string; employeeNo: string | null; title: string | null; team: string | null };
  acknowledgedAt: string | null;
  acknowledgedBy: { id: string; name: string } | null;
  pdfAttachmentId: string | null;
  items: { issuanceId: string; assetId: string; tag: string; type: string; brandModel: string; details: string; returnedOn: string | null; conditionBack: string | null }[];
  canAcknowledge: boolean;
}

interface EmployeeHit {
  id: string;
  employeeNo: string | null;
  firstName: string;
  lastName: string;
  position: string | null;
  industry: { code: string } | null;
}

interface AvailableAsset {
  id: string;
  tag: string;
  brandModel: string;
  details: string;
  assetType: { name: string };
}

const todayKey = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

const ackBadge = (s: Pick<Slip, 'acknowledgedAt'>) =>
  s.acknowledgedAt ? <StatusBadge status="ACKNOWLEDGED" extra={{ ACKNOWLEDGED: 'ok' }} label="Acknowledged" /> : <StatusBadge status="PENDING" extra={{ PENDING: 'warn' }} label="Awaiting acknowledgement" />;

/** Issue several available assets to one employee on one slip. `preset` are assets ticked on the list. */
export function IssueBatchModal({ preset = [], onClose, onDone }: { preset?: string[]; onClose: () => void; onDone: (slipId: string) => void }) {
  const toast = useToast();
  const [term, setTerm] = useState('');
  const [found, setFound] = useState<EmployeeHit[]>([]);
  const [picked, setPicked] = useState<EmployeeHit | null>(null);
  const [assets, setAssets] = useState<AvailableAsset[]>([]);
  const [ticked, setTicked] = useState<string[]>(preset);
  const [issuedOn, setIssuedOn] = useState(todayKey());
  const [conditionOut, setConditionOut] = useState('Good');
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api
      .get<{ rows: AvailableAsset[] }>(`/assets${qs({ status: 'AVAILABLE', scope: 'all', pageSize: 200 })}`)
      .then((r) => setAssets(r.rows))
      .catch(setError);
  }, []);
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
    if (!picked || !ticked.length) return;
    setBusy(true);
    setError(null);
    try {
      const slip = await api.post<Slip>('/assets/issue-batch', { employeeId: picked.id, assetIds: ticked, issuedOn, conditionOut: conditionOut.trim() || null, remarks: remarks.trim() || null });
      toast('ok', `${slip.number}: ${ticked.length} asset${ticked.length === 1 ? '' : 's'} issued — ${picked.firstName} is asked to acknowledge`);
      onDone(slip.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  const tickedRows = assets.filter((a) => ticked.includes(a.id));
  return (
    <Modal
      title="Issue several assets"
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button type="button" className="btn btn-primary" disabled={busy || !picked || !ticked.length} onClick={() => void issue()}>
            {busy ? 'Issuing…' : `Issue ${ticked.length || ''} on one slip`}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <Field label="Issue to" hint="An active employee — they are asked to acknowledge the slip">
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
            <input value={term} placeholder="Type a name or employee no.…" onChange={(e) => setTerm(e.target.value)} autoFocus autoComplete="off" />
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
      <Field label="Assets" hint="Tick every available asset going out together — search by tag, type or brand">
        <TickPicker
          search
          label="Assets"
          none="Tick the assets"
          noun="assets"
          choices={assets.map((a) => ({ value: a.id, label: `${a.tag} — ${a.assetType.name}`, hint: [a.brandModel, a.details].filter(Boolean).join(' · ') }))}
          value={ticked}
          onChange={setTicked}
        />
      </Field>
      {tickedRows.length > 0 && (
        <ul className="faint asset-hits">
          {tickedRows.map((a) => (
            <li key={a.id}>
              {a.tag} — {a.assetType.name} · {a.brandModel}
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-2">
        <Field label="Date issued">
          <input type="date" value={issuedOn} max={todayKey()} onChange={(e) => setIssuedOn(e.target.value)} />
        </Field>
        <Field label="Condition">
          <input value={conditionOut} onChange={(e) => setConditionOut(e.target.value)} />
        </Field>
      </div>
      <Field label="Remarks" hint="What they are for, what goes with them">
        <textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
      </Field>
    </Modal>
  );
}

/** The slip: what went out together, who has acknowledged, and the stored PDF. */
export function AssetSlipPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const confirm = useConfirm();
  const [row, setRow] = useState<Slip | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const load = useCallback(async () => {
    try {
      setRow(await api.get<Slip>(`/assets/slips/${id}`));
      setError(null);
      setReload((r) => r + 1);
    } catch (err) {
      setError(err);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  if (error && !row) return <ErrorBox error={error} />;
  if (!row) return <Loading />;
  async function acknowledge() {
    await api.post(`/assets/slips/${id}/acknowledge`, {});
    toast('ok', 'Acknowledged — the signed slip is filed');
    await load();
  }
  return (
    <div className="stack">
      <RecordHeader
        type="Issuance slip"
        code={row.number}
        title={`${row.items.length} asset${row.items.length === 1 ? '' : 's'} to ${row.employee.name}`}
        status={row.acknowledgedAt ? 'ACKNOWLEDGED' : 'PENDING'}
        statusLabel={row.acknowledgedAt ? 'Acknowledged' : 'Awaiting acknowledgement'}
        statusExtra={{ ACKNOWLEDGED: 'ok', PENDING: 'warn' }}
        meta={
          <>
            Issued {formatDate(row.issuedOn)} by {row.issuedBy.name}
            {row.employee.team ? ` · ${row.employee.team}` : ''}
          </>
        }
        actions={
          row.canAcknowledge && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() =>
                confirm.ask({
                  title: `Acknowledge ${row.number}?`,
                  body: `You confirm you received the ${row.items.length} asset${row.items.length === 1 ? '' : 's'} listed, in the condition stated. Your name, the date and the time are the signature on the slip.`,
                  confirmLabel: 'Acknowledge receipt',
                  tone: 'primary',
                  onConfirm: acknowledge,
                })
              }
            >
              Acknowledge receipt
            </button>
          )
        }
        print={`/api/assets/slips/${row.id}/pdf`}
        confirm={confirm}
      />
      <ErrorBox error={error} />
      {row.canAcknowledge && <div className="alert warn">Check the list below, then press Acknowledge receipt. You answer for each asset until it is received back.</div>}
      {row.acknowledgedAt && (
        <div className="alert ok">
          Acknowledged by {row.employee.name} on {formatDateTime(row.acknowledgedAt)}.
        </div>
      )}
      <section className="card">
        <h3 className="card-title">Assets on this slip</h3>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Type</th>
                <th>Serial / plate</th>
                <th>Returned</th>
              </tr>
            </thead>
            <tbody>
              {row.items.map((i) => (
                <tr key={i.issuanceId}>
                  <td>
                    <Link to={`/g-hr/assets/${i.assetId}`} className="mono">
                      {i.tag}
                    </Link>
                    <div className="faint">{i.brandModel}</div>
                  </td>
                  <td>{i.type}</td>
                  <td>{i.details || '—'}</td>
                  <td>{i.returnedOn ? `${formatDate(i.returnedOn)}${i.conditionBack ? ` — ${i.conditionBack}` : ''}` : <span className="faint">still out</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="kv">
          <dt>Issued to</dt>
          <dd>
            {row.employee.name} {row.employee.employeeNo && <span className="faint mono">{row.employee.employeeNo}</span>}
          </dd>
          <dt>Condition out</dt>
          <dd>{row.conditionOut ?? '—'}</dd>
          {row.remarks && (
            <>
              <dt>Remarks</dt>
              <dd>{row.remarks}</dd>
            </>
          )}
        </dl>
      </section>
      <Attachments
        key={reload}
        entityType="asset_slip"
        entityId={row.id}
        title="Acknowledged slip"
        hint={row.acknowledgedAt ? 'The slip as acknowledged, stamped with who and when' : 'Filed here once the holder acknowledges'}
        canEdit={false}
      />
    </div>
  );
}

/** Every slip — HR's — or one's own, with those still waiting for acknowledgement. */
export function AssetSlips() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [data, setData] = useState<{ rows: Slip[]; pending: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [issuing, setIssuing] = useState(false);
  useEffect(() => {
    api
      .get<{ rows: Slip[]; pending: number }>(`/assets/slips${qs({ pending: pending ? 'true' : undefined })}`)
      .then(setData)
      .catch(setError);
  }, [pending]);
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Issuance Slips</h1>
        </div>
        {can('ghr.assets.edit_all') || can('ghr.assets.edit_own') ? (
          <button type="button" className="btn btn-primary" onClick={() => setIssuing(true)}>
            + Issue several assets
          </button>
        ) : null}
      </div>
      <div className="card">
        <div className="card-head">
          <div className="scope-switch" role="group" aria-label="Which slips">
            <button type="button" className={pending ? '' : 'active'} aria-pressed={!pending} onClick={() => setPending(false)}>
              All
            </button>
            <button type="button" className={pending ? 'active' : ''} aria-pressed={pending} onClick={() => setPending(true)}>
              Awaiting acknowledgement{data ? ` (${data.pending})` : ''}
            </button>
          </div>
        </div>
        <ErrorBox error={error} />
        {!data ? (
          <Loading />
        ) : data.rows.length === 0 ? (
          <Empty title={pending ? 'Nothing waiting for acknowledgement' : 'No issuance slips yet'} />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Slip</th>
                  <th>Issued to</th>
                  <th>Assets</th>
                  <th>Issued</th>
                  <th>Acknowledgement</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((s) => (
                  <tr key={s.id} tabIndex={0} onClick={() => navigate(`/g-hr/assets/slips/${s.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/g-hr/assets/slips/${s.id}`)}>
                    <td>
                      <Link to={`/g-hr/assets/slips/${s.id}`} className="mono" onClick={(e) => e.stopPropagation()}>
                        {s.number}
                      </Link>
                    </td>
                    <td>
                      {s.employee.name}
                      <div className="faint">{[s.employee.employeeNo, s.employee.team].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td>
                      {s.items.length}
                      <div className="faint">{s.items.slice(0, 3).map((i) => i.tag).join(', ')}{s.items.length > 3 ? '…' : ''}</div>
                    </td>
                    <td>
                      {formatDate(s.issuedOn)}
                      <div className="faint">by {s.issuedBy.name}</div>
                    </td>
                    <td>
                      {ackBadge(s)}
                      {s.acknowledgedAt && <div className="faint">{formatDateTime(s.acknowledgedAt)}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {issuing && (
        <IssueBatchModal
          onClose={() => setIssuing(false)}
          onDone={(slipId) => {
            setIssuing(false);
            navigate(`/g-hr/assets/slips/${slipId}`);
          }}
        />
      )}
    </div>
  );
}
