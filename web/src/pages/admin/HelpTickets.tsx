import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DataList, type Column, type FilterDef } from '../../components/DataList';
import { RecordHeader } from '../../components/RecordHeader';
import { useConfirm } from '../../components/Confirm';
import { openAttachment } from '../../components/Attachments';
import { Stat } from '../../components/charts';
import { usePeople, toPerson } from '../../components/People';
import { PeoplePicker } from '../../components/PeoplePicker';
import { HELP_KINDS, HELP_STATUS_TONES } from '../../components/HelpDesk';
import { Avatar, Empty, ErrorBox, Field, Loading, StatusBadge, formatDate, formatDateTime, useToast } from '../../components/ui';

/**
 * Admin › Help Tickets (2026-10-11): what people raised from the Help box —
 * the register for the administrators, and each ticket's page, which the
 * person who raised it opens too (from My tickets in the box, or the bell).
 * The API decides who may open one; the page draws what it is told.
 */

interface Person {
  id: string;
  name: string;
  email?: string | null;
  photoPath?: string | null;
}

interface TicketRow {
  id: string;
  number: string;
  kind: string;
  kindLabel: string;
  subject: string;
  status: string;
  statusLabel: string;
  pagePath: string | null;
  createdBy: Person;
  createdAt: string;
  updatedAt: string;
  replies: number;
}

interface TicketSummary {
  count?: number;
  new?: number;
  inProgress?: number;
  done?: number;
  wontDo?: number;
}

const STATUSES = [
  { value: 'NEW', label: 'New' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'DONE', label: 'Done' },
  { value: 'WONT_DO', label: 'Won’t do' },
];

export function HelpTickets() {
  const navigate = useNavigate();
  const { people } = usePeople();

  const columns: Column<TicketRow>[] = [
    { key: 'number', label: 'Number', sortKey: 'number', width: '150px', render: (r) => <span className="mono">{r.number}</span> },
    {
      key: 'subject',
      label: 'Ticket',
      render: (r) => (
        <div>
          <div>{r.subject}</div>
          {r.pagePath && <div className="faint">{r.pagePath}</div>}
        </div>
      ),
    },
    { key: 'kind', label: 'Kind', sortKey: 'kind', render: (r) => r.kindLabel },
    {
      key: 'createdBy',
      label: 'Raised by',
      sortKey: 'createdAt',
      render: (r) => (
        <div>
          <div>{r.createdBy.name}</div>
          <div className="faint">{formatDateTime(r.createdAt)}</div>
        </div>
      ),
    },
    { key: 'replies', label: 'Replies', align: 'right', render: (r) => r.replies },
    { key: 'status', label: 'Status', sortKey: 'status', render: (r) => <StatusBadge status={r.status} extra={HELP_STATUS_TONES} label={r.statusLabel} /> },
  ];

  const filters: FilterDef[] = [
    { key: 'status', label: 'Status', options: STATUSES },
    { key: 'open', label: 'Open', options: [{ value: 'true', label: 'Open — not done or declined' }] },
    { key: 'kind', label: 'Kind', options: HELP_KINDS.map((k) => ({ value: k.value, label: k.label })) },
    { key: 'createdById', label: 'Raised by', options: people.map((p) => ({ value: p.id, label: p.name })) },
    { key: 'createdFrom', toKey: 'createdTo', label: 'Raised', type: 'dateRange' },
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Help Tickets</h1>
        </div>
      </div>
      <ReceiversCard />
      <DataList<TicketRow>
        listKey="help-tickets"
        endpoint="/help-tickets"
        columns={columns}
        filters={filters}
        rowKey={(r) => r.id}
        rowLabel={(r) => `Select ${r.number}`}
        selectable
        printPath="/api/help-tickets/pdf"
        onRowClick={(r) => navigate(`/admin/help-tickets/${r.id}`)}
        searchPlaceholder="Search number, subject, page, person…"
        emptyTitle="No tickets yet"
        emptyHint="What people raise from the Help button, in the top bar of every page, lands here."
        summary={(raw) => {
          const s = raw as TicketSummary;
          return (
            <>
              <Stat label="Tickets" value={s.count ?? 0} />
              <Stat label="New" value={s.new ?? 0} accent={s.new ? 'warn' : undefined} sub="not yet picked up" />
              <Stat label="In progress" value={s.inProgress ?? 0} />
              <Stat label="Done" value={s.done ?? 0} />
              <Stat label="Won’t do" value={s.wontDo ?? 0} />
            </>
          );
        }}
      />
    </div>
  );
}

interface ReceiversInfo {
  receivers: Person[];
  fallback: { id: string; name: string }[];
  canChange: boolean;
}

/**
 * Who receives new tickets (2026-10-11, the owner's call): chosen by a super
 * admin, read by whoever reads the register. The people chosen are told of
 * every new ticket and may answer them; nobody chosen is every super admin.
 */
