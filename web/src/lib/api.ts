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
  /**
   * An authenticated binary — a PDF, a logo, an account photo. `fetch` alone
   * won't carry the bearer token to an `<img src>`, so this is the one place
   * that fetches the bytes directly; callers turn the result into an object
   * URL and revoke it when they're done with it.
   */
  async getBlob(path: string): Promise<Blob> {
    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`/api${path}`, { headers });
    if (!res.ok) {
      // The server says why in JSON ({ error: string }); say the same.
      const body = await res.json().catch(() => null);
      const message = body && typeof body.error === 'string' ? body.error : `Request failed (${res.status})`;
      throw new ApiError(res.status, message);
    }
    return res.blob();
  },
};

/**
 * Opens a paper in a new tab under its REAL address (2026-10-12), so the
 * browser's Save as offers the server's standard file name ("Quotation
 * 0062602018 R0 - Carter Gasiong - 2026-10-08.pdf") rather than a blob's
 * random id. A new tab carries no bearer token, so this first asks for a
 * one-use print ticket for exactly this address (`POST /api/pdf/tickets`)
 * and opens `path?ticket=…`; the paper's own route then runs every check
 * it runs for a bearer, and a refusal there is a page saying why.
 *
 * `path` is the full `/api/...` path — every caller passes it that way. A
 * refused ticket (signed out, not a paper's address) is reported through
 * `onError`, as a refused paper was before.
 */
export function openPdf(path: string, onError: (message: string) => void): void {
  // Opened now, inside the click, so no popup blocker stands in the way;
  // pointed at the paper once the ticket is in hand.
  const tab = window.open('', '_blank');
  api
    .post<{ ticket: string }>('/pdf/tickets', { path })
    .then(({ ticket }) => {
      const url = `${path}${path.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(ticket)}`;
      if (tab) tab.location.href = url;
      else window.open(url, '_blank');
    })
    .catch((err: unknown) => {
      tab?.close();
      onError(err instanceof Error ? err.message : '');
    });
}

/**
 * Saves an authenticated binary under a file name — an `.ics`, a CSV, an
 * attendance sheet. `path` is API-relative like every `api.*` call, since it
 * goes through `getBlob`.
 */
export async function downloadBlob(path: string, filename: string): Promise<void> {
  const blob = await api.getBlob(path);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // The click has already started the save; the URL is not needed after it.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

// ── Shared shapes ────────────────────────────────────────────────────────────

export interface ListResult<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  /** What the whole filtered set adds up to, where an endpoint says (the quotation list does). */
  summary?: ListSummary;
}

/** A list endpoint's summary: `tabCounts` feeds a DataList's tab strip ('' is All); the rest is the screen's. */
export interface ListSummary {
  /** The tabs as the server names them — a stage renamed in Admin is renamed here. Beats the screen's own options. */
  tabs?: { value: string; label: string; color?: string }[];
  tabCounts?: Record<string, number>;
  [key: string]: unknown;
}

export interface MenuSubmodule {
  key: string;
  label: string;
  path: string;
  note?: string;
  /** Sidebar heading, set in the permission registry. Absent means "flat". */
  group?: string;
  /**
   * Not listed in the menu, but still a screen this person may open by link.
   * Kept in the payload so the sidebar still knows which module and section a
   * page such as /g-ops/budget-requests/:id belongs to.
   */
  hidden?: boolean;
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
    /** Printed under "Sincerely Yours," on the quotations this user authors. */
    phone: string | null;
    isSuperAdmin: boolean;
    roles: string[];
    /** Attachment id — see components/ui.tsx's Avatar. */
    photoPath: string | null;
    /** The Team on the employee record (HR's field), for the lists' Mine · Team · All switch; null without one. */
    team: { id: string; code: string; name: string } | null;
  };
  permissions: string[];
  menu: MenuModule[];
  company: { name: string; logoPath: string | null; currency: string; numberPrefix: string } | null;
  appearance?: {
    tokens: Record<string, string>;
    dark: Record<string, string>;
    day: Record<string, string>;
    css: string;
  };
  unread: number;
}

