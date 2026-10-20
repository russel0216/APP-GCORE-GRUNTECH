import { Router } from 'express';
import { z } from 'zod';
import { Prisma, type MemoAudience } from '@prisma/client';
import { prisma } from '../prisma';
import { env } from '../env';
import { handler, parseBody, listQuery, listResult, orderBy, notFound, badRequest, conflict, idsFilter } from '../http/kit';
import { authenticate, currentUser } from '../auth/middleware';
import { can, canEditRecord, type ResolvedUser } from '../permissions/resolve';
import { requireView, requireEdit, ownOnly, assertCanView } from '../shared/ownScope';
import { audit } from '../shared/audit';
import { nextNumber } from '../shared/numbering';
import { notify, type NotificationType } from '../shared/notifications';
import { mailConfig, sendMail } from '../shared/mail';
import { renderDocument, formatDate, formatShortDate, type PdfSection } from '../shared/pdf';
import { contactOf } from '../shared/approvals';
import { attachedFiles, withAttachments } from '../shared/pdfAttachments';
import { contentDisposition, paperFileName } from '../shared/paperName';
import { deleteAttachmentsOf, registerAttachmentGuard } from '../shared/attachments';
import { registerSearch } from '../shared/search';
import { manilaDate } from '../shared/day';
import { LIST_CAP, listReference, choice, sendListPdf } from '../shared/listPaper';

/**
 * G-HR › Records › MEMOS (2026-10-20, the owner's G-HR Records spec, "build
 * default"). HR drafts a memorandum, addresses it to everyone, to teams, to
 * plantilla positions or to named people, and issues it. Issuing RESOLVES the
 * audience into one `MemoRecipient` row per active employee, numbers the memo
 * (`memo`) and tells each recipient (a bell, and an email where SMTP is set);
 * each acknowledges it once, and HR reminds those who have not. A memo is a
 * record, not a routed document: no approval, no money.
 *
 * `ghr.memos` (SHARED_KEPT): the register — Create issues, Edit All any
 * memo, Edit Own those one drafted. A memo ADDRESSED to someone opens for
 * them with no right at all: the received list, the page, the paper and its
 * files all let a recipient in (`isRecipient`).
 */
export const memoRoutes = Router();
memoRoutes.use(authenticate);

const DOC = 'memo';
const PATH = '/g-hr/memos';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const include = {
  createdBy: { select: { id: true, name: true } },
  issuedBy: { select: { id: true, name: true, position: true } },
  _count: { select: { recipients: true } },
} satisfies Prisma.MemoInclude;
type Row = Prisma.MemoGetPayload<{ include: typeof include }>;

async function load(id: string): Promise<Row> {
  const row = await prisma.memo.findUnique({ where: { id }, include });
  if (!row) throw notFound('Memo not found');
  return row;
}

/** "All employees", "Teams: KAT, HIT", "Positions: …", "3 people: …" — who a memo is addressed to, in words. */
async function audienceLabels(rows: { audience: MemoAudience; teamIds: string[]; positionIds: string[]; employeeIds: string[] }[]): Promise<string[]> {
  const teamIds = [...new Set(rows.flatMap((r) => (r.audience === 'TEAMS' ? r.teamIds : [])))];
  const positionIds = [...new Set(rows.flatMap((r) => (r.audience === 'POSITIONS' ? r.positionIds : [])))];
  const employeeIds = [...new Set(rows.flatMap((r) => (r.audience === 'PEOPLE' ? r.employeeIds : [])))];
  const [teams, positions, people] = await Promise.all([
    teamIds.length ? prisma.industry.findMany({ where: { id: { in: teamIds } }, select: { id: true, code: true } }) : [],
    positionIds.length ? prisma.position.findMany({ where: { id: { in: positionIds } }, select: { id: true, title: true } }) : [],
    employeeIds.length ? prisma.employee.findMany({ where: { id: { in: employeeIds } }, select: { id: true, firstName: true, lastName: true } }) : [],
  ]);
  const team = new Map(teams.map((t) => [t.id, t.code]));
  const position = new Map(positions.map((p) => [p.id, p.title]));
  const person = new Map(people.map((p) => [p.id, `${p.firstName} ${p.lastName}`]));
  return rows.map((r) => {
    if (r.audience === 'ALL') return 'All employees';
    if (r.audience === 'TEAMS') return `Teams: ${r.teamIds.map((id) => team.get(id) ?? '?').join(', ')}`;
    if (r.audience === 'POSITIONS') return `Positions: ${r.positionIds.map((id) => position.get(id) ?? '?').join(', ')}`;
    const names = r.employeeIds.map((id) => person.get(id) ?? '?');
    return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
  });
}

