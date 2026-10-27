import { useCallback, useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { mayEdit as mayEditRecord, mayEditPage, useAuth } from '../../lib/auth';
import { ActiveBadge, Checkbox, Empty, ErrorBox, Field, Loading, Modal, ModalFoot, StatusBadge, useToast } from '../../components/ui';
import { useConfirm } from '../../components/Confirm';
import { NumberInput } from '../../components/NumberInput';
import { TeamPostsCard } from './TeamPosts';

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
  /** What it covers — under its name on the inventory's category tile. */
  description: string | null;
  sortOrder: number;
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

/** What a service document is (2026-10-20): Manual, Electrical drawing…, with how many documents carry it. */
/** A company asset's type (2026-10-21, G-HR › Asset Management). */
export interface AssetTypeDef {
  id: string;
  name: string;
  sortOrder: number;
  isSystem: boolean;
  isActive: boolean;
  _count?: { assets: number };
}

/** A brand an exhibition visitor may ask about (2026-10-27, Sales › Marketing), with how many asked. */
export interface ExhibitionBrandDef {
  id: string;
  name: string;
  sortOrder: number;
  isSystem: boolean;
  isActive: boolean;
  visitors?: number;
}

export interface DocumentCategoryDef {
  id: string;
  name: string;
  sortOrder: number;
  isSystem: boolean;
  isActive: boolean;
  _count?: { documents: number };
}

export interface CourseCategoryDef {
  id: string;
  name: string;
  color: string | null;
  sortOrder: number;
  isSystem: boolean;
  isActive: boolean;
  courseCount?: number;
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
  /** Who added it — what "own" means on Admin › Categories (2026-10-18); null on a seeded row. */
  createdById?: string | null;
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
  /** What the foot's Delete asks, where deleting does more than remove the row. */
  deleteQuestion?: (row: T) => string;
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
          {c.description && <div className="faint">{c.description}</div>}
        </>
      ),
    },
    { key: 'items', head: 'Items', headClass: 'right', cellClass: 'right', render: (c) => c._count.items },
  ],
  empty: { title: 'No item categories' },
  blank: { code: '', name: '', parentId: '', description: '', sortOrder: '0' },
  fromRow: (c) => ({ code: c.code, name: c.name, parentId: c.parentId ?? '', description: c.description ?? '', sortOrder: String(c.sortOrder ?? 0) }),
  fields: (row, rows) => [
    { kind: 'text', key: 'name', label: 'Name' },
    { kind: 'text', key: 'code', label: 'Code', mono: true, clean: upper },
    { kind: 'text', key: 'description', label: 'What it covers', hint: 'Shown under the name on the inventory screen' },
    { kind: 'count', key: 'sortOrder', label: 'Sort order' },
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
  payload: (f) => ({ code: f.code, name: f.name, parentId: f.parentId || null, description: f.description || null, sortOrder: Number(f.sortOrder) || 0 }),
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
  empty: { title: 'No quotation groups yet', hint: 'Add the groups a quotation line may be filed under.' },
  footnote:
    "The quotation editor offers these for a line's Group, which every priced line must choose. A line keeps the group it was saved with, so renaming one here does not rewrite quotations already issued. Deleting a group moves the lines filed under it to OTHERS; OTHERS itself cannot be deleted. Picking a group with a brand fills the line's Brand box when it is empty.",
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
  // Any group but OTHERS may go (2026-10-11, the owner's call): its lines move to OTHERS.
  deletable: (g) => g.name.trim().toUpperCase() !== 'OTHERS',
  deleteQuestion: (g) => {
    const inUse = g.lineCount ?? 0;
    const lines = inUse === 0 ? '' : ` ${inUse === 1 ? 'The one quotation line' : `The ${inUse.toLocaleString('en-US')} quotation lines`} filed under it move to OTHERS.`;
    return `Delete the quotation group ${g.name}?${lines} It cannot be undone.`;
  },
  notice: (g) =>
    g.name.trim().toUpperCase() === 'OTHERS'
      ? 'OTHERS is where the lines of a deleted group go, so it cannot be deleted.'
      : null,
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

const COURSE_CATEGORIES: CategorySpec<CourseCategoryDef> = {
  noun: 'course category',
  title: 'Course categories',
  endpoint: '/reference/course-categories',
  columns: [
    {
      key: 'name',
      head: 'Name',
      render: (t) => (
        <>
          <span className="tag academy-chip" style={t.color ? ({ '--chip-color': t.color } as React.CSSProperties) : undefined}>
            {t.name}
          </span>
          {t.isSystem && <span className="faint"> · built-in</span>}
        </>
      ),
    },
    { key: 'courses', head: 'Courses', headClass: 'right', cellClass: 'right', render: (t) => (t.courseCount ?? 0).toLocaleString('en-US') },
    { key: 'status', head: 'Status', render: (t) => activeBadge(t.isActive) },
  ],
  footnote:
    "What a course is filed under on the Academy's course list, each with the colour its chip wears — Pneumatics & Gas, Hydraulics & Flow, Electrical & Control, Compliance & HSE. A course carries the name, so renaming a category follows its courses; the four built-ins can be renamed but not deleted, and a category in use is deactivated rather than deleted.",
  blank: { name: '', color: '#2E9A4B', sortOrder: 0, isActive: true },
  fromRow: (t) => ({ name: t.name, color: t.color ?? '#2E9A4B', sortOrder: t.sortOrder, isActive: t.isActive }),
  fields: () => [
    { kind: 'text', key: 'name', label: 'Name', hint: 'e.g. Pneumatics & Gas, Compliance & HSE', maxLength: 60 },
    { kind: 'color', key: 'color', label: 'Colour', hint: 'The chip on the course list', fallback: '#2E9A4B' },
    { kind: 'count', key: 'sortOrder', label: 'Sort order' },
    { kind: 'check', key: 'isActive', label: 'Active — an inactive category stays on its courses but is not offered' },
  ],
  payload: (f) => ({ ...f, color: f.color || null }),
  canSave: (f) => !!text(f.name).trim(),
  deletable: (t) => !t.isSystem && (t.courseCount ?? 0) === 0,
  notice: (t) => {
    if (t.isSystem) return 'A built-in category: rename or recolour it, or untick Active to stop offering it.';
    const inUse = t.courseCount ?? 0;
    if (inUse === 0) return null;
    return `${inUse === 1 ? 'One course is' : `${inUse.toLocaleString('en-US')} courses are`} filed under it, so it cannot be deleted — untick Active to stop offering it.`;
  },
};

const DOCUMENT_CATEGORIES: CategorySpec<DocumentCategoryDef> = {
  noun: 'service document category',
  title: 'Service document categories',
  endpoint: '/reference/service-document-categories',
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
    { key: 'documents', head: 'Documents', headClass: 'right', cellClass: 'right', render: (t) => (t._count?.documents ?? 0).toLocaleString('en-US') },
    { key: 'status', head: 'Status', render: (t) => activeBadge(t.isActive) },
  ],
  footnote:
    'What a service document is — a manual, an electrical drawing, a test report, a datasheet — filed against a machine on the Installation Base or against a model. The six built-ins can be renamed but not deleted; a category in use is deactivated rather than deleted, and the documents under it keep it.',
  blank: { name: '', sortOrder: 0, isActive: true },
  fromRow: (t) => ({ name: t.name, sortOrder: t.sortOrder, isActive: t.isActive }),
  fields: () => [
    { kind: 'text', key: 'name', label: 'Name', hint: 'e.g. Commissioning report, Calibration certificate', maxLength: 80 },
    { kind: 'count', key: 'sortOrder', label: 'Sort order' },
    { kind: 'check', key: 'isActive', label: 'Active — an inactive category stays on its documents but is not offered' },
  ],
  canSave: (f) => !!text(f.name).trim(),
  deletable: (t) => !t.isSystem && (t._count?.documents ?? 0) === 0,
  notice: (t) => {
    if (t.isSystem) return 'A built-in category: rename it, or untick Active to stop offering it.';
    const inUse = t._count?.documents ?? 0;
    if (inUse === 0) return null;
    return `${inUse === 1 ? 'One document is' : `${inUse.toLocaleString('en-US')} documents are`} under this category, so it cannot be deleted — untick Active to stop offering it.`;
  },
};

