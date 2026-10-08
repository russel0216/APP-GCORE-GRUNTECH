import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError, setToken } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ErrorBox, Field, Loading, formatDateTime } from '../components/ui';
import { PasswordInput } from '../components/PasswordInput';
import { HrFact, type HrFacts } from '../components/HrFacts';
import { LandingBrand } from './Login';

/*
  The pages a person reaches before they can sign in: "Forgot password?", the
  reset link it sends, and the invitation to a new account.

  A link carries its token after the # — the part of an address a browser
  never sends to a server — and these pages hand it to the API in a POST body,
  so it lands in no access log. Each ends by signing the person in.
*/

interface LinkInfo {
  purpose: 'INVITE' | 'RESET';
  name: string;
  email: string;
  expiresAt: string;
  phone: string | null;
  personal: Personal | null;
  /** Team, position and employee number from HR — shown, never sent back. */
  facts: HrFacts | null;
}

interface Personal {
  mobile: string | null;
  address: string | null;
  birthDate: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
}

const tokenIn = (hash: string) => new URLSearchParams(hash.replace(/^#/, '')).get('token') ?? '';

function Frame({ title, wide, children }: { title: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className="landing">
      <div className={`login-wrap${wide ? ' login-wrap-wide' : ''}`}>
        <LandingBrand />
        <div className="panel">
          <h2>{title}</h2>
          {children}
        </div>
        <div className="faint login-host">gruntech.gcore.tech</div>
      </div>
    </div>
  );
}

/** Reads the link once, and says plainly when it no longer works. */
function useLink(purpose: 'INVITE' | 'RESET') {
  const location = useLocation();
  const token = useMemo(() => tokenIn(location.hash), [location.hash]);
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [gone, setGone] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setGone(
        purpose === 'INVITE'
          ? 'This page opens from the link in your invitation email.'
          : 'This page opens from the link in your password reset email.',
      );
      return;
    }
    let live = true;
    api
      .post<LinkInfo>('/auth/link', { token })
      .then((i) => {
        if (!live) return;
        if (i.purpose !== purpose) setGone('This link is for something else — open it from the email it came in.');
        else setInfo(i);
      })
      .catch((err) => {
        if (!live) return;
        setGone(
          err instanceof ApiError && err.status === 410
            ? purpose === 'INVITE'
              ? 'This invitation has expired or has already been used. Ask your administrator to send a new one.'
              : 'This reset link has expired or has already been used. Ask for a new one below.'
            : 'The link could not be opened. Check your connection and try again.',
        );
      });
    return () => {
      live = false;
    };
  }, [token, purpose]);

  return { token, info, gone };
}

/** Once a page has signed somebody in: the session, then the app. */
function useFinish() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  return async (jwt: string) => {
    setToken(jwt);
    await refresh();
    navigate('/', { replace: true });
  };
}

function SignedInNote({ as }: { as: string }) {
  const { me } = useAuth();
  if (!me || me.user.email === as) return null;
  return (
    <div className="alert warn">
      You are signed in as {me.user.name}. Finishing here signs you in as {as} instead.
    </div>
  );
}

// ── Forgot password ──────────────────────────────────────────────────────────

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [mail, setMail] = useState<boolean | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api
      .get<{ mail: boolean }>('/auth/options')
      .then((o) => setMail(o.mail))
      .catch(() => setMail(false));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ ok: boolean; mail: boolean }>('/auth/forgot', { email: email.trim() });
      if (!r.mail) setMail(false);
      else setSentTo(email.trim());
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Frame title="FORGOT PASSWORD">
      {mail === null ? (
        <Loading />
      ) : mail === false ? (
        <>
          <p className="login-text">
            Password resets by email are not set up on this G-CORE yet. Ask your administrator: they can
            send you a reset link from Admin › Users.
          </p>
          <p className="login-aside">
            <Link to="/">Back to sign in</Link>
          </p>
        </>
      ) : sentTo ? (
        <>
          <p className="login-text" role="status">
            If an account uses <strong>{sentTo}</strong>, a link to choose a new password is on its way. It
            works for one hour. If it does not arrive in a few minutes, look in the spam folder.
          </p>
          <p className="login-aside">
            <Link to="/">Back to sign in</Link>
          </p>
        </>
      ) : (
        <form onSubmit={submit}>
          <ErrorBox error={error} />
          <p className="login-text">Enter the email you sign in with, and we will send you a link to choose a new password.</p>
          <div className="field">
            <label htmlFor="forgot-email">Email</label>
            <input
              id="forgot-email"
              type="email"
              value={email}
              autoComplete="username"
              autoFocus
              required
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
            {busy ? 'Sending…' : 'SEND THE LINK'}
          </button>
          <p className="login-aside">
            <Link to="/">Back to sign in</Link>
          </p>
        </form>
      )}
    </Frame>
  );
}

// ── Choosing a password (shared by the reset and the welcome) ────────────────

function NewPassword({
  password,
  confirm,
  onPassword,
  onConfirm,
}: {
  password: string;
  confirm: string;
  onPassword: (v: string) => void;
  onConfirm: (v: string) => void;
}) {
  const mismatch = confirm.length > 0 && confirm !== password;
  return (
    <>
      <Field label="Choose a password" htmlFor="new-password" hint="At least 8 characters" required>
        <PasswordInput
          id="new-password"
          value={password}
          autoComplete="new-password"
          minLength={8}
          maxLength={128}
          required
          onChange={(e) => onPassword(e.target.value)}
        />
      </Field>
      <Field
        label="Type it again"
        htmlFor="confirm-password"
        error={mismatch ? 'The two passwords do not match' : undefined}
        required
      >
        <PasswordInput
          id="confirm-password"
          value={confirm}
          autoComplete="new-password"
          required
          aria-invalid={mismatch || undefined}
          onChange={(e) => onConfirm(e.target.value)}
        />
      </Field>
    </>
  );
}

