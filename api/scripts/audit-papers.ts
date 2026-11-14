/**
 * A read-only audit of what G-CORE prints (2026-11-14, the owner's report:
 * "audit all print out documents, some still overlapped").
 *
 *   npx tsx scripts/audit-papers.ts            # the newest 4 of every kind
 *   npx tsx scripts/audit-papers.ts 10         # the newest 10 of every kind
 *
 * It prints every kind of document and every list's paper through the API as
 * a super admin, reads each page's text runs with where they were set, and
 * reports the runs that sit ON one another: two lines closer than a line
 * apart whose ink overlaps sideways, or two runs on one line that run into
 * each other. It writes nothing — but each print leaves its EXPORTED audit
 * row, as any print does. Needs the API on :5100 (or API_URL).
 */
import { prisma } from '../src/prisma';
import { signToken } from '../src/auth/middleware';
import { pdfRuns, runWidth, type PdfRun } from './lib/paper';

const BASE = process.env.API_URL ?? 'http://localhost:5100/api';
const TAKE = Number(process.argv[2]) || 4;

interface Clash {
  page: number;
  a: string;
  b: string;
  how: string;
}

/** The runs of a page that are drawn over one another. */
export function overlaps(pdf: Buffer): Clash[] {
  const out: Clash[] = [];
  const byPage = new Map<number, (PdfRun & { w: number })[]>();
  for (const r of pdfRuns(pdf)) {
    if (!r.text.trim() || r.size <= 0) continue;
    byPage.set(r.page, [...(byPage.get(r.page) ?? []), { ...r, w: runWidth(r) }]);
  }
  for (const [page, runs] of byPage) {
    for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length; j++) {
        const a = runs[i];
        const b = runs[j];
        const sideways = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        if (sideways <= 1.5) continue;
        const dy = Math.abs(a.y - b.y);
        // Two lines whose baselines are closer than the taller one's own height.
        if (dy > 0.6 && dy < 0.82 * Math.max(a.size, b.size)) {
          out.push({ page, a: a.text, b: b.text, how: `lines ${dy.toFixed(1)}pt apart at ${Math.max(a.size, b.size)}pt` });
        } else if (dy <= 0.6 && sideways > 2.5 && a.text !== b.text) {
          // One line: the earlier run's ink reaches into the later one's.
          out.push({ page, a: a.text, b: b.text, how: `run into each other by ${sideways.toFixed(1)}pt` });
        }
      }
    }
  }
  return out;
}

type Row = Record<string, unknown> & { id: string };
const KINDS: { name: string; list: string; papers: (r: Row) => string[]; listPaper?: string | false }[] = [
  { name: 'Quotation', list: '/quotations?scope=all', papers: (r) => { const v = r.valueRevision as { id: string } | null; return v ? [`/quotations/${r.id}/revisions/${v.id}/pdf`] : []; } },
  { name: 'Sales order', list: '/sales-orders?scope=all', papers: (r) => [`/sales-orders/${r.id}/pdf`] },
  { name: 'Lead', list: '/leads?scope=all', papers: (r) => [`/leads/${r.id}/pdf`] },
  { name: 'Costing', list: '/costings?scope=all', papers: (r) => [`/costings/${r.id}/pdf`] },
  { name: 'Job order', list: '/job-orders?scope=all', papers: (r) => [`/job-orders/${r.id}/pdf`] },
  { name: 'Service JO', list: '/service-job-orders?scope=all', papers: (r) => [`/service-job-orders/${r.id}/pdf`] },
  { name: 'CAD J.O.', list: '/cad-job-orders?scope=all', papers: (r) => [`/cad-job-orders/${r.id}/pdf`] },
  { name: 'Request for Approval', list: '/plans', papers: (r) => [`/plans/${r.id}/pdf`] },
  { name: 'Project', list: '/jobs?scope=all', papers: (r) => [`/jobs/${r.id}/scope/pdf`, `/jobs/${r.id}/ledger/pdf`, `/jobs/${r.id}/kickoff/pdf`] },
  { name: 'Budget / travel request', list: '/budget-requests?scope=all', papers: (r) => [`/budget-requests/${r.id}/pdf`] },
  { name: 'Progress report', list: '/progress-reports', papers: (r) => [`/progress-reports/${r.id}/pdf`] },
  { name: 'Progress billing', list: '/billings', papers: (r) => [`/billings/${r.id}/pdf`] },
  { name: 'Invoice request', list: '/invoice-requests?scope=all', papers: (r) => [`/invoice-requests/${r.id}/pdf`] },
  { name: 'Commission request', list: '/commissions?scope=all', papers: (r) => [`/commissions/${r.id}/pdf`] },
  { name: 'Purchase request', list: '/purchase-requests?scope=all', papers: (r) => [`/purchase-requests/${r.id}/pdf`] },
  { name: 'RFQ', list: '/rfqs?scope=all', papers: (r) => [`/rfqs/${r.id}/pdf`] },
  { name: 'Canvass', list: '/canvasses?scope=all', papers: (r) => [`/canvasses/${r.id}/pdf`] },
  { name: 'Purchase order', list: '/purchase-orders?scope=all', papers: (r) => [`/purchase-orders/${r.id}/pdf`] },
  { name: 'Incoming report', list: '/receivings?scope=all', papers: (r) => [`/receivings/${r.id}/pdf`] },
  { name: 'Outgoing slip', list: '/stock-issues?scope=all', papers: (r) => [`/stock-issues/${r.id}/pdf`] },
  { name: 'Borrow slip', list: '/borrow-slips?scope=all', papers: (r) => [`/borrow-slips/${r.id}/pdf`] },
  { name: 'Pull-out slip', list: '/pullout-slips?scope=all', papers: (r) => [`/pullout-slips/${r.id}/pdf`] },
  { name: 'Invoice', list: '/invoices', papers: (r) => [`/invoices/${r.id}/pdf`] },
  { name: 'Supplier bill', list: '/supplier-bills', papers: (r) => [`/supplier-bills/${r.id}/pdf`] },
  { name: 'Reimbursement', list: '/expense-claims?scope=all', papers: (r) => [`/expense-claims/${r.id}/pdf`] },
  { name: 'Cash advance', list: '/cash-advances?scope=all', papers: (r) => [`/cash-advances/${r.id}/pdf`] },
  { name: 'Payment / collection', list: '/payments', papers: (r) => [`/payments/${r.id}/pdf`] },
  { name: 'Office budget', list: '/office-budgets', papers: (r) => [`/office-budgets/${r.id}/pdf`], listPaper: false },
  { name: 'Clearance', list: '/clearances', papers: (r) => [`/clearances/${r.id}/pdf`] },
  { name: 'Evaluation', list: '/evaluations', papers: (r) => [`/evaluations/${r.id}/pdf`] },
  { name: 'Memo', list: '/memos?scope=all', papers: (r) => [`/memos/${r.id}/pdf`] },
  { name: 'Meeting minutes', list: '/meetings?scope=all', papers: (r) => [`/meetings/${r.id}/minutes/pdf`] },
  { name: 'Course', list: '/courses', papers: (r) => [`/courses/${r.id}/pdf`] },
  { name: 'Man power request', list: '/hiring/mprs', papers: (r) => [`/hiring/mprs/${r.id}/pdf`], listPaper: '/hiring/mprs/pdf' },
  { name: 'Employment contract', list: '/hiring/contracts', papers: (r) => [`/hiring/contracts/${r.id}/pdf`], listPaper: '/hiring/contracts/pdf' },
  { name: 'Asset issuance slip', list: '/assets/slips', papers: (r) => [`/assets/slips/${r.id}/pdf`], listPaper: false },
  { name: 'Customers (list)', list: '/customers?scope=all', papers: () => [] },
  { name: 'Suppliers (list)', list: '/suppliers', papers: () => [] },
  { name: 'Employees (list)', list: '/employees', papers: () => [] },
  { name: 'Inventory (list)', list: '/inventory', papers: () => [] },
  { name: 'Assets (list)', list: '/assets', papers: () => [] },
  { name: 'Partners (list)', list: '/partners', papers: () => [] },
];