/** The active employees an audience means — read at issue, and by the form's count. */
function audienceWhere(m: { audience: MemoAudience; teamIds: string[]; positionIds: string[]; employeeIds: string[] }): Prisma.EmployeeWhereInput {
  const where: Prisma.EmployeeWhereInput = { isActive: true };
  if (m.audience === 'TEAMS') where.industryId = { in: m.teamIds };
  if (m.audience === 'POSITIONS') where.OR = [{ positionId: { in: m.positionIds } }, { extraPositions: { some: { positionId: { in: m.positionIds } } } }];
  if (m.audience === 'PEOPLE') where.id = { in: m.employeeIds };
  return where;
}

/** Whether the caller is one of the memo's recipients. */
async function isRecipient(me: ResolvedUser, memoId: string): Promise<{ id: string; acknowledgedAt: Date | null } | null> {
  return prisma.memoRecipient.findFirst({ where: { memoId, employee: { userId: me.id } }, select: { id: true, acknowledgedAt: true } });
}

/** May the caller read it through the register — View All, or the memo they drafted. */
function readsRegister(me: ResolvedUser, row: { createdById: string }): boolean {
  try {
    assertCanView(me, 'ghr', 'memos', row.createdById === me.id, row.createdById);
    return true;
  } catch {
    return false;
  }
}

/** The register, or the person it was sent to — else a 404 (a memo about others is nobody else's business). */
async function readable(me: ResolvedUser, id: string): Promise<{ row: Row; register: boolean; mine: { id: string; acknowledgedAt: Date | null } | null }> {
  const row = await load(id);
  const register = readsRegister(me, row);
  const mine = row.status === 'DRAFT' ? null : await isRecipient(me, row.id);
  if (!register && !mine) throw notFound('Memo not found');
  return { row, register, mine };
}

/** A bell each, and an email each where SMTP is set — sent after the save, never allowed to fail it. */
async function tell(userIds: string[], message: { type: NotificationType; title: string; body: string; link: string }) {
  const ids = [...new Set(userIds)];
  if (!ids.length) return;
  await notify(ids.map((userId) => ({ userId, ...message })));
  const cfg = mailConfig();
  if (!cfg) return;
  const people = await prisma.user.findMany({ where: { id: { in: ids }, isActive: true }, select: { email: true, name: true } });
  const url = `${env.appUrl.replace(/\/+$/, '')}${message.link}`;
  for (const p of people) {
    try {
      await sendMail({ to: p.email, toName: p.name, subject: message.title, text: `${message.body}\n\n${url}` }, cfg);
    } catch (err) {
      console.error(`Memo email to ${p.email} failed:`, err instanceof Error ? err.message : err);
    }
  }
}

const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

// ── The register ────────────────────────────────────────────────────────────

const STATUSES = ['DRAFT', 'ISSUED', 'ARCHIVED'] as const;
const AUDIENCES = ['ALL', 'TEAMS', 'POSITIONS', 'PEOPLE'] as const;

function listWhere(me: ResolvedUser, q: ReturnType<typeof listQuery>): { base: Prisma.MemoWhereInput; where: Prisma.MemoWhereInput } {
  const and: Prisma.MemoWhereInput[] = [];
  const ids = idsFilter(q.filters.ids);
  if (ids) and.push({ id: { in: ids } });
  if (q.search) {
    and.push({
      OR: [
        { number: { contains: q.search, mode: 'insensitive' } },
        { title: { contains: q.search, mode: 'insensitive' } },
        { body: { contains: q.search, mode: 'insensitive' } },
        { issuingOffice: { contains: q.search, mode: 'insensitive' } },
      ],
    });
  }
  if (q.scope === 'mine') and.push({ createdById: me.id });
  const base = ownOnly<Prisma.MemoWhereInput>(me, 'ghr', 'memos', and.length ? { AND: and } : {}, (owners) => ({ createdById: { in: owners } }));
  const where: Prisma.MemoWhereInput = { ...base };
  const status = choice(q.filters.status, STATUSES, 'Status');
  if (status) where.status = status;
  const audience = choice(q.filters.audience, AUDIENCES, 'Addressed to');
  if (audience) where.audience = audience;
  if (q.filters.pending === 'true') where.recipients = { some: { acknowledgedAt: null } };
  return { base, where };
}

