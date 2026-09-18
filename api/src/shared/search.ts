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
