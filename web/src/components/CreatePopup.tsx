import { lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';

/*
  "+ New …" from a picker (2026-11-18, the owner's call: "if none appear a
  suggestion to create one — popup window so it will retain on the page where
  I am"). The record's own New form, opened over the page with the typed name
  filled in; saving hands the new record back to the picker.

  The forms are loaded when first asked for: the pages that own them import
  half the app, and a picker must not.
*/

const WarehouseModal = lazy(() => import('../pages/masters/Reference').then((m) => ({ default: m.WarehouseModal })));
const ContactModal = lazy(() => import('../pages/masters/Customer360').then((m) => ({ default: m.ContactModal })));
const NewItemPopup = lazy(() => import('../pages/masters/Items').then((m) => ({ default: m.NewItemPopup })));

export type CreateKind = 'warehouse' | 'contact' | 'item';

/** Who may file one — the API's own rule, so the offer is never a dead end. */
export const CREATE_RIGHT: Record<CreateKind, string> = {
  warehouse: 'gchain.warehouses.create',
  contact: 'gops.customers.edit_all',
  item: 'gchain.items.create',
};

export const CREATE_LABEL: Record<CreateKind, string> = {
  warehouse: 'New warehouse',
  contact: 'New contact',
  item: 'New item',
};

export interface CreatedItem {
  id: string;
  code: string;
  name: string;
  partNumber: string | null;
  unit: string;
  standardCost: number | string | null;
}

export function CreatePopup({
  kind,
  typed,
  customerId,
  onClose,
  onCreated,
  onItem,
}: {
  kind: CreateKind;
  /** What was typed in the picker: the new record's name to start with. */
  typed: string;
  /** A contact belongs to a customer. */
  customerId?: string;
  onClose: () => void;
  /** The new record as an option: its id and how a list names it. */
  onCreated: (created: { id: string; label: string }) => void;
  /** The whole item, where the picker needs its unit and cost. */
  onItem?: (item: CreatedItem) => void;
}) {
  const preset = typed || undefined;
  return createPortal(
    <Suspense fallback={null}>
      {kind === 'warehouse' && (
        <WarehouseModal
          warehouse={null}
          presetName={preset}
          onClose={onClose}
          onSaved={(w) => (w ? onCreated({ id: w.id, label: `${w.code} — ${w.name}` }) : onClose())}
        />
      )}
      {kind === 'contact' && customerId && (
        <ContactModal
          customerId={customerId}
          contact={null}
          presetName={preset}
          onClose={onClose}
          onSaved={(c) => (c ? onCreated({ id: c.id, label: c.name }) : onClose())}
        />
      )}
      {kind === 'item' && (
        <NewItemPopup
          presetName={preset}
          onClose={onClose}
          onSaved={(it) => {
            onItem?.(it);
            onCreated({ id: it.id, label: `${it.code} — ${it.name}` });
          }}
        />
      )}
    </Suspense>,
    document.body,
  );
}