const SORTS = ['number', 'title', 'memoDate', 'issuedAt', 'createdAt', 'updatedAt'];

async function ackCounts(ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = await prisma.memoRecipient.groupBy({ by: ['memoId'], where: { memoId: { in: ids }, acknowledgedAt: { not: null } }, _count: { _all: true } });
  return new Map(rows.map((r) => [r.memoId, r._count._all]));
}

function present(r: Row, audienceLabel: string, acknowledged: number) {
  return {
    id: r.id,
    number: r.number,
    status: r.status,
    title: r.title,
    issuingOffice: r.issuingOffice,
    audience: r.audience,
    audienceLabel,
    memoDate: day(r.memoDate),
    issuedAt: r.issuedAt,
    issuedBy: r.issuedBy,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    recipients: r._count.recipients,
    acknowledged,
  };
}

memoRoutes.get(
  '/',
  requireView('ghr', 'memos'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { base, where } = listWhere(me, q);
    const [rows, total, issued, drafts, archived, unacked] = await Promise.all([
      prisma.memo.findMany({ where, include, orderBy: orderBy(q, SORTS, { updatedAt: 'desc' }), skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      prisma.memo.count({ where }),
      prisma.memo.count({ where: { ...base, status: 'ISSUED' } }),
      prisma.memo.count({ where: { ...base, status: 'DRAFT' } }),
      prisma.memo.count({ where: { ...base, status: 'ARCHIVED' } }),
      prisma.memoRecipient.count({ where: { acknowledgedAt: null, memo: { ...base, status: 'ISSUED' } } }),
    ]);
    const [labels, acks] = await Promise.all([audienceLabels(rows), ackCounts(rows.map((r) => r.id))]);
    res.json({
      ...listResult(rows.map((r, i) => present(r, labels[i], acks.get(r.id) ?? 0)), total, q),
      summary: { issued, drafts, archived, unacknowledged: unacked },
    });
  }),
);

/** The register on paper — the list's own query, or the rows ticked. Above /:id. */
memoRoutes.get(
  '/pdf',
  requireView('ghr', 'memos'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const q = listQuery(req);
    const { where } = listWhere(me, q);
    const [rows, count] = await Promise.all([
      prisma.memo.findMany({ where, include, orderBy: orderBy(q, SORTS, { updatedAt: 'desc' }), take: LIST_CAP }),
      prisma.memo.count({ where }),
    ]);
    const [labels, acks] = await Promise.all([audienceLabels(rows), ackCounts(rows.map((r) => r.id))]);
    const f = q.filters;
    const reference = listReference(count, rows.length, ['memo', 'memos'], [
      q.search ? `search "${q.search}"` : null,
      f.status ? `status ${f.status.toLowerCase()}` : null,
      f.audience ? `addressed to ${f.audience.toLowerCase()}` : null,
      f.pending === 'true' ? 'awaiting acknowledgement' : null,
      q.scope === 'mine' ? 'drafted by me' : null,
      f.ids ? 'the rows selected' : null,
    ]);
    const pdf = await renderDocument({
      title: 'Memos',
      date: new Date(),
      reference,
      landscape: true,
      sections: [
        {
          kind: 'table',
          head: ['Number', 'Title', 'Issued to', 'Issued by', 'Date', 'Acknowledged', 'Status'],
          align: ['left', 'left', 'left', 'left', 'left', 'right', 'left'],
          rows: rows.map((r, i) => [
            r.number ?? 'Draft',
            { title: r.title, body: r.issuingOffice ?? '' },
            labels[i],
            r.issuedBy?.name ?? '—',
            r.memoDate ? formatShortDate(r.memoDate) : '—',
            r.status === 'DRAFT' ? '—' : `${acks.get(r.id) ?? 0} of ${r._count.recipients}`,
            r.status === 'DRAFT' ? 'Draft' : r.status === 'ISSUED' ? 'Issued' : 'Archived',
          ]),
        },
      ],
    });
    await audit({ entityType: DOC, entityId: 'list', action: 'EXPORTED', summary: `Exported the memos list as PDF (${listReference(count, rows.length, ['memo', 'memos'], [])})` }, req);
    sendListPdf(res, pdf, 'memos.pdf');
  }),
);

