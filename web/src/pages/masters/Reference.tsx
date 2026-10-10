import { useCallback, useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Checkbox, Empty, ErrorBox, Field, Loading, Modal, ModalFoot, StatusBadge, useToast } from '../../components/ui';
import { useConfirm } from '../../components/Confirm';
import { NumberInput } from '../../components/NumberInput';

// ════════════════════════════════════════════════════════════════════
//  CATEGORIES — cost categories, item categories, teams, sub-industries,
//  quotation groups, activity types, drawing types
// ════════════════════════════════════════════════════════════════════

interface CostCategory {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  isSystem: boolean;
  isActive: boolean;
}

/**
 * A sales team (KAT, HIT, UIT, GIB, SIT — the Industry master, 2026-10-08):
 * a person's team is this row on their employee record. Exported: the
 * employee form reads the same shape from GET /reference/industries.
 */
export interface Industry {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  isSystem: boolean;
  isActive: boolean;
  _count?: { customers: number; employees: number };
}

/**
 * A customer's sub-industry (the owner's twenty-six — Aerospace, Agriculture,
 * Healthcare…; 2026-10-09). Exported: the customer form and the customer
 * list filter read the same shape from GET /reference/sub-industries.
 */
export interface SubIndustry {
  id: string;
  name: string;
  sortOrder: number;
  isSystem: boolean;
  isActive: boolean;
  _count?: { customers: number };
}

/** A quotation line's group (SCORO's Group column), with how many lines use it. */
export interface QuotationGroup {
  id: string;
  name: string;
  /** What the group covers — the editor's hint under its name. */
  description: string | null;
  /** The brand a line filed under it carries; none for a house group. */
  brand: string | null;
  sortOrder: number;
  isActive: boolean;
  lineCount?: number;
}

interface ItemCategory {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
  _count: { items: number };
}

/** A sales activity type (the calendar's Type list, 2026-10-08), with how many activities are of it. */
export interface ActivityTypeDef {
  id: string;
  /** Fixed for life — an activity carries it. */
  key: string;
  name: string;
  color: string | null;
  sortOrder: number;
  isSystem: boolean;
  isActive: boolean;
  activityCount?: number;
}

/** What a CAD job order asks for (2026-10-09): Layout plan, P&ID…, with how many requests carry it. */
export interface DrawingTypeDef {
  id: string;
  name: string;
  sortOrder: number;
  isSystem: boolean;
  isActive: boolean;
  _count?: { requests: number };
}

// ── One card and one modal for every category (2026-10-10) ───────────────────
//
// Seven cards used to carry seven near-identical modals — ~690 lines that
// differed only in their endpoint, their fields, who may be deleted and the
// note that says why not. Each category is now a `CategorySpec`: the DATA
// that differed; `CategoryCard` and `CategoryModal` are the one drawing.
// A new reference list is a spec and a line in `Categories`, never an eighth
// modal.

/** What every category row has: the key, and the name the modal's title prints. */
interface CategoryRow {
  id: string;
  name: string;
}

/** A modal's form: text, number and tick values by field key. */
type FormValue = string | number | boolean;
type Form = Record<string, FormValue>;

type FieldSpec =
  | {
      kind: 'text';
      key: string;
      label: string;
      hint?: string;
      maxLength?: number;
      mono?: boolean;
      /** A standard row's code is fixed: the box is shown, never typed in. */
      disabled?: boolean;
      /** Reshapes what was typed before it lands in the form (a code's upper-casing). */
      clean?: (typed: string) => string;
    }
  | { kind: 'count'; key: string; label: string }
  | { kind: 'color'; key: string; label: string; hint?: string; fallback: string }
  | { kind: 'select'; key: string; label: string; options: { value: string; label: string }[] }
  | { kind: 'check'; key: string; label: string };

interface CategoryColumn<T> {
  key: string;
  head: ReactNode;
  /** The `<th>`'s class (`m-col-code`, `right`). */
  headClass?: string;
  /** The `<td>`'s class (`mono`, `right`). */
  cellClass?: string;
  render: (row: T) => ReactNode;
}

