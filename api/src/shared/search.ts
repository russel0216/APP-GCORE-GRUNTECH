import { prisma } from '../prisma';
import { can, type ResolvedUser } from '../permissions/resolve';

/**
 * Global search (model §8.3).
 *
 * Modules register a provider here rather than the search endpoint importing
 * every module — so Phase 3 adds customers and quotations to Ctrl+K by calling
 * `registerSearch(...)` from its own folder, and search never becomes a file
 * that has to know about everything.
 *
 * Providers declare the permission needed to see their results, so search can
 * never leak a record the user could not open. A provider may name several
 * keys — view_all and view_own — and an `ownWhere` that narrows its query
 * when the caller holds only the own-scope key: a salesperson finds their
 * own leads from Ctrl+K, and nobody else's. It is a call of can(), not a
 * change to it, and the list screens already show them exactly these rows.
 */

export interface SearchHit {
  kind: string;
  id: string;
  title: string;
  subtitle?: string;
  link: string;
}

export interface SearchProvider {
  kind: string;
  label: string;
  /** Permission(s) that include this provider's hits — any one suffices. */
  permission: string | string[];
  /**
   * Applied when the caller holds only a `.view_own` key from `permission`.
   * The provider spreads it into its own where — the shape is its table's.
   */
  ownWhere?: (user: ResolvedUser) => Record<string, unknown>;
  search: (
    term: string,
    user: ResolvedUser,
    limit: number,
    own?: Record<string, unknown>,
  ) => Promise<SearchHit[]>;
}

const providers: SearchProvider[] = [];

export function registerSearch(provider: SearchProvider): void {
  providers.push(provider);
}

export function searchProviders(): SearchProvider[] {
  return providers;
}

function permissionsOf(p: SearchProvider): string[] {
  return Array.isArray(p.permission) ? p.permission : [p.permission];
}

/** Whether this user sees this provider's hits at all. */
export function canSearch(user: ResolvedUser, p: SearchProvider): boolean {
  return permissionsOf(p).some((key) => can(user, key));
}

/**
 * The own-scope narrowing for this user, or undefined for the full set: a
 * user who holds none of the provider's non-own keys sees only their own.
 * A super admin passes every can(), so they are never narrowed.
 */
function ownScope(user: ResolvedUser, p: SearchProvider): Record<string, unknown> | undefined {
  if (!p.ownWhere) return undefined;
  const full = permissionsOf(p).filter((key) => !key.endsWith('.view_own'));
  return full.some((key) => can(user, key)) ? undefined : p.ownWhere(user);
}

export async function globalSearch(
  term: string,
  user: ResolvedUser,
  limitPerKind = 5,
): Promise<SearchHit[]> {
  const q = term.trim();
  if (q.length < 2) return [];

  const allowed = providers.filter((p) => canSearch(user, p));
  const results = await Promise.all(
    allowed.map((p) =>
      p.search(q, user, limitPerKind, ownScope(user, p)).catch((err) => {
        console.error(`Search provider "${p.kind}" failed:`, err);
        return [] as SearchHit[];
      }),
    ),
  );
  return results.flat();
}

// ── Phase 1 providers ────────────────────────────────────────────────────────
// Business records join these as their modules ship.

registerSearch({
  kind: 'user',
  label: 'People',
  permission: 'admin.users.view_all',
  search: async (term, _user, limit) => {
    const rows = await prisma.user.findMany({
      where: {
        isActive: true,
        OR: [
          { name: { contains: term, mode: 'insensitive' } },
          { email: { contains: term, mode: 'insensitive' } },
          { employeeNo: { contains: term, mode: 'insensitive' } },
        ],
      },
      take: limit,
      select: { id: true, name: true, email: true, position: true },
    });
    return rows.map((r) => ({
      kind: 'user',
      id: r.id,
      title: r.name,
      subtitle: r.position ?? r.email,
      link: `/admin/users/${r.id}`,
    }));
  },
});

// ── Phase 2: the masters ─────────────────────────────────────────────────────

