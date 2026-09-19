import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, SHIPPED_PHASE } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Loading, formatMoney, relativeTime } from '../components/ui';

/**
 * The launcher.
 *
 * Four divisions, each with its own animated mark, in the layout carried over
 * from gasiontech.gcore.tech. Insights and Admin live in the top bar instead of
 * on this grid: they are places you go occasionally, and giving them equal
 * weight to the four divisions somebody works in every day would be a lie about
 * how the business is shaped.
 *
 * Below the grid is My Work. A launcher tells you where the departments are;
 * My Work tells you what the business needs from you today, which is the shift
 * from a menu-driven system to a process-driven one (model §8).
 */

/** The four divisions, in the order the original landing page had them. */
const DIVISIONS: { key: string; art: string; alt: string }[] = [
  { key: 'gops', art: '/modules/g-ops.webp', alt: 'Interlocking gears forming a G' },
  { key: 'ghr', art: '/modules/g-hr.webp', alt: 'A head drawn as a network of nodes' },
  { key: 'gfin', art: '/modules/g-fin.webp', alt: 'A rising chart over stacked peso notes and coins' },
  { key: 'gchain', art: '/modules/g-chain.webp', alt: 'Warehouse racking feeding a delivery van' },
];

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

  // Only the divisions this person can actually open. A card that leads to a
  // refusal is worse than no card.
  const cards = DIVISIONS.map((d) => ({
    ...d,
    module: me?.menu.find((m) => m.key === d.key),
  })).filter((d) => d.module);

  const company = me?.company?.name ?? 'Gruntechnology Corp';
  const waiting = work?.awaitingMyApproval.length ?? 0;

  return (
    <div className="home">
      <div className="home-hero">
        {/* The wordmark is the animated original, carrying the emblem inside
            the O that the text version cannot reproduce. The h1 is still a
            real heading for anything reading the page rather than looking at
            it; the image sits inside it and the text is hidden visually. */}
        <h1 className="home-wordmark">
          <img src="/modules/wordmark.webp" alt="G-CORE" loading="eager" draggable={false} />
          <span className="visually-hidden">G-CORE</span>
        </h1>
        <div className="wordmark-sub">{company}</div>
      </div>

      {/* Most people hold one or two divisions, not four. Left in a two-column
          grid a lone card sits half-width against the left edge and reads as a
          page that failed to load the rest. */}
      <div className={`module-grid${cards.length < 3 ? ' module-grid-few' : ''}`}>
        {cards.map(({ key, art, alt, module }) => {
          const live = module!.submodules.filter((s) => s.phase <= SHIPPED_PHASE);
          const target = live[0]?.path ?? module!.submodules[0]?.path ?? '/';
          return (
            <Link key={key} to={target} className="module-card" title={module!.blurb}>
              <div className="module-art">
                {/* The marks are animated WebP rather than video: they loop
                    forever, carry their own transparency and cost nothing to
                    decode. `loading="eager"` because they are the page. */}
                <img src={art} alt={alt} loading="eager" draggable={false} />
              </div>
              <div className="module-name">{module!.label}</div>
              <div className="module-blurb">{module!.blurb}</div>
            </Link>
          );
        })}
      </div>

      <div className="home-work">
        <div className="home-work-head">
          <h2>My Work</h2>
          {waiting > 0 && <span className="badge warn">{waiting} waiting on you</span>}
          <div style={{ flex: 1 }} />
          <Link to="/my-work" className="btn btn-sm">
            Open My Work
          </Link>
        </div>

        {loading ? (
          <Loading />
        ) : !work ? (
          <div className="card muted">My Work could not be loaded.</div>
        ) : (
          <div className="grid grid-4">
            <div className="card">
              <h3 className="card-title">
                Awaiting my approval
                {waiting > 0 && (
                  <span className="badge warn" style={{ marginLeft: 8 }}>
                    {waiting}
                  </span>
                )}
              </h3>
              {waiting === 0 ? (
                <div className="muted">Nothing is waiting on you.</div>
              ) : (
                <div className="stack">
                  {work.awaitingMyApproval.slice(0, 4).map((a) => (
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
                  {waiting > 4 && <div className="faint">and {waiting - 4} more…</div>}
                </div>
              )}
            </div>

            <div className="card">
              <h3 className="card-title">In flight</h3>
              {work.myPendingSubmissions.length === 0 ? (
                <div className="muted">You have nothing waiting on someone else.</div>
              ) : (
                <div className="stack">
                  {work.myPendingSubmissions.slice(0, 4).map((s) => (
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
              {work.assignedToMe.length === 0 ? (
                <div className="muted">Nothing assigned to you right now.</div>
              ) : (
                <div className="muted">{work.assignedToMe.length} item(s) — see My Work.</div>
              )}
            </div>

            <div className="card">
              <h3 className="card-title">Recent activity</h3>
              {work.recentActivity.length === 0 ? (
                <div className="muted">Nothing yet.</div>
              ) : (
                <div className="stack">
                  {work.recentActivity.slice(0, 4).map((a) => (
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

      <footer className="home-footer">
        © {company} · G-CORE Platform
      </footer>
    </div>
  );
}
