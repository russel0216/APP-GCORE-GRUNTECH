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
 * never leak a record the user could not open.
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
  /** Permission required to include this provider's hits. */
  permission: string;
  search: (term: string, user: ResolvedUser, limit: number) => Promise<SearchHit[]>;
}

const providers: SearchProvider[] = [];

export function registerSearch(provider: SearchProvider): void {
  providers.push(provider);
}

export function searchProviders(): SearchProvider[] {
  return providers;
}

export async function globalSearch(
  term: string,
  user: ResolvedUser,
  limitPerKind = 5,
): Promise<SearchHit[]> {
  const q = term.trim();
  if (q.length < 2) return [];

  const allowed = providers.filter((p) => can(user, p.permission));
  const results = await Promise.all(
    allowed.map((p) =>
      p.search(q, user, limitPerKind).catch((err) => {
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
      select: { id: true, code: true, name: true, industry: true, isActive: true },
    });
    return rows.map((r) => ({
      kind: 'customer',
      id: r.id,
      title: r.name,
      subtitle: [r.code, r.industry, r.isActive ? null : 'inactive'].filter(Boolean).join(' · '),
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

// ── Phase 3: sales ───────────────────────────────────────────────────────────

registerSearch({
  kind: 'lead',
  label: 'Leads',
  permission: 'gops.leads.view_all',
  search: async (term, _user, limit) => {
    const rows = await prisma.lead.findMany({
      where: {
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
  permission: 'gops.quotations.view_all',
  search: async (term, _user, limit) => {
    const rows = await prisma.quotation.findMany({
      where: {
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
  permission: 'gops.costing.view_all',
  search: async (term, _user, limit) => {
    const rows = await prisma.costing.findMany({
      where: {
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
  permission: 'gops.projects.view_all',
  search: async (term, _user, limit) => {
    const rows = await prisma.job.findMany({
      where: {
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
      link: r.link ?? `/my-work/approvals/${r.id}`,
    }));
  },
});