/**
 * The memos addressed to the caller — My Records' Memos Received tab. Any
 * signed-in person: it lists only their own; HR (View All) reads an
 * employee's with `?employeeId=` — the employee record's Memos tab. Above /:id.
 */
memoRoutes.get(
  '/received',
  handler(async (req, res) => {
    const me = currentUser(req);
    // HR reads an employee's on their record (`?employeeId=`, View All); anyone else only their own.
    const other = typeof req.query.employeeId === 'string' && req.query.employeeId ? req.query.employeeId : null;
    if (other && !can(me, 'ghr.memos.view_all')) throw notFound('Memo list not found');
    const rows = await prisma.memoRecipient.findMany({
      where: { ...(other ? { employeeId: other } : { employee: { userId: me.id } }), memo: { status: { not: 'DRAFT' } } },
      include: { memo: { include } },
      orderBy: { memo: { issuedAt: 'desc' } },
      take: 200,
    });
    const labels = await audienceLabels(rows.map((r) => r.memo));
    res.json({
      rows: rows.map((r, i) => ({
        id: r.memo.id,
        number: r.memo.number,
        title: r.memo.title,
        issuingOffice: r.memo.issuingOffice,
        audienceLabel: labels[i],
        issuedBy: r.memo.issuedBy,
        memoDate: day(r.memo.memoDate),
        issuedAt: r.memo.issuedAt,
        archived: r.memo.status === 'ARCHIVED',
        acknowledgedAt: r.acknowledgedAt,
      })),
      unacknowledged: rows.filter((r) => !r.acknowledgedAt).length,
    });
  }),
);

/** What the form addresses a memo with — teams, positions and active people, names only. Above /:id. */
memoRoutes.get(
  '/options',
  requireEdit('ghr', 'memos'),
  handler(async (_req, res) => {
    const [teams, positions, people] = await Promise.all([
      prisma.industry.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }], select: { id: true, code: true, name: true } }),
      prisma.position.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }], select: { id: true, code: true, title: true } }),
      prisma.employee.findMany({
        where: { isActive: true },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        select: { id: true, employeeNo: true, firstName: true, lastName: true, position: true, industry: { select: { code: true } } },
      }),
    ]);
    res.json({
      teams,
      positions,
      people: people.map((p) => ({ id: p.id, name: `${p.firstName} ${p.lastName}`, sub: [p.employeeNo, p.position].filter(Boolean).join(' · '), group: p.industry?.code ?? 'No team' })),
    });
  }),
);

/** How many active employees an audience reaches now — the form's "will go to N people". Above /:id. */
memoRoutes.post(
  '/reach',
  requireEdit('ghr', 'memos'),
  handler(async (req, res) => {
    const body = parseBody(audienceSchema, req.body);
    res.json({ count: await prisma.employee.count({ where: audienceWhere(checkedAudience(body)) }) });
  }),
);

// ── Create and modify a draft ───────────────────────────────────────────────

const audienceSchema = z.object({
  audience: z.enum(AUDIENCES).default('ALL'),
  teamIds: z.array(z.string()).max(50).default([]),
  positionIds: z.array(z.string()).max(200).default([]),
  employeeIds: z.array(z.string()).max(2000).default([]),
});

const schema = audienceSchema.extend({
  title: z.string().trim().min(3, 'What is the memo about?').max(300),
  body: z.string().trim().min(1, 'Write the memo').max(50_000),
  issuingOffice: z.string().trim().max(200).optional().nullable(),
  memoDate: z.string().regex(DAY, 'Use a date').optional().nullable(),
});