interface CategorySpec<T extends CategoryRow> {
  /** "cost category": "+ New cost category", "Modify cost category X", "Delete the cost category X?". */
  noun: string;
  /** The card's title. */
  title: string;
  /** `/reference/cost-categories`: POST creates, PATCH /:id modifies, DELETE /:id removes. */
  endpoint: string;
  columns: CategoryColumn<T>[];
  /** Drawn instead of the table while there are no rows; without it the empty table is drawn. */
  empty?: { title: string; hint?: string };
  /** The note under the table. */
  footnote?: ReactNode;
  /** The form a new row starts from. */
  blank: Form;
  /** The form an existing row opens on. */
  fromRow: (row: T) => Form;
  /** The fields, in order; the first text box takes focus. `rows` is for a field that lists the others (a parent category). */
  fields: (row: T | null, rows: T[]) => FieldSpec[];
  /** What is sent; the form itself when not given. */
  payload?: (form: Form) => unknown;
  /** Whether Save is offered; always when not given. */
  canSave?: (form: Form) => boolean;
  /** Whether this row may be deleted — besides `admin.categories.delete`, which the modal checks. */
  deletable: (row: T) => boolean;
  /** The note above an existing row's fields: what is fixed on it, or why it cannot be deleted. */
  notice?: (row: T) => ReactNode;
}

const upper = (s: string) => s.toUpperCase();
const text = (v: FormValue | undefined) => String(v ?? '');

/** Active / Inactive, as every category prints it. */
function activeBadge(isActive: boolean) {
  return <StatusBadge status={isActive ? 'ACTIVE' : 'INACTIVE'} extra={{ INACTIVE: '' }} />;
}

const COST_CATEGORIES: CategorySpec<CostCategory> = {
  noun: 'cost category',
  title: 'Cost categories',
  endpoint: '/reference/cost-categories',
  columns: [
    { key: 'code', head: 'Code', headClass: 'm-col-code', cellClass: 'mono', render: (c) => c.code },
    {
      key: 'name',
      head: 'Name',
      render: (c) => (
        <>
          {c.name}
          {c.isSystem && <span className="badge m-inline">standard</span>}
        </>
      ),
    },
    { key: 'status', head: 'Status', render: (c) => activeBadge(c.isActive) },
  ],
  footnote:
    'The six standard categories cannot be deleted — every budget and cost figure in the system is grouped by them. You can rename them.',
  blank: { code: '', name: '', sortOrder: 99, isActive: true },
  fromRow: (c) => ({ code: c.code, name: c.name, sortOrder: c.sortOrder, isActive: c.isActive }),
  fields: (row) => [
    { kind: 'text', key: 'name', label: 'Name' },
    { kind: 'text', key: 'code', label: 'Code', mono: true, disabled: row?.isSystem, clean: upper },
    { kind: 'count', key: 'sortOrder', label: 'Sort order' },
    { kind: 'check', key: 'isActive', label: 'Active' },
  ],
  deletable: (c) => !c.isSystem,
  notice: (c) =>
    c.isSystem
      ? 'This is one of the six standard categories. You can rename it; its code and existence are fixed because the cost ledger groups by them.'
      : null,
};

const ITEM_CATEGORIES: CategorySpec<ItemCategory> = {
  noun: 'item category',
  title: 'Item categories',
  endpoint: '/reference/item-categories',
  columns: [
    { key: 'code', head: 'Code', headClass: 'm-col-code', cellClass: 'mono', render: (c) => c.code },
    {
      key: 'name',
      head: 'Name',
      render: (c) => (
        <>
          {c.parentId && <span className="faint">↳ </span>}
          {c.name}
        </>
      ),
    },
    { key: 'items', head: 'Items', headClass: 'right', cellClass: 'right', render: (c) => c._count.items },
  ],
  empty: { title: 'No item categories' },
  blank: { code: '', name: '', parentId: '' },
  fromRow: (c) => ({ code: c.code, name: c.name, parentId: c.parentId ?? '' }),
  fields: (row, rows) => [
    { kind: 'text', key: 'name', label: 'Name' },
    { kind: 'text', key: 'code', label: 'Code', mono: true, clean: upper },
    {
      kind: 'select',
      key: 'parentId',
      label: 'Parent category',
      options: [
        { value: '', label: '— top level —' },
        ...rows.filter((c) => c.id !== row?.id).map((c) => ({ value: c.id, label: c.name })),
      ],
    },
  ],
  payload: (f) => ({ code: f.code, name: f.name, parentId: f.parentId || null }),
  deletable: () => true,
};

/** People and customers carrying the team — a team any record names is switched off, never deleted. */
const teamUse = (i: Industry) => (i._count?.customers ?? 0) + (i._count?.employees ?? 0);

