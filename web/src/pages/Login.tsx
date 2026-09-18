import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { ErrorBox } from '../components/ui';

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
        <div style={{ textAlign: 'center' }}>
          <h1 className="wordmark">G-CORE</h1>
          <div className="wordmark-sub">Gruntechnology Corp</div>
        </div>

        <form className="panel" onSubmit={submit}>
          <h2>SIGN IN</h2>
          <ErrorBox error={error} />

          <div className="field">
            <label>Email</label>
            <input
              type="email"
              value={email}
              autoComplete="username"
              autoFocus
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="field">
            <label>Password</label>
            <input
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'SIGN IN'}
          </button>
        </form>

        <div className="faint" style={{ fontSize: 11, letterSpacing: 1 }}>
          gruntech.gcore.tech
        </div>
      </div>
    </div>
  );
}
