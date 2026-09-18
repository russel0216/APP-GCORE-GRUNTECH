import type { Request } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

/**
 * Audit trail (model §6.4).
 *
 * Every major record keeps its lifecycle: Created → Submitted → Approved →
 * Converted/Executed → Completed. Writing this centrally means a new module
 * gets an audit trail by calling one function, rather than by remembering to
 * build one.
 */
export type AuditAction =
  | 'CREATED'
  | 'UPDATED'
  | 'DELETED'
  | 'SUBMITTED'
  | 'APPROVED'
  | 'REJECTED'
  | 'RETURNED'
  | 'CANCELLED'
  | 'CONVERTED'
  | 'EXECUTED'
  | 'COMPLETED'
  | 'SIGNED_IN'
  | 'EXPORTED';

export interface AuditInput {
  entityType: string;
  entityId: string;
  action: AuditAction;
  summary?: string;
  actorId?: string | null;
  actorName?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

function ipOf(req?: Request): string | null {
  if (!req) return null;
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string') return fwd.split(',')[0].trim();
  return req.socket.remoteAddress ?? null;
}

export async function audit(
  input: AuditInput,
  req?: Request,
  tx: Prisma.TransactionClient = prisma,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      summary: input.summary ?? null,
      actorId: input.actorId ?? req?.user?.id ?? null,
      actorName: input.actorName ?? req?.user?.name ?? null,
      before: (input.before ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      after: (input.after ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      ip: input.ip ?? ipOf(req),
    },
  });
}

/**
 * Strips fields that must never reach the audit log or an API response.
 * Password hashes are the obvious one; employee cost rates will join this list
 * when Phase 6 lands (model §4.4).
 */
const REDACTED = new Set(['passwordHash', 'password', 'token', 'costRate', 'salary']);

export function redact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!REDACTED.has(k)) out[k] = v;
  }
  return out as Partial<T>;
}