const TEAMS: CategorySpec<Industry> = {
  noun: 'team',
  title: 'Teams',
  endpoint: '/reference/industries',
  columns: [
    { key: 'code', head: 'Code', headClass: 'm-col-code', cellClass: 'mono', render: (i) => i.code },
    {
      key: 'name',
      head: 'Name',
      render: (i) => (
        <>
          {i.name}
          {i.isSystem && <span className="badge m-inline">standard</span>}
        </>
      ),
    },
    { key: 'people', head: 'People', headClass: 'right', cellClass: 'right', render: (i) => i._count?.employees ?? 0 },
    { key: 'status', head: 'Status', render: (i) => activeBadge(i.isActive) },
  ],
  empty: { title: 'No teams yet', hint: 'Run the seed to create the five — KAT, HIT, UIT, GIB and SIT.' },
  footnote:
    "HR puts each person on a team on the employee record; the quotation list counts quotes by it and the Team view lists a team's work. The standard teams cannot be deleted or recoded — but you can rename them or add your own. The five industries that came before them are switched off, never deleted.",
  blank: { code: '', name: '', sortOrder: 99, isActive: true },
  fromRow: (i) => ({ code: i.code, name: i.name, sortOrder: i.sortOrder, isActive: i.isActive }),
  fields: (row) => [
    { kind: 'text', key: 'name', label: 'Name', hint: 'e.g. Healthcare Industry Team' },
    {
      kind: 'text',
      key: 'code',
      label: 'Code',
      hint: 'Two to four letters',
      mono: true,
      maxLength: 4,
      disabled: row?.isSystem,
      clean: (s) => s.toUpperCase().replace(/[^A-Z]/g, ''),
    },
    { kind: 'count', key: 'sortOrder', label: 'Sort order' },
    { kind: 'check', key: 'isActive', label: 'Active — an inactive team stays on its people but is not offered for new ones' },
  ],
  canSave: (f) => text(f.name).trim().length >= 2 && /^[A-Z]{2,4}$/.test(text(f.code)),
  deletable: (i) => !i.isSystem && teamUse(i) === 0,
  notice: (i) => {
    if (i.isSystem) return 'A standard team. Rename it freely; its code is fixed because the quotation list and the Team view key on it.';
    const inUse = teamUse(i);
    if (inUse === 0) return null;
    return `${inUse === 1 ? 'One record carries' : `${inUse} records carry`} this team, so it cannot be deleted — untick Active to stop it being offered.`;
  },
};

const SUB_INDUSTRIES: CategorySpec<SubIndustry> = {
  noun: 'sub-industry',
  title: 'Sub-industries',
  endpoint: '/reference/sub-industries',
  columns: [
    {
      key: 'name',
      head: 'Name',
      render: (s) => (
        <>
          {s.name}
          {s.isSystem && <span className="badge m-inline">standard</span>}
        </>
      ),
    },
    { key: 'customers', head: 'Customers', headClass: 'right', cellClass: 'right', render: (s) => s._count?.customers ?? 0 },
    { key: 'status', head: 'Status', render: (s) => activeBadge(s.isActive) },
  ],
  empty: { title: 'No sub-industries yet', hint: "Run the seed to create the owner's twenty-six — Aerospace, Agriculture, Healthcare…" },
  footnote:
    'A customer may carry one of these — picked on the customer, later, by whoever knows. Sales Analytics counts what was quoted and won by it. The standard ones cannot be deleted — switch one off instead — but you can rename them or add your own.',
  blank: { name: '', sortOrder: 99, isActive: true },
  fromRow: (s) => ({ name: s.name, sortOrder: s.sortOrder, isActive: s.isActive }),
  fields: () => [
    { kind: 'text', key: 'name', label: 'Name', hint: 'e.g. Healthcare' },
    { kind: 'count', key: 'sortOrder', label: 'Sort order' },
    {
      kind: 'check',
      key: 'isActive',
      label: 'Active — an inactive sub-industry stays on its customers but is not offered for new ones',
    },
  ],
  canSave: (f) => text(f.name).trim().length >= 2,
  deletable: (s) => !s.isSystem && (s._count?.customers ?? 0) === 0,
  notice: (s) => {
    if (s.isSystem) return 'One of the standard sub-industries. Rename it freely; it cannot be deleted.';
    const inUse = s._count?.customers ?? 0;
    if (inUse === 0) return null;
    return `${inUse === 1 ? 'One customer carries' : `${inUse} customers carry`} this sub-industry, so it cannot be deleted — untick Active to stop it being offered.`;
  },
};

