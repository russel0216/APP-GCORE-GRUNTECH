import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Avatar, ErrorBox, Field, Loading, useToast } from '../components/ui';
import { useConfirm, type ConfirmApi } from '../components/Confirm';
import { PasswordInput } from '../components/PasswordInput';
import { HrFact, type HrFacts } from '../components/HrFacts';

// ── Account ──────────────────────────────────────────────────────────────────

/**
 * The photo card.
 *
 * A plain upload here is cosmetic — it never runs through `describeFace` and
 * can never become a face-match candidate (see the comment on `/auth/photo`
 * in api/src/routes/auth.ts). Capturing your face live at the Clock screen
 * goes the other way and overwrites this with that verified photo, which is
 * why the note below points there instead of duplicating a camera here.
 */
function ProfilePhoto({ confirm }: { confirm: ConfirmApi }) {
  const { me, refresh } = useAuth();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function upload(file: File) {
    if (!file.type.startsWith('image/')) {
      setError(new Error('Choose an image file'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set('photo', file);
      await api.post('/auth/photo', form);
      await refresh();
      toast('ok', 'Photo updated');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  /** Asked through the page's confirm bar, which shows a refusal and stays open — so this throws. */
  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api.del('/auth/photo');
      await refresh();
      toast('ok', 'Photo removed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h3 className="card-title">Profile photo</h3>
      <ErrorBox error={error} />
      <div className="row" style={{ gap: 'var(--s-4)', alignItems: 'center' }}>
        <Avatar name={me?.user.name ?? '?'} photoId={me?.user.photoPath} size={72} />
        <div className="stack" style={{ gap: 'var(--s-2)' }}>
          <div className="row" style={{ gap: 'var(--s-2)' }}>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              {me?.user.photoPath ? 'Replace photo' : 'Upload photo'}
            </button>
            {me?.user.photoPath && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={busy}
                onClick={() =>
                  confirm.ask({
                    title: 'Remove your profile photo?',
                    body: 'Your initials show beside your name until you upload another.',
                    confirmLabel: 'Remove',
                    onConfirm: remove,
                  })
                }
              >
                Remove
              </button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="visually-hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          <p className="faint" style={{ margin: 0, fontSize: 'var(--fs-xs)' }}>
            Shown beside your name across G-Core. If you clock in by face,
            capturing it at the <Link to="/g-hr/clock">Clock screen</Link>{' '}
            sets this too, from that verified photo — do that instead of a
            plain upload if you want the two to match.
          </p>
        </div>
      </div>
    </div>
  );
}

interface Personal {
  mobile: string | null;
  address: string | null;
  birthDate: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
}

interface Profile {
  phone: string | null;
  /** Null for an account with no employee record behind it. */
  personal: Personal | null;
  /** Team, position and employee number from HR — shown, never saved from here. */
  facts: HrFacts | null;
}

/**
 * Your own contact and personal details.
 *
 * The mobile prints under "Sincerely Yours," on every quotation you author,
 * so it is yours to keep current. With an employee record behind the account
 * you also keep your home address, birthday and emergency contact — the
 * details the invitation asked for, and HR's copy of them. Everything else
 * (name, position, reporting line, pay) stays with Admin and HR. Read from
 * /auth/profile rather than /auth/me so it is always the saved copy.
 */
function ContactDetails() {
  const toast = useToast();
  const [phone, setPhone] = useState('');
  const [personal, setPersonal] = useState<Personal | null>(null);
  const [facts, setFacts] = useState<HrFacts | null>(null);
  const [saved, setSaved] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const snapshot = (ph: string, p: Personal | null) => JSON.stringify([ph.trim(), p]);

  function adopt(r: Profile) {
    setPhone(r.phone ?? '');
    setPersonal(r.personal);
    setFacts(r.facts);
    setSaved(snapshot(r.phone ?? '', r.personal));
  }

  useEffect(() => {
    api
      .get<Profile>('/auth/profile')
      .then(adopt)
      .catch(setError)
      .finally(() => setLoading(false));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.patch<Profile>('/auth/profile', {
        phone: phone.trim() || null,
        // One mobile: the number on your quotations is also HR's number for you.
        ...(personal
          ? { personal: { ...personal, mobile: phone.trim() || null, birthDate: personal.birthDate || null } }
          : {}),
      });
      adopt(r);
      toast('ok', 'Details saved');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const setP = (key: keyof Personal, value: string) => setPersonal((p) => (p ? { ...p, [key]: value } : p));

  if (loading) return <Loading />;
  return (
    <form className="card" onSubmit={submit}>
      <h3 className="card-title">{personal ? 'Contact and personal details' : 'Contact'}</h3>
      <ErrorBox error={error} />
      {facts && (
        <div className="grid grid-3">
          <HrFact label="Team" value={facts.team} />
          <HrFact label="Position" value={facts.position} />
          <HrFact label="Employee number" value={facts.employeeNo} mono />
        </div>
      )}
      <Field label="Mobile" hint="Printed under your name on the quotations you author">
        <input
          type="tel"
          autoComplete="tel"
          value={phone}
          maxLength={40}
          onChange={(e) => setPhone(e.target.value)}
        />
      </Field>
      {personal && (
        <>
          <Field label="Home address">
            <input
              autoComplete="street-address"
              maxLength={300}
              value={personal.address ?? ''}
              onChange={(e) => setP('address', e.target.value)}
            />
          </Field>
          <Field label="Birthday">
            <input type="date" autoComplete="bday" value={personal.birthDate ?? ''} onChange={(e) => setP('birthDate', e.target.value)} />
          </Field>
          <div className="grid grid-2">
            <Field label="Emergency contact">
              <input
                maxLength={120}
                value={personal.emergencyContactName ?? ''}
                onChange={(e) => setP('emergencyContactName', e.target.value)}
              />
            </Field>
            <Field label="Their number">
              <input
                type="tel"
                maxLength={40}
                value={personal.emergencyContactPhone ?? ''}
                onChange={(e) => setP('emergencyContactPhone', e.target.value)}
              />
            </Field>
          </div>
        </>
      )}
      <div className="card-foot">
        <button className="btn btn-primary" type="submit" disabled={busy || snapshot(phone, personal) === saved}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

export function Account() {
  const { me, signOut } = useAuth();
  const toast = useToast();
  const ask = useConfirm();
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

      {ask.bar}

      <div className="grid grid-2">
        <ProfilePhoto confirm={ask} />

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
              <div className="row" style={{ gap: 'var(--s-1)' }}>
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

        <ContactDetails />

        <form className="card" onSubmit={submit}>
          <h3 className="card-title">Change password</h3>
          <ErrorBox error={error} />
          <Field label="Current password" htmlFor="account-current-password">
            <PasswordInput
              id="account-current-password"
              value={current}
              autoComplete="current-password"
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
          </Field>
          <Field label="New password" htmlFor="account-new-password" hint="At least 8 characters">
            <PasswordInput
              id="account-new-password"
              value={next}
              autoComplete="new-password"
              onChange={(e) => setNext(e.target.value)}
              required
            />
          </Field>
          <Field label="Confirm new password" htmlFor="account-confirm-password">
            <PasswordInput
              id="account-confirm-password"
              value={confirm}
              autoComplete="new-password"
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </Field>
          <div className="card-foot">
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
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

      {/* The document specimen prints from Company Settings, where the
          details it shows are changed — one button, in one place. */}
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
  );
}

