import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { parseDay } from '../../lib/day';
import { DataList, type Column } from '../../components/DataList';
import { Stat } from '../../components/charts';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { Attachments } from '../../components/Attachments';
import { PeoplePicker, type Person } from '../../components/PeoplePicker';
import { TickPicker } from '../../components/TickPicker';
import { Empty, ErrorBox, Field, Loading, Modal, ModalFoot, StatusBadge, formatDate, formatDateTime, useToast, type Tone } from '../../components/ui';

/**
 * G-HR › Records › MEMOS (2026-10-20, the owner's G-HR Records spec). HR
 * drafts a memorandum, addresses it — everyone, teams, positions or named
 * people — and issues it; each recipient acknowledges it once, and the
 * register shows who has. A memo addressed to someone opens for them with no
 * right (the API decides), so the page carries no Guard.
 */

type Audience = 'ALL' | 'TEAMS' | 'POSITIONS' | 'PEOPLE';
interface MemoRow {
  id: string;
  number: string | null;
  status: 'DRAFT' | 'ISSUED' | 'ARCHIVED';
  title: string;
  issuingOffice: string | null;
  audience: Audience;
  audienceLabel: string;
  memoDate: string | null;
  issuedAt: string | null;
  issuedBy: { id: string; name: string } | null;
  createdBy: { id: string; name: string };
  recipients: number;
  acknowledged: number;
}
interface MemoDetail extends MemoRow {
  body: string;
  teamIds: string[];
  positionIds: string[];
  employeeIds: string[];
  archivedAt: string | null;
  remindedAt: string | null;
  recipientsList: {
    employeeId: string;
    name: string;
    employeeNo: string | null;
    position: string | null;
    team: string | null;
    acknowledgedAt: string | null;
    reply: string | null;
    repliedAt: string | null;
  }[];
  mine: { acknowledgedAt: string | null; reply: string | null; repliedAt: string | null } | null;
  canEdit: boolean;
  canIssue: boolean;
  canRemind: boolean;
  canArchive: boolean;
  canRestore: boolean;
  canAcknowledge: boolean;
  canPullBack: boolean;
  canDelete: boolean;
  canReply: boolean;
  seesRecipients: boolean;
}
interface Summary {
  issued: number;
  drafts: number;
  archived: number;
  unacknowledged: number;
}

export const MEMO_TONES: Record<string, Tone> = { DRAFT: '', ISSUED: 'ok', ARCHIVED: '' };
export const MEMO_LABEL: Record<string, string> = { DRAFT: 'Draft', ISSUED: 'Issued', ARCHIVED: 'Archived' };
const AUDIENCE_LABEL: Record<Audience, string> = { ALL: 'All employees', TEAMS: 'Teams', POSITIONS: 'Positions', PEOPLE: 'Named people' };
const dateOf = (d: string | null) => (d ? formatDate(parseDay(d)) : '—');

