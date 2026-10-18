import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, setToken, type Me } from './api';
import { applyAppearance, normalise } from './appearance';

interface AuthValue {
  me: Me | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => void;
  refresh: () => Promise<void>;
  /** Exact permission check — `gops.quotations.edit_own`. */
  can: (permission: string) => boolean;
  /** True if the user can open a screen at all (either view scope). */
  canView: (moduleKey: string, submoduleKey: string) => boolean;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const next = await api.get<Me>('/auth/me');
      setMe(next);
      // The stored appearance, now that we have the server's copy rather than
      // the cached one main.tsx painted with.
      applyAppearance(normalise(next.appearance));
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onSignedOut = () => setMe(null);
    window.addEventListener('gcore:signed-out', onSignedOut);
    return () => window.removeEventListener('gcore:signed-out', onSignedOut);
  }, [refresh]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const { token } = await api.post<{ token: string }>('/auth/login', { email, password });
      setToken(token);
      await refresh();
    },
    [refresh],
  );

  const signOut = useCallback(() => {
    setToken(null);
    setMe(null);
  }, []);

  const value = useMemo<AuthValue>(() => {
    const permissions = new Set(me?.permissions ?? []);
    const isSuper = me?.user.isSuperAdmin ?? false;
    const can = (permission: string) => isSuper || permissions.has(permission);
    return {
      me,
      loading,
      signIn,
      signOut,
      refresh,
      can,
      canView: (m, s) => can(`${m}.${s}.view_all`) || can(`${m}.${s}.view_own`),
    };
  }, [me, loading, signIn, signOut, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/**
 * View Own / Edit Own on the screens that gained the pair on 2026-10-18 —
 * the web's twin of api/src/shared/ownScope.ts. `can` is useAuth()'s. The
 * page decides which buttons to draw with these; the API decides for real.
 */
export function mayView(can: (k: string) => boolean, m: string, s: string): boolean {
  return can(`${m}.${s}.view_all`) || can(`${m}.${s}.view_own`);
}

/** Edit All, or Edit Own on a record that is the viewer's own. */
export function mayEdit(can: (k: string) => boolean, m: string, s: string, isMine: boolean): boolean {
  return can(`${m}.${s}.edit_all`) || (isMine && can(`${m}.${s}.edit_own`));
}

/** Either key of the edit pair — for a page that keeps no record of anybody's (a settings page). */
export function mayEditPage(can: (k: string) => boolean, m: string, s: string): boolean {
  return can(`${m}.${s}.edit_all`) || can(`${m}.${s}.edit_own`);
}
