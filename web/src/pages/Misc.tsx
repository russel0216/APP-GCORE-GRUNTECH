import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, getToken, SHIPPED_PHASE } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ErrorBox, Field, Loading, useToast } from '../components/ui';

// ── Account ──────────────────────────────────────────────────────────────────

export function Account() {
  const { me, signOut } = useAuth();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) {
      setError(new Error('The two new passwords do not match'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/change-password', { currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      setConfirm('');
      toast('ok', 'Password changed');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>My Account</h1>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3 className="card-title">Details</h3>
          <div className="stack">
            <div>
              <div className="section-label">
                NAME
              </div>
              <div>{me?.user.name}</div>
            </div>
            <div>
              <div className="section-label">
                EMAIL
              </div>
              <div className="mono">{me?.user.email}</div>
            </div>
            <div>
              <div className="section-label">
                POSITION
              </div>
              <div>{me?.user.position ?? '—'}</div>
            </div>
            <div>
              <div className="section-label">
                ROLES
              </div>
              <div className="row" style={{ gap: 5 }}>
                {me?.user.isSuperAdmin && <span className="badge info">Super Admin</span>}
                {me?.user.roles.length ? (
                  me.user.roles.map((r) => (
                    <span key={r} className="badge">
                      {r}
                    </span>
                  ))
                ) : (
                  <span className="faint">none</span>
                )}
              </div>
            </div>
            <div>
              <div className="section-label">
                EFFECTIVE PERMISSIONS
              </div>
              <div className="mono">{me?.permissions.length ?? 0}</div>
            </div>
          </div>
        </div>

        <form className="card" onSubmit={submit}>
          <h3 className="card-title">Change password</h3>
          <ErrorBox error={error} />
          <Field label="Current password">
            <input
              type="password"
              value={current}
              autoComplete="current-password"
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
          </Field>
          <Field label="New password" hint="At least 8 characters">
            <input
              type="password"
              value={next}
              autoComplete="new-password"
              onChange={(e) => setNext(e.target.value)}
              required
            />
          </Field>
          <Field label="Confirm new password">
            <input
              type="password"
              value={confirm}
              autoComplete="new-password"
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </Field>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? 'Changing…' : 'Change password'}
          </button>
        </form>
      </div>

      {/*
        Sign out lives here as well as in the top bar. Below 520px the top bar
        cannot fit brand, search, bell, avatar and a full-width Sign out on the
        same line, so the button is hidden there — and a way out of the
        application that exists only on a wide screen is not a way out.
      */}
      <div className="card" style={{ marginTop: 'var(--s-4)' }}>
        <h3 className="card-title">Session</h3>
        <div className="row">
          <button className="btn btn-danger" onClick={signOut}>
            Sign out
          </button>
          <span className="muted">Ends this session on this device only.</span>
        </div>
      </div>
    </div>
  );
}

// ── System settings ──────────────────────────────────────────────────────────

interface Setting {
  key: string;
  value: unknown;
  description: string | null;
  updatedAt: string;
}

export function SystemSettings() {
  const toast = useToast();
  const [rows, setRows] = useState<Setting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api
      .get<Setting[]>('/settings')
      .then(setRows)
      .catch(setError)
      .finally(() => setLoading(false));
  }, []);

  function openSpecimen() {
    fetch('/api/pdf/specimen', { headers: { Authorization: `Bearer ${getToken()}` } })
      .then((r) => r.blob())
      .then((b) => window.open(URL.createObjectURL(b), '_blank'))
      .catch(() => toast('error', 'Could not render the specimen'));
  }

  if (loading) return <Loading />;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>System Settings</h1>
          <p>
            Keyed configuration for anything that must change without a deploy. Most Phase 1
            configuration lives on its own screen — Company, Numbering, Workflows, Roles.
          </p>
        </div>
      </div>

      <ErrorBox error={error} />

      <div className="grid grid-2">
        <div className="card">
          <h3 className="card-title">Document engine</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            Every printable document renders through one pipeline, so branding, the signature block
            and page numbering are identical everywhere. Print the specimen after changing company
            settings to see exactly what a quotation or progress report will look like.
          </p>
          <button className="btn" onClick={openSpecimen}>
            Print document specimen
          </button>
        </div>

        <div className="card">
          <h3 className="card-title">Stored settings</h3>
          {rows.length === 0 ? (
            <div className="muted">
              Nothing stored yet. Modules add their own settings here as they ship — leave
              allotments in Phase 6, budget-block rules in Phase 4.
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => (
                    <tr key={s.key}>
                      <td className="mono">{s.key}</td>
                      <td className="mono faint">{JSON.stringify(s.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Placeholder for screens whose module ships in a later phase ──────────────

export function ComingSoon() {
  const { me } = useAuth();
  const params = useParams();
  const path = `/${params['*'] ?? ''}`;

  const found = me?.menu
    .flatMap((m) => m.submodules.map((s) => ({ mod: m, sub: s })))
    .find((x) => path.startsWith(x.sub.path));

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{found?.sub.label ?? 'Not built yet'}</h1>
          <p>
            {found
              ? `${found.mod.label} › ${found.sub.label} ships in Phase ${found.sub.phase}.`
              : 'This screen does not exist yet.'}
          </p>
        </div>
      </div>

      <div className="card">
        <p style={{ marginTop: 0 }}>
          Phase {SHIPPED_PHASE} — the foundation — is what is built: authentication, users, roles and
          granular permissions, company settings, document numbering, the approval engine, audit log,
          attachments, notifications, global search, the shared list pattern and the PDF engine.
        </p>
        <p className="muted">
          {found?.sub.note ??
            'Its access can already be configured in Admin › Roles & Permissions, and its numbering in Admin › Numbering — so when the screen arrives, the surrounding configuration is already in place.'}
        </p>
        <Link to="/" className="btn">
          Back to home
        </Link>
      </div>
    </div>
  );
}
