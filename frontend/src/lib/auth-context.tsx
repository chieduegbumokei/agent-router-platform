'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import * as api from './api';
import type { SessionUser } from './types';

type Status = 'loading' | 'authed' | 'anon';

interface AuthState {
  status: Status;
  user: SessionUser | null;
  login(email: string, password: string): Promise<void>;
  signup(email: string, password: string): Promise<void>;
  logout(): void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<SessionUser | null>(null);

  // Silent session restore from the stored refresh token.
  useEffect(() => {
    api
      .refreshSession()
      .then((restored) => {
        setUser(restored);
        setStatus(restored ? 'authed' : 'anon');
      })
      .catch(() => setStatus('anon'));
  }, []);

  const value: AuthState = {
    status,
    user,
    async login(email, password) {
      const u = await api.login(email, password);
      setUser(u);
      setStatus('authed');
    },
    async signup(email, password) {
      const u = await api.signup(email, password);
      setUser(u);
      setStatus('authed');
    },
    logout() {
      api.logoutSession();
      setUser(null);
      setStatus('anon');
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