/** Only the list the audience uses is kept, and it must name someone. */
function checkedAudience<T extends z.infer<typeof audienceSchema>>(b: T): T {
  const out = { ...b, teamIds: b.audience === 'TEAMS' ? b.teamIds : [], positionIds: b.audience === 'POSITIONS' ? b.positionIds : [], employeeIds: b.audience === 'PEOPLE' ? b.employeeIds : [] };
  if (b.audience === 'TEAMS' && !out.teamIds.length) throw badRequest('Choose at least one team', [{ field: 'teamIds', message: 'Choose a team' }]);
  if (b.audience === 'POSITIONS' && !out.positionIds.length) throw badRequest('Choose at least one position', [{ field: 'positionIds', message: 'Choose a position' }]);
  if (b.audience === 'PEOPLE' && !out.employeeIds.length) throw badRequest('Choose at least one person', [{ field: 'employeeIds', message: 'Choose someone' }]);
  return out;
}

memoRoutes.post(
  '/',
  requireEdit('ghr', 'memos'),
  handler(async (req, res) => {
    const me = currentUser(req);
    if (!can(me, 'ghr.memos.create')) throw badRequest('You may read memos but not draft one');
    const body = checkedAudience(parseBody(schema, req.body));
    const row = await prisma.memo.create({
      data: {
        title: body.title,
        body: body.body,
        issuingOffice: body.issuingOffice?.trim() || null,
        audience: body.audience,
        teamIds: body.teamIds,
        positionIds: body.positionIds,
        employeeIds: body.employeeIds,
        memoDate: body.memoDate ? new Date(`${body.memoDate}T00:00:00Z`) : null,
        createdById: me.id,
      },
      include,
    });
    await audit({ entityType: DOC, entityId: row.id, action: 'CREATED', summary: `Drafted the memo "${row.title}"` }, req);
    const [label] = await audienceLabels([row]);
    res.status(201).json(present(row, label, 0));
  }),
);

memoRoutes.patch(
  '/:id',
  requireEdit('ghr', 'memos'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const existing = await load(req.params.id);
    if (!canEditRecord(me, 'ghr', 'memos', existing.createdById)) throw notFound('Memo not found');
    if (existing.status !== 'DRAFT') throw badRequest('An issued memo is what its recipients were sent — it is not changed. Archive it and issue a new one.');
    const body = checkedAudience(parseBody(schema, req.body));
    const claimed = await prisma.memo.updateMany({
      where: { id: existing.id, status: 'DRAFT' },
      data: {
        title: body.title,
        body: body.body,
        issuingOffice: body.issuingOffice?.trim() || null,
        audience: body.audience,
        teamIds: body.teamIds,
        positionIds: body.positionIds,
        employeeIds: body.employeeIds,
        memoDate: body.memoDate ? new Date(`${body.memoDate}T00:00:00Z`) : null,
      },
    });
    if (!claimed.count) throw conflict('The memo was issued a moment ago — reload it');
    const updated = await load(existing.id);
    await audit({ entityType: DOC, entityId: updated.id, action: 'UPDATED', summary: `Modified the draft memo "${updated.title}"` }, req);
    const [label] = await audienceLabels([updated]);
    res.json(present(updated, label, 0));
  }),
);

memoRoutes.delete(
  '/:id',
  requireEdit('ghr', 'memos'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(req.params.id);
    if (!canEditRecord(me, 'ghr', 'memos', row.createdById)) throw notFound('Memo not found');
    if (row.status !== 'DRAFT') throw badRequest('Only a draft is deleted — an issued memo is archived');
    const gone = await prisma.memo.deleteMany({ where: { id: row.id, status: 'DRAFT' } });
    if (!gone.count) throw conflict('The memo was issued a moment ago — reload it');
    await deleteAttachmentsOf(DOC, [row.id]);
    await audit({ entityType: DOC, entityId: row.id, action: 'DELETED', summary: `Deleted the draft memo "${row.title}"` }, req);
    res.json({ ok: true });
  }),
);

// ── Issue, acknowledge, remind, archive ─────────────────────────────────────