const EXHIBITION_BRANDS: CategorySpec<ExhibitionBrandDef> = {
  noun: 'exhibition brand',
  title: 'Exhibition brands',
  endpoint: '/reference/exhibition-brands',
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
    { key: 'visitors', head: 'Visitors', headClass: 'right', cellClass: 'right', render: (t) => (t.visitors ?? 0).toLocaleString('en-US') },
    { key: 'status', head: 'Status', render: (t) => activeBadge(t.isActive) },
  ],
  footnote:
    'The brands a visitor at an exhibition may ask about, ticked on Sales › Marketing. The nine built-ins can be renamed but not deleted; a brand visitors asked about is deactivated rather than deleted, and keeps its visitors.',
  blank: { name: '', sortOrder: 0, isActive: true },
  fromRow: (t) => ({ name: t.name, sortOrder: t.sortOrder, isActive: t.isActive }),
  fields: () => [
    { kind: 'text', key: 'name', label: 'Name', hint: 'As it should read on the tick box, e.g. Atlas Copco', maxLength: 80 },
    { kind: 'count', key: 'sortOrder', label: 'Sort order' },
    { kind: 'check', key: 'isActive', label: 'Active — an inactive brand stays on its visitors but is not offered' },
  ],
  canSave: (f) => !!text(f.name).trim(),
  deletable: (t) => !t.isSystem && (t.visitors ?? 0) === 0,
  notice: (t) => {
    if (t.isSystem) return 'A built-in brand: rename it, or untick Active to stop offering it.';
    const inUse = t.visitors ?? 0;
    if (inUse === 0) return null;
    return `${inUse === 1 ? 'One visitor' : `${inUse.toLocaleString('en-US')} visitors`} asked about it, so it cannot be deleted — untick Active to stop offering it.`;
  },
};

