import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api, qs, SHIPPED_PHASE, type ListResult } from '../lib/api';
import { useAuth } from '../lib/auth';
import { CommandPalette } from './CommandPalette';
import { Avatar, relativeTime } from './ui';
import { Icon, sectionIcon } from './Icon';
import { LayoutEditor } from './LayoutEditor';

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

  /*
    Collapsed to an icon rail, remembered per viewer.
    
    localStorage is the right home: it is a preference, not a record, and it
    failing is not worth an error. Read once, in the initialiser, so the
    sidebar never renders wide and then snaps narrow.
  */
  const [railed, setRailed] = useState(() => {
    try {
      return localStorage.getItem('gcore_nav_railed') === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('gcore_nav_railed', railed ? '1' : '0');
    } catch {
      /* a preference that cannot be saved is still a preference */
    }
  }, [railed]);

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

  /** Escape closes the notification drawer, as it does every other overlay. */
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (!el.closest('.drawer') && !el.closest('.bell')) setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [drawerOpen]);

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
  // Both are permission-driven: menuFor() only returns a module this person
  // can open, so the absence of an entry is the absence of the button.
  const insights = me?.menu.find((m) => m.key === 'insights');
  const admin = me?.menu.find((m) => m.key === 'admin');

  const activeSub = (() => {
    if (!activeModule) return null;
    let best: { key: string; length: number; path: string; label: string } | null = null;
    for (const sub of activeModule.submodules) {
      const matches =
        location.pathname === sub.path || location.pathname.startsWith(`${sub.path}/`);
      if (matches && (!best || sub.path.length > best.length)) {
        best = { key: sub.key, length: sub.path.length, path: sub.path, label: sub.label };
      }
    }
    return best;
  })();
  const activeKey = activeSub?.key ?? null;

  /*
    Anywhere deeper than the menu entry it belongs to — a record, a new form —
    gets one way back to that entry's list. Drawn here, once, so every screen
    has it and no screen draws its own.
  */
  const backTo =
    activeSub && location.pathname.startsWith(`${activeSub.path}/`) ? activeSub : null;

  /*
    It sits with the page's own buttons — Edit, Mark complete — rather than on
    a line of its own above the title. The page draws that row, so Shell finds
    it once the page has rendered and puts the button in with a portal. A page
    whose header has no buttons gets it at the header's right edge; a page with
    no header at all keeps it above the content, where it was.
  */
  const mainRef = useRef<HTMLElement | null>(null);
  const [backSlot, setBackSlot] = useState<HTMLElement | null>(null);
  const [noHeader, setNoHeader] = useState(false);
  useEffect(() => {
    setBackSlot(null);
    setNoHeader(false);
    const main = mainRef.current;
    if (!backTo || !main) return;
    let current: HTMLElement | null = null;
    const place = () => {
      if (current?.isConnected) return;
      const head = main.querySelector<HTMLElement>('.page-head, .record-head');
      if (!head) return;
      const actions = head.querySelector<HTMLElement>(
        ':scope > .row, :scope .record-head-actions',
      );
      const slot = document.createElement('span');
      slot.className = 'back-slot';
      if (actions) actions.prepend(slot);
      else head.append(slot);
      current = slot;
      setBackSlot(slot);
      setNoHeader(false);
    };
    place();
    const observer = new MutationObserver(place);
    observer.observe(main, { childList: true, subtree: true });
    // Still nothing once the page has had time to load: no header to join.
    const timer = window.setTimeout(() => {
      if (!current?.isConnected) setNoHeader(true);
    }, 800);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
      current?.remove();
    };
  }, [backTo?.path, location.pathname]);

  const backLink = backTo && (
    <Link className="btn back-link" to={backTo.path}>
      ← Back to {backTo.label}
    </Link>
  );

  /**
   * The sidebar, cut into the headings the registry declares.
   *
   * G-OPS carries twenty-three screens spanning sales, delivery and
   * aftermarket. Flat, nothing told you which was which. Order comes from the
   * registry, not from sorting — the registry order is the order somebody
   * works in — and a module that declares no groups (Insights, with six
   * entries) falls through to a single unlabelled run, exactly as before.
   */
  const navGroups = (() => {
    if (!activeModule) return [];
    const out: { name: string | null; items: typeof activeModule.submodules }[] = [];
    for (const sub of activeModule.submodules) {
      if (sub.hidden) continue;
      const name = sub.group ?? null;
      // Merged by name rather than by adjacency. G-OPS lists Costing after the
      // delivery screens, which as a run-length grouping produced a second
      // "Sales" heading further down the menu. A group appears once, where its
      // first member appears, and no future registry ordering can split it.
      const existing = out.find((g) => g.name === name);
      if (existing) existing.items.push(sub);
      else out.push({ name, items: [sub] });
    }
    // One heading over the whole list is a label, not a grouping.
    return out.length === 1 ? [{ name: null, items: out[0].items }] : out;
  })();

  /**
   * Two levels of menu, not one list of twenty-three.
   *
   * The sidebar carries the module's SECTIONS — Sales, Delivery, Aftermarket —
   * and the section you are in opens its screens on a second line across the
   * top. Twenty-three entries down the left was the whole menu shouting at
   * once; this shows you four choices, and then six.
   *
   * A module that declares no sections (Insights, six entries) keeps the flat
   * sidebar and grows no second line — two levels over six items would be
   * ceremony.
   */
  const sectioned = navGroups.length > 1 && navGroups.every((g) => g.name);

  const activeGroup = sectioned
    ? // A hidden screen (the SCORO Archive) lists in no group, so its page opens
      // the section it is declared under rather than the first one.
      (navGroups.find((g) => g.items.some((s) => s.key === activeKey)) ??
      navGroups.find((g) => g.name === activeModule?.submodules.find((s) => s.key === activeKey)?.group) ??
      navGroups[0])
    : null;

  /** Where a section's name points: its first screen that actually exists. */
  const sectionTarget = (group: (typeof navGroups)[number]) =>
    group.items.find((s) => s.phase <= SHIPPED_PHASE)?.path ?? null;

  /*
    Daylight everywhere except the launcher. The launcher is the product's
    identity — black, neon, the animated marks — and was explicitly to be
    kept; every screen you reach FROM it is a working surface, and a working
    surface is easier to read in daylight.
  */
  const day = location.pathname !== '/';

  /*
    The theme goes on <html>, not on the shell div.

    On the shell it cannot reach <body>, so the page behind a short sidebar
    stayed black while everything in front of it turned white — and a selector
    written `[data-theme] .shell` never matches the .shell that carries the
    attribute in the first place.
  */
  useEffect(() => {
    const root = document.documentElement;
    if (day) root.setAttribute('data-theme', 'day');
    else root.removeAttribute('data-theme');
    return () => root.removeAttribute('data-theme');
  }, [day]);

  return (
    <div className="shell">
      {/* First in the tab order, and the only way past a 23-item menu without
          twenty-three presses of Tab. */}
      <a className="skip-link" href="#content">
        Skip to content
      </a>

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

        {/* Insights and Admin live up here rather than on the launcher grid:
            they are places you go occasionally, and giving them equal weight to
            the four divisions somebody works in every day would misrepresent
            how the business is shaped. Each appears only if the menu says this
            person may open it. */}
        {insights && (
          <Link
            to="/insights"
            className={`topbar-link${location.pathname.startsWith('/insights') ? ' active' : ''}`}
          >
            Insights
          </Link>
        )}
        {admin && (
          <Link
            to={admin.submodules[0]?.path ?? '/admin/users'}
            className={`topbar-link${location.pathname.startsWith('/admin') ? ' active' : ''}`}
          >
            Admin
          </Link>
        )}

        <button className="search-trigger" onClick={() => setPaletteOpen(true)}>
          <span>⌕</span>
          <span className="label">Search everything</span>
          <div style={{ flex: 1 }} />
          <span className="kbd">Ctrl K</span>
        </button>

        <button
          className="bell"
          onClick={() => setDrawerOpen((d) => !d)}
          aria-expanded={drawerOpen}
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        >
          🔔
          {unread > 0 && (
            <span className="bell-dot" aria-hidden="true">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>

        <button className="avatar-btn" onClick={() => navigate('/account')} title={me?.user.name}>
          <Avatar name={me?.user.name ?? '?'} photoId={me?.user.photoPath} />
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
              // A notification is the fastest route to a document waiting on
              // you, and it was reachable by mouse only.
              <button
                type="button"
                key={n.id}
                className={`notif${n.isRead ? '' : ' unread'}`}
                onClick={() => void openNotification(n)}
              >
                <div className="title">{n.title}</div>
                <div className="meta">
                  {n.body ? `${n.body} · ` : ''}
                  {relativeTime(n.createdAt)}
                </div>
              </button>
            ))
          )}
        </div>
      )}

      {/*
        The bars under the top bar. One sticky wrapper rather than two, so the
        second one does not have to know how tall the first one is.

        On a wide screen the sections live in the sidebar, so only the screen
        line shows here. On a narrow screen the sidebar is gone, so the section
        line appears too and the pair replaces it entirely — a service engineer
        on a tablet can still reach every screen without the launcher or Ctrl+K.
      */}
      {activeModule && (
        <div className="nav-bars">
          <nav className="module-strip" aria-label={`${activeModule.label} sections`}>
            {sectioned
              ? navGroups.map((group) => {
                  const target = sectionTarget(group);
                  const active = group === activeGroup;
                  if (!target) {
                    return (
                      <span key={group.name} className="strip-item soon">
                        {group.name}
                      </span>
                    );
                  }
                  return (
                    <Link
                      key={group.name}
                      to={target}
                      className={`strip-item${active ? ' active' : ''}`}
                      aria-current={active ? 'true' : undefined}
                    >
                      {group.name}
                    </Link>
                  );
                })
              : activeModule.submodules.filter((sub) => !sub.hidden).map((sub) => {
                  const upcoming = sub.phase > SHIPPED_PHASE;
                  const active = sub.key === activeKey;
                  if (upcoming) {
                    return (
                      <span
                        key={sub.key}
                        className="strip-item soon"
                        title={`Ships in Phase ${sub.phase}`}
                      >
                        {sub.label}
                      </span>
                    );
                  }
                  return (
                    <Link
                      key={sub.key}
                      to={sub.path}
                      className={`strip-item${active ? ' active' : ''}`}
                      aria-current={active ? 'page' : undefined}
                    >
                      {sub.label}
                    </Link>
                  );
                })}
          </nav>

        </div>
      )}

      <div className="shell-body">
        {activeModule && (
          <nav
            className={`sidebar${sectioned ? ' sidebar-sections' : ''}${railed ? ' railed' : ''}`}
            aria-label={sectioned ? `${activeModule.label} sections` : `${activeModule.label} menu`}
          >
            <div className="sidebar-head">
              <span className="sidebar-title">{activeModule.label}</span>
              {/*
                aria-expanded describes the nav, not the button, so a screen
                reader is told what the control does rather than what it is.
              */}
              <button
                type="button"
                className="rail-toggle"
                onClick={() => setRailed((r) => !r)}
                aria-expanded={!railed}
                aria-label={railed ? 'Expand the menu' : 'Collapse the menu to icons'}
                title={railed ? 'Expand the menu' : 'Collapse the menu to icons'}
              >
                <Icon name="panel" size={16} />
              </button>
            </div>

            {/*
              Sections, not screens. Picking one opens its screens on the second
              line at the top; the left stays four or five choices long however
              many screens the module has behind them.
            */}
            {sectioned
              ? navGroups.map((group) => {
                  const target = sectionTarget(group);
                  const active = group === activeGroup;
                  const live = group.items.filter((s) => s.phase <= SHIPPED_PHASE).length;
                  if (!target) {
                    return (
                      <div key={group.name} className="nav-item soon" title={group.name ?? ''}>
                        <Icon name={sectionIcon(group.name)} size={17} />
                        <span className="nav-label">{group.name}</span>
                        <span className="tag">soon</span>
                      </div>
                    );
                  }
                  return (
                    <Link
                      key={group.name}
                      to={target}
                      className={`nav-item${active ? ' active' : ''}`}
                      aria-current={active ? 'true' : undefined}
                      // The title is the only name a railed item has on screen,
                      // and aria-label is the only one it has to a reader.
                      title={group.name ?? ''}
                      aria-label={railed ? `${group.name} — ${live} screen${live === 1 ? '' : 's'}` : undefined}
                    >
                      <Icon name={sectionIcon(group.name)} size={17} />
                      <span className="nav-label">{group.name}</span>
                      <span className="tag">{live}</span>
                    </Link>
                  );
                })
              : navGroups.map((group, i) => (
              <div key={group.name ?? `g${i}`}>
                {group.name && <div className="nav-group">{group.name}</div>}
                {group.items.map((sub) => {
                  const upcoming = sub.phase > SHIPPED_PHASE;
                  const active = sub.key === activeKey;
                  if (upcoming) {
                    return (
                      <div
                        key={sub.key}
                        className="nav-item soon"
                        title={sub.note ?? 'Ships in a later phase'}
                      >
                        <span>{sub.label}</span>
                        <span className="tag">P{sub.phase}</span>
                      </div>
                    );
                  }
                  return (
                    <Link
                      key={sub.key}
                      to={sub.path}
                      className={`nav-item${active ? ' active' : ''}`}
                      // Announces the current page to a screen reader, which
                      // the magenta bar only ever said to people who can see it.
                      aria-current={active ? 'page' : undefined}
                    >
                      <span>{sub.label}</span>
                    </Link>
                  );
                })}
              </div>
                ))}
          </nav>
        )}

        {/*
          The second line sits in the SAME column as the page, not above the
          whole shell — so it starts level with the sidebar rather than pushing
          it down. Sections on the left, that section's screens across the top
          of the page they belong to.
        */}
        <div className="content-col">
          {/* The second line: the screens inside the section you are in. */}
        {sectioned && activeGroup && (
          <nav className="sub-nav" aria-label={`${activeGroup.name} menu`}>
            {activeGroup.items.map((sub) => {
              const upcoming = sub.phase > SHIPPED_PHASE;
              const active = sub.key === activeKey;
              if (upcoming) {
                return (
                  <span
                    key={sub.key}
                    className="sub-nav-item soon"
                    title={sub.note ?? `Ships in Phase ${sub.phase}`}
                  >
                    {sub.label}
                    <span className="tag">P{sub.phase}</span>
                  </span>
                );
              }
              return (
                <Link
                  key={sub.key}
                  to={sub.path}
                  className={`sub-nav-item${active ? ' active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                >
                  {sub.label}
                </Link>
              );
            })}
          </nav>
        )}

          {/*
            data-route is what scopes a layout edit to the screen it was made
            on. Without it a nudge to "the second card in the first panel"
            would follow you onto every other page that happens to have one.
          */}
          <main ref={mainRef} className="content" id="content" tabIndex={-1} data-route={location.pathname}>
            {backLink && backSlot && createPortal(backLink, backSlot)}
            {backLink && !backSlot && noHeader && <div className="back-fallback">{backLink}</div>}
            <Outlet />
          </main>

          <LayoutEditor />
        </div>
      </div>

      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}
