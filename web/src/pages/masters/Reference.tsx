import { useCallback, useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Checkbox, Empty, ErrorBox, Field, Loading, Modal, ModalFoot, StatusBadge, useToast } from '../../components/ui';
import { useConfirm } from '../../components/Confirm';
import { NumberInput } from '../../components/NumberInput';

// ════════════════════════════════════════════════════════════════════
//  CATEGORIES — cost categories, item categories, teams, sub-industries,
//  quotation groups, activity types
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
 * A customer's sub-industry (the owner's eleven — Enterprise, Hospital,
 * Pharmaceutical…; 2026-10-08). Exported: the customer form and the customer
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

export function Categories() {
  const { can } = useAuth();
  const toast = useToast();
  const [cost, setCost] = useState<CostCategory[]>([]);
  const [items, setItems] = useState<ItemCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editingCost, setEditingCost] = useState<CostCategory | 'new' | null>(null);
  const [editingItem, setEditingItem] = useState<ItemCategory | 'new' | null>(null);
  const [industries, setIndustries] = useState<Industry[]>([]);
  const [editingIndustry, setEditingIndustry] = useState<Industry | 'new' | null>(null);
  const [subIndustries, setSubIndustries] = useState<SubIndustry[]>([]);
  const [editingSubIndustry, setEditingSubIndustry] = useState<SubIndustry | 'new' | null>(null);
  const [groups, setGroups] = useState<QuotationGroup[]>([]);
  const [editingGroup, setEditingGroup] = useState<QuotationGroup | 'new' | null>(null);
  const [activityTypes, setActivityTypes] = useState<ActivityTypeDef[]>([]);
  const [editingType, setEditingType] = useState<ActivityTypeDef | 'new' | null>(null);
  const [drawingTypes, setDrawingTypes] = useState<DrawingTypeDef[]>([]);
  const [editingDrawingType, setEditingDrawingType] = useState<DrawingTypeDef | 'new' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, i, ind, sub, g, at, dt] = await Promise.all([
        api.get<CostCategory[]>('/reference/cost-categories'),
        api.get<ItemCategory[]>('/reference/item-categories'),
        api.get<Industry[]>('/reference/industries'),
        api.get<SubIndustry[]>('/reference/sub-industries'),
        api.get<QuotationGroup[]>('/reference/quotation-groups'),
        api.get<ActivityTypeDef[]>('/reference/activity-types'),
        api.get<DrawingTypeDef[]>('/reference/cad-drawing-types'),
      ]);
      setCost(c);
      setItems(i);
      setIndustries(ind);
      setSubIndustries(sub);
      setGroups(g);
      setActivityTypes(at);
      setDrawingTypes(dt);
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

  const mayEdit = can('admin.categories.edit_all');

  if (loading) return <Loading />;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Categories</h1>
          <p>
            Cost categories are the five buckets every costing, budget and cost-ledger row is
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
        <div className="card">
          <div className="m-card-head">
            <h3 className="card-title">Cost categories</h3>
            {can('admin.categories.create') && (
              <button className="btn btn-primary btn-sm" onClick={() => setEditingCost('new')}>
                + New cost category
              </button>
            )}
          </div>

          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="m-col-code">Code</th>
                  <th>Name</th>
                  <th>Status</th>
                  {mayEdit && <th className="m-col-action" />}
                </tr>
              </thead>
              <tbody>
                {cost.map((c) => (
                  <tr key={c.id} {...opensModify(mayEdit ? () => setEditingCost(c) : null)}>
                    <td className="mono">{c.code}</td>
                    <td>
                      {c.name}
                      {c.isSystem && <span className="badge m-inline">standard</span>}
                    </td>
                    <td>
                      <StatusBadge status={c.isActive ? 'ACTIVE' : 'INACTIVE'} extra={{ INACTIVE: '' }} />
                    </td>
                    {mayEdit && <ModifyCell onClick={() => setEditingCost(c)} />}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="m-footnote">
            The five standard categories cannot be deleted — every budget and cost figure in the
            system is grouped by them. You can rename them.
          </p>
        </div>

        <div className="card">
          <div className="m-card-head">
            <h3 className="card-title">Item categories</h3>
            {can('admin.categories.create') && (
              <button className="btn btn-primary btn-sm" onClick={() => setEditingItem('new')}>
                + New item category
              </button>
            )}
          </div>

          {items.length === 0 ? (
            <Empty title="No item categories" />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th className="m-col-code">Code</th>
                    <th>Name</th>
                    <th className="right">
                      Items
                    </th>
                    {mayEdit && <th className="m-col-action" />}
                  </tr>
                </thead>
                <tbody>
                  {items.map((c) => (
                    <tr key={c.id} {...opensModify(mayEdit ? () => setEditingItem(c) : null)}>
                      <td className="mono">{c.code}</td>
                      <td>
                        {c.parentId && <span className="faint">↳ </span>}
                        {c.name}
                      </td>
                      <td className="right">{c._count.items}</td>
                      {mayEdit && <ModifyCell onClick={() => setEditingItem(c)} />}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/*
        Teams: a five-row reference card, NOT a DataList. It is a short,
        fixed list an administrator reads whole — paging, scope and export
        would be furniture. Rule 9 governs list screens; this is a setting.
      */}
      <div className="card m-industries">
        <div className="m-card-head">
          <h3 className="card-title">Teams</h3>
          {can('admin.categories.create') && (
            <button className="btn btn-primary btn-sm" onClick={() => setEditingIndustry('new')}>
              + New team
            </button>
          )}
        </div>

        {industries.length === 0 ? (
          <Empty
            title="No teams yet"
            hint="Run the seed to create the five — KAT, HIT, UIT, GIB and SIT."
          />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th className="m-col-code">Code</th>
                  <th>Name</th>
                  <th className="right">People</th>
                  <th>Status</th>
                  {mayEdit && <th className="m-col-action" />}
                </tr>
              </thead>
              <tbody>
                {industries.map((ind) => (
                  <tr key={ind.id} {...opensModify(mayEdit ? () => setEditingIndustry(ind) : null)}>
                    <td className="mono">{ind.code}</td>
                    <td>
                      {ind.name}
                      {ind.isSystem && <span className="badge m-inline">standard</span>}
                    </td>
                    <td className="right">{ind._count?.employees ?? 0}</td>
                    <td>
                      <StatusBadge status={ind.isActive ? 'ACTIVE' : 'INACTIVE'} extra={{ INACTIVE: '' }} />
                    </td>
                    {mayEdit && <ModifyCell onClick={() => setEditingIndustry(ind)} />}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="m-footnote">
          HR puts each person on a team on the employee record; the quotation list counts quotes
          by it and the Team view lists a team's work. The standard teams cannot be deleted or
          recoded — but you can rename them or add your own. The five industries that came before
          them are switched off, never deleted.
        </p>
      </div>

      {/*
        Sub-industries: where a customer sits in the market — the owner's
        eleven, typed in by hand on the customer and optional. The same short
        reference card as the teams.
      */}
      <div className="card m-industries">
        <div className="m-card-head">
          <h3 className="card-title">Sub-industries</h3>
          {can('admin.categories.create') && (
            <button className="btn btn-primary btn-sm" onClick={() => setEditingSubIndustry('new')}>
              + New sub-industry
            </button>
          )}
        </div>

        {subIndustries.length === 0 ? (
          <Empty title="No sub-industries yet" hint="Run the seed to create the eleven — Enterprise, Hospital, Pharmaceutical…" />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="right">Customers</th>
                  <th>Status</th>
                  {mayEdit && <th className="m-col-action" />}
                </tr>
              </thead>
              <tbody>
                {subIndustries.map((s) => (
                  <tr key={s.id} {...opensModify(mayEdit ? () => setEditingSubIndustry(s) : null)}>
                    <td>
                      {s.name}
                      {s.isSystem && <span className="badge m-inline">standard</span>}
                    </td>
                    <td className="right">{s._count?.customers ?? 0}</td>
                    <td>
                      <StatusBadge status={s.isActive ? 'ACTIVE' : 'INACTIVE'} extra={{ INACTIVE: '' }} />
                    </td>
                    {mayEdit && <ModifyCell onClick={() => setEditingSubIndustry(s)} />}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="m-footnote">
          A customer may carry one of these — picked on the customer, later, by whoever knows.
          Sales Analytics counts what was quoted and won by it. The standard ones cannot be
          deleted — switch one off instead — but you can rename them or add your own.
        </p>
      </div>

      {/*
        Quotation groups: a reference card like Industries. The editor suggests
        from it, and a group typed on a quotation line is added here on save.
      */}
      <div className="card m-industries">
        <div className="m-card-head">
          <h3 className="card-title">Quotation groups</h3>
          {can('admin.categories.create') && (
            <button className="btn btn-primary btn-sm" onClick={() => setEditingGroup('new')}>
              + New quotation group
            </button>
          )}
        </div>

        {groups.length === 0 ? (
          <Empty
            title="No quotation groups yet"
            hint="A group typed on a quotation line is added here when the quotation is saved."
          />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Covers</th>
                  <th>Brand</th>
                  <th className="right">Lines</th>
                  <th>Status</th>
                  {mayEdit && <th className="m-col-action" />}
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.id} {...opensModify(mayEdit ? () => setEditingGroup(g) : null)}>
                    <td>{g.name}</td>
                    <td>{g.description ?? <span className="faint">—</span>}</td>
                    <td>{g.brand ?? <span className="faint">—</span>}</td>
                    <td className="right">{(g.lineCount ?? 0).toLocaleString('en-US')}</td>
                    <td>
                      <StatusBadge status={g.isActive ? 'ACTIVE' : 'INACTIVE'} extra={{ INACTIVE: '' }} />
                    </td>
                    {mayEdit && <ModifyCell onClick={() => setEditingGroup(g)} />}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="m-footnote">
          The quotation editor offers these for a line&apos;s Group, which every priced line must
          choose. A line keeps the group it was saved with, so renaming one here does not rewrite
          quotations already issued; a group in use is deactivated rather than deleted. Picking a
          group with a brand fills the line&apos;s Brand box when it is empty.
        </p>
      </div>

      {/*
        Activity types (2026-10-08, SCORO's customisable activity types): the
        sales calendar's Type list as data. An activity carries the type's
        key, so a rename never rewrites one.
      */}
      <div className="card m-industries">
        <div className="m-card-head">
          <h3 className="card-title">Activity types</h3>
          {can('admin.categories.create') && (
            <button className="btn btn-primary btn-sm" onClick={() => setEditingType('new')}>
              + New activity type
            </button>
          )}
        </div>

        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Colour</th>
                <th className="right">Activities</th>
                <th>Status</th>
                {mayEdit && <th className="m-col-action" />}
              </tr>
            </thead>
            <tbody>
              {activityTypes.map((t) => (
                <tr key={t.id} {...opensModify(mayEdit ? () => setEditingType(t) : null)}>
                  <td>
                    {t.name}
                    {t.isSystem && <span className="faint"> · built-in</span>}
                  </td>
                  <td>
                    {t.color ? (
                      <span className="m-swatch-row">
                        <span className="m-swatch" style={{ background: t.color }} aria-hidden="true" />
                        <span className="mono">{t.color}</span>
                      </span>
                    ) : (
                      <span className="faint">default</span>
                    )}
                  </td>
                  <td className="right">{(t.activityCount ?? 0).toLocaleString('en-US')}</td>
                  <td>
                    <StatusBadge status={t.isActive ? 'ACTIVE' : 'INACTIVE'} extra={{ INACTIVE: '' }} />
                  </td>
                  {mayEdit && <ModifyCell onClick={() => setEditingType(t)} />}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="m-footnote">
          What the sales calendar offers as an activity&apos;s Type, each with the colour its chip
          wears. The six built-ins can be renamed and recoloured but not deleted; a type in use is
          deactivated rather than deleted, and the activities of that type keep it.
        </p>
      </div>

      {/*
        Drawing types (2026-10-09): what a CAD job order asks for — Layout
        plan, P&ID / schematic, single-line… The output to the requestor is
        always a PDF; the type says what is drawn.
      */}
      <div className="card m-industries">
        <div className="m-card-head">
          <h3 className="card-title">Drawing types</h3>
          {can('admin.categories.create') && (
            <button className="btn btn-primary btn-sm" onClick={() => setEditingDrawingType('new')}>
              + New drawing type
            </button>
          )}
        </div>

        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th className="right">CAD job orders</th>
                <th>Status</th>
                {mayEdit && <th className="m-col-action" />}
              </tr>
            </thead>
            <tbody>
              {drawingTypes.map((t) => (
                <tr key={t.id} {...opensModify(mayEdit ? () => setEditingDrawingType(t) : null)}>
                  <td>
                    {t.name}
                    {t.isSystem && <span className="faint"> · built-in</span>}
                  </td>
                  <td className="right">{(t._count?.requests ?? 0).toLocaleString('en-US')}</td>
                  <td>
                    <StatusBadge status={t.isActive ? 'ACTIVE' : 'INACTIVE'} extra={{ INACTIVE: '' }} />
                  </td>
                  {mayEdit && <ModifyCell onClick={() => setEditingDrawingType(t)} />}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="m-footnote">
          What a CAD job order asks the design team for. The seven built-ins can be renamed but not
          deleted; a type in use is deactivated rather than deleted, and the requests of that type keep
          it. Whatever the type, the output to the requestor is a PDF.
        </p>
      </div>

      {editingDrawingType && (
        <DrawingTypeModal
          type={editingDrawingType === 'new' ? null : editingDrawingType}
          onClose={() => setEditingDrawingType(null)}
          onSaved={() => {
            setEditingDrawingType(null);
            void load();
            toast('ok', 'Saved');
          }}
        />
      )}

      {editingType && (
        <ActivityTypeModal
          type={editingType === 'new' ? null : editingType}
          onClose={() => setEditingType(null)}
          onSaved={() => {
            setEditingType(null);
            void load();
            toast('ok', 'Saved');
          }}
        />
      )}

      {editingGroup && (
        <QuotationGroupModal
          group={editingGroup === 'new' ? null : editingGroup}
          onClose={() => setEditingGroup(null)}
          onSaved={() => {
            setEditingGroup(null);
            void load();
            toast('ok', 'Saved');
          }}
        />
      )}

      {editingSubIndustry && (
        <SubIndustryModal
          subIndustry={editingSubIndustry === 'new' ? null : editingSubIndustry}
          onClose={() => setEditingSubIndustry(null)}
          onSaved={() => {
            setEditingSubIndustry(null);
            void load();
            toast('ok', 'Saved');
          }}
        />
      )}

      {editingIndustry && (
        <IndustryModal
          industry={editingIndustry === 'new' ? null : editingIndustry}
          onClose={() => setEditingIndustry(null)}
          onSaved={() => {
            setEditingIndustry(null);
            void load();
            toast('ok', 'Saved');
          }}
        />
      )}

      {editingCost && (
        <CostCategoryModal
          category={editingCost === 'new' ? null : editingCost}
          onClose={() => setEditingCost(null)}
          onSaved={() => {
            setEditingCost(null);
            void load();
            toast('ok', 'Saved');
          }}
        />
      )}

      {editingItem && (
        <ItemCategoryModal
          category={editingItem === 'new' ? null : editingItem}
          all={items}
          onClose={() => setEditingItem(null)}
          onSaved={() => {
            setEditingItem(null);
            void load();
            toast('ok', 'Saved');
          }}
        />
      )}
    </div>
  );
}

function CostCategoryModal({
  category,
  onClose,
  onSaved,
}: {
  category: CostCategory | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    code: category?.code ?? '',
    name: category?.name ?? '',
    sortOrder: category?.sortOrder ?? 99,
    isActive: category?.isActive ?? true,
  });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (category) await api.patch(`/reference/cost-categories/${category.id}`, form);
      else await api.post('/reference/cost-categories', form);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  /** Asked in the modal's foot first; a refusal is shown there, so it throws. */
  async function remove() {
    if (!category) return;
    await api.del(`/reference/cost-categories/${category.id}`);
    onSaved();
  }

  return (
    <Modal
      title={category ? `Modify cost category ${category.name}` : 'New cost category'}
      onClose={onClose}
      footer={
        <ModalFoot
          onCancel={onClose}
          busy={busy}
          danger={
            category && !category.isSystem && can('admin.categories.delete')
              ? {
                  label: 'Delete',
                  question: `Delete the cost category ${category.name}? It cannot be undone.`,
                  onConfirm: remove,
                  disabled: busy,
                }
              : undefined
          }
        >
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      {category?.isSystem && (
        <div className="alert info">
          This is one of the five standard categories. You can rename it; its code and existence are
          fixed because the cost ledger groups by them.
        </div>
      )}
      <Field label="Name">
        <input value={form.name} autoFocus onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="Code">
        <input
          className="mono"
          value={form.code}
          disabled={category?.isSystem}
          onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
        />
      </Field>
      <Field label="Sort order">
        <NumberInput
          kind="count"
          value={form.sortOrder}
          onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })}
        />
      </Field>
      <Checkbox checked={form.isActive} onChange={(v) => setForm({ ...form, isActive: v })} label="Active" />
    </Modal>
  );
}

function QuotationGroupModal({
  group,
  onClose,
  onSaved,
}: {
  group: QuotationGroup | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    name: group?.name ?? '',
    description: group?.description ?? '',
    brand: group?.brand ?? '',
    sortOrder: group?.sortOrder ?? 0,
    isActive: group?.isActive ?? true,
  });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = { ...form, description: form.description.trim() || null, brand: form.brand.trim() || null };
      if (group) await api.patch(`/reference/quotation-groups/${group.id}`, payload);
      else await api.post('/reference/quotation-groups', payload);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  /** Asked in the modal's foot first; a refusal is shown there, so it throws. */
  async function remove() {
    if (!group) return;
    await api.del(`/reference/quotation-groups/${group.id}`);
    onSaved();
  }

  const inUse = group?.lineCount ?? 0;

  return (
    <Modal
      title={group ? `Modify quotation group ${group.name}` : 'New quotation group'}
      onClose={onClose}
      footer={
        <ModalFoot
          onCancel={onClose}
          busy={busy}
          danger={
            group && inUse === 0 && can('admin.categories.delete')
              ? {
                  label: 'Delete',
                  question: `Delete the quotation group ${group.name}? It cannot be undone.`,
                  onConfirm: remove,
                  disabled: busy,
                }
              : undefined
          }
        >
          <button className="btn btn-primary" onClick={save} disabled={busy || !form.name.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      {group && inUse > 0 && (
        <div className="alert info">
          {inUse === 1 ? 'One quotation line is' : `${inUse.toLocaleString('en-US')} quotation lines are`} filed
          under this group, so it cannot be deleted — untick Active to stop it being suggested.
        </div>
      )}
      <Field label="Name" hint="e.g. OMEGA AIR, GRUNTECH SERVICES">
        <input value={form.name} autoFocus maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="Covers" hint="Shown under the name in the editor's dropdown — e.g. Compressed Air & Gas Treatment and Separation">
        <input value={form.description} maxLength={200} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </Field>
      <Field label="Brand" hint="Fills a line's Brand box when the group is picked; leave blank for a house group">
        <input value={form.brand} maxLength={120} onChange={(e) => setForm({ ...form, brand: e.target.value })} />
      </Field>
      <Field label="Sort order">
        <NumberInput
          kind="count"
          value={form.sortOrder}
          onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })}
        />
      </Field>
      <Checkbox
        checked={form.isActive}
        onChange={(v) => setForm({ ...form, isActive: v })}
        label="Active — an inactive group stays on its lines but is not suggested"
      />
    </Modal>
  );
}

function ActivityTypeModal({
  type,
  onClose,
  onSaved,
}: {
  type: ActivityTypeDef | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    name: type?.name ?? '',
    color: type?.color ?? '#5B2A8C',
    sortOrder: type?.sortOrder ?? 0,
    isActive: type?.isActive ?? true,
  });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = { ...form, color: form.color || null };
      if (type) await api.patch(`/reference/activity-types/${type.id}`, payload);
      else await api.post('/reference/activity-types', payload);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  /** Asked in the modal's foot first; a refusal is shown there, so it throws. */
  async function remove() {
    if (!type) return;
    await api.del(`/reference/activity-types/${type.id}`);
    onSaved();
  }

  const inUse = type?.activityCount ?? 0;

  return (
    <Modal
      title={type ? `Modify activity type ${type.name}` : 'New activity type'}
      onClose={onClose}
      footer={
        <ModalFoot
          onCancel={onClose}
          busy={busy}
          danger={
            type && !type.isSystem && inUse === 0 && can('admin.categories.delete')
              ? {
                  label: 'Delete',
                  question: `Delete the activity type ${type.name}? It cannot be undone.`,
                  onConfirm: remove,
                  disabled: busy,
                }
              : undefined
          }
        >
          <button className="btn btn-primary" onClick={save} disabled={busy || !form.name.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      {type && (type.isSystem || inUse > 0) && (
        <div className="alert info">
          {type.isSystem
            ? 'A built-in type: rename or recolour it, or untick Active to stop offering it.'
            : `${inUse === 1 ? 'One activity is' : `${inUse.toLocaleString('en-US')} activities are`} of this type, so it cannot be deleted — untick Active to stop offering it.`}
        </div>
      )}
      <Field label="Name" hint={type ? `Key ${type.key} — an activity carries the key, so renaming rewrites nothing` : 'e.g. Demo, Site survey, Training'}>
        <input value={form.name} autoFocus maxLength={60} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="Colour" hint="The edge of its chips on the calendar">
        <input type="color" value={form.color || '#5B2A8C'} onChange={(e) => setForm({ ...form, color: e.target.value })} />
      </Field>
      <Field label="Sort order">
        <NumberInput kind="count" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })} />
      </Field>
      <Checkbox
        checked={form.isActive}
        onChange={(v) => setForm({ ...form, isActive: v })}
        label="Active — an inactive type stays on its activities but is not offered"
      />
    </Modal>
  );
}

function DrawingTypeModal({
  type,
  onClose,
  onSaved,
}: {
  type: DrawingTypeDef | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    name: type?.name ?? '',
    sortOrder: type?.sortOrder ?? 0,
    isActive: type?.isActive ?? true,
  });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (type) await api.patch(`/reference/cad-drawing-types/${type.id}`, form);
      else await api.post('/reference/cad-drawing-types', form);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  /** Asked in the modal's foot first; a refusal is shown there, so it throws. */
  async function remove() {
    if (!type) return;
    await api.del(`/reference/cad-drawing-types/${type.id}`);
    onSaved();
  }

  const inUse = type?._count?.requests ?? 0;

  return (
    <Modal
      title={type ? `Modify drawing type ${type.name}` : 'New drawing type'}
      onClose={onClose}
      footer={
        <ModalFoot
          onCancel={onClose}
          busy={busy}
          danger={
            type && !type.isSystem && inUse === 0 && can('admin.categories.delete')
              ? {
                  label: 'Delete',
                  question: `Delete the drawing type ${type.name}? It cannot be undone.`,
                  onConfirm: remove,
                  disabled: busy,
                }
              : undefined
          }
        >
          <button className="btn btn-primary" onClick={save} disabled={busy || form.name.trim().length < 2}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      {type && (type.isSystem || inUse > 0) && (
        <div className="alert info">
          {type.isSystem
            ? 'A built-in type: rename it, or untick Active to stop offering it.'
            : `${inUse === 1 ? 'One CAD job order is' : `${inUse.toLocaleString('en-US')} CAD job orders are`} of this type, so it cannot be deleted — untick Active to stop offering it.`}
        </div>
      )}
      <Field label="Name" hint="e.g. Isometric, Equipment layout, Cable schedule">
        <input value={form.name} autoFocus maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="Sort order">
        <NumberInput kind="count" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })} />
      </Field>
      <Checkbox
        checked={form.isActive}
        onChange={(v) => setForm({ ...form, isActive: v })}
        label="Active — an inactive type stays on its requests but is not offered"
      />
    </Modal>
  );
}

function IndustryModal({
  industry,
  onClose,
  onSaved,
}: {
  industry: Industry | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    code: industry?.code ?? '',
    name: industry?.name ?? '',
    sortOrder: industry?.sortOrder ?? 99,
    isActive: industry?.isActive ?? true,
  });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (industry) await api.patch(`/reference/industries/${industry.id}`, form);
      else await api.post('/reference/industries', form);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  /** Asked in the modal's foot first; a refusal is shown there, so it throws. */
  async function remove() {
    if (!industry) return;
    await api.del(`/reference/industries/${industry.id}`);
    onSaved();
  }

  const inUse = (industry?._count?.customers ?? 0) + (industry?._count?.employees ?? 0);
  const valid = form.name.trim().length >= 2 && /^[A-Z]{2,4}$/.test(form.code);

  return (
    <Modal
      title={industry ? `Modify team ${industry.name}` : 'New team'}
      onClose={onClose}
      footer={
        <ModalFoot
          onCancel={onClose}
          busy={busy}
          danger={
            industry && !industry.isSystem && inUse === 0 && can('admin.categories.delete')
              ? {
                  label: 'Delete',
                  question: `Delete the team ${industry.name}? It cannot be undone.`,
                  onConfirm: remove,
                  disabled: busy,
                }
              : undefined
          }
        >
          <button className="btn btn-primary" onClick={save} disabled={busy || !valid}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      {industry?.isSystem && (
        <div className="alert info">
          A standard team. Rename it freely; its code is fixed because the quotation list and the
          Team view key on it.
        </div>
      )}
      {industry && !industry.isSystem && inUse > 0 && (
        <div className="alert info">
          {inUse === 1 ? 'One record carries' : `${inUse} records carry`} this team, so it cannot
          be deleted — untick Active to stop it being offered.
        </div>
      )}
      <Field label="Name" hint="e.g. Healthcare Industry Team">
        <input value={form.name} autoFocus onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="Code" hint="Two to four letters">
        <input
          className="mono"
          value={form.code}
          maxLength={4}
          disabled={industry?.isSystem}
          onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase().replace(/[^A-Z]/g, '') })}
        />
      </Field>
      <Field label="Sort order">
        <NumberInput
          kind="count"
          value={form.sortOrder}
          onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })}
        />
      </Field>
      <Checkbox
        checked={form.isActive}
        onChange={(v) => setForm({ ...form, isActive: v })}
        label="Active — an inactive team stays on its people but is not offered for new ones"
      />
    </Modal>
  );
}

/** Add or modify a sub-industry: a name, its order, and whether it is offered. */
function SubIndustryModal({
  subIndustry,
  onClose,
  onSaved,
}: {
  subIndustry: SubIndustry | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    name: subIndustry?.name ?? '',
    sortOrder: subIndustry?.sortOrder ?? 99,
    isActive: subIndustry?.isActive ?? true,
  });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (subIndustry) await api.patch(`/reference/sub-industries/${subIndustry.id}`, form);
      else await api.post('/reference/sub-industries', form);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  /** Asked in the modal's foot first; a refusal is shown there, so it throws. */
  async function remove() {
    if (!subIndustry) return;
    await api.del(`/reference/sub-industries/${subIndustry.id}`);
    onSaved();
  }

  const inUse = subIndustry?._count?.customers ?? 0;

  return (
    <Modal
      title={subIndustry ? `Modify sub-industry ${subIndustry.name}` : 'New sub-industry'}
      onClose={onClose}
      footer={
        <ModalFoot
          onCancel={onClose}
          busy={busy}
          danger={
            subIndustry && !subIndustry.isSystem && inUse === 0 && can('admin.categories.delete')
              ? {
                  label: 'Delete',
                  question: `Delete the sub-industry ${subIndustry.name}? It cannot be undone.`,
                  onConfirm: remove,
                  disabled: busy,
                }
              : undefined
          }
        >
          <button className="btn btn-primary" onClick={save} disabled={busy || form.name.trim().length < 2}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </ModalFoot>
      }
    >
      <ErrorBox error={error} />
      {subIndustry?.isSystem && (
        <div className="alert info">One of the standard sub-industries. Rename it freely; it cannot be deleted.</div>
      )}
      {subIndustry && !subIndustry.isSystem && inUse > 0 && (
        <div className="alert info">
          {inUse === 1 ? 'One customer carries' : `${inUse} customers carry`} this sub-industry, so it
          cannot be deleted — untick Active to stop it being offered.
        </div>
      )}
      <Field label="Name" hint="e.g. Hospital">
        <input value={form.name} autoFocus onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="Sort order">
        <NumberInput kind="count" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })} />
      </Field>
      <Checkbox
        checked={form.isActive}
        onChange={(v) => setForm({ ...form, isActive: v })}
        label="Active — an inactive sub-industry stays on its customers but is not offered for new ones"
      />
    </Modal>
  );
}

function ItemCategoryModal({
  category,
  all,
  onClose,
  onSaved,
}: {
  category: ItemCategory | null;
  all: ItemCategory[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState({
    code: category?.code ?? '',
    name: category?.name ?? '',
    parentId: category?.parentId ?? '',
  });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = { code: form.code, name: form.name, parentId: form.parentId || null };
      if (category) await api.patch(`/reference/item-categories/${category.id}`, payload);
      else await api.post('/reference/item-categories', payload);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  /** Asked in the modal's foot first; a refusal is shown there, so it throws. */
  async function remove() {
    if (!category) return;
    await api.del(`/reference/item-categories/${category.id}`);
    onSaved();
  }

  return (
    <Modal
      title={category ? `Modify item category ${category.name}` : 'New item category'}
      onClose={onClose}
      footer={
        <ModalFoot
          onCancel={onClose}
          busy={busy}
          danger={
            category && can('admin.categories.delete')
              ? {
                  label: 'Delete',
                  question: `Delete the item category ${category.name}? It cannot be undone.`,
                  onConfirm: remove,
                  disabled: busy,
                }
              : undefined
          }
        >
          <button className="btn btn-primary" onClick={save} disabled={busy}>
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
      <Field label="Parent category">
        <select value={form.parentId} onChange={(e) => setForm({ ...form, parentId: e.target.value })}>
          <option value="">— top level —</option>
          {all
            .filter((c) => c.id !== category?.id)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      </Field>
    </Modal>
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
