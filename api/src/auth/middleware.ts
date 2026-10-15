import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../env';
import { forbidden, unauthorized } from '../http/kit';
import { can, resolveUser, type ResolvedUser } from '../permissions/resolve';
import { redeemTicket, ticketPath } from '../shared/printTickets';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: ResolvedUser;
    }
  }
}

export interface TokenPayload {
  sub: string;
  email: string;
}

export function signToken(userId: string, email: string): string {
  const payload: TokenPayload = { sub: userId, email };
  return jwt.sign(payload, env.jwtSecret, { expiresIn: env.jwtExpiresIn } as jwt.SignOptions);
}

function bearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
}

/** Requires a valid token and loads the user's effective permissions. */
export const authenticate: RequestHandler = (req, _res, next) => {
  const token = bearer(req);
  const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : null;
  // A print ticket (shared/printTickets.ts) stands in for the bearer on the
  // ONE GET it was issued for — the tab a paper opens in carries no token.
  if (!token && ticket) {
    // Two routers under one prefix (/api/jobs) each authenticate: the
    // ticket was spent by the first, and the user it named stands.
    if (req.user) return next();
    if (req.method !== 'GET') return next(unauthorized('A print ticket opens a paper, nothing else'));
    const path = ticketPath(req.originalUrl);
    const redeemed = path ? redeemTicket(ticket, path) : { refused: 'malformed' as const };
    if ('refused' in redeemed) {
      return next(
        unauthorized(
          redeemed.refused === 'used' || redeemed.refused === 'expired'
            ? 'That print link was already used or has expired — print it again from G-CORE'
            : 'That print link is not valid — print it again from G-CORE',
        ),
      );
    }
    return void resolveUser(redeemed.userId)
      .then((user) => {
        if (!user) return next(unauthorized('Your account is no longer active'));
        req.user = user;
        next();
      })
      .catch(next);
  }
  if (!token) return next(unauthorized());

  let payload: TokenPayload;
  try {
    payload = jwt.verify(token, env.jwtSecret) as TokenPayload;
  } catch {
    return next(unauthorized('Your session has expired — please sign in again'));
  }

  resolveUser(payload.sub)
    .then((user) => {
      if (!user) return next(unauthorized('Your account is no longer active'));
      req.user = user;
      next();
    })
    .catch(next);
};

/** Requires one specific `module.submodule.action` permission. */
export function require_(permissionKey: string): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!can(req.user, permissionKey)) {
      return next(forbidden(`You need "${permissionKey}" to do this`));
    }
    next();
  };
}

/** Requires any one of several permissions — used for view_own OR view_all. */
export function requireAny(...permissionKeys: string[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!permissionKeys.some((k) => can(req.user!, k))) {
      return next(forbidden(`You need one of: ${permissionKeys.join(', ')}`));
    }
    next();
  };
}

/**
 * `requireAny`, except that a caller holding none of the keys is let through
 * MARKED (`res.locals.deciderOnly`), for a record route that also admits whoever
 * may decide the record's open approval — a stand-in, who holds no right to
 * the module (2026-10-12). The handler must then prove that with
 * `mayDecide()` (shared/approvals.ts) or refuse; nothing else changes for a
 * caller who holds a key.
 */
export function requireAnyOrDecider(...permissionKeys: string[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    res.locals.deciderOnly = !permissionKeys.some((k) => can(req.user!, k));
    next();
  };
}

export const requireSuperAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (!req.user.isSuperAdmin) return next(forbidden('Super Admin only'));
  next();
};

export function currentUser(req: Request): ResolvedUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
