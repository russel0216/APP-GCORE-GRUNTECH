import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { ErrorBox } from '../components/ui';
import { PasswordInput } from '../components/PasswordInput';

/** The wordmark over every signed-out page: sign in, forgot, reset, welcome. */
export function LandingBrand() {
  return (
    <div className="login-brand">
      <h1 className="wordmark">G-CORE</h1>
      <div className="wordmark-sub">Gruntechnology Corp</div>
    </div>
  );
}

export function Login() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="landing">
      <div className="login-wrap">
        <LandingBrand />

        <form className="panel" onSubmit={submit}>
          <h2>SIGN IN</h2>
          <ErrorBox error={error} />

          <div className="field">
            <label htmlFor="login-email">Email</label>
            <input
              id="login-email"
              type="email"
              value={email}
              autoComplete="username"
              autoFocus
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="field">
            <label htmlFor="login-password">Password</label>
            <PasswordInput
              id="login-password"
              value={password}
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'SIGN IN'}
          </button>

          <p className="login-aside">
            <Link to="/forgot-password">Forgot password?</Link>
          </p>
        </form>

        <div className="faint login-host">gruntech.gcore.tech</div>
      </div>
    </div>
  );
}
