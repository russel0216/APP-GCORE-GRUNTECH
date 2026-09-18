import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, SHIPPED_PHASE } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Loading, formatMoney, relativeTime } from '../components/ui';

/**
 * The home screen.
 *
 * The division cards are retained from the existing G-CORE landing, as asked.
 * What is new is everything below them: My Work. A launcher tells you where the
 * departments are; My Work tells you what the business needs from you today.
 * That is the shift from a menu-driven system to a process-driven one
 * (model §8).
 */

interface MyWork {
  awaitingMyApproval: {
    id: string;
    subject: string;
    documentType: string;
    documentNumber: string | null;
    amount: number | null;
    link: string | null;
    createdAt: string;
  }[];
  myPendingSubmissions: {
    id: string;
    subject: string;
    documentType: string;
    documentNumber: string | null;
    link: string | null;
    createdAt: string;
  }[];
  unreadNotifications: number;
  recentActivity: {
    id: string;
    entityType: string;
    action: string;
    summary: string | null;
    at: string;
  }[];
  assignedToMe: unknown[];
  todaysSchedule: unknown[];
}

export function Home() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const [work, setWork] = useState<MyWork | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<MyWork>('/my-work')
      .then(setWork)
      .catch(() => setWork(null))
      .finally(() => setLoading(false));
  }, []);

  const divisions = (me?.menu ?? []).filter((m) => m.key !== 'admin');
  const admin = me?.menu.find((m) => m.key === 'admin');

  return (
    <div>
      <div style={{ textAlign: 'center', padding: '10px 0 26px' }}>
        <h1 className="wordmark" style={{ fontSize: 36 }}>
          G-CORE
        </h1>
        <div className="wordmark-sub">{me?.company?.name ?? 'Gruntechnology Corp'}</div>
      </div>

      <div className="division-grid" style={{ marginBottom: 30 }}>
        {divisions.map((mod) => {
          const live = mod.submodules.filter((s) => s.phase <= SHIPPED_PHASE);
          const target = live[0]?.path ?? mod.submodules[0]?.path ?? '/';
          return (
            <Link key={mod.key} to={target} className="division-card">
              <div className="label">{mod.label}</div>
              <div className="blurb">{mod.blurb}</div>
              <div className="count">
                {live.length > 0
                  ? `${live.length} of ${mod.submodules.length} screens available`
                  : `${mod.submodules.length} screens — ships in a later phase`}
              </div>
            </Link>
          );
        })}
        {admin && (
          <Link to="/admin/users" className="division-card">
            <div className="label">ADMIN</div>
            <div className="blurb">{admin.blurb}</div>
            <div className="count">{admin.submodules.length} screens available</div>
          </Link>
        )}
      </div>

      <h2 className="card-title" style={{ fontSize: 13, letterSpacing: 3 }}>
        My Work
      </h2>

      {loading ? (
        <Loading />
      ) : !work ? (
        <div className="card muted">My Work could not be loaded.</div>
      ) : (
        <div className="grid grid-2">
          <div className="card">
            <h3 className="card-title">
              Awaiting my approval
              {work.awaitingMyApproval.length > 0 && (
                <span className="badge warn" style={{ marginLeft: 8 }}>
                  {work.awaitingMyApproval.length}
                </span>
              )}
            </h3>
            {work.awaitingMyApproval.length === 0 ? (
              <div className="muted">Nothing is waiting on you.</div>
            ) : (
              <div className="stack">
                {work.awaitingMyApproval.map((a) => (
                  <div
                    key={a.id}
                    className="row"
                    style={{ justifyContent: 'space-between', cursor: 'pointer' }}
                    onClick={() => navigate(a.link ?? '/my-work')}
                  >
                    <div>
                      <div>{a.subject}</div>
                      <div className="faint mono">
                        {a.documentNumber ?? a.documentType} · {relativeTime(a.createdAt)}
                      </div>
                    </div>
                    {a.amount !== null && <span className="mono">{formatMoney(a.amount)}</span>}
                  </div>
                ))}
                <Link to="/my-work" className="btn btn-sm" style={{ alignSelf: 'flex-start' }}>
                  Open approval queue
                </Link>
              </div>
            )}
          </div>

          <div className="card">
            <h3 className="card-title">My submissions in flight</h3>
            {work.myPendingSubmissions.length === 0 ? (
              <div className="muted">You have nothing waiting on someone else.</div>
            ) : (
              <div className="stack">
                {work.myPendingSubmissions.map((s) => (
                  <div key={s.id}>
                    <div>{s.subject}</div>
                    <div className="faint mono">
                      {s.documentNumber ?? s.documentType} · sent {relativeTime(s.createdAt)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <h3 className="card-title">Assigned to me</h3>
            <div className="muted">
              Leads, projects and service jobs appear here once G-OPS ships (Phases 3–4).
            </div>
          </div>

          <div className="card">
            <h3 className="card-title">My recent activity</h3>
            {work.recentActivity.length === 0 ? (
              <div className="muted">Nothing yet.</div>
            ) : (
              <div className="stack">
                {work.recentActivity.map((a) => (
                  <div key={a.id}>
                    <div>{a.summary ?? `${a.action} ${a.entityType}`}</div>
                    <div className="faint">{relativeTime(a.at)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