memoRoutes.post(
  '/:id/issue',
  requireEdit('ghr', 'memos'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(req.params.id);
    if (!canEditRecord(me, 'ghr', 'memos', row.createdById)) throw notFound('Memo not found');
    if (row.status !== 'DRAFT') throw badRequest('This memo was issued already');
    const today = manilaDate(new Date());
    const result = await prisma.$transaction(async (tx) => {
      const claimed = await tx.memo.updateMany({ where: { id: row.id, status: 'DRAFT', updatedAt: row.updatedAt }, data: { status: 'ISSUED' } });
      if (!claimed.count) throw conflict('The memo changed a moment ago — reload it');
      const people = await tx.employee.findMany({ where: audienceWhere(row), select: { id: true, userId: true } });
      if (!people.length) throw badRequest('Nobody active is addressed — choose who the memo is for');
      const number = await nextNumber('memo', tx);
      await tx.memo.update({ where: { id: row.id }, data: { number, issuedAt: new Date(), issuedById: me.id, memoDate: row.memoDate ?? today } });
      await tx.memoRecipient.createMany({ data: people.map((p) => ({ memoId: row.id, employeeId: p.id })), skipDuplicates: true });
      return { number, people };
    });
    const issued = await load(row.id);
    await audit({ entityType: DOC, entityId: row.id, action: 'SUBMITTED', summary: `Issued memo ${result.number} "${row.title}" to ${result.people.length} ${result.people.length === 1 ? 'person' : 'people'}` }, req);
    await tell(
      result.people.map((p) => p.userId).filter((id): id is string => !!id && id !== me.id),
      { type: 'memo.issued', title: `Memo ${result.number}: ${row.title}`, body: `${row.issuingOffice ?? me.name} issued a memo to you. Read it and acknowledge it.`, link: `${PATH}/${row.id}` },
    );
    const [label] = await audienceLabels([issued]);
    res.json(present(issued, label, 0));
  }),
);

memoRoutes.post(
  '/:id/acknowledge',
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(req.params.id);
    const mine = row.status === 'DRAFT' ? null : await isRecipient(me, row.id);
    if (!mine) throw notFound('Memo not found');
    const done = await prisma.memoRecipient.updateMany({ where: { id: mine.id, acknowledgedAt: null }, data: { acknowledgedAt: new Date() } });
    if (!done.count) throw conflict(`You acknowledged this memo on ${formatDate(mine.acknowledgedAt ?? new Date())}`);
    await audit({ entityType: DOC, entityId: row.id, action: 'APPROVED', summary: `${me.name} acknowledged memo ${row.number}` }, req);
    res.json({ ok: true, acknowledgedAt: new Date() });
  }),
);

/** Tell everyone who has not acknowledged it yet — once a day at most. */
memoRoutes.post(
  '/:id/remind',
  requireEdit('ghr', 'memos'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(req.params.id);
    if (!canEditRecord(me, 'ghr', 'memos', row.createdById)) throw notFound('Memo not found');
    if (row.status !== 'ISSUED') throw badRequest('Only an issued memo is reminded');
    const since = new Date(Date.now() - 24 * 3_600_000);
    const claimed = await prisma.memo.updateMany({ where: { id: row.id, OR: [{ remindedAt: null }, { remindedAt: { lt: since } }] }, data: { remindedAt: new Date() } });
    if (!claimed.count) throw conflict('A reminder went out within the last day — try again tomorrow');
    const pending = await prisma.memoRecipient.findMany({ where: { memoId: row.id, acknowledgedAt: null }, select: { employee: { select: { userId: true } } } });
    const userIds = pending.map((p) => p.employee.userId).filter((id): id is string => !!id);
    await tell(userIds, { type: 'memo.reminder', title: `Reminder — memo ${row.number}: ${row.title}`, body: 'Please read this memo and acknowledge it.', link: `${PATH}/${row.id}` });
    await audit({ entityType: DOC, entityId: row.id, action: 'UPDATED', summary: `Reminded ${pending.length} ${pending.length === 1 ? 'person' : 'people'} to acknowledge memo ${row.number}` }, req);
    res.json({ reminded: pending.length });
  }),
);