async function main() {
  const admin = await prisma.user.findFirst({ where: { isSuperAdmin: true, isActive: true } });
  if (!admin) throw new Error('No active super admin to print as');
  const token = signToken(admin.id, admin.email);
  const get = (path: string) => fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  let printed = 0;
  let bad = 0;
  const skipped: string[] = [];
  const say = (label: string, clashes: Clash[]) => {
    printed++;
    if (!clashes.length) return;
    bad++;
    console.log(`\n✗ ${label} — ${clashes.length} overlap${clashes.length === 1 ? '' : 's'}`);
    for (const c of clashes.slice(0, 6)) console.log(`    p${c.page}: “${c.a.slice(0, 48)}” × “${c.b.slice(0, 48)}” (${c.how})`);
    if (clashes.length > 6) console.log(`    … and ${clashes.length - 6} more`);
  };
  const check = async (label: string, path: string) => {
    const res = await get(path);
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('pdf')) {
      if (res.status !== 404 && res.status !== 400) skipped.push(`${label}: ${res.status}`);
      return;
    }
    say(label, overlaps(Buffer.from(await res.arrayBuffer())));
  };

  for (const kind of KINDS) {
    const sep = kind.list.includes('?') ? '&' : '?';
    const res = await get(`${kind.list}${sep}pageSize=${TAKE}`);
    const body = (await res.json().catch(() => null)) as { rows?: Row[] } | Row[] | null;
    const rows = Array.isArray(body) ? body : (body?.rows ?? []);
    if (!res.ok) {
      skipped.push(`${kind.name}: list ${res.status}`);
      continue;
    }
    for (const row of rows.slice(0, TAKE)) {
      for (const paper of kind.papers(row)) await check(`${kind.name} ${String(row.number ?? row.code ?? row.name ?? row.id)} (${paper.split('/').slice(-2).join('/')})`, paper);
    }
    if (kind.listPaper !== false) {
      const base = kind.list.split('?')[0];
      const query = kind.list.includes('?') ? `?${kind.list.split('?')[1]}` : '';
      await check(`${kind.name} — list paper`, kind.listPaper ?? `${base}/pdf${query}`);
    }
    if (!rows.length && kind.papers({ id: 'x' } as Row).length) skipped.push(`${kind.name}: none on file`);
  }
  await check('Specimen (every section kind)', '/pdf/specimen');
  await check('Sales report (one page)', '/sales-reports/sales-orders.pdf');
  await check('Not yet invoiced report', '/sales-reports/to-invoice.pdf');

  console.log(`\n${printed} papers printed, ${bad} with overlapping text.`);
  if (skipped.length) console.log(`Not checked: ${skipped.join('; ')}`);
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(2);
  });
}