const QUOTATION_GROUPS: CategorySpec<QuotationGroup> = {
  noun: 'quotation group',
  title: 'Quotation groups',
  endpoint: '/reference/quotation-groups',
  columns: [
    { key: 'name', head: 'Name', render: (g) => g.name },
    { key: 'covers', head: 'Covers', render: (g) => g.description ?? <span className="faint">—</span> },
    { key: 'brand', head: 'Brand', render: (g) => g.brand ?? <span className="faint">—</span> },
    { key: 'lines', head: 'Lines', headClass: 'right', cellClass: 'right', render: (g) => (g.lineCount ?? 0).toLocaleString('en-US') },
    { key: 'status', head: 'Status', render: (g) => activeBadge(g.isActive) },
  ],
  empty: { title: 'No quotation groups yet', hint: 'A group typed on a quotation line is added here when the quotation is saved.' },
  footnote:
    "The quotation editor offers these for a line's Group, which every priced line must choose. A line keeps the group it was saved with, so renaming one here does not rewrite quotations already issued; a group in use is deactivated rather than deleted. Picking a group with a brand fills the line's Brand box when it is empty.",
  blank: { name: '', description: '', brand: '', sortOrder: 0, isActive: true },
  fromRow: (g) => ({ name: g.name, description: g.description ?? '', brand: g.brand ?? '', sortOrder: g.sortOrder, isActive: g.isActive }),
  fields: () => [
    { kind: 'text', key: 'name', label: 'Name', hint: 'e.g. OMEGA AIR, GRUNTECH SERVICES', maxLength: 120 },
    {
      kind: 'text',
      key: 'description',
      label: 'Covers',
      hint: "Shown under the name in the editor's dropdown — e.g. Compressed Air & Gas Treatment and Separation",
      maxLength: 200,
    },
    { kind: 'text', key: 'brand', label: 'Brand', hint: "Fills a line's Brand box when the group is picked; leave blank for a house group", maxLength: 120 },
    { kind: 'count', key: 'sortOrder', label: 'Sort order' },
    { kind: 'check', key: 'isActive', label: 'Active — an inactive group stays on its lines but is not suggested' },
  ],
  payload: (f) => ({ ...f, description: text(f.description).trim() || null, brand: text(f.brand).trim() || null }),
  canSave: (f) => !!text(f.name).trim(),
  deletable: (g) => (g.lineCount ?? 0) === 0,
  notice: (g) => {
    const inUse = g.lineCount ?? 0;
    if (inUse === 0) return null;
    return `${inUse === 1 ? 'One quotation line is' : `${inUse.toLocaleString('en-US')} quotation lines are`} filed under this group, so it cannot be deleted — untick Active to stop it being suggested.`;
  },
};

const ACTIVITY_TYPES: CategorySpec<ActivityTypeDef> = {
  noun: 'activity type',
  title: 'Activity types',
  endpoint: '/reference/activity-types',
  columns: [
    {
      key: 'name',
      head: 'Name',
      render: (t) => (
        <>
          {t.name}
          {t.isSystem && <span className="faint"> · built-in</span>}
        </>
      ),
    },
    {
      key: 'colour',
      head: 'Colour',
      render: (t) =>
        t.color ? (
          <span className="m-swatch-row">
            <span className="m-swatch" style={{ background: t.color }} aria-hidden="true" />
            <span className="mono">{t.color}</span>
          </span>
        ) : (
          <span className="faint">default</span>
        ),
    },
    { key: 'activities', head: 'Activities', headClass: 'right', cellClass: 'right', render: (t) => (t.activityCount ?? 0).toLocaleString('en-US') },
    { key: 'status', head: 'Status', render: (t) => activeBadge(t.isActive) },
  ],
  footnote:
    "What the sales calendar offers as an activity's Type, each with the colour its chip wears. The six built-ins can be renamed and recoloured but not deleted; a type in use is deactivated rather than deleted, and the activities of that type keep it.",
  blank: { name: '', color: '#5B2A8C', sortOrder: 0, isActive: true },
  fromRow: (t) => ({ name: t.name, color: t.color ?? '#5B2A8C', sortOrder: t.sortOrder, isActive: t.isActive }),
  fields: (row) => [
    {
      kind: 'text',
      key: 'name',
      label: 'Name',
      hint: row ? `Key ${row.key} — an activity carries the key, so renaming rewrites nothing` : 'e.g. Demo, Site survey, Training',
      maxLength: 60,
    },
    { kind: 'color', key: 'color', label: 'Colour', hint: 'The edge of its chips on the calendar', fallback: '#5B2A8C' },
    { kind: 'count', key: 'sortOrder', label: 'Sort order' },
    { kind: 'check', key: 'isActive', label: 'Active — an inactive type stays on its activities but is not offered' },
  ],
  payload: (f) => ({ ...f, color: f.color || null }),
  canSave: (f) => !!text(f.name).trim(),
  deletable: (t) => !t.isSystem && (t.activityCount ?? 0) === 0,
  notice: (t) => {
    if (t.isSystem) return 'A built-in type: rename or recolour it, or untick Active to stop offering it.';
    const inUse = t.activityCount ?? 0;
    if (inUse === 0) return null;
    return `${inUse === 1 ? 'One activity is' : `${inUse.toLocaleString('en-US')} activities are`} of this type, so it cannot be deleted — untick Active to stop offering it.`;
  },
};

