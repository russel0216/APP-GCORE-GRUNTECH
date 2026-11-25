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

/**
 * A supplier picker is on G-CHAIN's forms (the purchase order, the canvass, the
 * Incoming Report without an order, the item master …) and G-FIN's money out
 * (the supplier bill) (2026-11-25, the owner's report: "Receive from — supplier
 * could not be listed" for a warehouse hand on an Incoming without a PO): anyone
 * who writes on one of those, or reads the supplier master, may look a supplier
 * up by name.
 */
export const SUPPLIER_PICKER_KEYS: string[] = [
  ...allPermissions()
    .filter((p) => (p.module === 'gchain' || p.module === 'gfin') && WRITE_ACTIONS.has(p.action))
    .map((p) => p.key),
  'gchain.suppliers.view_own',
  'gchain.suppliers.view_team',
  'gchain.suppliers.view_all',
];

export function mayPickSuppliers(user: ResolvedUser): boolean {
  return SUPPLIER_PICKER_KEYS.some((k) => can(user, k));
}

export const requireSupplierPicker: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (!mayPickSuppliers(req.user)) return next(forbidden('You need a right that picks a supplier to list them'));
  next();
};