export function Memos() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(params.get('new') === '1');

  const columns: Column<MemoRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', render: (r) => <span className="mono">{r.number ?? 'Draft'}</span> },
    {
      key: 'title',
      label: 'Memo',
      sortKey: 'title',
      render: (r) => (
        <>
          <strong>{r.title}</strong>
          {r.issuingOffice && <div className="faint">{r.issuingOffice}</div>}
        </>
      ),
    },
    { key: 'audience', label: 'Issued to', render: (r) => r.audienceLabel },
    { key: 'issuedBy', label: 'Issued by', render: (r) => r.issuedBy?.name ?? <span className="faint">—</span> },
    { key: 'memoDate', label: 'Date', sortKey: 'memoDate', render: (r) => dateOf(r.memoDate) },
    {
      key: 'acknowledged',
      label: 'Acknowledged',
      align: 'right',
      render: (r) => (r.status === 'DRAFT' ? <span className="faint">—</span> : <span className="mono">{r.acknowledged} of {r.recipients}</span>),
    },
    { key: 'status', label: 'Status', render: (r) => <StatusBadge status={r.status} extra={MEMO_TONES} label={MEMO_LABEL[r.status]} /> },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Memos</h1>
        </div>
      </div>
      <DataList<MemoRow>
        listKey="memos"
        endpoint="/memos"
        printPath="/api/memos/pdf"
        columns={columns}
        rowKey={(r) => r.id}
        scoped
        // Mine here is the memos one DRAFTED; what was sent to one is My Records › Memos Received.
        mineLabel="Drafted by me"
        selectable
        searchPlaceholder="Search number, title, text…"
        emptyTitle="No memos yet"
        onRowClick={(r) => navigate(`/g-hr/memos/${r.id}`)}
        filters={[
          { key: 'status', label: 'Status', options: [{ value: 'DRAFT', label: 'Draft' }, { value: 'ISSUED', label: 'Issued' }, { value: 'ARCHIVED', label: 'Archived' }] },
          { key: 'audience', label: 'Issued to', options: (Object.keys(AUDIENCE_LABEL) as Audience[]).map((a) => ({ value: a, label: AUDIENCE_LABEL[a] })) },
          { key: 'pending', label: 'Acknowledgement', options: [{ value: 'true', label: 'Someone has not acknowledged' }] },
        ]}
        summary={(raw) => {
          const s = raw as unknown as Summary | undefined;
          return s ? (
            <>
              <Stat label="Issued" value={s.issued} />
              <Stat label="Awaiting acknowledgement" value={s.unacknowledged} sub="people, across issued memos" accent={s.unacknowledged ? 'warn' : undefined} />
              <Stat label="Drafts" value={s.drafts} />
              <Stat label="Archived" value={s.archived} />
            </>
          ) : null;
        }}
        actions={
          can('ghr.memos.create') ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
              + New memo
            </button>
          ) : null
        }
      />
      {creating && (
        <MemoModal
          onClose={() => {
            setCreating(false);
            if (params.has('new')) {
              const next = new URLSearchParams(params);
              next.delete('new');
              setParams(next, { replace: true });
            }
          }}
          onSaved={(id) => navigate(`/g-hr/memos/${id}`)}
        />
      )}
    </div>
  );
}

// ── The form ────────────────────────────────────────────────────────────────

interface Options {
  teams: { id: string; code: string; name: string }[];
  positions: { id: string; code: string; title: string }[];
  people: Person[];
}