const DRAWING_TYPES: CategorySpec<DrawingTypeDef> = {
  noun: 'drawing type',
  title: 'Drawing types',
  endpoint: '/reference/cad-drawing-types',
  columns: [
    {
      key: 'name',
      head: 'Name',
      render: (t) => (
        <>
          {t.name}
          {t.isSystem && <span className="faint"> · built-in</span>}
        </>
      ),
    },
    { key: 'requests', head: 'CAD job orders', headClass: 'right', cellClass: 'right', render: (t) => (t._count?.requests ?? 0).toLocaleString('en-US') },
    { key: 'status', head: 'Status', render: (t) => activeBadge(t.isActive) },
  ],
  footnote:
    'What a CAD job order asks the design team for. The seven built-ins can be renamed but not deleted; a type in use is deactivated rather than deleted, and the requests of that type keep it. Whatever the type, the output to the requestor is a PDF.',
  blank: { name: '', sortOrder: 0, isActive: true },
  fromRow: (t) => ({ name: t.name, sortOrder: t.sortOrder, isActive: t.isActive }),
  fields: () => [
    { kind: 'text', key: 'name', label: 'Name', hint: 'e.g. Isometric, Equipment layout, Cable schedule', maxLength: 80 },
    { kind: 'count', key: 'sortOrder', label: 'Sort order' },
    { kind: 'check', key: 'isActive', label: 'Active — an inactive type stays on its requests but is not offered' },
  ],
  canSave: (f) => text(f.name).trim().length >= 2,
  deletable: (t) => !t.isSystem && (t._count?.requests ?? 0) === 0,
  notice: (t) => {
    if (t.isSystem) return 'A built-in type: rename it, or untick Active to stop offering it.';
    const inUse = t._count?.requests ?? 0;
    if (inUse === 0) return null;
    return `${inUse === 1 ? 'One CAD job order is' : `${inUse.toLocaleString('en-US')} CAD job orders are`} of this type, so it cannot be deleted — untick Active to stop offering it.`;
  },
};

/**
 * A category row opens its "Modify …" modal — clicked, or Enter / Space while
 * the row has focus (rule 13) — for whoever may edit; nothing for a reader.
 * Keys pressed on the row-end Modify button are that button's own.
 */
function opensModify(open: (() => void) | null) {
  if (!open) return {};
  return {
    className: 'clickable',
    tabIndex: 0,
    onClick: open,
    onKeyDown: (e: ReactKeyboardEvent<HTMLTableRowElement>) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    },
  };
}

/** The row-end Modify: the same modal as the row, without the row's click opening it a second time. */
function ModifyCell({ onClick }: { onClick: () => void }) {
  return (
    <td className="m-col-action">
      <button
        type="button"
        className="btn btn-sm"
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
      >
        Modify
      </button>
    </td>
  );
}

/**
 * One reference card: its title, "+ New …" for whoever may create, the
 * table (every row opens Modify for whoever may edit), the footnote, and the
 * modal it opens. The card owns the modal so the page holds no state per
 * category.
 */