registerSearch({
  kind: 'customer',
  label: 'Customers',
  permission: 'gops.customers.view_all',
  search: async (term, _user, limit) => {
    const rows = await prisma.customer.findMany({
      where: {
        OR: [
          { name: { contains: term, mode: 'insensitive' } },
          { code: { contains: term, mode: 'insensitive' } },
          { legalName: { contains: term, mode: 'insensitive' } },
          // Finding the company by the person you dealt with.
          { contacts: { some: { name: { contains: term, mode: 'insensitive' } } } },
        ],
      },
      take: limit,
      select: { id: true, code: true, name: true, industry: { select: { code: true } }, isActive: true },
    });
    return rows.map((r) => ({
      kind: 'customer',
      id: r.id,
      title: r.name,
      subtitle: [r.code, r.industry?.code, r.isActive ? null : 'inactive'].filter(Boolean).join(' · '),
      link: `/g-ops/customers/${r.id}`,
    }));
  },
});

registerSearch({
  kind: 'supplier',
  label: 'Suppliers',
  permission: 'gchain.suppliers.view_all',
  search: async (term, _user, limit) => {
    const rows = await prisma.supplier.findMany({
      where: {
        OR: [
          { name: { contains: term, mode: 'insensitive' } },
          { code: { contains: term, mode: 'insensitive' } },
          { category: { contains: term, mode: 'insensitive' } },
          { contacts: { some: { name: { contains: term, mode: 'insensitive' } } } },
        ],
      },
      take: limit,
      select: { id: true, code: true, name: true, category: true, isActive: true },
    });
    return rows.map((r) => ({
      kind: 'supplier',
      id: r.id,
      title: r.name,
      subtitle: [r.code, r.category, r.isActive ? null : 'inactive'].filter(Boolean).join(' · '),
      link: `/g-chain/suppliers/${r.id}`,
    }));
  },
});

registerSearch({
  kind: 'employee',
  label: 'Employees',
  permission: 'ghr.employees.view_all',
  search: async (term, _user, limit) => {
    const rows = await prisma.employee.findMany({
      where: {
        OR: [
          { firstName: { contains: term, mode: 'insensitive' } },
          { lastName: { contains: term, mode: 'insensitive' } },
          { employeeNo: { contains: term, mode: 'insensitive' } },
          { position: { contains: term, mode: 'insensitive' } },
        ],
      },
      take: limit,
      select: { id: true, employeeNo: true, firstName: true, lastName: true, position: true },
    });
    return rows.map((r) => ({
      kind: 'employee',
      id: r.id,
      title: `${r.firstName} ${r.lastName}`,
      subtitle: [r.employeeNo, r.position].filter(Boolean).join(' · '),
      link: `/g-hr/employees/${r.id}`,
    }));
  },
});

registerSearch({
  kind: 'item',
  label: 'Items',
  permission: 'gchain.items.view_all',
  search: async (term, _user, limit) => {
    const rows = await prisma.item.findMany({
      where: {
        OR: [
          { name: { contains: term, mode: 'insensitive' } },
          { code: { contains: term, mode: 'insensitive' } },
          { partNumber: { contains: term, mode: 'insensitive' } },
        ],
      },
      take: limit,
      select: { id: true, code: true, name: true, partNumber: true, unit: true },
    });
    return rows.map((r) => ({
      kind: 'item',
      id: r.id,
      title: r.name,
      subtitle: [r.code, r.partNumber, r.unit].filter(Boolean).join(' · '),
      link: `/g-chain/items/${r.id}`,
    }));
  },
});

// Partners are suppliers seen from Sales — the same rows, behind the Sales key,
// so a salesperson who holds no gchain.suppliers permission still finds the
// principal whose catalogue they need. Two kinds: the partner, and a document
// it publishes (a resource), both landing on the partner page.