const ASSET_TYPES: CategorySpec<AssetTypeDef> = {
  noun: 'asset type',
  title: 'Asset types',
  endpoint: '/reference/asset-types',
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
    { key: 'assets', head: 'Assets', headClass: 'right', cellClass: 'right', render: (t) => (t._count?.assets ?? 0).toLocaleString('en-US') },
    { key: 'status', head: 'Status', render: (t) => activeBadge(t.isActive) },
  ],
  footnote:
    'What a company asset is — a vehicle, a laptop, a phone, a tool kit — on G-HR › Asset Management. The built-ins can be renamed but not deleted; a type in use is deactivated rather than deleted, and the assets under it keep it.',
  blank: { name: '', sortOrder: 0, isActive: true },
  fromRow: (t) => ({ name: t.name, sortOrder: t.sortOrder, isActive: t.isActive }),
  fields: () => [
    { kind: 'text', key: 'name', label: 'Name', hint: 'e.g. Company Vehicle, Two-way Radio', maxLength: 80 },
    { kind: 'count', key: 'sortOrder', label: 'Sort order' },
    { kind: 'check', key: 'isActive', label: 'Active — an inactive type stays on its assets but is not offered' },
  ],
  canSave: (f) => !!text(f.name).trim(),
  deletable: (t) => !t.isSystem && (t._count?.assets ?? 0) === 0,
  notice: (t) => {
    if (t.isSystem) return 'A built-in type: rename it, or untick Active to stop offering it.';
    const inUse = t._count?.assets ?? 0;
    if (inUse === 0) return null;
    return `${inUse === 1 ? 'One asset is' : `${inUse.toLocaleString('en-US')} assets are`} of this type, so it cannot be deleted — untick Active to stop offering it.`;
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
  const { can, me } = useAuth();
  const toast = useToast();
  // The Modify column shows for Edit All or Edit Own; each row opens only
  // where the viewer may change it — Edit Own, the entries they added (2026-10-18).
  const mayEdit = mayEditPage(can, 'admin', 'categories');
  const mayEditRow = (row: T) => mayEditRecord(can, 'admin', 'categories', !!me && row.createdById === me.user.id);
  const [editing, setEditing] = useState<T | 'new' | null>(null);

  return (
    <div className={className}>
      <div className="card-head">
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
                <tr key={row.id} {...opensModify(mayEditRow(row) ? () => setEditing(row) : null)}>
                  {spec.columns.map((c) => (
                    <td key={c.key} className={c.cellClass}>
                      {c.render(row)}
                    </td>
                  ))}
                  {mayEdit && (mayEditRow(row) ? <ModifyCell onClick={() => setEditing(row)} /> : <td className="m-col-action" />)}
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
                  question: spec.deleteQuestion ? spec.deleteQuestion(row) : `Delete the ${spec.noun} ${row.name}? It cannot be undone.`,
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
  documentCategories: DocumentCategoryDef[];
  assetTypes: AssetTypeDef[];
  courseCategories: CourseCategoryDef[];
  exhibitionBrands: ExhibitionBrandDef[];
}

const NO_LISTS: CategoryLists = { cost: [], items: [], teams: [], subIndustries: [], groups: [], activityTypes: [], drawingTypes: [], documentCategories: [], courseCategories: [], assetTypes: [], exhibitionBrands: [] };

export function Categories() {
  const [lists, setLists] = useState<CategoryLists>(NO_LISTS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cost, items, teams, subIndustries, groups, activityTypes, drawingTypes, documentCategories, courseCategories, assetTypes, exhibitionBrands] = await Promise.all([
        api.get<CostCategory[]>('/reference/cost-categories'),
        api.get<ItemCategory[]>('/reference/item-categories'),
        api.get<Industry[]>('/reference/industries'),
        api.get<SubIndustry[]>('/reference/sub-industries'),
        api.get<QuotationGroup[]>('/reference/quotation-groups'),
        api.get<ActivityTypeDef[]>('/reference/activity-types'),
        api.get<DrawingTypeDef[]>('/reference/cad-drawing-types'),
        api.get<DocumentCategoryDef[]>('/reference/service-document-categories'),
        api.get<CourseCategoryDef[]>('/reference/course-categories'),
        api.get<AssetTypeDef[]>('/reference/asset-types'),
        api.get<ExhibitionBrandDef[]>('/reference/exhibition-brands'),
      ]);
      setLists({ cost, items, teams, subIndustries, groups, activityTypes, drawingTypes, documentCategories, courseCategories, assetTypes, exhibitionBrands });
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
      <TeamPostsCard />
      <CategoryCard spec={SUB_INDUSTRIES} rows={lists.subIndustries} onChanged={changed} className="card m-industries" />
      <CategoryCard spec={QUOTATION_GROUPS} rows={lists.groups} onChanged={changed} className="card m-industries" />
      <CategoryCard spec={ACTIVITY_TYPES} rows={lists.activityTypes} onChanged={changed} className="card m-industries" />
      <CategoryCard spec={DRAWING_TYPES} rows={lists.drawingTypes} onChanged={changed} className="card m-industries" />
      <CategoryCard spec={DOCUMENT_CATEGORIES} rows={lists.documentCategories} onChanged={changed} className="card m-industries" />
      <CategoryCard spec={EXHIBITION_BRANDS} rows={lists.exhibitionBrands} onChanged={changed} className="card m-industries" />
      <CategoryCard spec={ASSET_TYPES} rows={lists.assetTypes} onChanged={changed} className="card m-industries" />
      <CategoryCard spec={COURSE_CATEGORIES} rows={lists.courseCategories} onChanged={changed} className="card m-industries" />
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
  /** Whether the viewer may change it — Edit All, or Edit Own on a warehouse they added (2026-10-18). */
  canEdit?: boolean;
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

  // Per warehouse: Edit All, or Edit Own on one the viewer added — the API says which (2026-10-18).
  const mayEdit = (w: Warehouse) => w.canEdit ?? can('gchain.warehouses.edit_all');

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
              <div className="card-head">
                <div className="row">
                  <strong>{w.name}</strong>
                  <span className="mono faint">{w.code}</span>
                  <ActiveBadge active={w.isActive} />
                </div>
                {mayEdit(w) && (
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

              <div className="muted" style={{ fontSize: 'var(--fs-sm)', margin: 'var(--s-2) 0 var(--s-3)' }}>
                {[w.address, w.city].filter(Boolean).join(', ') || 'No address recorded'}
              </div>

              <div className="row" style={{ gap: 'var(--s-1)' }}>
                {w.locations.length === 0 ? (
                  <span className="faint">No locations</span>
                ) : (
                  w.locations.map((l) =>
                    mayEdit(w) ? (
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
