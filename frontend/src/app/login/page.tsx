'use client';

import { AlertCircle, Eye, EyeOff, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

export default function LoginPage() {
  const { status, login, signup } = useAuth();
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === 'authed') router.replace('/chat');
  }, [status, router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'login') await login(email, password);
      else await signup(email, password);
      router.replace('/chat');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong - is the backend running?');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-gate">
      <main className="login-main">
        <div className="login-form-col">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="Cross River" className="login-logo" />
          <h1>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
          <p className="login-sub">
            {mode === 'login'
              ? 'Enter the email and password for your Cross River Assistant account'
              : 'Set an email and password to start using the Cross River Assistant'}
          </p>

          <form onSubmit={onSubmit}>
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
            </label>
            <label className="field">
              <span>Password{mode === 'signup' ? ' (min 8 characters)' : ''}</span>
              <div className="password-wrap">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  minLength={8}
                  required
                />
                <button
                  type="button"
                  className="password-toggle"
                  onClick={() => setShowPassword((s) => !s)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  title={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </label>

            {error && (
              <div className="login-error">
                <AlertCircle size={14} /> {error}
              </div>
            )}

            <button className="btn primary login-submit" type="submit" disabled={busy}>
              {busy && <Loader2 size={15} className="spin" />}
              {mode === 'login' ? 'Continue' : 'Create account'}
            </button>
          </form>

          <div className="login-alt">
            <span>{mode === 'login' ? "Don't have an account?" : 'Already have an account?'}</span>
            <button
              className="btn secondary login-alt-btn"
              onClick={() => {
                setError(null);
                setMode((m) => (m === 'login' ? 'signup' : 'login'));
              }}
            >
              {mode === 'login' ? 'Create account' : 'Log in'}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