// ── Reset ────────────────────────────────────────────────────────────────────

export function ResetPassword() {
  const { token, info, gone } = useLink('RESET');
  const finish = useFinish();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError(new Error('The two passwords do not match'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ token: string }>('/auth/reset', { token, password });
      await finish(r.token);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Frame title="CHOOSE A NEW PASSWORD">
      {gone ? (
        <>
          <p className="login-text">{gone}</p>
          <p className="login-aside">
            <Link to="/forgot-password">Send me a new link</Link> · <Link to="/">Sign in</Link>
          </p>
        </>
      ) : !info ? (
        <Loading />
      ) : (
        <form onSubmit={submit}>
          <SignedInNote as={info.email} />
          <ErrorBox error={error} />
          <p className="login-text">
            For <strong>{info.email}</strong>. The link works until {formatDateTime(info.expiresAt)}.
          </p>
          <NewPassword password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} />
          <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'SAVE AND SIGN IN'}
          </button>
        </form>
      )}
    </Frame>
  );
}

// ── Welcome (an invitation) ──────────────────────────────────────────────────

export function Welcome() {
  const { token, info, gone } = useLink('INVITE');
  const finish = useFinish();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mobile, setMobile] = useState('');
  const [personal, setPersonal] = useState<Personal | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const photoInput = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // What HR already has is filled in, for the person to check rather than retype.
  useEffect(() => {
    if (!info) return;
    setMobile(info.phone ?? info.personal?.mobile ?? '');
    setPersonal(info.personal);
  }, [info]);

  useEffect(() => {
    if (!photo) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(photo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  function pickPhoto(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError(new Error('Choose an image file for your photo'));
      return;
    }
    setError(null);
    setPhoto(file);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError(new Error('The two passwords do not match'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ token: string }>('/auth/welcome', {
        token,
        password,
        phone: mobile.trim() || null,
        // Only what this page asks for; the address and emergency contact stay
        // as HR has them, kept by the person from My Account.
        ...(personal ? { personal: { mobile: mobile.trim() || null, birthDate: personal.birthDate || null } } : {}),
      });
      // The account exists now; the photo goes up with the new session. A photo
      // that fails is not worth losing the welcome over — it can be added later.
      if (photo) {
        setToken(r.token);
        const form = new FormData();
        form.set('photo', photo);
        await api.post('/auth/photo', form).catch(() => undefined);
      }
      await finish(r.token);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const setP = (key: keyof Personal, value: string) => setPersonal((p) => (p ? { ...p, [key]: value } : p));

  return (
    <Frame title="WELCOME TO G-CORE" wide>
      {gone ? (
        <>
          <p className="login-text">{gone}</p>
          <p className="login-aside">
            <Link to="/">Sign in</Link>
          </p>
        </>
      ) : !info ? (
        <Loading />
      ) : (
        <form onSubmit={submit}>
          <SignedInNote as={info.email} />
          <ErrorBox error={error} />
          <p className="login-text">
            Hi {info.name.split(' ')[0]}. You sign in with <strong>{info.email}</strong>. Choose your password and
            check your details — the invitation works until {formatDateTime(info.expiresAt)}.
          </p>

          <NewPassword password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} />

          <Field label="Mobile number" hint="Printed under your name on the quotations you raise">
            <input type="tel" autoComplete="tel" maxLength={40} value={mobile} onChange={(e) => setMobile(e.target.value)} />
          </Field>

          <div className="field">
            <span className="field-label-text" id="welcome-photo-label">
              Profile photo <span className="faint">(optional)</span>
            </span>
            <div className="welcome-photo">
              {preview ? (
                <img src={preview} alt="Your new profile photo" />
              ) : (
                <span className="welcome-photo-empty" aria-hidden="true">
                  {info.name.trim().charAt(0).toUpperCase()}
                </span>
              )}
              <div className="row welcome-photo-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  aria-describedby="welcome-photo-label"
                  onClick={() => photoInput.current?.click()}
                >
                  {photo ? 'Choose another' : 'Choose a photo'}
                </button>
                {photo && (
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPhoto(null)}>
                    Remove
                  </button>
                )}
              </div>
              <input
                ref={photoInput}
                type="file"
                accept="image/*"
                className="visually-hidden"
                tabIndex={-1}
                onChange={(e) => {
                  pickPhoto(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </div>
          </div>

          {(personal || info.facts) && (
            <fieldset className="welcome-personal">
              <legend>Your details</legend>
              <p className="faint welcome-note">
                Your team, position and employee number are on your HR record — if one is wrong, tell HR.
                {personal ? ' Check your birthday.' : ''}
              </p>
              <HrFact label="Team" value={info.facts?.team ?? null} />
              <HrFact label="Position" value={info.facts?.position ?? null} />
              {personal && (
                <Field label="Birthday">
                  <input type="date" autoComplete="bday" value={personal.birthDate ?? ''} onChange={(e) => setP('birthDate', e.target.value)} />
                </Field>
              )}
              <HrFact label="Employee number" value={info.facts?.employeeNo ?? null} mono />
            </fieldset>
          )}

          <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
            {busy ? 'Setting up…' : 'SAVE AND SIGN IN'}
          </button>
        </form>
      )}
    </Frame>
  );
}
