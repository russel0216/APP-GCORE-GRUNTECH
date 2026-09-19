import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api, qs, SHIPPED_PHASE, type ListResult } from '../lib/api';
import { useAuth } from '../lib/auth';
import { CommandPalette } from './CommandPalette';
import { initials, relativeTime } from './ui';

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  isRead: boolean;
  createdAt: string;
}

export function Shell() {
  const { me, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(me?.unread ?? 0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function loadNotifications() {
    try {
      const res = await api.get<ListResult<Notification> & { unread: number }>(
        `/notifications${qs({ pageSize: 20 })}`,
      );
      setNotifications(res.rows);
      setUnread(res.unread);
    } catch {
      /* the bell is not worth an error banner */
    }
  }

  useEffect(() => {
    void loadNotifications();
    const timer = setInterval(() => void loadNotifications(), 60_000);
    return () => clearInterval(timer);
  }, []);

  async function openNotification(n: Notification) {
    setDrawerOpen(false);
    if (!n.isRead) {
      setUnread((u) => Math.max(0, u - 1));
      setNotifications((list) => list.map((x) => (x.id === n.id ? { ...x, isRead: true } : x)));
      try {
        await api.post(`/notifications/${n.id}/read`);
      } catch {
        /* the navigation matters more than the read receipt */
      }
    }
    if (n.link) navigate(n.link);
  }

  // The active module drives the sidebar — the shell shows one division's
  // menu at a time rather than every screen in the business at once.
  const activeModule =
    me?.menu.find((m) =>
      m.submodules.some((s) => location.pathname === s.path || location.pathname.startsWith(`${s.path}/`)),
    ) ?? null;

  /**
   * Exactly one menu entry is highlighted: the one whose path matches the URL
   * most specifically.
   *
   * A module's dashboard sits at the module root — /g-hr, /g-chain — so a plain
   * prefix test lights it up on every screen in that module. Longest match
   * wins, and where two entries share a path (Employees and Employee Pay Rates)
   * the first one does, so a single entry is ever active.
   */
  const activeKey = (() => {
    if (!activeModule) return null;
    let best: { key: string; length: number } | null = null;
    for (const sub of activeModule.submodules) {
      const matches =
        location.pathname === sub.path || location.pathname.startsWith(`${sub.path}/`);
      if (matches && (!best || sub.path.length > best.length)) {
        best = { key: sub.key, length: sub.path.length };
      }
    }
    return best?.key ?? null;
  })();

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="topbar-brand">
          G-CORE
        </Link>
        {activeModule && (
          <span className="badge" style={{ letterSpacing: 1 }}>
            {activeModule.label}
          </span>
        )}

        <div className="topbar-spacer" />

        <button className="search-trigger" onClick={() => setPaletteOpen(true)}>
          <span>⌕</span>
          <span className="label">Search everything</span>
          <div style={{ flex: 1 }} />
          <span className="kbd">Ctrl K</span>
        </button>

        <button className="bell" onClick={() => setDrawerOpen((d) => !d)} aria-label="Notifications">
          🔔
          {unread > 0 && <span className="bell-dot">{unread > 99 ? '99+' : unread}</span>}
        </button>

        <button className="avatar" onClick={() => navigate('/account')} title={me?.user.name}>
          {initials(me?.user.name ?? '?')}
        </button>

        <button className="btn btn-ghost btn-sm" onClick={signOut}>
          Sign out
        </button>
      </header>

      {drawerOpen && (
        <div className="drawer">
          <div className="modal-head">
            <h3>Notifications</h3>
            <button
              className="btn btn-ghost btn-sm"
              onClick={async () => {
                await api.post('/notifications/read-all');
                await loadNotifications();
              }}
            >
              Mark all read
            </button>
          </div>
          {notifications.length === 0 ? (
            <div className="empty" style={{ padding: 30 }}>
              Nothing new
            </div>
          ) : (
            notifications.map((n) => (
              <div
                key={n.id}
                className={`notif${n.isRead ? '' : ' unread'}`}
                onClick={() => void openNotification(n)}
              >
                <div className="title">{n.title}</div>
                <div className="meta">
                  {n.body ? `${n.body} · ` : ''}
                  {relativeTime(n.createdAt)}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Narrow screens hide the sidebar, so the module's screens move into a
          scrollable strip. Without it a service engineer on a tablet can reach
          a screen only through the home page or Ctrl+K. */}
      {activeModule && (
        <nav className="module-strip">
          {activeModule.submodules.map((sub) => {
            const upcoming = sub.phase > SHIPPED_PHASE;
            const active = sub.key === activeKey;
            if (upcoming) {
              return (
                <span key={sub.key} className="strip-item soon" title={`Ships in Phase ${sub.phase}`}>
                  {sub.label}
                </span>
              );
            }
            return (
              <Link key={sub.key} to={sub.path} className={`strip-item${active ? ' active' : ''}`}>
                {sub.label}
              </Link>
            );
          })}
        </nav>
      )}

      <div className="shell-body">
        {activeModule && (
          <nav className="sidebar">
            <div className="sidebar-title">{activeModule.label}</div>
            {activeModule.submodules.map((sub) => {
              const upcoming = sub.phase > SHIPPED_PHASE;
              const active = sub.key === activeKey;
              if (upcoming) {
                return (
                  <div key={sub.key} className="nav-item soon" title={sub.note ?? 'Ships in a later phase'}>
                    <span>{sub.label}</span>
                    <span className="tag">P{sub.phase}</span>
                  </div>
                );
              }
              return (
                <Link key={sub.key} to={sub.path} className={`nav-item${active ? ' active' : ''}`}>
                  <span>{sub.label}</span>
                </Link>
              );
            })}
          </nav>
        )}

        <main className="content">
          <Outlet />
        </main>
      </div>

      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}
