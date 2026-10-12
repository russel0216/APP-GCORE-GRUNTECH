import crypto from 'node:crypto';
import { env } from '../env';

/**
 * Print tickets (2026-10-12): how a paper opens in a tab of its own under
 * its REAL address, so the browser saves it under the server's standard
 * name (`shared/paperName.ts`) rather than a blob's random id.
 *
 * A tab opened with `window.open` carries no bearer token, so the page asks
 * first — `POST /api/print-tickets { path }` — and opens `path?ticket=…`.
 * The ticket is the liveness challenge's design (`shared/liveness.ts`):
 * stateless, an HMAC with the JWT secret over `userId.path.issuedAt.nonce`,
 * good for `TICKET_TTL_MS` and ONCE — the only memory is the set of nonces
 * spent within that window, which a restart forgets (a ticket is then
 * still good for what is left of its two minutes, for the same person and
 * the same address). It opens exactly one GET of exactly the path and query
 * it was issued for, as the person it was issued to; every permission check,
 * guard and audit row runs as for a bearer.
 */
export const TICKET_TTL_MS = 2 * 60 * 1000;

const sign = (payload: string) => crypto.createHmac('sha256', env.jwtSecret).update(payload).digest('base64url');

const spent = new Map<string, number>();
function sweep(now: number) {
  for (const [nonce, issuedAt] of spent) if (now - issuedAt > TICKET_TTL_MS) spent.delete(nonce);
}

/**
 * The address a ticket names, in one spelling: what the browser would ask
 * for (`URL`'s own encoding), with any `ticket` parameter taken out. Both
 * the issue and the check go through it, so `?a=1&b=x%20y` and the same
 * address re-encoded by the browser compare equal. Null for anything that
 * is not an API path (a full URL, another origin, a non-API page).
 */
export function ticketPath(raw: string): string | null {
  if (!raw.startsWith('/api/') || raw.startsWith('//')) return null;
  let u: URL;
  try {
    u = new URL(raw, 'http://ticket.invalid');
  } catch {
    return null;
  }
  if (u.origin !== 'http://ticket.invalid' || !u.pathname.startsWith('/api/')) return null;
  u.searchParams.delete('ticket');
  const search = u.searchParams.toString();
  return search ? `${u.pathname}?${search}` : u.pathname;
}

/** A ticket for `path`, as `<issuedAt>.<nonce>.<userId>.<mac>`. */
export function issueTicket(userId: string, path: string, now = Date.now()): string {
  const nonce = crypto.randomBytes(12).toString('base64url');
  return `${now}.${nonce}.${userId}.${sign(`${userId}.${path}.${now}.${nonce}`)}`;
}

export type TicketRefusal = 'malformed' | 'expired' | 'forged' | 'used';

/**
 * Checks a ticket for `path` and SPENDS it, answering whose it is. The user
 * named in the ticket is covered by its HMAC, so neither the person nor the
 * address can be changed.
 */
export function redeemTicket(
  ticket: string,
  path: string,
  now = Date.now(),
): { userId: string } | { refused: TicketRefusal } {
  const parts = ticket.split('.');
  if (parts.length !== 4) return { refused: 'malformed' };
  const [issued, nonce, userId, mac] = parts;
  const issuedAt = Number(issued);
  if (!Number.isFinite(issuedAt) || !nonce || !userId || !mac) return { refused: 'malformed' };
  if (now - issuedAt > TICKET_TTL_MS || issuedAt - now > 5000) return { refused: 'expired' };
  const expected = Buffer.from(sign(`${userId}.${path}.${issued}.${nonce}`));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { refused: 'forged' };
  sweep(now);
  if (spent.has(nonce)) return { refused: 'used' };
  spent.set(nonce, issuedAt);
  return { userId };
}