registerSearch({
  kind: 'partner',
  label: 'Partners',
  permission: 'gops.partners.view_all',
  search: async (term, _user, limit) => {
    const rows = await prisma.supplier.findMany({
      where: {
        isPartner: true,
        OR: [
          { name: { contains: term, mode: 'insensitive' } },
          { brand: { contains: term, mode: 'insensitive' } },
          { code: { contains: term, mode: 'insensitive' } },
          { category: { contains: term, mode: 'insensitive' } },
        ],
      },
      take: limit,
      select: { id: true, code: true, name: true, brand: true, category: true, isActive: true },
    });
    return rows.map((r) => ({
      kind: 'partner',
      id: r.id,
      title: r.brand ?? r.name,
      subtitle: [r.code, r.brand && r.brand !== r.name ? r.name : null, r.category, r.isActive ? null : 'inactive']
        .filter(Boolean)
        .join(' · '),
      link: `/g-ops/partners/${r.id}`,
    }));
  },
});

registerSearch({
  kind: 'partner_resource',
  label: 'Partner documents',
  permission: 'gops.partners.view_all',
  search: async (term, _user, limit) => {
    const rows = await prisma.partnerResource.findMany({
      where: {
        isActive: true,
        supplier: { isPartner: true },
        OR: [
          { title: { contains: term, mode: 'insensitive' } },
          { description: { contains: term, mode: 'insensitive' } },
        ],
      },
      take: limit,
      select: {
        id: true,
        title: true,
        kind: true,
        supplierId: true,
        supplier: { select: { name: true, brand: true } },
      },
    });
    const kindLabel: Record<string, string> = {
      CATALOGUE: 'Catalogue',
      PRICE_LIST: 'Price list',
      SIZING_APP: 'Sizing app',
      OTHER: 'Document',
    };
    return rows.map((r) => ({
      kind: 'partner_resource',
      id: r.id,
      title: r.title,
      subtitle: `${kindLabel[r.kind] ?? r.kind} · ${r.supplier.brand ?? r.supplier.name}`,
      link: `/g-ops/partners/${r.supplierId}`,
    }));
  },
});

// ── Phase 3: sales ───────────────────────────────────────────────────────────
// Own scope mirrors each list route: a lead belongs to its assignee, a
// quotation and a costing to their owner, a project to its manager.

