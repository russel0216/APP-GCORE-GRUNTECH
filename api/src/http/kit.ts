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

/**
 * Runs a delete, and turns a foreign-key refusal (Prisma P2003 — a record
 * elsewhere still points at it) into a 400 that says so, rather than a 500.
 * The delete's transaction has rolled back by then, so nothing went.
 */
export async function deleteOrRefuse<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if ((err as { code?: string })?.code === 'P2003') {
      throw badRequest(`${what} still has records filed against it, so it is kept — nothing was deleted`);
    }
    throw err;
  }
}
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

export function errorMiddleware(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof HttpError ? err.message : 'Something went wrong on our side';
  if (!(err instanceof HttpError)) console.error(err);
  // A paper opened in its own tab through a print ticket is read by a
  // person, not a script: the refusal is a page saying why, never raw JSON.
  if (req.method === 'GET' && typeof req.query.ticket === 'string' && !res.headersSent) {
    const text = message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    res
      .status(status)
      .type('html')
      .send(
        `<!doctype html><meta charset="utf-8"><title>Not printed</title>` +
          `<body style="font:16px system-ui,sans-serif;margin:3rem;color:#222">` +
          `<h1 style="font-size:20px">This paper could not be opened</h1><p>${text}</p></body>`,
      );
    return;
  }
  if (err instanceof HttpError) {
    res.status(status).json({ error: message, details: err.details });
    return;
  }
  res.status(500).json({ error: message });
}
