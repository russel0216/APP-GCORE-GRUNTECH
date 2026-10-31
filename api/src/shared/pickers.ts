/**
 * Who may read a picker's list of names (2026-10-31, help tickets: "No option
 * for Warehouse" on the purchase requisition, "customer could not be listed" on
 * the Installation Base). A picker answers names only, never the record, so it
 * opens to whoever fills a form that picks one — not only to the master's
 * readers.
 */
import type { RequestHandler } from 'express';
import { allPermissions } from '../permissions/registry';
import { can } from '../permissions/resolve';
import { forbidden, unauthorized } from '../http/kit';
import type { ResolvedUser } from '../permissions/resolve';

const WRITE_ACTIONS = new Set(['create', 'edit_own', 'edit_team', 'edit_all']);

/**
 * A customer picker is on the forms of G-OPS (leads, quotations, sales orders,
 * job orders, the installation base, service JOs, visits, reports, contracts …)
 * and of G-FIN's money in: anyone who writes on one of those, or reads the
 * customer master, may look a customer up by name.
 */
export const CUSTOMER_PICKER_KEYS: string[] = [
  ...allPermissions()
    .filter((p) => (p.module === 'gops' || p.module === 'gfin') && WRITE_ACTIONS.has(p.action))
    .map((p) => p.key),
  'gops.customers.view_own',
  'gops.customers.view_team',
  'gops.customers.view_all',
];

export function mayPickCustomers(user: ResolvedUser): boolean {
  return CUSTOMER_PICKER_KEYS.some((k) => can(user, k));
}

export const requireCustomerPicker: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (!mayPickCustomers(req.user)) return next(forbidden('You need a right that picks a customer to list them'));
  next();
};
