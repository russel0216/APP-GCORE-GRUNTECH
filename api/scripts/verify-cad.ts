/**
 * CAD job orders verification — the design team's queue (2026-10-09).
 *
 *   npx tsx scripts/verify-cad.ts      (the API must be running)
 *
 * What the module promises, checked over HTTP with throwaway users on the
 * seeded roles (sales, Designer Lead, Designer Support):
 *
 *   · A request is numbered, the design team is told, and only the people on
 *     it (or a view_all holder) can open it.
 *   · A designer takes it or the lead assigns it; the requestor sets no
 *     priority and reports no progress — the design team does.
 *   · A revision needs a PDF (the output to the requestor is always a PDF);
 *     a refused upload leaves no stray file; an AutoCAD file is accepted by
 *     its extension; R0, R1 are never overwritten; the files are guarded.
 *   · Changes requested go into the thread and send the drawing back; accept
 *     completes it; the accepted revision files as an Approved Plan on the
 *     linked project, by copy.
 *   · The list, its cards, the filters, the paper, search and My Work all
 *     read the same rows; hold, resume and cancel keep their reasons.
 *
 * If the API is down this FAILS loudly rather than skipping. Creates its own
 * records (TAG prefix), cleans up at start and end, refuses production.
 */

import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/prisma';
import { env } from '../src/env';
import { signToken } from '../src/auth/middleware';
import { resolveUser } from '../src/permissions/resolve';
import { globalSearch } from '../src/shared/search';
import { deleteAttachment, attachmentPath, isCadFile } from '../src/shared/attachments';
import { listQuery } from '../src/http/kit';
import { nextNumber } from '../src/shared/numbering';
import { CAD_DRAWING_TYPES } from '../src/shared/cadDrawingTypes';
// Side-effect import: registers the search provider and the attachment guards.
import { cadListWhere, cadListSummary } from '../src/routes/cadJobOrders';

if (env.isProduction) {
  console.error('Refusing to run against a production database.');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const TAG = 'ZZCAD';
const MAIL = '@verifycad.local';
const BASE = `http://localhost:${env.port}/api`;
const D = (v: number) => new Prisma.Decimal(v);
const PDF = () => new Blob(['%PDF-1.4\n%verify\n'], { type: 'application/pdf' });

async function cleanup() {
  const requests = await prisma.cadJobOrder.findMany({
    where: { title: { startsWith: TAG } },
    select: { id: true, revisions: { select: { id: true } }, comments: { select: { id: true } }, approvedPlanId: true },
  });
  const ids = requests.map((r) => r.id);
  // Everyone the module told — the real design team included — by link, since
  // the titles carry the number rather than the TAG.
  if (ids.length) await prisma.notification.deleteMany({ where: { link: { in: ids.map((id) => `/g-ops/cad-job-orders/${id}`) } } });
  const planIds = requests.map((r) => r.approvedPlanId).filter((id): id is string => !!id);
  const files = await prisma.attachment.findMany({
    where: {
      OR: [
        { entityType: 'cad_job_order', entityId: { in: ids } },
        { entityType: 'cad_revision', entityId: { in: requests.flatMap((r) => r.revisions.map((x) => x.id)) } },
        { entityType: 'cad_comment', entityId: { in: requests.flatMap((r) => r.comments.map((x) => x.id)) } },
        { entityType: 'approved_plan', entityId: { in: planIds } },
      ],
    },
    select: { id: true },
  });
  for (const f of files) await deleteAttachment(f.id);
  await prisma.cadJobOrder.deleteMany({ where: { title: { startsWith: TAG } } });
  await prisma.approvedPlan.deleteMany({ where: { title: { startsWith: TAG } } });
  await prisma.job.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.costing.deleteMany({ where: { title: { startsWith: TAG } } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.cadDrawingType.deleteMany({ where: { name: { startsWith: TAG } } });

  const users = await prisma.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  if (userIds.length) {
    await prisma.attachment.deleteMany({ where: { uploadedById: { in: userIds } } });
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
}

async function makeUser(name: string, local: string, roleKeys: string[]) {
  const roles = await prisma.role.findMany({ where: { key: { in: roleKeys } } });
  if (roles.length !== roleKeys.length) throw new Error(`Missing seeded role(s): ${roleKeys.join(', ')} — run the seed`);
  return prisma.user.create({
    data: { name, email: `${local}${MAIL}`, passwordHash: await bcrypt.hash('x', 10), roles: { create: roles.map((r) => ({ roleId: r.id })) } },
  });
}

interface HttpResult {
  status: number;
  type: string;
  text: string;
  body: Record<string, unknown>;
}

async function http(token: string, method: string, path: string, body?: unknown): Promise<HttpResult> {
  const isForm = body instanceof FormData;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: isForm ? (body as FormData) : JSON.stringify(body) } : {}),
  });
  const type = res.headers.get('content-type') ?? '';
  const text = type.includes('json') || type.startsWith('text') ? await res.text() : '';
  if (!text) await res.arrayBuffer();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, type, text, body: parsed };
}

/**
 * Readable text out of a rendered PDF — the same reader verify-foundation
 * uses. PDFKit Flate-compresses its content streams and writes text as hex
 * runs split at kerning pairs, so each TJ array is joined back into one piece.
 */
function pdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const out: string[] = [];
  const stream = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = stream.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    let body: string;
    try {
      body = zlib.inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    for (const show of body.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      let piece = '';
      for (const part of show[1].matchAll(/<([0-9A-Fa-f]*)>|\(((?:\\.|[^\\()])*)\)/g)) {
        piece += part[1] ? Buffer.from(part[1], 'hex').toString('latin1') : part[2].replace(/\\([()\\])/g, '$1');
      }
      if (piece) out.push(piece);
    }
  }
  return out.join('\n');
}

/** A document's text and its page sizes. */
async function printed(token: string, path: string): Promise<{ status: number; text: string; pages: string[] }> {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return { status: res.status, text: '', pages: [] };
  const bytes = Buffer.from(await res.arrayBuffer());
  const pages = [...bytes.toString('latin1').matchAll(/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => `${m[1]}x${m[2]}`);
  return { status: res.status, text: pdfText(bytes), pages };
}

/** A sign-off dated under its name: "Oct 10, 2026, 6:07 AM". */
const signedCount = (t: string) => (t.match(/[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M/g) ?? []).length;
const pendingCount = (t: string) => (t.match(/Pending/g) ?? []).length;
/** A head or a role prints in capitals and may wrap: read the words, not the line breaks. */
const flat = (t: string) => t.replace(/\s+/g, ' ');

async function apiReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

const bells = (userId: string, type: string) => prisma.notification.count({ where: { userId, type } });

async function main() {
  console.log('\nG-CORE CAD job orders verification\n');
  await cleanup();

  if (!(await apiReachable())) {
    check('API is reachable', false, `nothing answers at ${BASE} — start it with "npm run dev" and rerun`);
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exitCode = 1;
    return;
  }

  const admin = await prisma.user.findFirst({ where: { isSuperAdmin: true } });
  if (!admin) throw new Error('No super admin — run the seed');
  const adminT = signToken(admin.id, admin.email);

  // ══ The seed: permissions, roles, drawing types ═══════════════════════════
  console.log('The seed');
  const keys = new Set((await prisma.permission.findMany({ where: { key: { startsWith: 'gops.cad_job_orders.' } }, select: { key: true } })).map((p) => p.key));
  check(
    'the CAD J.O. permissions exist, Approve among them (the Designer Lead’s dispatch right)',
    ['view_own', 'view_all', 'create', 'edit_own', 'edit_all', 'approve', 'export', 'delete'].every((a) => keys.has(`gops.cad_job_orders.${a}`)),
    [...keys].join(','),
  );
  const roleKeys = async (key: string) =>
    new Set((await prisma.rolePermission.findMany({ where: { role: { key } }, select: { permission: { select: { key: true } } } })).map((r) => r.permission.key));
  const leadKeys = await roleKeys('designer_lead');
  const supportKeys = await roleKeys('designer');
  const salesKeys = await roleKeys('sales');
  check('the Designer Lead holds the design right and Approve', leadKeys.has('gops.cad_job_orders.edit_all') && leadKeys.has('gops.cad_job_orders.approve'));
  check('Designer Support holds the design right, never Approve', supportKeys.has('gops.cad_job_orders.edit_all') && !supportKeys.has('gops.cad_job_orders.approve'));
  check('sales raises requests and sees its own', salesKeys.has('gops.cad_job_orders.create') && salesKeys.has('gops.cad_job_orders.view_own') && !salesKeys.has('gops.cad_job_orders.view_all'));
  const seededTypes = await prisma.cadDrawingType.findMany({ where: { isSystem: true }, orderBy: { sortOrder: 'asc' } });
  check(
    `the ${CAD_DRAWING_TYPES.length} drawing types are seeded as system rows in the owner’s order`,
    seededTypes.map((t) => t.name).join('|') === CAD_DRAWING_TYPES.join('|'),
    seededTypes.map((t) => t.name).join('|'),
  );
  check('the CAD upload ceiling is at least the ordinary one', env.maxCadUploadMb >= env.maxUploadMb, `${env.maxCadUploadMb} vs ${env.maxUploadMb}`);
  check('an AutoCAD or SketchUp file is known by its extension', isCadFile('plant.DWG') && isCadFile('room.skp') && !isCadFile('page.html') && !isCadFile('run.exe'));

  // ══ People and records ════════════════════════════════════════════════════
  const requestor = await makeUser(`${TAG} Requestor`, 'requestor', ['sales']);
  const outsider = await makeUser(`${TAG} Other Sales`, 'outsider', ['sales']);
  const lead = await makeUser(`${TAG} Designer Lead`, 'lead', ['designer_lead']);
  const support = await makeUser(`${TAG} Designer Support`, 'support', ['designer']);
  const requestorT = signToken(requestor.id, requestor.email);
  const outsiderT = signToken(outsider.id, outsider.email);
  const leadT = signToken(lead.id, lead.email);
  const supportT = signToken(support.id, support.email);

  const customer = await prisma.customer.create({ data: { code: `${TAG}-C1`, name: `${TAG} Customer`, createdById: admin.id } });
  const costing = await prisma.costing.create({
    data: { number: await nextNumber('costing'), title: `${TAG} Costing`, ownerId: admin.id, totalCost: D(80_000), contractValue: D(100_000) },
  });
  const job = await prisma.job.create({
    data: { number: await nextNumber('project'), type: 'PROJECT', name: `${TAG} Project`, customerId: customer.id, costingId: costing.id, createdById: admin.id, contractValue: D(100_000) },
  });
  const layout = seededTypes[0];

  // ══ Raising ═══════════════════════════════════════════════════════════════
  console.log('\nRaising a request');
  const refusedCreate = await http(supportT, 'POST', '/cad-job-orders', { customerId: customer.id, title: `${TAG} nope`, scope: 'A designer does not raise requests' });
  check('a designer without the create right cannot raise one', refusedCreate.status === 403, String(refusedCreate.status));
  const badLink = await http(requestorT, 'POST', '/cad-job-orders', { customerId: customer.id, jobId: 'nope', title: `${TAG} bad link`, scope: 'A project that does not exist' });
  check('a project that is not this customer’s is refused', badLink.status === 400, String(badLink.status));
  const created = await http(requestorT, 'POST', '/cad-job-orders', {
    customerId: customer.id,
    jobId: job.id,
    drawingTypeId: layout.id,
    title: `${TAG} Compressor room layout`,
    scope: 'Plan view of the compressor room with the two units, piping and the dryer, dimensioned.',
    neededBy: '2026-12-01',
  });
  check('the requestor raises a request', created.status === 201, created.text);
  const id = String(created.body.id);
  check('it is numbered from the cad_job_order counter', /CJO/.test(String(created.body.number)), String(created.body.number));
  check('it starts REQUESTED, normal priority, 0%', created.body.status === 'REQUESTED' && created.body.priority === 'NORMAL' && created.body.progressPct === 0);
  check('the design team was told — the lead and the support designer', (await bells(lead.id, 'cad.requested')) === 1 && (await bells(support.id, 'cad.requested')) === 1);
  check('the requestor was not told of their own request', (await bells(requestor.id, 'cad.requested')) === 0);

  const seenByOutsider = await http(outsiderT, 'GET', `/cad-job-orders/${id}`);
  check('another salesperson cannot open it', seenByOutsider.status === 403, String(seenByOutsider.status));
  const seenBySupport = await http(supportT, 'GET', `/cad-job-orders/${id}`);
  check('the support designer opens it and may take it, not assign it', seenBySupport.status === 200 && seenBySupport.body.canTake === true && seenBySupport.body.canAssign === false, seenBySupport.text.slice(0, 200));
  const seenByLead = await http(leadT, 'GET', `/cad-job-orders/${id}`);
  check('the lead may assign it', seenByLead.body.canAssign === true);
  const seenByRequestor = await http(requestorT, 'GET', `/cad-job-orders/${id}`);
  check('the requestor may edit and cancel, never set priority or progress', seenByRequestor.body.canEdit === true && seenByRequestor.body.canCancel === true && seenByRequestor.body.canSetPriority === false && seenByRequestor.body.canProgress === false);

  // ══ Dispatch ══════════════════════════════════════════════════════════════
  console.log('\nDispatch');
  const badAssign = await http(leadT, 'POST', `/cad-job-orders/${id}/assign`, { userId: outsider.id });
  check('the lead cannot assign it to somebody off the design team', badAssign.status === 400, badAssign.text);
  const taken = await http(supportT, 'POST', `/cad-job-orders/${id}/take`);
  check('the support designer takes it from the queue', taken.status === 200 && taken.body.status === 'IN_PROGRESS', taken.text.slice(0, 200));
  check('and the requestor was told who has it', (await bells(requestor.id, 'cad.assigned')) === 1);
  const takenAgain = await http(leadT, 'POST', `/cad-job-orders/${id}/take`);
  check('a taken request cannot be taken again — the lead reassigns', takenAgain.status === 400, takenAgain.text);
  const requestorPriority = await http(requestorT, 'POST', `/cad-job-orders/${id}/priority`, { priority: 'URGENT' });
  check('the requestor cannot set the priority', requestorPriority.status === 403, String(requestorPriority.status));
  const priority = await http(supportT, 'POST', `/cad-job-orders/${id}/priority`, { priority: 'URGENT' });
  check('the designer on it sets the priority', priority.status === 200 && priority.body.priority === 'URGENT', priority.text.slice(0, 200));
  const leadPriority = await http(leadT, 'POST', `/cad-job-orders/${id}/priority`, { priority: 'HIGH' });
  check('and so does the lead, on any', leadPriority.status === 200 && leadPriority.body.priority === 'HIGH');
  const badProgress = await http(supportT, 'POST', `/cad-job-orders/${id}/progress`, { progressPct: 140 });
  check('progress past 100 is refused', badProgress.status === 400, badProgress.text);
  const progress = await http(supportT, 'POST', `/cad-job-orders/${id}/progress`, { progressPct: 40 });
  check('the designer reports 40%', progress.status === 200 && progress.body.progressPct === 40, progress.text.slice(0, 200));

  // ══ Revisions ═════════════════════════════════════════════════════════════
  console.log('\nRevisions');
  const uploadsBefore = fs.readdirSync(env.uploadDir).length;
  const noPdf = new FormData();
  noPdf.set('note', 'First issue');
  noPdf.set('files', new Blob(['AC1027 not really a drawing'], { type: 'application/octet-stream' }), 'layout.dwg');
  const refusedRevision = await http(supportT, 'POST', `/cad-job-orders/${id}/revisions`, noPdf);
  check('a revision without a PDF is refused — the requestor always receives a PDF', refusedRevision.status === 400 && /PDF/.test(String(refusedRevision.body.error)), refusedRevision.text);
  check('and the refused upload left no stray file on disk', fs.readdirSync(env.uploadDir).length === uploadsBefore, `${fs.readdirSync(env.uploadDir).length} vs ${uploadsBefore}`);
  check('nor a revision row', (await prisma.cadRevision.count({ where: { cadJobOrderId: id } })) === 0);

  const r0 = new FormData();
  r0.set('note', 'First issue: plan view, both units');
  r0.set('files', PDF(), 'layout-R0.pdf');
  r0.append('files', new Blob(['AC1027 not really a drawing'], { type: 'application/octet-stream' }), 'layout-R0.dwg');
  const revision0 = await http(supportT, 'POST', `/cad-job-orders/${id}/revisions`, r0);
  check('R0 is submitted with its PDF and its DWG beside it', revision0.status === 201 && revision0.body.sequence === 0, revision0.text.slice(0, 300));
  const r0Files = await prisma.attachment.findMany({ where: { entityType: 'cad_revision', entityId: String(revision0.body.id) } });
  check('the DWG was accepted by its extension, whatever the browser called it', r0Files.length === 2 && r0Files.some((f) => f.fileName.endsWith('.dwg')), r0Files.map((f) => `${f.fileName}:${f.mimeType}`).join(','));
  const afterR0 = await http(requestorT, 'GET', `/cad-job-orders/${id}`);
  check('the request is FOR_REVIEW at 100%', afterR0.body.status === 'FOR_REVIEW' && afterR0.body.progressPct === 100, afterR0.text.slice(0, 200));
  check('the requestor was told R0 is ready', (await bells(requestor.id, 'cad.revision')) === 1);
  check('the requestor may accept or ask for changes', afterR0.body.canAccept === true && afterR0.body.canRequestChanges === true);
  const pdfFile = r0Files.find((f) => f.fileName.endsWith('.pdf'))!;
  const fileByOutsider = await http(outsiderT, 'GET', `/attachments/file/${pdfFile.id}`);
  check('a revision’s file is guarded by the request’s own visibility', fileByOutsider.status === 404, String(fileByOutsider.status));
  const fileByRequestor = await http(requestorT, 'GET', `/attachments/file/${pdfFile.id}`);
  check('and opens for the requestor', fileByRequestor.status === 200 && fileByRequestor.type.includes('pdf'), `${fileByRequestor.status} ${fileByRequestor.type}`);

  // ══ The thread: changes requested, a comment, R1 ══════════════════════════
  console.log('\nThe thread');
  const changesByOutsider = await http(outsiderT, 'POST', `/cad-job-orders/${id}/changes`, { comment: 'Not mine to ask' });
  check('somebody else cannot ask for changes', changesByOutsider.status === 403 || changesByOutsider.status === 400, String(changesByOutsider.status));
  const changes = await http(requestorT, 'POST', `/cad-job-orders/${id}/changes`, { comment: 'Move the dryer to the north wall and add the condensate line.' });
  check('the requestor asks for changes', changes.status === 201 && changes.body.isChangeRequest === true, changes.text.slice(0, 200));
  const afterChanges = await http(supportT, 'GET', `/cad-job-orders/${id}`);
  check('the drawing goes back as CHANGES_REQUESTED, the comment on R0', afterChanges.body.status === 'CHANGES_REQUESTED' && (afterChanges.body.comments as unknown[]).length === 1, afterChanges.text.slice(0, 200));
  check('and the designer was told', (await bells(support.id, 'cad.comment')) === 1);
  const resumed = await http(supportT, 'POST', `/cad-job-orders/${id}/progress`, { progressPct: 60 });
  check('reporting progress puts it back in progress', resumed.body.status === 'IN_PROGRESS' && resumed.body.progressPct === 60, resumed.text.slice(0, 200));

  const withFile = new FormData();
  withFile.set('body', 'Condensate line routed under the slab — see the markup.');
  withFile.set('revisionId', String(revision0.body.id));
  withFile.set('files', PDF(), 'markup.pdf');
  const comment = await http(supportT, 'POST', `/cad-job-orders/${id}/comments`, withFile);
  check('a comment carries a file and names its revision', comment.status === 201 && (comment.body.files as unknown[]).length === 1 && (comment.body.revision as { sequence: number }).sequence === 0, comment.text.slice(0, 300));
  check('the requestor was told of the comment', (await bells(requestor.id, 'cad.comment')) === 1);
  const badRevisionComment = new FormData();
  badRevisionComment.set('body', 'x');
  badRevisionComment.set('revisionId', 'nope');
  const refusedComment = await http(requestorT, 'POST', `/cad-job-orders/${id}/comments`, badRevisionComment);
  check('a comment naming a revision that is not on the request is refused', refusedComment.status === 400, refusedComment.text);

  const r1 = new FormData();
  r1.set('note', 'Dryer moved north, condensate line added');
  r1.set('files', PDF(), 'layout-R1.pdf');
  r1.set('externalUrl', 'https://drive.example.com/plant-model');
  const revision1 = await http(supportT, 'POST', `/cad-job-orders/${id}/revisions`, r1);
  check('R1 follows R0 and keeps its external link', revision1.status === 201 && revision1.body.sequence === 1 && revision1.body.externalUrl === 'https://drive.example.com/plant-model', revision1.text.slice(0, 300));
  check('R0 is still there, untouched', (await prisma.attachment.count({ where: { entityType: 'cad_revision', entityId: String(revision0.body.id) } })) === 2);
  const badUrl = new FormData();
  badUrl.set('note', 'x');
  badUrl.set('files', PDF(), 'x.pdf');
  badUrl.set('externalUrl', 'javascript:alert(1)');
  const refusedUrl = await http(supportT, 'POST', `/cad-job-orders/${id}/revisions`, badUrl);
  check('an external link must be http(s)', refusedUrl.status === 400, refusedUrl.text);

  // ══ Accepting, and filing on the project ══════════════════════════════════
  console.log('\nAccepting');
  const acceptBySupportNoNote = await http(supportT, 'POST', `/cad-job-orders/${id}/accept`, {});
  check('a designer closing it must say why', acceptBySupportNoNote.status === 400, acceptBySupportNoNote.text);
  const accepted = await http(requestorT, 'POST', `/cad-job-orders/${id}/accept`, { note: 'Looks right, thanks' });
  check('the requestor accepts R1', accepted.status === 200 && accepted.body.status === 'COMPLETED', accepted.text.slice(0, 200));
  check('the designer was told', (await bells(support.id, 'cad.updated')) >= 1);
  const acceptedTwice = await http(requestorT, 'POST', `/cad-job-orders/${id}/accept`, {});
  check('it cannot be accepted twice', acceptedTwice.status === 400);
  const editClosed = await http(requestorT, 'PATCH', `/cad-job-orders/${id}`, { title: `${TAG} renamed` });
  check('a completed request is a record — no edits', editClosed.status === 403, String(editClosed.status));

  const filed = await http(requestorT, 'POST', `/cad-job-orders/${id}/file-plan`, { discipline: 'Mechanical' });
  check('the accepted revision files as an Approved Plan on the project', filed.status === 201 && filed.body.revision === 'R1' && filed.body.jobId === job.id, filed.text.slice(0, 300));
  const planFiles = await prisma.attachment.findMany({ where: { entityType: 'approved_plan', entityId: String(filed.body.id) } });
  const r1Files = await prisma.attachment.findMany({ where: { entityType: 'cad_revision', entityId: String(revision1.body.id) } });
  check('its files are COPIES of R1’s — the revision keeps its own', planFiles.length === r1Files.length && planFiles.every((p) => !r1Files.some((r) => r.storedName === p.storedName)) && planFiles.every((p) => fs.existsSync(attachmentPath(p.storedName))));
  const filedTwice = await http(requestorT, 'POST', `/cad-job-orders/${id}/file-plan`, {});
  check('it files once', filedTwice.status === 400, filedTwice.text);
  const final = await http(leadT, 'GET', `/cad-job-orders/${id}`);
  check('the request remembers its plan', (final.body.approvedPlan as { id: string } | null)?.id === filed.body.id);

  // ══ Hold, resume, cancel ══════════════════════════════════════════════════
  console.log('\nHold, resume, cancel');
  const second = await http(requestorT, 'POST', '/cad-job-orders', { customerId: customer.id, title: `${TAG} Single-line diagram`, scope: 'SLD of the new MCC, 480 V', neededBy: '2026-01-02' });
  const id2 = String(second.body.id);
  await http(leadT, 'POST', `/cad-job-orders/${id2}/assign`, { userId: support.id });
  check('the lead assigns the second request to the support designer', (await prisma.cadJobOrder.findUnique({ where: { id: id2 } }))?.assignedToId === support.id);
  check('the designer was told of the assignment', (await bells(support.id, 'cad.assigned')) === 1);
  const held = await http(requestorT, 'POST', `/cad-job-orders/${id2}/hold`, { reason: 'Waiting on the MCC supplier’s drawing' });
  check('the requestor puts it on hold with a reason', held.status === 200 && held.body.status === 'ON_HOLD' && held.body.holdReason === 'Waiting on the MCC supplier’s drawing', held.text.slice(0, 200));
  const heldProgress = await http(supportT, 'POST', `/cad-job-orders/${id2}/progress`, { progressPct: 10 });
  check('no progress on a held request', heldProgress.status === 400);
  const back = await http(supportT, 'POST', `/cad-job-orders/${id2}/resume`);
  check('resume puts it back where it was', back.status === 200 && back.body.status === 'IN_PROGRESS' && back.body.holdReason === null, back.text.slice(0, 200));
  const cancelByOutsider = await http(outsiderT, 'POST', `/cad-job-orders/${id2}/cancel`, { reason: 'not mine' });
  check('somebody else cannot cancel it', cancelByOutsider.status === 403 || cancelByOutsider.status === 400, String(cancelByOutsider.status));
  const cancelBySupport = await http(supportT, 'POST', `/cad-job-orders/${id2}/cancel`, { reason: 'designer cannot' });
  check('nor can the support designer — the requestor or the lead do', cancelBySupport.status === 403, String(cancelBySupport.status));

  const third = await http(requestorT, 'POST', '/cad-job-orders', { customerId: customer.id, title: `${TAG} As-built`, scope: 'As-built of the piping after commissioning' });
  const id3 = String(third.body.id);

  // ══ The list, the cards, the paper, search, My Work ═══════════════════════
  console.log('\nThe list');
  const q = (filters: Record<string, string>, scope = 'all') => listQuery({ query: { search: TAG, scope, ...filters } } as never);
  const leadUser = (await resolveUser(lead.id))!;
  const requestorUser = (await resolveUser(requestor.id))!;
  const outsiderUser = (await resolveUser(outsider.id))!;
  const count = async (user: typeof leadUser, filters: Record<string, string>, scope = 'all') => prisma.cadJobOrder.count({ where: cadListWhere(user, q(filters, scope)).where });
  check('the lead sees all three', (await count(leadUser, {})) === 3);
  check('the requestor’s own-scope list is the three they raised', (await count(requestorUser, {})) === 3);
  check('another salesperson sees none of them', (await count(outsiderUser, {})) === 0);
  check('the support designer’s Mine is what is on their board — the two assigned to them', (await count((await resolveUser(support.id))!, {}, 'mine')) === 2);
  const summary = await cadListSummary(cadListWhere(leadUser, q({})).base);
  check(
    'the cards: 2 open, 1 completed, 1 overdue (the second, needed last January), 1 waiting for a designer',
    summary.open === 2 && summary.completed === 1 && summary.overdue === 1 && summary.unassigned === 1,
    JSON.stringify(summary),
  );
  check(
    'the filters select what they say',
    (await count(leadUser, { status: 'COMPLETED' })) === 1 &&
      (await count(leadUser, { open: 'true' })) === 2 &&
      (await count(leadUser, { overdue: 'true' })) === 1 &&
      (await count(leadUser, { unassigned: 'true' })) === 1 &&
      (await count(leadUser, { assignedToId: support.id })) === 2 &&
      (await count(leadUser, { assignedToId: 'none' })) === 1 &&
      (await count(leadUser, { priority: 'HIGH' })) === 1 &&
      (await count(leadUser, { drawingTypeId: layout.id })) === 1 &&
      (await count(leadUser, { neededFrom: '2026-11-01', neededTo: '2026-12-31' })) === 1 &&
      (await count(leadUser, { ids: id3 })) === 1,
  );
  let refused = 0;
  for (const bad of [{ status: 'WHATEVER' }, { priority: 'MEH' }, { neededFrom: '12/01/2026' }]) {
    try {
      cadListWhere(leadUser, q(bad));
    } catch (err) {
      if ((err as { status?: number }).status === 400) refused++;
    }
  }
  check('a malformed filter is a 400, never an empty list', refused === 3, `${refused} of 3`);
  const listed = await http(leadT, 'GET', `/cad-job-orders?search=${TAG}&sort=neededBy&dir=asc`);
  const rows = listed.body.rows as { id: string; overdue: boolean; latestRevision: { label: string } | null; revisionCount: number }[];
  check('the list carries the derived facts: overdue, the latest revision, the counts', listed.status === 200 && rows.length === 3 && rows.some((r) => r.id === id2 && r.overdue) && rows.find((r) => r.id === id)?.latestRevision?.label === 'R1' && rows.find((r) => r.id === id)?.revisionCount === 2, listed.text.slice(0, 300));
  check('and the summary with it', (listed.body.summary as { open: number }).open === 2);
  const paper = await http(leadT, 'GET', `/cad-job-orders/pdf?search=${TAG}&ids=${id},${id2}`);
  check('the printed list answers with a PDF for the ticked rows', paper.status === 200 && paper.type.includes('pdf'), `${paper.status} ${paper.type}`);
  const one = await http(requestorT, 'GET', `/cad-job-orders/${id}/pdf`);
  check('and so does the request', one.status === 200 && one.type.includes('pdf'), `${one.status} ${one.type}`);
  const onePdfByOutsider = await http(outsiderT, 'GET', `/cad-job-orders/${id}/pdf`);
  check('not for somebody else', onePdfByOutsider.status === 403, String(onePdfByOutsider.status));

  // The paper (rule 6). No route, so the sign-offs are the people who
  // actually acted, each dated, and never a slot nobody is named for:
  // Requested by; Drawn by whoever submitted the latest revision; Accepted by
  // the requestor — whose name stands over "Pending" until they do.
  const exportsOf = (entityId: string) => prisma.auditLog.count({ where: { entityType: 'cad_job_order', entityId, action: 'EXPORTED' } });
  const printsBefore = await exportsOf(id);
  const donePaper = await printed(requestorT, `/cad-job-orders/${id}/pdf`);
  const roles = (t: string) => ['REQUESTED BY', 'DRAWN BY', 'ACCEPTED BY', 'CLOSED BY'].filter((r) => flat(t).includes(r));
  check(
    'an accepted request prints Requested, Drawn and Accepted by, each by name and dated, nothing Pending',
    donePaper.status === 200 &&
      roles(donePaper.text).join(',') === 'REQUESTED BY,DRAWN BY,ACCEPTED BY' &&
      signedCount(donePaper.text) === 3 &&
      pendingCount(donePaper.text) === 0 &&
      donePaper.text.includes(`${TAG} Requestor`),
    `${donePaper.status} ${roles(donePaper.text).join(',')} ${signedCount(donePaper.text)} signed, ${pendingCount(donePaper.text)} pending`,
  );
  check(
    'its words are words: the status and priority through statusLabel, the revisions under "Revision"',
    donePaper.text.includes('Completed') &&
      !donePaper.text.includes('COMPLETED') &&
      /Priority: (Low|Normal|High|Urgent)\b/.test(donePaper.text) &&
      flat(donePaper.text).includes('REVISION') &&
      !donePaper.text.includes('CHANGES REQUESTED'),
    donePaper.text.split('\n').filter((l) => /omplet|ormal|REVISION|CHANGES/.test(l)).join(' | ').slice(0, 200),
  );
  check(
    'it names the requestor once in its details, with no date of its own — the dated sign-off says when, in Manila',
    donePaper.text.includes(`${TAG} Requestor`) && !donePaper.text.includes(`${TAG} Requestor, `),
    donePaper.text.split('\n').filter((l) => l.includes('Requestor')).join(' | '),
  );
  const workingPaper = await printed(leadT, `/cad-job-orders/${id2}/pdf`);
  check(
    'in progress with no revision yet: the designer on it and the requestor each stand over "Pending"',
    workingPaper.status === 200 &&
      roles(workingPaper.text).join(',') === 'REQUESTED BY,DRAWN BY,ACCEPTED BY' &&
      workingPaper.text.includes(`${TAG} Designer Support`) &&
      signedCount(workingPaper.text) === 1 &&
      pendingCount(workingPaper.text) === 2 &&
      workingPaper.text.includes('No revision submitted yet.') &&
      flat(workingPaper.text).includes('In progress'),
    `${workingPaper.status} ${roles(workingPaper.text).join(',')} ${signedCount(workingPaper.text)} signed, ${pendingCount(workingPaper.text)} pending`,
  );
  const queuedPaper = await printed(requestorT, `/cad-job-orders/${id3}/pdf`);
  check(
    'waiting for a designer, it prints no "Drawn by" slot nobody is named for',
    queuedPaper.status === 200 &&
      roles(queuedPaper.text).join(',') === 'REQUESTED BY,ACCEPTED BY' &&
      signedCount(queuedPaper.text) === 1 &&
      pendingCount(queuedPaper.text) === 1,
    `${queuedPaper.status} ${roles(queuedPaper.text).join(',')} ${signedCount(queuedPaper.text)} signed, ${pendingCount(queuedPaper.text)} pending`,
  );
  check('every print of a request is on its trail as EXPORTED', (await exportsOf(id)) === printsBefore + 1, `${printsBefore} → ${await exportsOf(id)}`);
  const listPrintsBefore = await exportsOf('list');
  const listPaper = await printed(leadT, `/cad-job-orders/pdf?search=${TAG}`);
  check(
    'the printed list is landscape, its heads whole, its dates MM/DD/YYYY, its statuses words — and audited',
    listPaper.status === 200 &&
      listPaper.pages.length > 0 &&
      listPaper.pages.every((b) => b === '841.89x595.28') &&
      flat(listPaper.text).includes('NUMBER') &&
      listPaper.text.includes('01/02/2026') &&
      flat(listPaper.text).includes('In progress') &&
      !listPaper.text.includes('IN_PROGRESS') &&
      (await exportsOf('list')) === listPrintsBefore + 1,
    `${listPaper.status} ${listPaper.pages.join(',')} ${listPaper.text.split('\n').filter((l) => /\d\/\d|rogress|PROGRESS|NUMBER/.test(l)).join(' | ').slice(0, 300)}`,
  );

  // Every filter `cadListWhere` applied is said on the paper, by name — a
  // list narrowed to one drawing type never reads as the whole queue.
  const narrowed = await printed(
    leadT,
    `/cad-job-orders/pdf?search=${TAG}&drawingTypeId=${layout.id}&assignedToId=${support.id}&requestedById=${requestor.id}&customerId=${customer.id}&jobId=${job.id}`,
  );
  const narrowedLine = flat(narrowed.text);
  check(
    'a narrowed list names every filter it was printed under — drawing type, designer, requestor, customer, project',
    narrowed.status === 200 &&
      narrowedLine.includes(`drawing type ${layout.name}`) &&
      narrowedLine.includes(`designer ${TAG} Designer Support`) &&
      narrowedLine.includes(`requested by ${TAG} Requestor`) &&
      narrowedLine.includes(`customer ${TAG} Customer`) &&
      narrowedLine.includes(`project ${job.number}`) &&
      !narrowedLine.includes('one designer') &&
      !narrowedLine.includes('one requestor'),
    narrowedLine.match(/search.{0,300}/)?.[0] ?? `${narrowed.status}`,
  );

  // The paper's counts are of the set it PRINTED — never the queue's cards,
  // which stand under the visibility rule alone. The whole queue under the
  // search is three, two open, one overdue; narrowed to what is completed and
  // needed in November–December it is one, none open, none overdue — and the
  // window prints as MM/DD/YYYY, as every date on a list does.
  const queuePaper = flat((await printed(leadT, `/cad-job-orders/pdf?search=${TAG}`)).text);
  const donePrinted = await printed(leadT, `/cad-job-orders/pdf?search=${TAG}&status=COMPLETED&neededFrom=2026-11-01&neededTo=2026-12-31`);
  const doneLine = flat(donePrinted.text);
  check(
    'a filtered list counts what it printed — "1 CAD job order, 0 open, 0 overdue" — not the queue’s 3, 2 open, 1 overdue',
    queuePaper.includes('3 CAD job orders, 2 open, 1 overdue') &&
      donePrinted.status === 200 &&
      doneLine.includes('1 CAD job order, 0 open, 0 overdue') &&
      doneLine.includes('status Completed') &&
      doneLine.includes('needed 11/01/2026 to 12/31/2026') &&
      !doneLine.includes('December'),
    `${queuePaper.match(/Reference: [^—]*/)?.[0] ?? ''} | ${doneLine.match(/Reference: .{0,160}/)?.[0] ?? donePrinted.status}`,
  );
  const tickedPrinted = flat((await printed(leadT, `/cad-job-orders/pdf?ids=${id2}`)).text);
  check(
    'Print selected counts the ticked rows alone, and says so',
    tickedPrinted.includes('1 CAD job order, 1 open, 1 overdue') && tickedPrinted.includes('the rows selected') && !tickedPrinted.includes(`${TAG} As-built`),
    tickedPrinted.match(/Reference: .{0,120}/)?.[0] ?? '',
  );

  const hitsForRequestor = (await globalSearch(TAG, requestorUser)).filter((h) => h.kind === 'cad_job_order');
  const hitsForOutsider = (await globalSearch(TAG, outsiderUser)).filter((h) => h.kind === 'cad_job_order');
  check('Ctrl+K finds the requestor’s own, and nobody else’s', hitsForRequestor.length === 3 && hitsForOutsider.length === 0 && hitsForRequestor.every((h) => h.link.startsWith('/g-ops/cad-job-orders/')), `${hitsForRequestor.length} / ${hitsForOutsider.length}`);

  const work = await http(supportT, 'GET', '/my-work');
  const mine = (work.body.assignedToMe as { kind: string; id: string; link: string; overdue?: boolean }[]).filter((r) => r.kind === 'cad_job_order');
  check('My Work shows the designer the request on their board, overdue', mine.length === 1 && mine[0].id === id2 && mine[0].overdue === true && mine[0].link === `/g-ops/cad-job-orders/${id2}`, JSON.stringify(mine));
  const leadWork = await http(leadT, 'GET', '/my-work');
  // The lead's queue holds every unassigned request in the database; this
  // script's own (tagged) are the ones it can speak for.
  const queue = (leadWork.body.assignedToMe as { kind: string; id: string; title: string }[]).filter(
    (r) => r.kind === 'cad_job_order' && r.title.includes(TAG),
  );
  check('and the lead the one waiting for a designer', queue.length === 1 && queue[0].id === id3, JSON.stringify(queue));

  const cancelled = await http(requestorT, 'POST', `/cad-job-orders/${id3}/cancel`, { reason: 'Customer withdrew' });
  check('the requestor cancels the third with a reason', cancelled.status === 200 && (await prisma.cadJobOrder.findUnique({ where: { id: id3 } }))?.cancelReason === 'Customer withdrew');
  const cancelledPaper = await printed(requestorT, `/cad-job-orders/${id3}/pdf`);
  check(
    'a cancelled request prints only what happened — no slot left "Pending" for ever — and says why',
    cancelledPaper.status === 200 &&
      roles(cancelledPaper.text).join(',') === 'REQUESTED BY' &&
      pendingCount(cancelledPaper.text) === 0 &&
      cancelledPaper.text.includes('Customer withdrew'),
    `${cancelledPaper.status} ${roles(cancelledPaper.text).join(',')} ${pendingCount(cancelledPaper.text)} pending`,
  );

  // ══ Drawing types ═════════════════════════════════════════════════════════
  console.log('\nDrawing types');
  const typesPublic = await http(requestorT, 'GET', '/reference/cad-drawing-types?active=true');
  check('anyone signed in reads the list', typesPublic.status === 200 && (typesPublic.body as unknown as unknown[]).length >= CAD_DRAWING_TYPES.length);
  const typeDenied = await http(requestorT, 'POST', '/reference/cad-drawing-types', { name: `${TAG} Isometric` });
  check('changing it takes the categories right', typeDenied.status === 403);
  const made = await http(adminT, 'POST', '/reference/cad-drawing-types', { name: `${TAG} Isometric` });
  check('an administrator adds one', made.status === 201, made.text);
  const dup = await http(adminT, 'POST', '/reference/cad-drawing-types', { name: `${TAG} isometric` });
  check('one per spelling, case-blind', dup.status === 409, String(dup.status));
  const sysDelete = await http(adminT, 'DELETE', `/reference/cad-drawing-types/${layout.id}`);
  check('a system type is never deleted', sysDelete.status === 400, sysDelete.text);
  const madeDelete = await http(adminT, 'DELETE', `/reference/cad-drawing-types/${made.body.id}`);
  check('an unused custom one is', madeDelete.status === 200);

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