memoRoutes.post(
  '/:id/archive',
  requireEdit('ghr', 'memos'),
  handler(async (req, res) => {
    const me = currentUser(req);
    const row = await load(req.params.id);
    if (!canEditRecord(me, 'ghr', 'memos', row.createdById)) throw notFound('Memo not found');
    const restore = req.body?.restore === true;
    const from = restore ? 'ARCHIVED' : 'ISSUED';
    const done = await prisma.memo.updateMany({
      where: { id: row.id, status: from },
      data: restore ? { status: 'ISSUED', archivedAt: null, archivedById: null } : { status: 'ARCHIVED', archivedAt: new Date(), archivedById: me.id },
    });
    if (!done.count) throw badRequest(restore ? 'Only an archived memo is restored' : 'Only an issued memo is archived');
    await audit({ entityType: DOC, entityId: row.id, action: 'UPDATED', summary: `${restore ? 'Restored' : 'Archived'} memo ${row.number}` }, req);
    res.json({ ok: true });
  }),
);

// ── One memo ────────────────────────────────────────────────────────────────

memoRoutes.get(
  '/:id',
  handler(async (req, res) => {
    const me = currentUser(req);
    const { row, register, mine } = await readable(me, req.params.id);
    const [label] = await audienceLabels([row]);
    const recipients = register
      ? await prisma.memoRecipient.findMany({
          where: { memoId: row.id },
          orderBy: [{ employee: { lastName: 'asc' } }, { employee: { firstName: 'asc' } }],
          select: { acknowledgedAt: true, employee: { select: { id: true, employeeNo: true, firstName: true, lastName: true, position: true, industry: { select: { code: true } } } } },
        })
      : [];
    const acknowledged = register ? recipients.filter((r) => r.acknowledgedAt).length : 0;
    const mayChange = register && canEditRecord(me, 'ghr', 'memos', row.createdById);
    res.json({
      ...present(row, label, acknowledged),
      body: row.body,
      teamIds: row.teamIds,
      positionIds: row.positionIds,
      employeeIds: row.employeeIds,
      archivedAt: row.archivedAt,
      remindedAt: row.remindedAt,
      recipientsList: recipients.map((r) => ({
        employeeId: r.employee.id,
        name: `${r.employee.firstName} ${r.employee.lastName}`,
        employeeNo: r.employee.employeeNo,
        position: r.employee.position,
        team: r.employee.industry?.code ?? null,
        acknowledgedAt: r.acknowledgedAt,
      })),
      mine: mine ? { acknowledgedAt: mine.acknowledgedAt } : null,
      canEdit: mayChange && row.status === 'DRAFT',
      canIssue: mayChange && row.status === 'DRAFT',
      canRemind: mayChange && row.status === 'ISSUED' && row._count.recipients > acknowledged,
      canArchive: mayChange && row.status === 'ISSUED',
      canRestore: mayChange && row.status === 'ARCHIVED',
      canAcknowledge: !!mine && !mine.acknowledgedAt,
      seesRecipients: register,
    });
  }),
);

/**
 * The memorandum on paper: TO, FROM, DATE and SUBJECT, the body, and — for
 * the register — who acknowledged it and when; issued by, dated. Its files
 * follow it (`?attachments=0` bare).
 */