function ReceiversCard() {
  const toast = useToast();
  const { people } = usePeople();
  const [info, setInfo] = useState<ReceiversInfo | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.get<ReceiversInfo>('/help-tickets/receivers');
      setInfo(data);
      setChosen(data.receivers.map((r) => r.id));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!info) return error ? <ErrorBox error={error} /> : null;
  const saved = info.receivers.map((r) => r.id);
  const dirty = chosen.length !== saved.length || chosen.some((id, i) => id !== saved[i]);
  const nobody = (info.fallback.length ? info.fallback.map((p) => p.name).join(', ') : 'nobody yet');

  async function save() {
    setBusy(true);
    try {
      await api.put('/help-tickets/receivers', { userIds: chosen });
      toast('ok', chosen.length ? 'Saved — new tickets go to the people chosen' : 'Saved — new tickets go to every super admin');
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card help-receivers">
      <h3 className="card-title">Who receives new tickets</h3>
      <p className="faint help-receivers-note">
        They get a bell (and an email where email is set up) for every new ticket, and may answer and close tickets. When nobody is
        chosen, every super admin receives them{info.receivers.length ? '' : ` — now ${nobody}`}.
      </p>
      <ErrorBox error={error} />
      {info.canChange ? (
        <>
          <PeoplePicker people={people.map(toPerson)} value={chosen} onChange={setChosen} max={50} />
          <div className="card-foot">
            <span className="faint">{chosen.length ? `${chosen.length} chosen` : 'Nobody chosen — every super admin'}</span>
            <span className="spacer" />
            <button type="button" className="btn btn-sm" disabled={!dirty || busy} onClick={() => setChosen(saved)}>
              Cancel
            </button>
            <button type="button" className="btn btn-sm btn-primary" disabled={!dirty || busy} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      ) : info.receivers.length ? (
        <ul className="help-receiver-list">
          {info.receivers.map((r) => (
            <li key={r.id}>
              <Avatar name={r.name} photoId={r.photoPath} size={26} />
              {r.name}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// ── One ticket ──────────────────────────────────────────────────────────────

interface TicketFile {
  id: string;
  fileName: string;
  mimeType: string;
}

interface TicketDetail {
  id: string;
  number: string;
  kind: string;
  kindLabel: string;
  subject: string;
  description: string;
  status: string;
  statusLabel: string;
  pagePath: string | null;
  userAgent: string | null;
  viewport: string | null;
  createdBy: Person;
  createdAt: string;
  closedAt: string | null;
  replies: { id: string; author: Person | null; body: string; status: string | null; statusLabel: string | null; createdAt: string }[];
  files: TicketFile[];
  canReply: boolean;
  canManage: boolean;
}

/** A stored picture, fetched with the bearer token and shown; a click opens it full size. */
function Picture({ file }: { file: TicketFile }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    api
      .getBlob(`/attachments/file/${file.id}`)
      .then((blob) => {
        made = URL.createObjectURL(blob);
        if (live) setUrl(made);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [file.id]);
  if (failed) return <p className="faint">{file.fileName} could not be loaded.</p>;
  if (!url) return <Loading label="Loading the picture…" />;
  return (
    <button type="button" onClick={() => void openAttachment(file)} aria-label={`Open ${file.fileName} full size`}>
      <img src={url} alt={file.fileName} />
    </button>
  );
}

export function HelpTicketPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const [row, setRow] = useState<TicketDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState('');

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setRow(await api.get<TicketDetail>(`/help-tickets/${id}`));
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

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      toast('ok', label);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  /** A move asked in the confirm bar: it throws, so a refusal shows in the bar. */
  async function move(status: string, note: string | null, label: string) {
    await api.post(`/help-tickets/${row!.id}/status`, { status, note: note || null });
    toast('ok', label);
    await load();
  }

  if (loading) return <Loading />;
  if (!row) return <ErrorBox error={error ?? new Error('Ticket not found')} />;

  const r = row;
  const own = me?.user.id === r.createdBy.id;
  const closed = r.status === 'DONE' || r.status === 'WONT_DO';

  return (
    <div>
      <RecordHeader
        type="Help Ticket"
        code={r.number}
        title={r.subject}
        status={r.status}
        statusExtra={HELP_STATUS_TONES}
        statusLabel={r.statusLabel}
        meta={
          <>
            {r.kindLabel} · raised by {r.createdBy.name} on {formatDateTime(r.createdAt)}
            {r.closedAt ? ` · closed ${formatDate(r.closedAt)}` : ''}
          </>
        }
        actions={
          r.canManage ? (
            <>
              {r.status === 'NEW' && (
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run('Marked in progress', () => api.post(`/help-tickets/${r.id}/status`, { status: 'IN_PROGRESS' }))}>
                  Start on it
                </button>
              )}
              {!closed && (
                <button
                  type="button"
                  className={r.status === 'IN_PROGRESS' ? 'btn btn-primary' : 'btn'}
                  disabled={busy}
                  onClick={() =>
                    confirm.ask({
                      title: `Mark ${r.number} done?`,
                      body: `${r.createdBy.name} is told. If they reply, it opens again.`,
                      confirmLabel: 'Mark done',
                      reason: 'optional',
                      reasonLabel: 'What was done (they read it)',
                      tone: 'primary',
                      onConfirm: (note) => move('DONE', note, 'Marked done'),
                    })
                  }
                >
                  Mark done
                </button>
              )}
              {closed && (
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run('Opened again', () => api.post(`/help-tickets/${r.id}/status`, { status: 'IN_PROGRESS' }))}>
                  Open again
                </button>
              )}
            </>
          ) : undefined
        }
        more={[
          r.canManage &&
            !closed && {
              label: 'Won’t do',
              danger: true,
              confirm: {
                title: `Decline ${r.number}?`,
                body: `${r.createdBy.name} is told, with your reason.`,
                confirmLabel: 'Won’t do',
                reason: 'required',
                minReason: 3,
                reasonLabel: 'Why will it not be done?',
                onConfirm: (note) => move('WONT_DO', note, 'Declined'),
              },
            },
        ]}
        confirm={confirm}
      />

      <ErrorBox error={error} />
      {own && closed && <div className="alert info">This ticket is {r.statusLabel.toLowerCase()}. If it is not, reply below — that opens it again.</div>}

      <div className="grid-2">
        <section className="card">
          <h3 className="card-title">The ticket</h3>
          <p className="help-description">{r.description}</p>
          <dl className="kv">
            <dt>Kind</dt>
            <dd>{r.kindLabel}</dd>
            <dt>Raised by</dt>
            <dd>
              {r.createdBy.name}
              {r.createdBy.email ? <span className="faint"> · {r.createdBy.email}</span> : null}
            </dd>
            <dt>Raised</dt>
            <dd>{formatDateTime(r.createdAt)}</dd>
            <dt>Page</dt>
            <dd>{r.pagePath ? <Link to={r.pagePath}>{r.pagePath}</Link> : '—'}</dd>
            {r.viewport && (
              <>
                <dt>Window</dt>
                <dd>{r.viewport}</dd>
              </>
            )}
            {r.userAgent && (
              <>
                <dt>Browser</dt>
                <dd className="faint">{r.userAgent}</dd>
              </>
            )}
          </dl>
        </section>

        <section className="card">
          <h3 className="card-title">
            Screenshots
            {r.files.length ? <span className="badge">{r.files.length}</span> : null}
          </h3>
          {r.files.length ? (
            <div className="help-gallery">
              {r.files.map((f) => (
                <Picture key={f.id} file={f} />
              ))}
            </div>
          ) : (
            <Empty title="No picture" hint="It was sent without a screenshot." />
          )}
        </section>
      </div>

      <section className="card">
        <h3 className="card-title">
          Thread
          {r.replies.length ? <span className="badge">{r.replies.length}</span> : null}
        </h3>
        {r.replies.length === 0 ? (
          <Empty title="No answer yet" hint={r.canManage ? 'Your reply reaches the person who raised it.' : 'You are told here and by the bell when it is answered.'} />
        ) : (
          <ul className="help-thread">
            {r.replies.map((c) => (
              <li key={c.id} className="help-reply">
                <Avatar name={c.author?.name ?? 'Former user'} photoId={c.author?.photoPath} size={32} />
                <div className="help-reply-body">
                  <div className="help-reply-meta">
                    <strong>{c.author?.name ?? 'Former user'}</strong>
                    <span>{formatDateTime(c.createdAt)}</span>
                    {c.status && <StatusBadge status={c.status} extra={HELP_STATUS_TONES} label={c.statusLabel ?? undefined} />}
                  </div>
                  {c.body ? <p className="help-reply-text">{c.body}</p> : <p className="help-reply-text faint">Marked {c.statusLabel?.toLowerCase()}.</p>}
                </div>
              </li>
            ))}
          </ul>
        )}
        {r.canReply && (
          <div className="help-compose">
            <Field label={own ? 'Add to your ticket' : `Reply to ${r.createdBy.name}`}>
              <textarea rows={3} value={reply} maxLength={10000} onChange={(e) => setReply(e.target.value)} />
            </Field>
            <div className="help-compose-foot">
              <span className="faint">{own && closed ? 'Replying opens it again.' : own ? 'The administrators are told.' : `${r.createdBy.name} is told.`}</span>
              <span className="spacer" />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy || !reply.trim()}
                onClick={() =>
                  void run('Sent', async () => {
                    await api.post(`/help-tickets/${r.id}/replies`, { body: reply.trim() });
                    setReply('');
                  })
                }
              >
                Send
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
