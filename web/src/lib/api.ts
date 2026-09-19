/** One HTTP client for the whole app — token handling and errors in one place. */

const TOKEN_KEY = 'gcore_token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode — the session simply won't persist across reloads */
  }
}

export interface FieldError {
  field: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: FieldError[],
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

export function qs(params: Query): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch(`/api${path}`, { method, headers, body: payload });

  if (res.status === 401) {
    setToken(null);
    // Let the auth provider notice rather than hard-reloading mid-typing.
    window.dispatchEvent(new CustomEvent('gcore:signed-out'));
    throw new ApiError(401, 'Your session has expired — please sign in again');
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let details: FieldError[] | undefined;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
      if (Array.isArray(data?.details)) details = data.details;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message, details);
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

// ── Shared shapes ────────────────────────────────────────────────────────────

export interface ListResult<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export interface MenuSubmodule {
  key: string;
  label: string;
  path: string;
  phase: number;
  note?: string;
  actions: string[];
}

export interface MenuModule {
  key: string;
  label: string;
  blurb: string;
  submodules: MenuSubmodule[];
}

export interface Me {
  user: {
    id: string;
    name: string;
    email: string;
    position: string | null;
    isSuperAdmin: boolean;
    roles: string[];
  };
  permissions: string[];
  menu: MenuModule[];
  company: { name: string; logoPath: string | null; currency: string; numberPrefix: string } | null;
  unread: number;
}

/**
 * Screens at or below this phase are live; anything above renders as upcoming.
 *
 * Bumped as each phase lands. The registry on the server already declares every
 * screen and its phase, so this is the only place the front end needs to know
 * how far the build has got.
 */
export const SHIPPED_PHASE = 5;