registerSearch({
  kind: 'lead',
  label: 'Leads',
  permission: ['gops.leads.view_all', 'gops.leads.view_own'],
  ownWhere: (user) => ({ assignedToId: user.id }),
  search: async (term, _user, limit, own) => {
    const rows = await prisma.lead.findMany({
      where: {
        ...own,
        OR: [
          { companyName: { contains: term, mode: 'insensitive' } },
          { number: { contains: term, mode: 'insensitive' } },
          { contactPerson: { contains: term, mode: 'insensitive' } },
        ],
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: { id: true, number: true, companyName: true, status: true },
    });
    return rows.map((r) => ({
      kind: 'lead',
      id: r.id,
      title: r.companyName,
      subtitle: `${r.number} · ${r.status.toLowerCase().replace(/_/g, ' ')}`,
      link: `/g-ops/leads/${r.id}`,
    }));
  },
});

registerSearch({
  kind: 'quotation',
  label: 'Quotations',
  permission: ['gops.quotations.view_all', 'gops.quotations.view_own'],
  ownWhere: (user) => ({ ownerId: user.id }),
  search: async (term, _user, limit, own) => {
    const rows = await prisma.quotation.findMany({
      where: {
        ...own,
        OR: [
          { number: { contains: term, mode: 'insensitive' } },
          { subject: { contains: term, mode: 'insensitive' } },
          { customer: { name: { contains: term, mode: 'insensitive' } } },
        ],
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        number: true,
        subject: true,
        outcome: true,
        customer: { select: { name: true } },
      },
    });
    return rows.map((r) => ({
      kind: 'quotation',
      id: r.id,
      title: `${r.number} — ${r.subject}`,
      subtitle: `${r.customer.name} · ${r.outcome.toLowerCase()}`,
      link: `/g-ops/quotations/${r.id}`,
    }));
  },
});

registerSearch({
  kind: 'costing',
  label: 'Costings',
  permission: ['gops.costing.view_all', 'gops.costing.view_own'],
  ownWhere: (user) => ({ ownerId: user.id }),
  search: async (term, _user, limit, own) => {
    const rows = await prisma.costing.findMany({
      where: {
        ...own,
        OR: [
          { number: { contains: term, mode: 'insensitive' } },
          { title: { contains: term, mode: 'insensitive' } },
          { customer: { name: { contains: term, mode: 'insensitive' } } },
        ],
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: { id: true, number: true, title: true, contractValue: true },
    });
    return rows.map((r) => ({
      kind: 'costing',
      id: r.id,
      title: r.title,
      subtitle: `${r.number} · ${new Intl.NumberFormat('en-PH', {
        style: 'currency',
        currency: 'PHP',
      }).format(Number(r.contractValue))}`,
      link: `/g-ops/costing/${r.id}`,
    }));
  },
});

// ── Phase 4: delivery ────────────────────────────────────────────────────────

registerSearch({
  kind: 'job',
  label: 'Projects',
  permission: ['gops.projects.view_all', 'gops.projects.view_own'],
  ownWhere: (user) => ({ projectManagerId: user.id }),
  search: async (term, _user, limit, own) => {
    const rows = await prisma.job.findMany({
      where: {
        ...own,
        OR: [
          { name: { contains: term, mode: 'insensitive' } },
          { number: { contains: term, mode: 'insensitive' } },
          { customerPoNumber: { contains: term, mode: 'insensitive' } },
          { customer: { name: { contains: term, mode: 'insensitive' } } },
        ],
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        number: true,
        name: true,
        status: true,
        customer: { select: { name: true } },
      },
    });
    return rows.map((r) => ({
      kind: 'job',
      id: r.id,
      title: r.name,
      subtitle: `${r.number} · ${r.customer.name} · ${r.status.toLowerCase().replace(/_/g, ' ')}`,
      link: `/g-ops/projects/${r.id}`,
    }));
  },
});

registerSearch({
  kind: 'progress',
  label: 'Progress & billing',
  permission: 'gops.progress_billing.view_all',
  search: async (term, _user, limit) => {
    const [reports, billings] = await Promise.all([
      prisma.progressReport.findMany({
        where: {
          OR: [
            { number: { contains: term, mode: 'insensitive' } },
            { job: { name: { contains: term, mode: 'insensitive' } } },
          ],
        },
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: { id: true, number: true, reportNo: true, job: { select: { id: true, name: true } } },
      }),
      prisma.progressBilling.findMany({
        where: { number: { contains: term, mode: 'insensitive' } },
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: { id: true, number: true, billingNo: true, job: { select: { id: true, name: true } } },
      }),
    ]);
    return [
      ...reports.map((r) => ({
        kind: 'progress',
        id: r.id,
        title: `${r.number} — report #${r.reportNo}`,
        subtitle: r.job.name,
        link: `/g-ops/progress/${r.id}`,
      })),
      ...billings.map((b) => ({
        kind: 'progress',
        id: b.id,
        title: `${b.number} — billing #${b.billingNo}`,
        subtitle: b.job.name,
        link: `/g-ops/billings/${b.id}`,
      })),
    ].slice(0, limit);
  },
});

registerSearch({
  kind: 'approval',
  label: 'Approvals',
  permission: 'admin.workflows.view_all',
  search: async (term, _user, limit) => {
    const rows = await prisma.approvalRequest.findMany({
      where: {
        OR: [
          { subject: { contains: term, mode: 'insensitive' } },
          { documentNumber: { contains: term, mode: 'insensitive' } },
        ],
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      kind: 'approval',
      id: r.id,
      title: r.subject,
      subtitle: `${r.documentNumber ?? r.documentType} · ${r.status}`,
      // A request with no record link lands on the queue, which is the one
      // page that can act on it — not on a URL the app does not render.
      link: r.link ?? '/my-work',
    }));
  },
});
