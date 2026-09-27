import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, SHIPPED_PHASE } from '../lib/api';
import { useAuth } from '../lib/auth';
import { recordLink } from '../lib/links';
import { Loading, formatMoney, relativeTime } from '../components/ui';
import { clockTime, kindLabel, type ScheduleRow, type WorkRow } from './MyWork';

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
 *
 * Every row on the cards is a <Link>: they were <div onClick> once, which a
 * keyboard could not reach (rule 13).
 */

/** The four divisions, in the order the original landing page had them. */
const DIVISIONS: { key: string; art: string; alt: string }[] = [
  { key: 'gops', art: '/modules/g-ops.gif', alt: 'Interlocking gears forming a G' },
  { key: 'ghr', art: '/modules/g-hr.gif', alt: 'A head drawn as a network of nodes' },
  { key: 'gfin', art: '/modules/g-fin.gif', alt: 'A rising chart over stacked peso notes and coins' },
  { key: 'gchain', art: '/modules/g-chain.gif', alt: 'Warehouse racking feeding a delivery van' },
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
    requester?: { name: string };
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
    entityId: string;
    action: string;
    summary: string | null;
    at: string;
  }[];
  assignedToMe: WorkRow[];
  todaysSchedule: ScheduleRow[];
  myDrafts: WorkRow[];
}

const PREVIEW = 3;

export function Home() {
  const { me } = useAuth();
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
  const assigned = work?.assignedToMe ?? [];
  const today = work?.todaysSchedule ?? [];

  return (
    <div className="home">
      <div className="home-hero">
        {/* The wordmark is the animated original, carrying the emblem inside
            the O that the text version cannot reproduce. The h1 is still a
            real heading for anything reading the page rather than looking at
            it; the image sits inside it and the text is hidden visually. */}
        <h1 className="home-wordmark">
          <img src="/modules/wordmark.gif" alt="G-CORE" loading="eager" draggable={false} />
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
                {/* GIF, deliberately. An animated WebP built from the same
                    source was correct by every measure - 75 frames, infinite
                    loop, served whole - and still would not play. GIF is the
                    most broadly supported animation on the web and takes the
                    format out of the list of things that can go wrong. */}
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
          <div className="home-work-spacer" />
          <Link to="/my-work" className="btn btn-sm">
            Open My Work
          </Link>
        </div>

        {loading ? (
          <Loading />
        ) : !work ? (
          <div className="card muted">My Work could not be loaded.</div>
        ) : (
          <div className="grid home-work-grid">
            <div className="card">
              <h3 className="card-title">
                Awaiting my approval
                {waiting > 0 && <span className="badge warn card-title-count">{waiting}</span>}
              </h3>
              {waiting === 0 ? (
                <div className="muted">Nothing is waiting on you.</div>
              ) : (
                <div className="stack">
                  {work.awaitingMyApproval.slice(0, PREVIEW).map((a) => (
                    <Link key={a.id} to={a.link ?? '/my-work'} className="row home-row">
                      <span className="home-row-main">
                        <span className="home-row-title">{a.subject}</span>
                        <span className="faint mono">
                          {a.documentNumber ?? a.documentType}
                          {a.requester?.name ? ` · ${a.requester.name}` : ''} · {relativeTime(a.createdAt)}
                        </span>
                      </span>
                      {a.amount !== null && <span className="mono">{formatMoney(a.amount)}</span>}
                    </Link>
                  ))}
                  {waiting > PREVIEW && <div className="faint">and {waiting - PREVIEW} more…</div>}
                </div>
              )}
            </div>

            <div className="card">
              <h3 className="card-title">In flight</h3>
              {work.myPendingSubmissions.length === 0 ? (
                <div className="muted">You have nothing waiting on someone else.</div>
              ) : (
                <div className="stack">
                  {work.myPendingSubmissions.slice(0, PREVIEW).map((s) => (
                    <Link key={s.id} to={s.link ?? '/my-work'} className="home-row">
                      <span className="home-row-title">{s.subject}</span>
                      <span className="faint mono">
                        {s.documentNumber ?? s.documentType} · sent {relativeTime(s.createdAt)}
                      </span>
                    </Link>
                  ))}
                  {work.myPendingSubmissions.length > PREVIEW && (
                    <div className="faint">and {work.myPendingSubmissions.length - PREVIEW} more…</div>
                  )}
                </div>
              )}
            </div>

            <div className="card">
              <h3 className="card-title">
                Assigned to me
                {assigned.length > 0 && <span className="badge card-title-count">{assigned.length}</span>}
              </h3>
              {assigned.length === 0 ? (
                <div className="muted">Nothing assigned to you right now.</div>
              ) : (
                <div className="stack">
                  {assigned.slice(0, PREVIEW).map((r) => (
                    <Link key={`${r.kind}:${r.id}`} to={r.link} className="home-row">
                      <span className="home-row-title">
                        {r.title}
                        {r.overdue && <span className="badge danger work-overdue-tag">overdue</span>}
                      </span>
                      <span className="faint mono">
                        {kindLabel(r.kind)}
                        {r.subtitle ? ` · ${r.subtitle}` : ''}
                      </span>
                    </Link>
                  ))}
                  {assigned.length > PREVIEW && <div className="faint">and {assigned.length - PREVIEW} more…</div>}
                </div>
              )}
            </div>

            <div className="card">
              <h3 className="card-title">
                Today
                {today.length > 0 && <span className="badge info card-title-count">{today.length}</span>}
              </h3>
              {today.length === 0 ? (
                <div className="muted">Nothing scheduled today.</div>
              ) : (
                <div className="stack">
                  {today.slice(0, PREVIEW).map((s) => (
                    <Link key={`${s.kind}:${s.id}`} to={s.link} className="row home-row">
                      <span className="mono today-time">{clockTime(s.startsAt)}</span>
                      <span className="home-row-main">
                        <span className="home-row-title">{s.title}</span>
                        <span className="faint">
                          {kindLabel(s.kind)}
                          {s.sub ? ` · ${s.sub}` : ''}
                        </span>
                      </span>
                    </Link>
                  ))}
                  {today.length > PREVIEW && <div className="faint">and {today.length - PREVIEW} more…</div>}
                </div>
              )}
            </div>

            <div className="card">
              <h3 className="card-title">Recent activity</h3>
              {work.recentActivity.length === 0 ? (
                <div className="muted">Nothing yet.</div>
              ) : (
                <div className="stack">
                  {work.recentActivity.slice(0, PREVIEW).map((a) => {
                    const text = a.summary ?? `${a.action} ${a.entityType}`;
                    const link = recordLink(a.entityType, a.entityId);
                    return link ? (
                      <Link key={a.id} to={link} className="home-row">
                        <span className="home-row-title">{text}</span>
                        <span className="faint">{relativeTime(a.at)}</span>
                      </Link>
                    ) : (
                      <div key={a.id} className="home-row">
                        <span className="home-row-title">{text}</span>
                        <span className="faint">{relativeTime(a.at)}</span>
                      </div>
                    );
                  })}
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