memoRoutes.get(
  '/:id/pdf',
  handler(async (req, res) => {
    const me = currentUser(req);
    const { row, register } = await readable(me, req.params.id);
    const [label] = await audienceLabels([row]);
    const sections: PdfSection[] = [
      {
        kind: 'fields',
        columns: 2,
        fields: [
          { label: 'To', value: label },
          { label: 'From', value: row.issuingOffice ?? row.issuedBy?.name ?? row.createdBy.name },
          { label: 'Date', value: row.memoDate ? formatDate(row.memoDate) : 'Not yet issued' },
          { label: 'Subject', value: row.title },
        ],
      },
      { kind: 'text', title: 'Memorandum', body: row.body },
    ];
    if (register && row.status !== 'DRAFT') {
      const recipients = await prisma.memoRecipient.findMany({
        where: { memoId: row.id },
        orderBy: [{ employee: { lastName: 'asc' } }, { employee: { firstName: 'asc' } }],
        select: { acknowledgedAt: true, employee: { select: { employeeNo: true, firstName: true, lastName: true, industry: { select: { code: true } } } } },
      });
      sections.push({
        kind: 'table',
        title: 'Acknowledgements',
        head: ['Employee', 'Number', 'Team', 'Acknowledged'],
        rows: recipients.map((r) => [
          `${r.employee.firstName} ${r.employee.lastName}`,
          r.employee.employeeNo ?? '—',
          r.employee.industry?.code ?? '—',
          r.acknowledgedAt ? formatDate(r.acknowledgedAt) : 'Pending',
        ]),
      });
    }
    const issuer = row.issuedBy ?? row.createdBy;
    const bare = await renderDocument({
      title: 'Memorandum',
      documentNumber: row.number ?? undefined,
      date: row.memoDate ?? row.createdAt,
      reference: row.status === 'DRAFT' ? 'Draft — not yet issued' : row.status === 'ARCHIVED' ? 'Archived' : undefined,
      sections,
      signatories: [{ role: row.status === 'DRAFT' ? 'Drafted by' : 'Issued by', name: issuer.name, ...(await contactOf(issuer.id)), at: row.issuedAt ?? undefined }],
    });
    const files = req.query.attachments === '0' ? [] : await attachedFiles(DOC, row.id);
    const { pdf, listed } = await withAttachments(bare, files, { title: 'Memorandum', number: row.number ?? row.title, reference: row.title });
    await audit({ entityType: DOC, entityId: row.id, action: 'EXPORTED', summary: `Printed memo ${row.number ?? row.title}${listed ? ` with ${listed} attachment${listed === 1 ? '' : 's'}` : ''}` }, req);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', contentDisposition(paperFileName({ kind: 'Memorandum', number: row.number ?? 'Draft', author: issuer.name, date: row.memoDate ?? row.createdAt })));
    res.send(pdf);
  }),
);

// ── The files, Ctrl+K and My Work ───────────────────────────────────────────

/** Read as the memo is (the register or a recipient); added or removed only while it is a draft — what was issued stays what was sent. */
registerAttachmentGuard(
  DOC,
  async (user, id) => {
    try {
      await readable(user, id);
      return true;
    } catch {
      return false;
    }
  },
  {
    write: async (user, id) => {
      const row = await prisma.memo.findUnique({ where: { id }, select: { createdById: true, status: true } });
      return !!row && row.status === 'DRAFT' && canEditRecord(user, 'ghr', 'memos', row.createdById);
    },
  },
);

registerSearch({
  kind: DOC,
  label: 'Memos',
  permission: ['ghr.memos.view_all', 'ghr.memos.view_own'],
  ownWhere: (user) => ({ createdById: user.id }),
  search: async (term, _user, limit, own) => {
    const rows = await prisma.memo.findMany({
      where: { AND: [own ?? {}, { OR: [{ number: { contains: term, mode: 'insensitive' } }, { title: { contains: term, mode: 'insensitive' } }] }] },
      take: limit,
      orderBy: { updatedAt: 'desc' },
      select: { id: true, number: true, title: true, status: true },
    });
    return rows.map((r) => ({ kind: DOC, id: r.id, title: r.title, subtitle: `${r.number ?? 'Draft'} · ${r.status === 'DRAFT' ? 'Draft' : r.status === 'ISSUED' ? 'Issued' : 'Archived'}`, link: `${PATH}/${r.id}` }));
  },
});

/** My Work: the memos addressed to me that I have not acknowledged — newest first, ten at most. */
export async function memosToAcknowledge(me: ResolvedUser) {
  const rows = await prisma.memoRecipient.findMany({
    where: { acknowledgedAt: null, employee: { userId: me.id }, memo: { status: 'ISSUED' } },
    select: { memo: { select: { id: true, number: true, title: true, issuedAt: true, issuingOffice: true } } },
    orderBy: { memo: { issuedAt: 'desc' } },
    take: 10,
  });
  return rows.map((r) => ({
    id: r.memo.id,
    kind: DOC,
    title: r.memo.title,
    subtitle: `${r.memo.number} · ${r.memo.issuingOffice ?? 'memo'} — read and acknowledge it`,
    when: r.memo.issuedAt,
    link: `${PATH}/${r.memo.id}`,
  }));
}