function MemoModal({ existing, onClose, onSaved }: { existing?: MemoDetail; onClose: () => void; onSaved: (id: string) => void }) {
  const toast = useToast();
  const [options, setOptions] = useState<Options | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [reach, setReach] = useState<number | null>(null);
  const [form, setForm] = useState({
    title: existing?.title ?? '',
    issuingOffice: existing ? (existing.issuingOffice ?? '') : 'Human Resources Department',
    memoDate: existing?.memoDate ?? '',
    audience: (existing?.audience ?? 'ALL') as Audience,
    teamIds: existing?.teamIds ?? [],
    positionIds: existing?.positionIds ?? [],
    employeeIds: existing?.employeeIds ?? [],
    body: existing?.body ?? '',
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    api.get<Options>('/memos/options').then(setOptions).catch(setError);
  }, []);

  // How many active people the audience reaches now — the API's own count.
  const audienceKey = JSON.stringify([form.audience, form.teamIds, form.positionIds, form.employeeIds]);
  useEffect(() => {
    const picked = { ALL: true, TEAMS: form.teamIds.length > 0, POSITIONS: form.positionIds.length > 0, PEOPLE: form.employeeIds.length > 0 }[form.audience];
    if (!picked) {
      setReach(null);
      return;
    }
    const t = window.setTimeout(() => {
      api
        .post<{ count: number }>('/memos/reach', { audience: form.audience, teamIds: form.teamIds, positionIds: form.positionIds, employeeIds: form.employeeIds })
        .then((r) => setReach(r.count))
        .catch(() => setReach(null));
    }, 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audienceKey]);

  async function save() {
    setBusy(true);
    setError(null);
    const body = { ...form, issuingOffice: form.issuingOffice.trim() || null, memoDate: form.memoDate || null };
    try {
      if (existing) {
        await api.patch(`/memos/${existing.id}`, body);
        toast('ok', 'Memo saved');
        onSaved(existing.id);
      } else {
        const created = await api.post<{ id: string }>('/memos', body);
        toast('ok', 'Draft saved — attach any files, then issue it');
        onSaved(created.id);
      }
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const incomplete = form.title.trim().length < 3 || !form.body.trim();

  return (
    <Modal
      title={existing ? `Modify memo` : 'New memo'}
      onClose={onClose}
      dirty={!busy && (form.title !== (existing?.title ?? '') || form.body !== (existing?.body ?? ''))}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy || incomplete}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <Field label="Subject" required>
        <input value={form.title} placeholder="Revised office hours during the holidays" onChange={(e) => set('title', e.target.value)} autoFocus />
      </Field>
      <div className="grid grid-2">
        <Field label="From" hint="The issuing office, printed as FROM">
          <input value={form.issuingOffice} onChange={(e) => set('issuingOffice', e.target.value)} />
        </Field>
        <Field label="Date" hint="Blank takes the day it is issued">
          <input type="date" value={form.memoDate} onChange={(e) => set('memoDate', e.target.value)} />
        </Field>
      </div>
      <div className="grid grid-2">
        <Field label="Addressed to" hint={reach === null ? 'Choose who it is for' : `Will go to ${reach} ${reach === 1 ? 'person' : 'people'} on file today`}>
          <select value={form.audience} onChange={(e) => set('audience', e.target.value as Audience)}>
            {(Object.keys(AUDIENCE_LABEL) as Audience[]).map((a) => (
              <option key={a} value={a}>
                {AUDIENCE_LABEL[a]}
              </option>
            ))}
          </select>
        </Field>
        {form.audience === 'TEAMS' && options && (
          <Field label="Teams">
            <TickPicker choices={options.teams.map((t) => ({ value: t.id, label: t.code, hint: t.name }))} value={form.teamIds} onChange={(v) => set('teamIds', v)} none="No team chosen" noun="teams" />
          </Field>
        )}
        {form.audience === 'POSITIONS' && options && (
          <Field label="Positions" hint="Holders of the position, main or also-held">
            <TickPicker choices={options.positions.map((p) => ({ value: p.id, label: p.title, hint: p.code }))} value={form.positionIds} onChange={(v) => set('positionIds', v)} none="No position chosen" noun="positions" />
          </Field>
        )}
      </div>
      {form.audience === 'PEOPLE' && options && (
        <Field label="People">
          <PeoplePicker people={options.people} value={form.employeeIds} onChange={(v) => set('employeeIds', v)} />
        </Field>
      )}
      <Field label="Memorandum" required hint="The text the recipients read and acknowledge">
        <textarea rows={12} value={form.body} onChange={(e) => set('body', e.target.value)} />
      </Field>
    </Modal>
  );
}

// ── One memo ────────────────────────────────────────────────────────────────

export function MemoPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [row, setRow] = useState<MemoDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [modifying, setModifying] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setRow(await api.get<MemoDetail>(`/memos/${id}`));
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
    await api.post(`/memos/${r.id}/${path}`, body);
    toast('ok', ok);
    await load();
  }

  const pending = r.recipientsList.filter((p) => !p.acknowledgedAt);
  return (
    <div>
      <RecordHeader
        type="Memo"
        code={r.number ?? undefined}
        title={r.title}
        status={r.status}
        statusExtra={MEMO_TONES}
        statusLabel={MEMO_LABEL[r.status]}
        meta={
          <>
            To {r.audienceLabel}
            {r.issuedBy ? ` · issued by ${r.issuedBy.name}` : ` · drafted by ${r.createdBy.name}`}
            {r.memoDate ? ` · ${dateOf(r.memoDate)}` : ''}
          </>
        }
        actions={
          <>
            {r.canIssue && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() =>
                  confirm.ask({
                    title: `Issue "${r.title}"?`,
                    body: `It is numbered and sent to ${r.audienceLabel.toLowerCase().startsWith('all') ? 'every active employee' : r.audienceLabel}. Each recipient is told and asked to acknowledge it. An issued memo is not changed.`,
                    confirmLabel: 'Issue memo',
                    tone: 'primary',
                    onConfirm: () => post('issue', {}, 'Memo issued'),
                  })
                }
              >
                Issue memo
              </button>
            )}
            {r.canAcknowledge && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() =>
                  confirm.ask({
                    title: 'Acknowledge this memo?',
                    body: 'You confirm you have read it. The date and time are kept as your acknowledgement.',
                    confirmLabel: 'Acknowledge',
                    tone: 'primary',
                    onConfirm: () => post('acknowledge', {}, 'Acknowledged'),
                  })
                }
              >
                Acknowledge
              </button>
            )}
            {r.canRemind && (
              <button
                type="button"
                className="btn"
                onClick={() =>
                  confirm.ask({
                    title: `Remind ${pending.length} ${pending.length === 1 ? 'person' : 'people'}?`,
                    body: 'Everyone who has not acknowledged it gets a bell (and an email where email is set up). Once a day at most.',
                    confirmLabel: 'Send reminder',
                    tone: 'primary',
                    onConfirm: () => post('remind', {}, 'Reminder sent'),
                  })
                }
              >
                Remind
              </button>
            )}
          </>
        }
        print={`/api/memos/${r.id}/pdf`}
        more={[
          r.canArchive && {
            label: 'Archive',
            confirm: { title: `Archive memo ${r.number}?`, body: 'It stays on every recipient’s list, marked archived.', confirmLabel: 'Archive', onConfirm: () => post('archive', {}, 'Archived') },
          },
          r.canRestore && {
            label: 'Restore',
            confirm: { title: `Restore memo ${r.number}?`, body: 'It reads as issued again.', confirmLabel: 'Restore', tone: 'primary', onConfirm: () => post('archive', { restore: true }, 'Restored') },
          },
          r.canPullBack && {
            label: 'Pull back to draft',
            danger: true,
            confirm: {
              title: `Pull memo ${r.number} back to draft?`,
              body: `It leaves every recipient's list and each is told it was withdrawn. ${r.acknowledged ? `The ${r.acknowledged} acknowledgement${r.acknowledged === 1 ? '' : 's'} given are kept on the audit trail; issued again, everyone acknowledges anew.` : ''} A draft may then be changed, issued again or deleted.`,
              confirmLabel: 'Pull back',
              reason: 'required' as const,
              minReason: 3,
              onConfirm: (reason: string) => post('pull-back', { reason }, 'Pulled back to draft'),
            },
          },
          r.canDelete && {
            label: 'Delete',
            danger: true,
            confirm: {
              title: `Delete the draft "${r.title}"?`,
              body: r.number ? 'The draft and its files go for good. It was issued once and pulled back — that stays on the audit trail.' : 'The draft and its files go for good. Nobody was sent it.',
              confirmLabel: 'Delete',
              onConfirm: async () => {
                await api.del(`/memos/${r.id}`);
                toast('ok', 'Draft deleted');
                navigate('/g-hr/memos');
              },
            },
          },
        ]}
        modify={r.canEdit ? () => setModifying(true) : undefined}
        confirm={confirm}
      />
      <ErrorBox error={error} />

      <div className="stack">
        {r.mine && (
          <div className={`alert ${r.mine.acknowledgedAt ? 'ok' : 'warn'}`}>
            {r.mine.acknowledgedAt
              ? `You acknowledged this memo on ${formatDateTime(r.mine.acknowledgedAt)}.`
              : 'This memo is addressed to you — read it, write an explanation below if one is asked of you, and press Acknowledge.'}
          </div>
        )}
        <section className="card">
          <h3 className="card-title">Memorandum</h3>
          <dl className="kv">
            <dt>To</dt>
            <dd>{r.audienceLabel}</dd>
            <dt>From</dt>
            <dd>{r.issuingOffice ?? r.issuedBy?.name ?? r.createdBy.name}</dd>
            <dt>Date</dt>
            <dd>{r.memoDate ? dateOf(r.memoDate) : <span className="faint">set when issued</span>}</dd>
            <dt>Subject</dt>
            <dd>
              <strong>{r.title}</strong>
            </dd>
          </dl>
          <p className="memo-body">{r.body}</p>
        </section>

        {r.mine && (r.canReply || r.mine.reply) && <MemoReply memoId={r.id} mine={r.mine} canReply={r.canReply} onSaved={load} />}

        <Attachments entityType="memo" entityId={r.id} title="Files" hint="The signed copy, a policy — added while the memo is a draft" canEdit={r.canEdit} />

        {r.seesRecipients && r.status !== 'DRAFT' && (
          <section className="card">
            <div className="card-head">
              <h3 className="card-title">
                Acknowledgements — {r.acknowledged} of {r.recipients}
              </h3>
              {r.remindedAt && <span className="faint">Last reminded {formatDateTime(r.remindedAt)}</span>}
            </div>
            {r.recipientsList.length === 0 ? (
              <Empty title="Nobody was addressed" />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th>Team</th>
                      <th>Explanation</th>
                      <th>Acknowledged</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.recipientsList.map((p) => (
                      <tr key={p.employeeId}>
                        <td>
                          <strong>{p.name}</strong>
                          <div className="faint">{[p.employeeNo, p.position].filter(Boolean).join(' · ')}</div>
                        </td>
                        <td>{p.team ?? <span className="faint">—</span>}</td>
                        <td>
                          {p.reply ? (
                            <>
                              <div className="memo-reply-text">{p.reply}</div>
                              <div className="faint">{p.repliedAt ? formatDateTime(p.repliedAt) : ''}</div>
                            </>
                          ) : (
                            <span className="faint">—</span>
                          )}
                        </td>
                        <td>{p.acknowledgedAt ? formatDateTime(p.acknowledgedAt) : <StatusBadge status="PENDING" label="Not yet" />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </div>

      {modifying && (
        <MemoModal
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

/** The recipient's explanation letter: written in the card before acknowledging, changed until then. */
function MemoReply({
  memoId,
  mine,
  canReply,
  onSaved,
}: {
  memoId: string;
  mine: { reply: string | null; repliedAt: string | null };
  canReply: boolean;
  onSaved: () => Promise<void>;
}) {
  const toast = useToast();
  const [text, setText] = useState(mine.reply ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const dirty = text.trim() !== (mine.reply ?? '');
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/memos/${memoId}/reply`, { text });
      toast('ok', mine.reply ? 'Explanation updated' : 'Explanation sent');
      await onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <div className="card-head">
        <h3 className="card-title">Your explanation</h3>
        {mine.repliedAt && <span className="faint">Sent {formatDateTime(mine.repliedAt)}</span>}
      </div>
      {canReply ? (
        <>
          <Field label="Explanation letter" hint="HR is told. You may change it until you acknowledge the memo.">
            <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <ErrorBox error={error} />
          <div className="card-foot">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !dirty || text.trim().length < 3} onClick={save}>
              {mine.reply ? 'Save explanation' : 'Send explanation'}
            </button>
          </div>
        </>
      ) : (
        <p className="memo-reply-text">{mine.reply}</p>
      )}
    </section>
  );
}

// ── My Records › Memos Received ─────────────────────────────────────────────

interface Received {
  id: string;
  number: string | null;
  title: string;
  issuingOffice: string | null;
  audienceLabel: string;
  issuedBy: { name: string } | null;
  memoDate: string | null;
  archived: boolean;
  acknowledgedAt: string | null;
}

/** The memos addressed to the viewer — or, on the employee record for HR, to that employee. */
export function MemosReceived({ employeeId }: { employeeId?: string } = {}) {
  const [data, setData] = useState<{ rows: Received[]; unacknowledged: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api
      .get<{ rows: Received[]; unacknowledged: number }>(`/memos/received${employeeId ? `?employeeId=${encodeURIComponent(employeeId)}` : ''}`)
      .then(setData)
      .catch(setError);
  }, [employeeId]);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  return (
    <div className="card">
      <div className="card-head">
        <h3 className="card-title">{employeeId ? 'Memos issued to them' : 'Memos received'}</h3>
        {data.unacknowledged > 0 && <StatusBadge status="PENDING" label={`${data.unacknowledged} to acknowledge`} />}
      </div>
      {data.rows.length === 0 ? (
        <Empty title="No memos yet" hint={employeeId ? undefined : 'A memo HR issues to you lands here and on My Work.'} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Reference no.</th>
                <th>Title</th>
                <th>Issued to</th>
                <th>Issued by</th>
                <th>Date</th>
                <th>Acknowledgment</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((m) => (
                <tr key={m.id}>
                  <td>
                    <Link className="mono" to={`/g-hr/memos/${m.id}`}>
                      {m.number}
                    </Link>
                  </td>
                  <td>
                    <strong>{m.title}</strong>
                    {m.archived && <div className="faint">Archived</div>}
                  </td>
                  <td>{m.audienceLabel}</td>
                  <td>
                    {m.issuingOffice ?? m.issuedBy?.name ?? '—'}
                    {m.issuingOffice && m.issuedBy && <div className="faint">{m.issuedBy.name}</div>}
                  </td>
                  <td>{dateOf(m.memoDate)}</td>
                  <td>{m.acknowledgedAt ? <StatusBadge status="ACKNOWLEDGED" extra={{ ACKNOWLEDGED: 'ok' }} label={`Acknowledged ${formatDate(m.acknowledgedAt)}`} /> : <StatusBadge status="PENDING" label="Not yet" />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