function CategoryCard<T extends CategoryRow>({
  spec,
  rows,
  onChanged,
  className = 'card',
}: {
  spec: CategorySpec<T>;
  rows: T[];
  /** A save or a delete went through: the page reloads every list. */
  onChanged: () => void;
  className?: string;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const mayEdit = can('admin.categories.edit_all');
  const [editing, setEditing] = useState<T | 'new' | null>(null);

  return (
    <div className={className}>
      <div className="m-card-head">
        <h3 className="card-title">{spec.title}</h3>
        {can('admin.categories.create') && (
          <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>
            + New {spec.noun}
          </button>
        )}
      </div>

      {spec.empty && rows.length === 0 ? (
        <Empty title={spec.empty.title} hint={spec.empty.hint} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                {spec.columns.map((c) => (
                  <th key={c.key} className={c.headClass}>
                    {c.head}
                  </th>
                ))}
                {mayEdit && <th className="m-col-action" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} {...opensModify(mayEdit ? () => setEditing(row) : null)}>
                  {spec.columns.map((c) => (
                    <td key={c.key} className={c.cellClass}>
                      {c.render(row)}
                    </td>
                  ))}
                  {mayEdit && <ModifyCell onClick={() => setEditing(row)} />}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {spec.footnote && <p className="m-footnote">{spec.footnote}</p>}

      {editing && (
        <CategoryModal
          spec={spec}
          row={editing === 'new' ? null : editing}
          rows={rows}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
            toast('ok', 'Saved');
          }}
        />
      )}
    </div>
  );
}

/** One field of a category's form, drawn by its kind. */
function CategoryField({
  field,
  value,
  autoFocus,
  onChange,
}: {
  field: FieldSpec;
  value: FormValue | undefined;
  autoFocus: boolean;
  onChange: (value: FormValue) => void;
}) {
  switch (field.kind) {
    case 'text':
      return (
        <Field label={field.label} hint={field.hint}>
          <input
            className={field.mono ? 'mono' : undefined}
            value={text(value)}
            autoFocus={autoFocus}
            maxLength={field.maxLength}
            disabled={field.disabled}
            onChange={(e) => onChange(field.clean ? field.clean(e.target.value) : e.target.value)}
          />
        </Field>
      );
    case 'count':
      return (
        <Field label={field.label}>
          <NumberInput kind="count" value={Number(value ?? 0)} onChange={(e) => onChange(Number(e.target.value))} />
        </Field>
      );
    case 'color':
      return (
        <Field label={field.label} hint={field.hint}>
          <input type="color" value={text(value) || field.fallback} onChange={(e) => onChange(e.target.value)} />
        </Field>
      );
    case 'select':
      return (
        <Field label={field.label}>
          <select value={text(value)} onChange={(e) => onChange(e.target.value)}>
            {field.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      );
    case 'check':
      return <Checkbox checked={value === true} onChange={onChange} label={field.label} />;
  }
}

/**
 * "New <noun>" or "Modify <noun> <name>": the spec's fields over its endpoint,
 * ModalFoot with Delete for a row the spec says may go (and only for an
 * `admin.categories.delete` holder), asked in the foot; a refusal from the
 * server shows there.
 */
function CategoryModal<T extends CategoryRow>({
  spec,
  row,
  rows,
  onClose,
  onSaved,
}: {
  spec: CategorySpec<T>;
  row: T | null;
  rows: T[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState<Form>(() => (row ? spec.fromRow(row) : spec.blank));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = spec.payload ? spec.payload(form) : form;
      if (row) await api.patch(`${spec.endpoint}/${row.id}`, body);
      else await api.post(spec.endpoint, body);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  /** Asked in the modal's foot first; a refusal is shown there, so it throws. */
  async function remove() {
    if (!row) return;
    await api.del(`${spec.endpoint}/${row.id}`);
    onSaved();
  }

  const fields = spec.fields(row, rows);
  const firstText = fields.find((f) => f.kind === 'text')?.key;
  const notice = row && spec.notice ? spec.notice(row) : null;

  return (
    <Modal
      title={row ? `Modify ${spec.noun} ${row.name}` : `New ${spec.noun}`}
      onClose={onClose}
      footer={
        <ModalFoot
          onCancel={onClose}
          busy={busy}
          danger={
            row && spec.deletable(row) && can('admin.categories.delete')
              ? {
                  label: 'Delete',
                  question: `Delete the ${spec.noun} ${row.name}? It cannot be undone.`,
                  onConfirm: remove,
                  disabled: busy,
                }
              : undefined
          }
        >
          <button className="btn btn-primary" onClick={save} disabled={busy || (spec.canSave ? !spec.canSave(form) : false)}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      {notice && <div className="alert info">{notice}</div>}
      {fields.map((f) => (
        <CategoryField
          key={f.key}
          field={f}
          value={form[f.key]}
          autoFocus={f.key === firstText}
          onChange={(value) => setForm((current) => ({ ...current, [f.key]: value }))}
        />
      ))}
    </Modal>
  );
}

interface CategoryLists {
  cost: CostCategory[];
  items: ItemCategory[];
  teams: Industry[];
  subIndustries: SubIndustry[];
  groups: QuotationGroup[];
  activityTypes: ActivityTypeDef[];
  drawingTypes: DrawingTypeDef[];
}

const NO_LISTS: CategoryLists = { cost: [], items: [], teams: [], subIndustries: [], groups: [], activityTypes: [], drawingTypes: [] };

export function Categories() {
  const [lists, setLists] = useState<CategoryLists>(NO_LISTS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cost, items, teams, subIndustries, groups, activityTypes, drawingTypes] = await Promise.all([
        api.get<CostCategory[]>('/reference/cost-categories'),
        api.get<ItemCategory[]>('/reference/item-categories'),
        api.get<Industry[]>('/reference/industries'),
        api.get<SubIndustry[]>('/reference/sub-industries'),
        api.get<QuotationGroup[]>('/reference/quotation-groups'),
        api.get<ActivityTypeDef[]>('/reference/activity-types'),
        api.get<DrawingTypeDef[]>('/reference/cad-drawing-types'),
      ]);
      setLists({ cost, items, teams, subIndustries, groups, activityTypes, drawingTypes });
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const changed = () => void load();

  if (loading) return <Loading />;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Categories</h1>
          <p>
            Cost categories are the six buckets every costing, budget and cost-ledger row is
            grouped by. Item categories are how you organise the item master for browsing — they
            have no effect on money. Teams — KAT, HIT, UIT, GIB, SIT — are the sales teams people
            are on; sub-industries are where a customer sits in the market, so sales can be
            counted by it. Quotation groups are what a quotation line is filed under, and how
            Sales Analytics counts what was quoted and won.
          </p>
        </div>
      </div>

      <ErrorBox error={error} />

      <div className="grid grid-2">
        <CategoryCard spec={COST_CATEGORIES} rows={lists.cost} onChanged={changed} />
        <CategoryCard spec={ITEM_CATEGORIES} rows={lists.items} onChanged={changed} />
      </div>

      {/*
        The rest are short reference cards an administrator reads whole, NOT
        DataLists — paging, scope and export would be furniture. Rule 9
        governs list screens; these are settings. Teams: a person's team is
        this row on their employee record. Sub-industries: where a customer
        sits in the market, optional. Quotation groups: what the editor
        offers, and a group typed on a line joins on save. Activity types
        (SCORO's customisable types): the calendar's Type list as data — an
        activity carries the key, so a rename never rewrites one. Drawing
        types: what a CAD job order asks for; the output is always a PDF.
      */}
      <CategoryCard spec={TEAMS} rows={lists.teams} onChanged={changed} className="card m-industries" />
      <CategoryCard spec={SUB_INDUSTRIES} rows={lists.subIndustries} onChanged={changed} className="card m-industries" />
      <CategoryCard spec={QUOTATION_GROUPS} rows={lists.groups} onChanged={changed} className="card m-industries" />
      <CategoryCard spec={ACTIVITY_TYPES} rows={lists.activityTypes} onChanged={changed} className="card m-industries" />
      <CategoryCard spec={DRAWING_TYPES} rows={lists.drawingTypes} onChanged={changed} className="card m-industries" />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
//  WAREHOUSES
// ════════════════════════════════════════════════════════════════════

interface Location {
  id: string;
  code: string;
  name: string | null;
}

interface Warehouse {
  id: string;
  code: string;
  name: string;
  address: string | null;
  city: string | null;
  isActive: boolean;
  locations: Location[];
}

export function Warehouses() {
  const { can } = useAuth();
  const toast = useToast();
  const [rows, setRows] = useState<Warehouse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Warehouse | 'new' | null>(null);
  const [addingLocation, setAddingLocation] = useState<Warehouse | null>(null);
  // Removing a location asks here, under the page head: a location has no
  // modal of its own (there is nothing to modify on it), so it is removed
  // from its chip on the warehouse's card.
  const confirm = useConfirm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api.get<Warehouse[]>('/warehouses'));
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mayEdit = can('gchain.warehouses.edit_all');

  /** Asked in the confirm bar first; a refusal is shown there, so it throws. */
  async function removeLocation(w: Warehouse, l: Location) {
    await api.del(`/warehouses/${w.id}/locations/${l.id}`);
    toast('ok', `Location ${l.code} removed`);
    void load();
  }

  if (loading) return <Loading />;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Warehouses</h1>
          <p>
            Where stock physically sits. Locations are the bin, rack or shelf inside a warehouse —
            worth setting up only if you need to find things by position.
          </p>
        </div>
        {can('gchain.warehouses.create') && (
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            + New warehouse
          </button>
        )}
      </div>
      {confirm.bar}

      <ErrorBox error={error} />

      {rows.length === 0 ? (
        <div className="card">
          <Empty title="No warehouses yet" />
        </div>
      ) : (
        <div className="grid grid-2">
          {rows.map((w) => (
            <div key={w.id} className="card">
              {/* The card's head: what it is on the left; + Add location, then Modify right-most. */}
              <div className="m-card-head">
                <div className="row">
                  <strong>{w.name}</strong>
                  <span className="mono faint" style={{ fontSize: 12 }}>
                    {w.code}
                  </span>
                  <span className={`badge ${w.isActive ? 'ok' : ''}`}>
                    {w.isActive ? 'Active' : 'Inactive'}
                  </span>
                </div>
                {mayEdit && (
                  <div className="row">
                    <button className="btn btn-sm" onClick={() => setAddingLocation(w)}>
                      + Add location
                    </button>
                    <button className="btn btn-sm" onClick={() => setEditing(w)}>
                      Modify
                    </button>
                  </div>
                )}
              </div>

              <div className="muted" style={{ fontSize: 12, margin: '6px 0 12px' }}>
                {[w.address, w.city].filter(Boolean).join(', ') || 'No address recorded'}
              </div>

              <div className="row" style={{ gap: 5 }}>
                {w.locations.length === 0 ? (
                  <span className="faint" style={{ fontSize: 12 }}>
                    No locations
                  </span>
                ) : (
                  w.locations.map((l) =>
                    mayEdit ? (
                      // Removed from its chip, asking first: a location has nothing to modify.
                      <span key={l.id} className="list-chip" title={l.name ?? undefined}>
                        {l.code}
                        <button
                          type="button"
                          aria-label={`Remove the location ${l.code}`}
                          title="Remove"
                          onClick={() =>
                            confirm.ask({
                              title: `Remove the location ${l.code} from ${w.name}?`,
                              body: 'It cannot be undone.',
                              confirmLabel: 'Remove',
                              onConfirm: () => removeLocation(w, l),
                            })
                          }
                        >
                          ×
                        </button>
                      </span>
                    ) : (
                      <span key={l.id} className="badge" title={l.name ?? undefined}>
                        {l.code}
                      </span>
                    ),
                  )
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <WarehouseModal
          warehouse={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
            toast('ok', 'Saved');
          }}
        />
      )}

      {addingLocation && (
        <LocationModal
          warehouse={addingLocation}
          onClose={() => setAddingLocation(null)}
          onSaved={() => {
            setAddingLocation(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function WarehouseModal({
  warehouse,
  onClose,
  onSaved,
}: {
  warehouse: Warehouse | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    code: warehouse?.code ?? '',
    name: warehouse?.name ?? '',
    address: warehouse?.address ?? '',
    city: warehouse?.city ?? '',
    isActive: warehouse?.isActive ?? true,
  });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        code: form.code,
        name: form.name,
        address: form.address || null,
        city: form.city || null,
        isActive: form.isActive,
      };
      if (warehouse) await api.patch(`/warehouses/${warehouse.id}`, payload);
      else await api.post('/warehouses', payload);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  /** Asked in the modal's foot first; a refusal is shown there, so it throws. */
  async function remove() {
    if (!warehouse) return;
    await api.del(`/warehouses/${warehouse.id}`);
    onSaved();
  }

  return (
    <Modal
      title={warehouse ? `Modify warehouse ${warehouse.name}` : 'New warehouse'}
      onClose={onClose}
      footer={
        <ModalFoot
          onCancel={onClose}
          busy={busy}
          danger={
            warehouse && can('gchain.warehouses.delete')
              ? {
                  label: 'Delete',
                  question: `Delete the warehouse ${warehouse.name}? It cannot be undone.`,
                  onConfirm: remove,
                  disabled: busy,
                }
              : undefined
          }
        >
          <button className="btn btn-primary" onClick={save} disabled={busy || !form.name || !form.code}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      <Field label="Name">
        <input value={form.name} autoFocus onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="Code">
        <input
          className="mono"
          value={form.code}
          onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
        />
      </Field>
      <Field label="Address">
        <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
      </Field>
      <Field label="City">
        <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
      </Field>
      <Checkbox checked={form.isActive} onChange={(v) => setForm({ ...form, isActive: v })} label="Active" />
    </Modal>
  );
}

function LocationModal({
  warehouse,
  onClose,
  onSaved,
}: {
  warehouse: Warehouse;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/warehouses/${warehouse.id}/locations`, { code, name: name || null });
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Add location — ${warehouse.name}`}
      onClose={onClose}
      footer={
        <ModalFoot onCancel={onClose} busy={busy}>
          <button className="btn btn-primary" onClick={save} disabled={busy || !code}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />

      <div className="grid grid-2">
        <Field label="Code" hint="A-01, RACK-3">
          <input className="mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        </Field>
        <Field label="Description">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
