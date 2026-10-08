import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodTypeAny } from 'zod';

/** An error carrying an HTTP status — anything else becomes a 500. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (m: string, d?: unknown) => new HttpError(400, m, d);
export const unauthorized = (m = 'Not signed in') => new HttpError(401, m);
export const forbidden = (m = 'You do not have access to this') => new HttpError(403, m);
export const notFound = (m = 'Not found') => new HttpError(404, m);
export const conflict = (m: string) => new HttpError(409, m);

/** Wraps an async handler so a rejected promise reaches the error middleware. */
export function handler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function parseBody<T extends ZodTypeAny>(schema: T, body: unknown): ReturnType<T['parse']> {
  try {
    return schema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      throw badRequest(
        'Some fields need attention',
        err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      );
    }
    throw err;
  }
}

// ── The shared list pattern ──────────────────────────────────────────────────
// Every list screen in G-Core uses the same query contract, so the same
// front-end component drives all of them (model §8.4).

export interface ListQuery {
  page: number;
  pageSize: number;
  search: string;
  sort: string | null;
  dir: 'asc' | 'desc';
  /** Mine · Team · All (2026-10-08): `team` is the viewer's team on their employee record — see shared/team.ts. */
  scope: 'mine' | 'team' | 'all';
  filters: Record<string, string>;
}

const RESERVED = new Set(['page', 'pageSize', 'search', 'sort', 'dir', 'scope']);

export function listQuery(req: Request): ListQuery {
  const q = req.query as Record<string, string | undefined>;
  const filters: Record<string, string> = {};
  for (const [key, value] of Object.entries(q)) {
    if (!RESERVED.has(key) && typeof value === 'string' && value !== '') filters[key] = value;
  }
  return {
    page: Math.max(1, Number(q.page) || 1),
    pageSize: Math.min(200, Math.max(1, Number(q.pageSize) || 25)),
    search: (q.search ?? '').trim(),
    sort: q.sort ?? null,
    dir: q.dir === 'asc' ? 'asc' : 'desc',
    scope: q.scope === 'mine' ? 'mine' : q.scope === 'team' ? 'team' : 'all',
    filters,
  };
}

export interface ListResult<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export function listResult<T>(rows: T[], total: number, q: ListQuery): ListResult<T> {
  return {
    rows,
    total,
    page: q.page,
    pageSize: q.pageSize,
    pageCount: Math.max(1, Math.ceil(total / q.pageSize)),
  };
}

/** The most rows one selection may name — a page holds at most 100, so five pages' worth. */
export const MAX_SELECTED_IDS = 500;

/**
 * A list's `?ids=` — the rows a person ticked (mass actions, 2026-10-08) —
 * as ids, or null when absent. Comma-separated, trimmed, de-duplicated; more
 * than MAX_SELECTED_IDS is a 400 rather than a silently shorter paper. Always
 * ANDed with the list's own visibility rule, so naming an id never shows a
 * row the caller could not see in the list.
 */
export function idsFilter(value: string | undefined): string[] | null {
  if (!value) return null;
  const ids = [...new Set(value.split(',').map((v) => v.trim()).filter(Boolean))];
  if (ids.length > MAX_SELECTED_IDS) throw badRequest(`Select at most ${MAX_SELECTED_IDS} rows at a time`);
  return ids;
}

/**
 * Builds a Prisma orderBy from the list query, falling back to a default when
 * the requested column is not sortable. Only whitelisted columns are accepted —
 * `sort` comes from the URL.
 */
export function orderBy(q: ListQuery, sortable: string[], fallback: Record<string, 'asc' | 'desc'>) {
  if (q.sort && sortable.includes(q.sort)) return { [q.sort]: q.dir };
  return fallback;
}

export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side' });
}
