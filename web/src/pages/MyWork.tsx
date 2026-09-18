import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { ErrorBox, Loading, Modal, formatMoney, relativeTime, useToast } from '../components/ui';

interface ApprovalRequest {
  id: string;
  documentType: string;
  documentNumber: string | null;
  subject: string;
  amount: number | null;
  link: string | null;
  status: string;
  createdAt: string;
  actions?: { action: string; comment: string | null; actedAt: string; approver?: { name: string } }[];
}

export function MyWork() {
  const [pending, setPending] = useState<ApprovalRequest[]>([]);
  const [mine, setMine] = useState<ApprovalRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [acting, setActing] = useState<{ request: ApprovalRequest; action: 'APPROVED' | 'REJECTED' | 'RETURNED' } | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, m] = await Promise.all([
        api.get<ApprovalRequest[]>('/approvals/pending'),
        api.get<ApprovalRequest[]>('/approvals/mine'),
      ]);
      setPending(p);
      setMine(m);
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <Loading />;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>My Work</h1>
          <p>
            Everything waiting on you, and everything you are waiting on. One approval engine serves
            every document type, so this queue stays the same as new modules ship.
          </p>
        </div>
      </div>

      <ErrorBox error={error} />

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 className="card-title">
          Awaiting my approval
          {pending.length > 0 && (
            <span className="badge warn" style={{ marginLeft: 8 }}>
              {pending.length}
            </span>
          )}
        </h3>

        {pending.length === 0 ? (
          <div className="muted">Nothing is waiting on you right now.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Subject</th>
                  <th className="right">Amount</th>
                  <th>Raised</th>
                  <th style={{ width: 230 }}>Decision</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.documentNumber ?? r.documentType}</td>
                    <td>{r.subject}</td>
                    <td className="right mono">{r.amount === null ? '—' : formatMoney(r.amount)}</td>
                    <td className="muted">{relativeTime(r.createdAt)}</td>
                    <td>
                      <div className="row">
                        <button
                          className="btn btn-sm btn-ok"
                          onClick={() => setActing({ request: r, action: 'APPROVED' })}
                        >
                          Approve
                        </button>
                        <button
                          className="btn btn-sm"
                          onClick={() => setActing({ request: r, action: 'RETURNED' })}
                        >
                          Return
                        </button>
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() => setActing({ request: r, action: 'REJECTED' })}
                        >
                          Reject
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h3 className="card-title">My submissions</h3>
        {mine.length === 0 ? (
          <div className="muted">You have not submitted anything for approval yet.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Subject</th>
                  <th>Status</th>
                  <th>Submitted</th>
                  <th>Last decision</th>
                </tr>
              </thead>
              <tbody>
                {mine.map((r) => {
                  const last = r.actions?.[r.actions.length - 1];
                  return (
                    <tr key={r.id}>
                      <td className="mono">{r.documentNumber ?? r.documentType}</td>
                      <td>{r.subject}</td>
                      <td>
                        <span
                          className={`badge ${
                            r.status === 'APPROVED' ? 'ok' : r.status === 'PENDING' ? 'warn' : 'danger'
                          }`}
                        >
                          {r.status}
                        </span>
                      </td>
                      <td className="muted">{relativeTime(r.createdAt)}</td>
                      <td className="muted">
                        {last
                          ? `${last.action} by ${last.approver?.name ?? '—'}${
                              last.comment ? ` — ${last.comment}` : ''
                            }`
                          : 'Not yet acted on'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {acting && (
        <DecisionModal
          request={acting.request}
          action={acting.action}
          onClose={() => setActing(null)}
          onDone={async (verb) => {
            setActing(null);
            toast('ok', `${acting.request.subject} — ${verb}`);
            await load();
          }}
        />
      )}
    </div>
  );
}

function DecisionModal({
  request,
  action,
  onClose,
  onDone,
}: {
  request: ApprovalRequest;
  action: 'APPROVED' | 'REJECTED' | 'RETURNED';
  onClose: () => void;
  onDone: (verb: string) => void;
}) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const verb = action === 'APPROVED' ? 'approved' : action === 'REJECTED' ? 'rejected' : 'returned';

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/approvals/${request.id}/act`, { action, comment: comment || undefined });
      onDone(verb);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`${verb[0].toUpperCase()}${verb.slice(1)} — ${request.documentNumber ?? request.documentType}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className={`btn ${action === 'APPROVED' ? 'btn-ok' : 'btn-danger'}`}
            onClick={submit}
            disabled={busy}
          >
            {busy ? 'Working…' : `Confirm ${verb}`}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <p className="muted" style={{ marginTop: 0 }}>
        {request.subject}
        {request.amount !== null && ` · ${formatMoney(request.amount)}`}
      </p>
      <div className="field">
        <label>Comment {action === 'APPROVED' ? '(optional)' : '(recommended)'}</label>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder={
            action === 'APPROVED'
              ? 'Anything the requester should know'
              : 'Say what needs to change — this is what the requester sees'
          }
        />
      </div>
      <p className="faint" style={{ fontSize: 12 }}>
        This decision is recorded against the document permanently, with your name and the time.
      </p>
    </Modal>
  );
}
